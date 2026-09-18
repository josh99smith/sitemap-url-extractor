Get **every URL a website lists in its XML sitemaps**, with the metadata that comes with it: last modification date, change frequency, priority, `hreflang` alternates and image counts. Paste website URLs or sitemap URLs, and the Actor finds the sitemaps (robots.txt, `/sitemap.xml`, `/sitemap_index.xml`, `/wp-sitemap.xml`, ...), follows nested sitemap indexes, unpacks `.xml.gz` files and returns one clean record per page.

It is built for **SEO specialists, developers and data teams** who need a complete, structured list of a site's pages without crawling it. You pay a small flat price per URL, and sites whose sitemap cannot be found or loaded are reported **free of charge**.

## What can you do with Sitemap URL Extractor?

- **SEO audits**: compare the sitemap against your crawl or Google Search Console coverage, find stale `lastmod` dates, missing `hreflang` alternates or pages that should not be indexed.
- **Seed other scrapers and crawlers**: get the full URL list of a site in seconds and feed it to a content scraper, screenshot Actor or your own pipeline instead of discovering pages link by link.
- **Monitor competitors**: schedule a weekly run and diff the results to see which pages, products or articles a competitor added or changed.
- **Build AI / RAG corpora**: collect every documentation, blog or help-centre URL of a site and pass the list to a text extractor for embedding.
- **Content inventories and migrations**: export the whole site structure to CSV or Excel before a redesign or platform migration.
- **Replace Zapier/Make sitemap steps**: run on a schedule and push new URLs to Google Sheets, Airtable, Slack or a webhook with Apify integrations.

## How it works

For a website URL the Actor reads `robots.txt` and follows every `Sitemap:` directive. If there is none, it probes `/sitemap.xml`, `/sitemap_index.xml`, `/sitemap-index.xml`, `/wp-sitemap.xml` and `/sitemap.txt`. For a sitemap URL it starts there directly. Sitemap index files are followed recursively (up to the configured depth), gzip-compressed sitemaps are decompressed, and every `<url>` entry is parsed including the image and `xhtml:link` extensions. Requests are limited to 5 concurrent connections per host.

The Actor reads sitemap files only; it does not crawl the pages themselves. Sites without a sitemap, or sitemaps hidden behind a login or bot protection, cannot be extracted and are reported as failures.

## How to use it

1. Open the Actor and paste your URLs into **Website or sitemap URLs**, one per line. Website URLs trigger discovery; direct sitemap URLs are read as-is.
2. Optionally set **Max URLs per site** (default 5,000) to cap the cost of very large sites, and add **Include / Exclude URL patterns** to keep only the sections you need (for example `**/blog/**` or `/products/`).
3. Click **Start**. URLs appear in the **Output** tab while the run is in progress.
4. Download the dataset as JSON, CSV, Excel or XML, or pass it to another Actor or integration.

To run it programmatically, use the **API** tab: any Apify Actor can be started with one HTTP request or via the [JavaScript](https://docs.apify.com/api/client/js) and [Python](https://docs.apify.com/api/client/python) clients.

```json
{
    "urls": ["https://www.apify.com", "https://blog.apify.com/sitemap.xml"],
    "maxUrlsPerSite": 5000,
    "includePatterns": [],
    "excludePatterns": ["*.pdf"],
    "maxSitemapDepth": 5,
    "outputSitemapsOnly": false
}
```

## Output

One record per URL:

```json
{
    "site": "https://www.apify.com",
    "sitemapUrl": "https://apify.com/sitemap.xml",
    "url": "https://apify.com/store",
    "lastmod": "2026-09-17T06:12:41.000Z",
    "changefreq": "daily",
    "priority": 0.8,
    "alternates": [{ "hreflang": "en", "href": "https://apify.com/store" }],
    "imageCount": 0,
    "fetchedAt": "2026-09-18T20:24:11.000Z"
}
```

Sitemaps that cannot be found or loaded are still recorded, so nothing silently disappears:

```json
{ "site": "https://this-domain-does-not-exist.example", "success": false, "errorType": "dns", "error": "getaddrinfo ENOTFOUND ...", "fetchedAt": "..." }
```

With **List sitemap files only** switched on, each record describes one sitemap file instead (`sitemapUrl`, `kind`, `urlCount`, `childSitemapCount`, `depth`, `lastmod`).

### Fields

| Field | Description |
| --- | --- |
| `site` | Origin of the website the URL belongs to (as you supplied it). |
| `sitemapUrl` | The sitemap file the URL was found in. |
| `url` | The page URL (absolute). |
| `lastmod` | Last modification date from the sitemap, normalised to ISO 8601 when possible; `null` if absent. |
| `changefreq` | `always`, `hourly`, `daily`, `weekly`, `monthly`, `yearly`, `never` or `null`. |
| `priority` | Sitemap priority between 0.0 and 1.0, or `null`. |
| `alternates[]` | `hreflang` / `href` pairs from `xhtml:link rel="alternate"` entries. |
| `imageCount` | Number of `image:image` entries attached to the URL. |
| `fetchedAt` | When the sitemap file was read. |
| `errorType` | For failures only: `invalid-url`, `not-found`, `http-error`, `blocked`, `dns`, `timeout`, `network` or `other`. |

## Pricing: how much does it cost to extract sitemap URLs?

You pay a **flat price per extracted URL** (shown next to the Start button); 5,000 URLs cost about $1. Nothing is charged for Actor start-up, for failed sites, or for sitemap files that could not be loaded. The Actor stops automatically when it reaches the maximum cost you set for a run, so a huge site never produces a surprise bill, and **Max URLs per site** caps each site individually.

## Tips

- **Large sites**: news and ecommerce sites can list millions of URLs. Combine **Max URLs per site** with **Include URL patterns** to fetch only the section you care about, or run **List sitemap files only** first to see how the sitemap is structured.
- **Patterns**: globs (`**/blog/**`, `*.pdf`), regular expressions in slashes (`/\/products\/\d+$/`) and plain substrings (`/docs/`) are all accepted, case-insensitively.
- **Blocked sites**: a few CDNs refuse cloud IP addresses. Enable **Proxy configuration > Apify Proxy** in the Advanced section (proxy traffic is billed by Apify separately).
- **Change tracking**: use the **Schedule** tab to run weekly and compare `lastmod` values between runs.

## FAQ

**The site has pages that are not in the output. Why?**
Only URLs present in the site's sitemaps are returned; the Actor does not crawl pages. If the site does not maintain a sitemap, use a crawler such as Website Content Crawler instead.

**Does it work with WordPress, Shopify, Wix, Webflow, Next.js sites?**
Yes. All of them publish standard XML sitemaps (WordPress at `/wp-sitemap.xml` or via Yoast/RankMath sitemap indexes), which the Actor discovers automatically.

**Which sitemap formats are supported?**
XML `urlset` and `sitemapindex` files (including the image, video, news and `xhtml:link` extensions), gzip-compressed `.xml.gz` files and plain-text sitemaps. RSS/Atom feeds are not sitemaps and are reported as `not-found`.

**Is this legal?**
Sitemaps are published specifically so that automated clients can read them. The Actor sends a handful of requests per site at a polite rate and stores only the URLs and metadata the site publishes. You are responsible for using the results in compliance with the laws that apply to you.

## Support and feedback

Found a sitemap that is not parsed correctly? Open a ticket in the **Issues** tab of this Actor with the sitemap URL and we will look into it.

This Actor is open source under the MIT licence.
