/**
 * Pure parsing helpers: XML sitemaps (urlset + sitemapindex, with image/video/xhtml extensions),
 * plain-text sitemaps, robots.txt "Sitemap:" directives and include/exclude pattern matching.
 * No network access here so everything is unit-testable.
 */
import { XMLParser } from 'fast-xml-parser';

export interface Alternate {
    hreflang: string;
    href: string;
}

export interface SitemapEntry {
    url: string;
    lastmod: string | null;
    changefreq: string | null;
    priority: number | null;
    alternates: Alternate[];
    imageCount: number;
}

export interface ChildSitemap {
    url: string;
    lastmod: string | null;
}

export interface ParsedSitemap {
    /** `urlset` = page list, `index` = list of other sitemaps, `text` = plain-text list, `invalid` = not a sitemap. */
    kind: 'urlset' | 'index' | 'text' | 'invalid';
    urls: SitemapEntry[];
    sitemaps: ChildSitemap[];
    error?: string;
}

const ARRAY_TAGS = new Set(['url', 'sitemap', 'link', 'image', 'video']);

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    cdataPropName: false,
    processEntities: true,
    htmlEntities: true,
    ignoreDeclaration: true,
    ignorePiTags: true,
    isArray: (tagName) => ARRAY_TAGS.has(tagName),
});

type XmlNode = Record<string, unknown>;

function textOf(node: unknown): string | null {
    if (node === undefined || node === null) return null;
    if (typeof node === 'string') return node.trim() || null;
    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) return textOf(node[0]);
    if (typeof node === 'object') return textOf((node as XmlNode)['#text']);
    return null;
}

function attr(node: unknown, name: string): string | null {
    if (!node || typeof node !== 'object') return null;
    const value = (node as XmlNode)[`@_${name}`];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asArray<T>(value: T | T[] | undefined): T[] {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

/** Resolves a possibly relative location against the sitemap's own URL and drops non-http(s) schemes. */
export function resolveLoc(loc: string | null, base: string): string | null {
    if (!loc) return null;
    try {
        const resolved = new URL(loc.trim(), base);
        if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
        return resolved.toString();
    } catch {
        return null;
    }
}

/** Normalises W3C datetime / ISO dates to ISO 8601; returns the raw value when it cannot be parsed. */
export function normalizeDate(value: string | null): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    // Date-only values (2024-01-31) stay date-only rather than gaining a timezone.
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) return trimmed;
    return new Date(ms).toISOString();
}

function parsePriority(value: string | null): number | null {
    if (!value) return null;
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
}

function parseChangefreq(value: string | null): string | null {
    if (!value) return null;
    const v = value.trim().toLowerCase();
    return v || null;
}

function parseUrlNode(node: XmlNode, base: string): SitemapEntry | null {
    const url = resolveLoc(textOf(node.loc), base);
    if (!url) return null;
    const alternates: Alternate[] = [];
    for (const link of asArray(node.link as XmlNode | XmlNode[] | undefined)) {
        const rel = attr(link, 'rel');
        const hreflang = attr(link, 'hreflang');
        const href = resolveLoc(attr(link, 'href'), base);
        if (rel && rel !== 'alternate') continue;
        if (!hreflang || !href) continue;
        alternates.push({ hreflang, href });
    }
    return {
        url,
        lastmod: normalizeDate(textOf(node.lastmod)),
        changefreq: parseChangefreq(textOf(node.changefreq)),
        priority: parsePriority(textOf(node.priority)),
        alternates,
        imageCount: asArray(node.image as unknown[]).length,
    };
}

function looksLikeXml(body: string): boolean {
    return body.slice(0, 2000).trimStart().startsWith('<');
}

function looksLikeHtml(body: string): boolean {
    const head = body.slice(0, 2000).toLowerCase();
    return head.includes('<!doctype html') || head.includes('<html') || head.includes('<body');
}

/** Parses a plain-text sitemap (one absolute URL per line). */
export function parseTextSitemap(body: string, base: string): ParsedSitemap {
    const urls: SitemapEntry[] = [];
    for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        if (!/^https?:\/\//i.test(line)) {
            return {
                kind: 'invalid',
                urls: [],
                sitemaps: [],
                error: 'Not a sitemap (text response contains non-URL lines)',
            };
        }
        const url = resolveLoc(line, base);
        if (url) urls.push({ url, lastmod: null, changefreq: null, priority: null, alternates: [], imageCount: 0 });
    }
    if (urls.length === 0) return { kind: 'invalid', urls: [], sitemaps: [], error: 'Empty text sitemap' };
    return { kind: 'text', urls, sitemaps: [] };
}

/**
 * Parses an XML sitemap or sitemap index. Falls back to a plain-text sitemap when the body is not XML
 * and every non-empty line is a URL.
 */
export function parseSitemap(body: string, sitemapUrl: string): ParsedSitemap {
    const trimmed = body.replace(/^\uFEFF/, '');
    if (!trimmed.trim()) return { kind: 'invalid', urls: [], sitemaps: [], error: 'Empty response body' };
    if (!looksLikeXml(trimmed)) return parseTextSitemap(trimmed, sitemapUrl);
    if (looksLikeHtml(trimmed))
        return { kind: 'invalid', urls: [], sitemaps: [], error: 'Response is an HTML page, not a sitemap' };

    let doc: XmlNode;
    try {
        doc = parser.parse(trimmed) as XmlNode;
    } catch (err) {
        return {
            kind: 'invalid',
            urls: [],
            sitemaps: [],
            error: `XML parse error: ${(err as Error).message.slice(0, 200)}`,
        };
    }

    const urlset = doc.urlset as XmlNode | undefined;
    const index = doc.sitemapindex as XmlNode | undefined;
    if (index && typeof index === 'object') {
        const sitemaps: ChildSitemap[] = [];
        for (const node of asArray(index.sitemap as XmlNode | XmlNode[] | undefined)) {
            const url = resolveLoc(textOf(node.loc), sitemapUrl);
            if (url) sitemaps.push({ url, lastmod: normalizeDate(textOf(node.lastmod)) });
        }
        return { kind: 'index', urls: [], sitemaps };
    }
    if (urlset && typeof urlset === 'object') {
        const urls: SitemapEntry[] = [];
        for (const node of asArray(urlset.url as XmlNode | XmlNode[] | undefined)) {
            const entry = parseUrlNode(node, sitemapUrl);
            if (entry) urls.push(entry);
        }
        return { kind: 'urlset', urls, sitemaps: [] };
    }
    // RSS feeds, XSL-wrapped pages and error documents are XML too, but not sitemaps.
    const rootName = Object.keys(doc).find((k) => !k.startsWith('?')) ?? 'unknown';
    return { kind: 'invalid', urls: [], sitemaps: [], error: `Not a sitemap (root element <${rootName}>)` };
}

/** Extracts absolute sitemap URLs from robots.txt `Sitemap:` directives (case-insensitive). */
export function parseRobotsSitemaps(robotsTxt: string, robotsUrl: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const rawLine of robotsTxt.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, '').trim();
        const match = /^sitemap\s*:\s*(.+)$/i.exec(line);
        if (!match) continue;
        const url = resolveLoc(match[1], robotsUrl);
        if (url && !seen.has(url)) {
            seen.add(url);
            out.push(url);
        }
    }
    return out;
}

/** Heuristic: does the given URL point at a sitemap file rather than a website? */
export function looksLikeSitemapUrl(url: string): boolean {
    try {
        const { pathname } = new URL(url);
        const p = pathname.toLowerCase();
        return /\.(xml|xml\.gz|txt|gz)$/.test(p) || p.includes('sitemap');
    } catch {
        return false;
    }
}

/** Normalises user input: adds https://, validates the host. Returns null for garbage. */
export function normalizeInputUrl(raw: string): string | null {
    let value = raw.trim();
    if (!value) return null;
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
    try {
        const parsed = new URL(value);
        if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') return null;
        return parsed.toString();
    } catch {
        return null;
    }
}

export type Matcher = (url: string) => boolean;

const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g;

function globToRegExp(glob: string): RegExp {
    let out = '^';
    for (let i = 0; i < glob.length; i += 1) {
        const ch = glob[i];
        if (ch === '*') {
            if (glob[i + 1] === '*') {
                out += '.*';
                i += 1;
            } else out += '[^/]*';
        } else if (ch === '?') out += '[^/]';
        else out += ch.replace(REGEX_ESCAPE, '\\$&');
    }
    return new RegExp(`${out}$`, 'i');
}

/**
 * Compiles include/exclude patterns into a single matcher (OR semantics).
 * - `/regex/flags` is a regular expression;
 * - anything containing regex metacharacters other than `*` and `?` is tried as a regular expression;
 * - `*` / `?` patterns are globs (`*` stays within a path segment, `**` crosses segments); a glob without
 *   a scheme matches anywhere inside the URL;
 * - plain strings are case-insensitive substrings.
 */
export function compileMatchers(patterns: string[] | undefined): Matcher | null {
    const list = (patterns ?? []).map((p) => p.trim()).filter(Boolean);
    if (list.length === 0) return null;
    const regexes = list.map((pattern) => {
        const slashForm = /^\/(.+)\/([a-z]*)$/i.exec(pattern);
        if (slashForm) {
            try {
                return new RegExp(slashForm[1], slashForm[2].includes('i') ? slashForm[2] : `${slashForm[2]}i`);
            } catch {
                return globToRegExp(pattern);
            }
        }
        if (/[\\^$()|[\]+]/.test(pattern)) {
            try {
                return new RegExp(pattern, 'i');
            } catch {
                return globToRegExp(pattern);
            }
        }
        if (pattern.includes('*') || pattern.includes('?')) {
            return /^https?:\/\//i.test(pattern) ? globToRegExp(pattern) : globToRegExp(`**${pattern}**`);
        }
        return new RegExp(pattern.replace(REGEX_ESCAPE, '\\$&'), 'i');
    });
    return (url) => regexes.some((re) => re.test(url));
}
