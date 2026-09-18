/**
 * Sitemap discovery and traversal for one website. All network access goes through the injected
 * `Fetcher`, so the whole flow can be unit-tested with an in-memory fake.
 */
import type { ErrorType, Fetcher } from './fetch.js';
import {
    type ChildSitemap,
    looksLikeSitemapUrl,
    type Matcher,
    type ParsedSitemap,
    parseRobotsSitemaps,
    parseSitemap,
    type SitemapEntry,
} from './parse.js';

export const FALLBACK_SITEMAP_PATHS = [
    '/sitemap.xml',
    '/sitemap_index.xml',
    '/sitemap-index.xml',
    '/wp-sitemap.xml',
    '/sitemap.txt',
];

export interface SitemapInfo {
    sitemapUrl: string;
    kind: 'urlset' | 'index' | 'text';
    urlCount: number;
    childSitemapCount: number;
    /** `<lastmod>` reported for this file by its parent sitemap index, if any. */
    lastmod: string | null;
    depth: number;
}

export interface SitemapFailure {
    sitemapUrl: string;
    errorType: ErrorType;
    error: string;
    statusCode?: number;
}

export interface ExtractOptions {
    fetch: Fetcher;
    limiter: HostLimiter;
    maxUrls: number;
    maxDepth: number;
    include: Matcher | null;
    exclude: Matcher | null;
    sitemapsOnly: boolean;
    /** Receives matching URLs from one sitemap file. Return `false` to stop the whole site (e.g. budget exhausted). */
    onUrls: (entries: SitemapEntry[], sitemapUrl: string) => Promise<boolean>;
    /** Receives metadata for every sitemap file that parsed successfully. Return `false` to stop. */
    onSitemap: (info: SitemapInfo) => Promise<boolean>;
    /** Receives fetch/parse failures of individual sitemap files that were expected to exist. */
    onFailure: (failure: SitemapFailure) => Promise<void>;
}

export interface ExtractResult {
    site: string;
    /** `true` when at least one sitemap file was found and parsed. */
    discovered: boolean;
    sitemapsFound: number;
    urlsEmitted: number;
    /** Number of sitemap files that failed to load or parse. */
    failures: number;
    /** `true` when a callback asked to stop early. */
    stopped: boolean;
    /** Why discovery failed (only when `discovered` is false). */
    discoveryError?: SitemapFailure;
}

/** Limits concurrent requests per hostname (polite crawling). */
export class HostLimiter {
    private readonly active = new Map<string, number>();

    private readonly waiting = new Map<string, (() => void)[]>();

    constructor(private readonly perHost = 5) {}

    async run<T>(url: string, fn: () => Promise<T>): Promise<T> {
        const host = safeHost(url);
        await this.acquire(host);
        try {
            return await fn();
        } finally {
            this.release(host);
        }
    }

    private async acquire(host: string): Promise<void> {
        const current = this.active.get(host) ?? 0;
        if (current < this.perHost) {
            this.active.set(host, current + 1);
            return;
        }
        await new Promise<void>((resolve) => {
            const queue = this.waiting.get(host) ?? [];
            queue.push(resolve);
            this.waiting.set(host, queue);
        });
        this.active.set(host, (this.active.get(host) ?? 0) + 1);
    }

    private release(host: string): void {
        this.active.set(host, Math.max(0, (this.active.get(host) ?? 1) - 1));
        const queue = this.waiting.get(host);
        const next = queue?.shift();
        if (next) next();
    }
}

function safeHost(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

export function siteOf(url: string): string {
    try {
        return new URL(url).origin;
    } catch {
        return url;
    }
}

type ValidSitemap = ParsedSitemap & { kind: 'urlset' | 'index' | 'text' };
type Loaded = { ok: true; parsed: ValidSitemap; finalUrl: string } | { ok: false; failure: SitemapFailure };

interface QueueItem {
    url: string;
    depth: number;
    lastmod: string | null;
}

/** Runs `worker` over a growable queue with bounded concurrency. Workers may push more items. */
async function drainQueue<T>(
    queue: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
    shouldStop: () => boolean,
): Promise<void> {
    const state = { index: 0, active: 0 };
    await new Promise<void>((resolve) => {
        const pump = (): void => {
            while (state.active < concurrency && state.index < queue.length && !shouldStop()) {
                const item = queue[state.index];
                state.index += 1;
                state.active += 1;
                worker(item)
                    .catch(() => undefined)
                    .finally(() => {
                        state.active -= 1;
                        pump();
                    });
            }
            if (state.active === 0 && (state.index >= queue.length || shouldStop())) resolve();
        };
        pump();
    });
}

/**
 * Discovers the sitemap(s) of `inputUrl` (a website or a sitemap file), walks sitemap indexes up to
 * `maxDepth` levels deep and reports URLs, sitemap files and failures through the callbacks.
 */
export async function extractSite(inputUrl: string, options: ExtractOptions): Promise<ExtractResult> {
    const site = siteOf(inputUrl);
    const result: ExtractResult = {
        site,
        discovered: false,
        sitemapsFound: 0,
        urlsEmitted: 0,
        failures: 0,
        stopped: false,
    };
    const cache = new Map<string, Loaded>();
    const seenUrls = new Set<string>();
    const visitedSitemaps = new Set<string>();

    const load = async (url: string): Promise<Loaded> => {
        const cached = cache.get(url);
        if (cached) return cached;
        const outcome = await options.limiter.run(url, async () => options.fetch(url));
        let loaded: Loaded;
        if (!outcome.ok) {
            loaded = {
                ok: false,
                failure: {
                    sitemapUrl: url,
                    errorType: outcome.errorType,
                    error: outcome.error,
                    statusCode: outcome.statusCode,
                },
            };
        } else {
            const parsed = parseSitemap(outcome.body, outcome.finalUrl || url);
            loaded =
                parsed.kind === 'invalid'
                    ? {
                          ok: false,
                          failure: {
                              sitemapUrl: url,
                              errorType: 'not-found',
                              error: parsed.error ?? 'Not a sitemap',
                              statusCode: outcome.statusCode,
                          },
                      }
                    : { ok: true, parsed: parsed as ValidSitemap, finalUrl: outcome.finalUrl || url };
        }
        cache.set(url, loaded);
        return loaded;
    };

    // ---- 1. Discovery: which sitemap files do we start from? ----
    const roots: ChildSitemap[] = [];
    let explicitFailure: SitemapFailure | undefined;
    if (looksLikeSitemapUrl(inputUrl)) {
        const loaded = await load(inputUrl);
        if (loaded.ok) roots.push({ url: inputUrl, lastmod: null });
        else explicitFailure = loaded.failure;
    }

    if (roots.length === 0) {
        // robots.txt "Sitemap:" directives first ...
        const robotsUrl = `${site}/robots.txt`;
        const robots = await options.limiter.run(robotsUrl, async () => options.fetch(robotsUrl));
        const fromRobots = robots.ok ? parseRobotsSitemaps(robots.body, robotsUrl) : [];
        for (const url of fromRobots) if (url !== inputUrl) roots.push({ url, lastmod: null });

        // ... then the conventional locations, first hit wins.
        if (roots.length === 0) {
            for (const path of FALLBACK_SITEMAP_PATHS) {
                const candidate = `${site}${path}`;
                if (candidate === inputUrl) continue;
                const loaded = await load(candidate);
                if (loaded.ok) {
                    roots.push({ url: candidate, lastmod: null });
                    break;
                }
                if (loaded.failure.errorType === 'blocked' || loaded.failure.errorType === 'dns') {
                    explicitFailure ??= loaded.failure;
                    break;
                }
            }
        }
    }

    if (roots.length === 0) {
        result.discoveryError = explicitFailure ?? {
            sitemapUrl: `${site}/robots.txt`,
            errorType: 'not-found',
            error: 'No sitemap found: robots.txt lists none and none of the common locations exist',
        };
        result.failures = 1;
        return result;
    }

    // ---- 2. Traversal ----
    const queue: QueueItem[] = roots.map((r) => ({ url: r.url, depth: 0, lastmod: r.lastmod }));
    for (const r of roots) visitedSitemaps.add(r.url);

    const handle = async (item: QueueItem): Promise<void> => {
        if (result.stopped) return;
        const loaded = await load(item.url);
        if (result.stopped) return;
        if (!loaded.ok) {
            result.failures += 1;
            await options.onFailure(loaded.failure);
            return;
        }
        const { parsed } = loaded;
        result.discovered = true;
        result.sitemapsFound += 1;

        if (parsed.kind === 'index') {
            if (item.depth < options.maxDepth) {
                for (const child of parsed.sitemaps) {
                    if (visitedSitemaps.has(child.url)) continue;
                    visitedSitemaps.add(child.url);
                    queue.push({ url: child.url, depth: item.depth + 1, lastmod: child.lastmod });
                }
            }
        }

        const keepGoing = await options.onSitemap({
            sitemapUrl: item.url,
            kind: parsed.kind,
            urlCount: parsed.urls.length,
            childSitemapCount: parsed.sitemaps.length,
            lastmod: item.lastmod,
            depth: item.depth,
        });
        if (!keepGoing) {
            result.stopped = true;
            return;
        }
        if (options.sitemapsOnly || parsed.urls.length === 0) return;

        const entries: SitemapEntry[] = [];
        for (const entry of parsed.urls) {
            if (result.urlsEmitted + entries.length >= options.maxUrls) break;
            if (seenUrls.has(entry.url)) continue;
            if (options.include && !options.include(entry.url)) continue;
            if (options.exclude && options.exclude(entry.url)) continue;
            seenUrls.add(entry.url);
            entries.push(entry);
        }
        if (entries.length === 0) return;
        result.urlsEmitted += entries.length;
        const cont = await options.onUrls(entries, item.url);
        if (!cont) result.stopped = true;
    };

    const shouldStop = (): boolean =>
        result.stopped || (!options.sitemapsOnly && result.urlsEmitted >= options.maxUrls);
    await drainQueue(queue, 5, handle, shouldStop);

    // Every root failure was already reported through onFailure, so no extra site-level record is needed.
    return result;
}
