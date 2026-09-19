import { setTimeout as sleep } from 'node:timers/promises';

import { Actor, log } from 'apify';

import { extractSite, HostLimiter, type SitemapFailure, type SitemapInfo, siteOf } from './extract.js';
import { createFetcher, type ErrorType } from './fetch.js';
import { compileMatchers, normalizeInputUrl, type SitemapEntry } from './parse.js';

const CHARGE_EVENT = 'url-extracted';
const PUSH_BATCH_SIZE = 500;
const SITE_CONCURRENCY = 10;
const PER_HOST_CONCURRENCY = 5;

interface Input {
    urls?: (string | { url: string })[];
    maxUrlsPerSite?: number;
    includePatterns?: string[];
    excludePatterns?: string[];
    maxSitemapDepth?: number;
    outputSitemapsOnly?: boolean;
    timeoutSecs?: number;
    proxyConfiguration?: {
        useApifyProxy?: boolean;
        apifyProxyGroups?: string[];
        apifyProxyCountry?: string;
        proxyUrls?: string[];
    };
}

interface UrlRecord {
    site: string;
    sitemapUrl: string;
    url: string;
    lastmod: string | null;
    changefreq: string | null;
    priority: number | null;
    alternates: { hreflang: string; href: string }[];
    imageCount: number;
    fetchedAt: string;
}

interface SitemapRecord {
    site: string;
    sitemapUrl: string;
    kind: 'urlset' | 'index' | 'text';
    urlCount: number;
    childSitemapCount: number;
    lastmod: string | null;
    depth: number;
    fetchedAt: string;
}

interface FailureRecord {
    site: string;
    sitemapUrl?: string;
    success: false;
    errorType: ErrorType;
    error: string;
    statusCode?: number;
    fetchedAt: string;
}

await Actor.init();

Actor.on('aborting', async () => {
    await sleep(1000);
    await Actor.exit();
});

const input = (await Actor.getInput<Input>()) ?? {};
const maxUrlsPerSite = Math.min(Math.max(input.maxUrlsPerSite ?? 5000, 1), 200_000);
const maxSitemapDepth = Math.min(Math.max(input.maxSitemapDepth ?? 5, 0), 20);
const outputSitemapsOnly = input.outputSitemapsOnly ?? false;
const timeoutSecs = Math.min(Math.max(input.timeoutSecs ?? 30, 5), 120);

const include = compileMatchers(input.includePatterns);
const exclude = compileMatchers(input.excludePatterns);

const rawUrls = (input.urls ?? []).map((u) => (typeof u === 'string' ? u : (u?.url ?? '')));
if (rawUrls.length === 0) {
    await Actor.fail(
        'Input "urls" is empty. Provide at least one website or sitemap URL, e.g. ["https://www.apify.com"].',
    );
}

const seen = new Set<string>();
const targets: string[] = [];
const invalid: FailureRecord[] = [];
for (const raw of rawUrls) {
    const normalized = normalizeInputUrl(raw);
    if (!normalized) {
        invalid.push({
            site: raw,
            success: false,
            errorType: 'invalid-url',
            error: 'Not a valid website or sitemap URL',
            fetchedAt: new Date().toISOString(),
        });
        continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    targets.push(normalized);
}
if (invalid.length) await Actor.pushData(invalid); // free: nothing was extracted

const proxyConfiguration =
    input.proxyConfiguration?.useApifyProxy || input.proxyConfiguration?.proxyUrls?.length
        ? await Actor.createProxyConfiguration(input.proxyConfiguration)
        : undefined;
const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;

const fetch = createFetcher({ timeoutMs: timeoutSecs * 1000, proxyUrl, retries: 1 });
const limiter = new HostLimiter(PER_HOST_CONCURRENCY);
const { isPayPerEvent } = Actor.getChargingManager().getPricingInfo();

let sitemapsFound = 0;
let urlsPushed = 0;
let urlsCharged = 0;
let sitesWithResults = 0;
let failures = invalid.length;
let stopBecauseOfBudget = false;

log.info(
    `Extracting sitemap URLs for ${targets.length} site(s): max ${maxUrlsPerSite} URLs per site, depth ${maxSitemapDepth}${outputSitemapsOnly ? ', listing sitemap files only' : ''}.`,
);

/** Pushes charged records in batches; returns false once the run's charge limit is reached. */
async function pushCharged(records: (UrlRecord | SitemapRecord)[]): Promise<boolean> {
    for (let i = 0; i < records.length; i += PUSH_BATCH_SIZE) {
        if (stopBecauseOfBudget) return false;
        const wanted = records.slice(i, i + PUSH_BATCH_SIZE);
        // Ask the budget how many events still fit and push only that many (the SDK's chargedCount over-reports).
        const allowed = isPayPerEvent ? Actor.getChargingManager().calculateMaxEventChargeCountWithinLimit(CHARGE_EVENT) : wanted.length;
        const batch = wanted.slice(0, Math.max(0, allowed));
        let eventChargeLimitReached = batch.length < wanted.length;
        if (batch.length > 0) {
            const result = await Actor.pushData(batch, CHARGE_EVENT);
            eventChargeLimitReached = eventChargeLimitReached || result.eventChargeLimitReached;
        }
        const stored = batch.length;
        urlsPushed += stored;
        urlsCharged += stored;
        if (eventChargeLimitReached) {
            stopBecauseOfBudget = true;
            log.warning(
                'Maximum charge limit for this run reached; stopping early. Raise the run cost limit to extract more URLs.',
            );
            return false;
        }
    }
    return true;
}

async function processSite(target: string): Promise<void> {
    if (stopBecauseOfBudget) return;
    const site = siteOf(target);
    const result = await extractSite(target, {
        fetch,
        limiter,
        maxUrls: maxUrlsPerSite,
        maxDepth: maxSitemapDepth,
        include,
        exclude,
        sitemapsOnly: outputSitemapsOnly,
        onUrls: async (entries: SitemapEntry[], sitemapUrl: string) => {
            const fetchedAt = new Date().toISOString();
            const records: UrlRecord[] = entries.map((e) => ({
                site,
                sitemapUrl,
                url: e.url,
                lastmod: e.lastmod,
                changefreq: e.changefreq,
                priority: e.priority,
                alternates: e.alternates,
                imageCount: e.imageCount,
                fetchedAt,
            }));
            return pushCharged(records);
        },
        onSitemap: async (info: SitemapInfo) => {
            sitemapsFound += 1;
            log.info(
                `${info.sitemapUrl}: ${info.kind} with ${info.urlCount} URLs and ${info.childSitemapCount} child sitemaps (depth ${info.depth})`,
            );
            if (!outputSitemapsOnly) return !stopBecauseOfBudget;
            const record: SitemapRecord = { site, ...info, fetchedAt: new Date().toISOString() };
            return pushCharged([record]);
        },
        onFailure: async (failure: SitemapFailure) => {
            failures += 1;
            const record: FailureRecord = { site, ...failure, success: false, fetchedAt: new Date().toISOString() };
            log.warning(`${failure.sitemapUrl}: ${failure.errorType} - ${failure.error}`);
            await Actor.pushData(record); // free of charge
        },
    });

    if (result.discoveryError) {
        failures += 1;
        const record: FailureRecord = {
            site,
            ...result.discoveryError,
            success: false,
            fetchedAt: new Date().toISOString(),
        };
        log.warning(`${target}: ${record.errorType} - ${record.error}`);
        await Actor.pushData(record); // free of charge
        return;
    }
    if (result.discovered) sitesWithResults += 1;
    log.info(
        `${site}: ${result.sitemapsFound} sitemap file(s), ${result.urlsEmitted} URL(s) extracted${result.failures ? `, ${result.failures} sitemap file(s) failed` : ''}`,
    );
}

// Sites run in parallel; the HostLimiter keeps each hostname at <= 5 concurrent requests.
const pending = [...targets];
const workers = Array.from({ length: Math.min(SITE_CONCURRENCY, pending.length) }, async () => {
    while (pending.length > 0 && !stopBecauseOfBudget) {
        const next = pending.shift();
        if (!next) break;
        try {
            await processSite(next);
        } catch (err) {
            failures += 1;
            const message = err instanceof Error ? err.message : String(err);
            log.exception(err as Error, `${next}: unexpected error`);
            await Actor.pushData({
                site: siteOf(next),
                success: false,
                errorType: 'other',
                error: message.slice(0, 500),
                fetchedAt: new Date().toISOString(),
            } satisfies FailureRecord);
        }
    }
});
await Promise.all(workers);

const summary = {
    sitesRequested: rawUrls.length,
    sitesWithResults,
    sitemapsFound,
    urlsExtracted: urlsPushed,
    urlsCharged: isPayPerEvent ? urlsCharged : urlsPushed,
    failures,
    stoppedEarlyDueToBudget: stopBecauseOfBudget,
};
await Actor.setValue('SUMMARY', summary);
log.info(`Done. ${JSON.stringify(summary)}`);

await Actor.exit();
