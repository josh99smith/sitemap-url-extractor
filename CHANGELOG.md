# Changelog

## 0.1.0 (2026-09-18)

- Initial release: discovers sitemaps via robots.txt `Sitemap:` directives and common locations (`/sitemap.xml`, `/sitemap_index.xml`, `/sitemap-index.xml`, `/wp-sitemap.xml`, `/sitemap.txt`).
- Follows nested sitemap index files, reads gzip-compressed `.xml.gz` sitemaps and plain-text sitemaps.
- Outputs `lastmod`, `changefreq`, `priority`, `hreflang` alternates and image count per URL, with include/exclude filtering and a per-site URL cap.
- Sitemaps that cannot be found or loaded are reported in the dataset and never billed.
