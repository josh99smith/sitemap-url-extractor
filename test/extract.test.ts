import { describe, expect, it } from 'vitest';

import {
    type ExtractOptions,
    extractSite,
    HostLimiter,
    type SitemapFailure,
    type SitemapInfo,
} from '../src/extract.js';
import type { FetchOutcome } from '../src/fetch.js';
import type { SitemapEntry } from '../src/parse.js';

type Responses = Record<string, string | { status: number } | { delayMs: number; body: string } | 'network'>;

function urlset(...urls: string[]): string {
    return `<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
}

function index(...urls: string[]): string {
    return `<sitemapindex>${urls.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join('')}</sitemapindex>`;
}

function fakeFetcher(responses: Responses, calls: string[] = []) {
    return async (url: string): Promise<FetchOutcome> => {
        calls.push(url);
        const res = responses[url];
        if (res === undefined) return { ok: false, url, statusCode: 404, errorType: 'not-found', error: 'HTTP 404' };
        if (res === 'network') return { ok: false, url, errorType: 'network', error: 'read ECONNRESET' };
        if (typeof res === 'object' && 'delayMs' in res) {
            await new Promise((resolve) => {
                setTimeout(resolve, res.delayMs);
            });
            return { ok: true, url, finalUrl: url, statusCode: 200, contentType: 'application/xml', body: res.body };
        }
        if (typeof res === 'object') {
            return {
                ok: false,
                url,
                statusCode: res.status,
                errorType: res.status === 403 ? 'blocked' : 'http-error',
                error: `HTTP ${res.status}`,
            };
        }
        return { ok: true, url, finalUrl: url, statusCode: 200, contentType: 'application/xml', body: res };
    };
}

interface Collected {
    urls: { url: string; sitemapUrl: string }[];
    sitemaps: SitemapInfo[];
    failures: SitemapFailure[];
}

function run(inputUrl: string, responses: Responses, overrides: Partial<ExtractOptions> = {}, calls: string[] = []) {
    const collected: Collected = { urls: [], sitemaps: [], failures: [] };
    const options: ExtractOptions = {
        fetch: fakeFetcher(responses, calls),
        limiter: new HostLimiter(5),
        maxUrls: 1000,
        maxDepth: 5,
        maxSitemaps: 500,
        include: null,
        exclude: null,
        sitemapsOnly: false,
        onUrls: async (entries: SitemapEntry[], sitemapUrl: string) => {
            for (const e of entries) collected.urls.push({ url: e.url, sitemapUrl });
            return true;
        },
        onSitemap: async (info) => {
            collected.sitemaps.push(info);
            return true;
        },
        onFailure: async (failure) => {
            collected.failures.push(failure);
        },
        ...overrides,
    };
    return { collected, result: extractSite(inputUrl, options) };
}

describe('extractSite', () => {
    it('discovers sitemaps from robots.txt and walks a sitemap index', async () => {
        const { collected, result } = run('https://example.com/', {
            'https://example.com/robots.txt': 'User-agent: *\nSitemap: https://example.com/sitemap_index.xml',
            'https://example.com/sitemap_index.xml': index(
                'https://example.com/posts.xml',
                'https://example.com/pages.xml',
            ),
            'https://example.com/posts.xml': urlset('https://example.com/p/1', 'https://example.com/p/2'),
            'https://example.com/pages.xml': urlset('https://example.com/about', 'https://example.com/p/1'),
        });
        const r = await result;
        expect(r.discovered).toBe(true);
        expect(r.sitemapsFound).toBe(3);
        expect(r.urlsEmitted).toBe(3); // p/1 deduplicated across sitemaps
        expect(collected.urls.map((u) => u.url).sort()).toEqual([
            'https://example.com/about',
            'https://example.com/p/1',
            'https://example.com/p/2',
        ]);
        expect(collected.urls.find((u) => u.url === 'https://example.com/about')?.sitemapUrl).toBe(
            'https://example.com/pages.xml',
        );
        expect(collected.sitemaps.map((s) => s.kind).sort()).toEqual(['index', 'urlset', 'urlset']);
        expect(collected.sitemaps.find((s) => s.kind === 'index')?.childSitemapCount).toBe(2);
    });

    it('falls back to common sitemap locations when robots.txt lists none', async () => {
        const calls: string[] = [];
        const { collected, result } = run(
            'https://example.com/',
            {
                'https://example.com/robots.txt': 'User-agent: *\nDisallow:',
                'https://example.com/sitemap.xml': '<!doctype html><html><body>Not found</body></html>',
                'https://example.com/sitemap_index.xml': urlset('https://example.com/x'),
            },
            {},
            calls,
        );
        const r = await result;
        expect(r.discovered).toBe(true);
        expect(collected.urls.map((u) => u.url)).toEqual(['https://example.com/x']);
        expect(calls).toEqual([
            'https://example.com/robots.txt',
            'https://example.com/sitemap.xml',
            'https://example.com/sitemap_index.xml',
        ]);
    });

    it('reads an explicit sitemap URL directly without touching robots.txt', async () => {
        const calls: string[] = [];
        const { result } = run(
            'https://example.com/sitemap.xml',
            { 'https://example.com/sitemap.xml': urlset('https://example.com/a') },
            {},
            calls,
        );
        const r = await result;
        expect(r.urlsEmitted).toBe(1);
        expect(calls).toEqual(['https://example.com/sitemap.xml']);
    });

    it('reports not-found when nothing can be discovered', async () => {
        const { collected, result } = run('https://example.com/', {
            'https://example.com/robots.txt': 'User-agent: *',
        });
        const r = await result;
        expect(r.discovered).toBe(false);
        expect(r.discoveryError?.errorType).toBe('not-found');
        expect(collected.urls).toEqual([]);
        expect(collected.failures).toEqual([]);
    });

    it('surfaces the original failure for an explicit sitemap URL that returns an error', async () => {
        const { result } = run('https://example.com/sitemap.xml', {
            'https://example.com/sitemap.xml': { status: 500 },
        });
        const r = await result;
        expect(r.discovered).toBe(false);
        expect(r.discoveryError).toMatchObject({
            sitemapUrl: 'https://example.com/sitemap.xml',
            errorType: 'http-error',
            statusCode: 500,
        });
    });

    it('stops probing when the site blocks requests', async () => {
        const calls: string[] = [];
        const { result } = run(
            'https://example.com/',
            { 'https://example.com/robots.txt': { status: 403 }, 'https://example.com/sitemap.xml': { status: 403 } },
            {},
            calls,
        );
        const r = await result;
        expect(r.discoveryError?.errorType).toBe('blocked');
        expect(calls).toEqual(['https://example.com/robots.txt', 'https://example.com/sitemap.xml']);
    });

    it('reports failing child sitemaps individually and keeps going', async () => {
        const { collected, result } = run('https://example.com/sitemap.xml', {
            'https://example.com/sitemap.xml': index(
                'https://example.com/a.xml',
                'https://example.com/b.xml',
                'https://example.com/c.xml',
            ),
            'https://example.com/a.xml': urlset('https://example.com/1'),
            'https://example.com/c.xml': 'network',
        });
        const r = await result;
        expect(r.urlsEmitted).toBe(1);
        expect(r.failures).toBe(2);
        expect(collected.failures.map((f) => [f.sitemapUrl, f.errorType]).sort()).toEqual([
            ['https://example.com/b.xml', 'not-found'],
            ['https://example.com/c.xml', 'network'],
        ]);
    });

    it('honours maxUrls, include/exclude patterns and maxDepth', async () => {
        const responses: Responses = {
            'https://example.com/sitemap.xml': index('https://example.com/l1.xml'),
            'https://example.com/l1.xml': index('https://example.com/l2.xml'),
            'https://example.com/l2.xml': urlset('https://example.com/deep'),
        };
        const shallow = await run('https://example.com/sitemap.xml', responses, { maxDepth: 1 }).result;
        expect(shallow.sitemapsFound).toBe(2);
        expect(shallow.urlsEmitted).toBe(0);

        const many = urlset(
            ...Array.from({ length: 20 }, (_, i) => `https://example.com/${i % 2 ? 'blog' : 'shop'}/${i}`),
        );
        const { collected, result } = run(
            'https://example.com/sitemap.xml',
            { 'https://example.com/sitemap.xml': many },
            { maxUrls: 3, include: (u) => u.includes('/blog/'), exclude: (u) => u.endsWith('/1') },
        );
        const r = await result;
        expect(r.urlsEmitted).toBe(3);
        expect(collected.urls.map((u) => u.url)).toEqual([
            'https://example.com/blog/3',
            'https://example.com/blog/5',
            'https://example.com/blog/7',
        ]);
    });

    it('stops as soon as a callback returns false (budget exhausted)', async () => {
        let pushes = 0;
        const { result } = run(
            'https://example.com/sitemap.xml',
            {
                'https://example.com/sitemap.xml': index('https://example.com/a.xml', 'https://example.com/b.xml'),
                'https://example.com/a.xml': urlset('https://example.com/1'),
                'https://example.com/b.xml': { delayMs: 20, body: urlset('https://example.com/2') },
            },
            {
                onUrls: async () => {
                    pushes += 1;
                    return false;
                },
            },
        );
        const r = await result;
        expect(r.stopped).toBe(true);
        expect(pushes).toBe(1);
    });

    it('does not emit URLs in sitemaps-only mode but still lists every file', async () => {
        const { collected, result } = run(
            'https://example.com/sitemap.xml',
            {
                'https://example.com/sitemap.xml': index('https://example.com/a.xml'),
                'https://example.com/a.xml': urlset('https://example.com/1', 'https://example.com/2'),
            },
            { sitemapsOnly: true },
        );
        const r = await result;
        expect(r.urlsEmitted).toBe(0);
        expect(collected.urls).toEqual([]);
        expect(collected.sitemaps.map((s) => [s.sitemapUrl, s.kind, s.urlCount])).toEqual([
            ['https://example.com/sitemap.xml', 'index', 0],
            ['https://example.com/a.xml', 'urlset', 2],
        ]);
    });
});

describe('HostLimiter', () => {
    it('never exceeds the per-host limit but lets other hosts proceed', async () => {
        const limiter = new HostLimiter(2);
        let active = 0;
        let peak = 0;
        const task = async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => {
                setTimeout(resolve, 5);
            });
            active -= 1;
        };
        await Promise.all(Array.from({ length: 6 }, async () => limiter.run('https://a.com/x', task)));
        expect(peak).toBe(2);

        peak = 0;
        await Promise.all([
            limiter.run('https://a.com/x', task),
            limiter.run('https://b.com/x', task),
            limiter.run('https://c.com/x', task),
        ]);
        expect(peak).toBe(3);
    });
});
