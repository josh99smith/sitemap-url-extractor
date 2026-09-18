import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { categorizeError, decodeBody } from '../src/fetch.js';
import {
    compileMatchers,
    looksLikeSitemapUrl,
    normalizeDate,
    normalizeInputUrl,
    parseRobotsSitemaps,
    parseSitemap,
} from '../src/parse.js';

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>https://example.com/</loc>
    <lastmod>2024-01-31</lastmod>
    <changefreq>Daily</changefreq>
    <priority>1.0</priority>
    <xhtml:link rel="alternate" hreflang="de" href="https://example.com/de/"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/"/>
    <image:image><image:loc>https://example.com/a.png</image:loc></image:image>
    <image:image><image:loc>https://example.com/b.png</image:loc></image:image>
  </url>
  <url>
    <loc>https://example.com/products?id=1&amp;lang=en</loc>
    <lastmod>2024-02-01T10:20:30+02:00</lastmod>
  </url>
  <url>
    <loc><![CDATA[https://example.com/cdata]]></loc>
    <priority>not-a-number</priority>
  </url>
  <url>
    <loc>ftp://example.com/ignored</loc>
  </url>
  <url>
    <lastmod>2024-01-01</lastmod>
  </url>
</urlset>`;

const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-posts.xml</loc><lastmod>2024-03-01T00:00:00Z</lastmod></sitemap>
  <sitemap><loc>/sitemap-pages.xml.gz</loc></sitemap>
</sitemapindex>`;

describe('parseSitemap', () => {
    it('parses a urlset with extensions, entities and CDATA', () => {
        const parsed = parseSitemap(URLSET, 'https://example.com/sitemap.xml');
        expect(parsed.kind).toBe('urlset');
        expect(parsed.urls).toHaveLength(3);
        const [home, product, cdata] = parsed.urls;
        expect(home.url).toBe('https://example.com/');
        expect(home.lastmod).toBe('2024-01-31');
        expect(home.changefreq).toBe('daily');
        expect(home.priority).toBe(1);
        expect(home.imageCount).toBe(2);
        expect(home.alternates).toEqual([
            { hreflang: 'de', href: 'https://example.com/de/' },
            { hreflang: 'x-default', href: 'https://example.com/' },
        ]);
        expect(product.url).toBe('https://example.com/products?id=1&lang=en');
        expect(product.lastmod).toBe('2024-02-01T08:20:30.000Z');
        expect(product.priority).toBeNull();
        expect(product.alternates).toEqual([]);
        expect(cdata.url).toBe('https://example.com/cdata');
        expect(cdata.priority).toBeNull();
    });

    it('parses a single-url urlset (no array wrapper)', () => {
        const parsed = parseSitemap(
            '<urlset><url><loc>https://a.com/x</loc></url></urlset>',
            'https://a.com/sitemap.xml',
        );
        expect(parsed.kind).toBe('urlset');
        expect(parsed.urls.map((u) => u.url)).toEqual(['https://a.com/x']);
    });

    it('parses a sitemap index and resolves relative locations', () => {
        const parsed = parseSitemap(INDEX, 'https://example.com/sitemap_index.xml');
        expect(parsed.kind).toBe('index');
        expect(parsed.sitemaps).toEqual([
            { url: 'https://example.com/sitemap-posts.xml', lastmod: '2024-03-01T00:00:00.000Z' },
            { url: 'https://example.com/sitemap-pages.xml.gz', lastmod: null },
        ]);
    });

    it('tolerates a UTF-8 BOM and leading whitespace', () => {
        const parsed = parseSitemap(`\uFEFF\n  ${INDEX}`, 'https://example.com/sitemap.xml');
        expect(parsed.kind).toBe('index');
    });

    it('parses plain-text sitemaps', () => {
        const parsed = parseSitemap('https://a.com/1\n# comment\n\nhttps://a.com/2\r\n', 'https://a.com/sitemap.txt');
        expect(parsed.kind).toBe('text');
        expect(parsed.urls.map((u) => u.url)).toEqual(['https://a.com/1', 'https://a.com/2']);
    });

    it('rejects HTML pages, RSS feeds, junk text and empty bodies', () => {
        expect(parseSitemap('<!DOCTYPE html><html><body>404</body></html>', 'https://a.com/sitemap.xml').kind).toBe(
            'invalid',
        );
        expect(parseSitemap('<rss><channel><item/></channel></rss>', 'https://a.com/sitemap.xml').kind).toBe('invalid');
        expect(parseSitemap('Not Found', 'https://a.com/sitemap.xml').kind).toBe('invalid');
        expect(parseSitemap('   ', 'https://a.com/sitemap.xml').kind).toBe('invalid');
        expect(parseSitemap('<urlset><url><loc>https://a.com</loc>', 'https://a.com/sitemap.xml').kind).toBe('urlset');
    });
});

describe('parseRobotsSitemaps', () => {
    it('extracts Sitemap directives case-insensitively and resolves relative paths', () => {
        const robots = `User-agent: *\nDisallow: /admin\n\nsitemap: https://cdn.example.com/sitemap.xml # main\nSITEMAP:/sitemap-news.xml\nSitemap: https://cdn.example.com/sitemap.xml\n`;
        expect(parseRobotsSitemaps(robots, 'https://example.com/robots.txt')).toEqual([
            'https://cdn.example.com/sitemap.xml',
            'https://example.com/sitemap-news.xml',
        ]);
    });

    it('returns an empty list when there are no directives', () => {
        expect(parseRobotsSitemaps('User-agent: *\nAllow: /', 'https://example.com/robots.txt')).toEqual([]);
    });
});

describe('helpers', () => {
    it('recognises sitemap URLs', () => {
        expect(looksLikeSitemapUrl('https://a.com/sitemap.xml')).toBe(true);
        expect(looksLikeSitemapUrl('https://a.com/sitemaps/posts-1.xml.gz')).toBe(true);
        expect(looksLikeSitemapUrl('https://a.com/wp-sitemap-posts-post-1.xml')).toBe(true);
        expect(looksLikeSitemapUrl('https://a.com/')).toBe(false);
        expect(looksLikeSitemapUrl('https://a.com/blog')).toBe(false);
    });

    it('normalises input URLs', () => {
        expect(normalizeInputUrl('example.com')).toBe('https://example.com/');
        expect(normalizeInputUrl('  https://Example.com/Sitemap.xml ')).toBe('https://example.com/Sitemap.xml');
        expect(normalizeInputUrl('not a url')).toBeNull();
        expect(normalizeInputUrl('')).toBeNull();
    });

    it('normalises dates and keeps unparsable values', () => {
        expect(normalizeDate('2024-05-06')).toBe('2024-05-06');
        expect(normalizeDate('2024-05-06T01:02:03Z')).toBe('2024-05-06T01:02:03.000Z');
        expect(normalizeDate('yesterday-ish')).toBe('yesterday-ish');
        expect(normalizeDate(null)).toBeNull();
    });

    it('categorises errors', () => {
        expect(categorizeError('HTTP 403', 403)).toBe('blocked');
        expect(categorizeError('HTTP 404', 404)).toBe('not-found');
        expect(categorizeError('HTTP 500', 500)).toBe('http-error');
        expect(categorizeError('getaddrinfo ENOTFOUND x')).toBe('dns');
        expect(categorizeError('Timeout awaiting request')).toBe('timeout');
        expect(categorizeError('read ECONNRESET')).toBe('network');
        expect(categorizeError('something odd')).toBe('other');
    });

    it('gunzips raw .gz bodies and passes plain bodies through', () => {
        const xml = '<urlset><url><loc>https://a.com/</loc></url></urlset>';
        expect(decodeBody(gzipSync(Buffer.from(xml)), 'https://a.com/sitemap.xml.gz', 'application/x-gzip')).toBe(xml);
        expect(decodeBody(Buffer.from(xml), 'https://a.com/sitemap.xml', 'application/xml')).toBe(xml);
    });
});

describe('compileMatchers', () => {
    it('returns null for empty patterns', () => {
        expect(compileMatchers(undefined)).toBeNull();
        expect(compileMatchers(['', '  '])).toBeNull();
    });

    it('supports globs, regexes and substrings', () => {
        const glob = compileMatchers(['**/blog/**'])!;
        expect(glob('https://a.com/blog/post-1')).toBe(true);
        expect(glob('https://a.com/about')).toBe(false);

        const ext = compileMatchers(['*.pdf'])!;
        expect(ext('https://a.com/files/report.pdf')).toBe(true);
        expect(ext('https://a.com/files/report.html')).toBe(false);

        const regex = compileMatchers(['/\\/products\\/\\d+$/'])!;
        expect(regex('https://a.com/products/42')).toBe(true);
        expect(regex('https://a.com/products/new')).toBe(false);

        const bare = compileMatchers(['^https://a\\.com/(en|de)/'])!;
        expect(bare('https://a.com/de/x')).toBe(true);
        expect(bare('https://a.com/fr/x')).toBe(false);

        const substring = compileMatchers(['/docs/'])!;
        expect(substring('https://a.com/docs/intro')).toBe(true);
        expect(substring('https://a.com/DOCS/intro')).toBe(true);
        expect(substring('https://a.com/doc/intro')).toBe(false);
    });

    it('ORs several patterns together', () => {
        const m = compileMatchers(['/blog/', '/news/'])!;
        expect(m('https://a.com/news/1')).toBe(true);
        expect(m('https://a.com/blog/1')).toBe(true);
        expect(m('https://a.com/shop/1')).toBe(false);
    });
});
