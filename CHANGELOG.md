# Changelog

## 0.1.2 (2026-09-23)

- Listing: joined the Best Damn series. New title "Best Damn Sitemap URL Extractor", new description, icon and README banner. No change to inputs, output or pricing.
- README: new "Integrate and automate your workflow" section (Make, Zapier, n8n, Slack, Airbyte, GitHub, Google Drive, webhooks).

## 0.1.1 (2026-09-20)

- Fixed: with several sitemaps fetched in parallel, two batches could be delivered at once and overshoot the run's cost cap with URLs that were never billed (observed: 1,000 URLs delivered for a 500-URL budget). Charged pushes are now serialised.
- Duplicate input URLs are now deduplicated by the Actor instead of being rejected by input validation.

## 0.1.0 (2026-09-18)

- Initial release: discovers sitemaps via robots.txt `Sitemap:` directives and common locations (`/sitemap.xml`, `/sitemap_index.xml`, `/sitemap-index.xml`, `/wp-sitemap.xml`, `/sitemap.txt`).
- Follows nested sitemap index files, reads gzip-compressed `.xml.gz` sitemaps and plain-text sitemaps.
- Outputs `lastmod`, `changefreq`, `priority`, `hreflang` alternates and image count per URL, with include/exclude filtering and a per-site URL cap.
- Sitemaps that cannot be found or loaded are reported in the dataset and never billed.
