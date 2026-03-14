/**
 * onpage-to-csv.ts — Transform DataForSEO OnPage API data to SF-compatible CSVs.
 *
 * Produces CSV files with identical headers to Screaming Frog output so all
 * downstream consumers (Dwight prompt, Michael prompt, sync-dwight) work unchanged.
 */

import type {
  OnPagePage,
  OnPageSummary,
  OnPageMicrodataItem,
  OnPageResource,
} from './dataforseo-onpage.js';

// ── CSV helpers ───────────────────────────────────────────────

function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsvRow(fields: (string | number | null | undefined)[]): string {
  return fields.map(escapeCsvField).join(',');
}

// ── Column derivation helpers ─────────────────────────────────

function deriveStatus(statusCode: number): string {
  if (statusCode >= 200 && statusCode < 300) return 'OK';
  if (statusCode >= 300 && statusCode < 400) return 'Redirect';
  if (statusCode >= 400 && statusCode < 500) return 'Client Error';
  if (statusCode >= 500) return 'Server Error';
  return 'Unknown';
}

function deriveIndexability(page: OnPagePage): string {
  if (page.status_code >= 300 && page.status_code < 400) return 'Non-Indexable';
  if (page.checks?.no_index_page) return 'Non-Indexable';
  if (page.checks?.is_redirect) return 'Non-Indexable';
  if (page.meta?.follow === false) return 'Non-Indexable';
  return 'Indexable';
}

function deriveIndexabilityStatus(page: OnPagePage): string {
  if (page.checks?.is_redirect) return 'Redirect';
  if (page.checks?.no_index_page) return 'Noindex';
  if (page.meta?.follow === false) return 'Nofollow';
  if (page.status_code >= 400) return 'Client Error';
  if (page.status_code >= 500) return 'Server Error';
  return 'Indexable';
}

function deriveMetaRobots(page: OnPagePage): string {
  const parts: string[] = [];
  if (page.checks?.no_index_page) parts.push('noindex');
  if (page.meta?.follow === false) parts.push('nofollow');
  if (parts.length === 0) return '';
  return parts.join(', ');
}

function deriveRedirectType(statusCode: number): string {
  if (statusCode === 301) return 'Permanent';
  if (statusCode === 302) return 'Temporary';
  if (statusCode === 307) return 'Temporary (307)';
  if (statusCode === 308) return 'Permanent (308)';
  if (statusCode >= 300 && statusCode < 400) return `Redirect (${statusCode})`;
  return '';
}

// ── Main transformers ─────────────────────────────────────────

/**
 * Transform OnPage pages to internal_all.csv with exact INTERNAL_ALL_KEEP_COLUMNS headers.
 */
export function transformPagesToInternalAll(pages: OnPagePage[]): string {
  const headers = [
    'Address', 'Content Type', 'Status Code', 'Status',
    'Indexability', 'Indexability Status',
    'Title 1', 'Title 1 Length',
    'Meta Description 1', 'Meta Description 1 Length',
    'H1-1', 'H1-1 Length',
    'H2-1', 'H2-1 Length',
    'Meta Robots 1', 'Canonical Link Element 1',
    'Word Count', 'Text Ratio', 'Readability',
    'Crawl Depth', 'Link Score',
    'Inlinks', 'Unique Inlinks', 'Outlinks', 'External Outlinks', 'Unique External Outlinks',
    'Response Time', 'Redirect URL', 'Redirect Type',
    'Spelling Errors', 'Grammar Errors',
    'Size (bytes)',
  ];

  const rows = [toCsvRow(headers)];

  for (const p of pages) {
    const title = p.meta?.title ?? '';
    const description = p.meta?.description ?? '';
    const h1s = p.meta?.htags?.h1 ?? [];
    const h2s = p.meta?.htags?.h2 ?? [];
    const h1 = h1s[0] ?? '';
    const h2 = h2s[0] ?? '';

    const contentType = p.resource_type === 'html' ? 'text/html' : p.resource_type ?? '';
    const wordCount = p.content?.plain_text_word_count ?? '';
    const textRatio = p.content?.plain_text_rate != null
      ? `${(p.content.plain_text_rate * 100).toFixed(1)}%`
      : '';
    const readability = p.content?.automated_readability_index ?? '';
    const crawlDepth = p.page_timing?.depth ?? p.click_depth ?? '';
    const linkScore = p.onpage_score ?? '';
    const inlinks = p.internal_links_count ?? 0;
    const outlinks = (p.internal_links_count ?? 0) + (p.external_links_count ?? 0);
    const responseTime = p.page_timing?.duration_time != null
      ? `${(p.page_timing.duration_time * 1000).toFixed(0)}`
      : '';
    const redirectUrl = p.redirect_url ?? p.location ?? '';
    const redirectType = deriveRedirectType(p.status_code);

    rows.push(toCsvRow([
      p.url,
      contentType,
      p.status_code,
      deriveStatus(p.status_code),
      deriveIndexability(p),
      deriveIndexabilityStatus(p),
      title,
      title.length || '',
      description,
      description.length || '',
      h1,
      h1.length || '',
      h2,
      h2.length || '',
      deriveMetaRobots(p),
      p.meta?.canonical ?? '',
      wordCount,
      textRatio,
      readability,
      crawlDepth,
      linkScore,
      inlinks,
      inlinks, // Unique Inlinks ≈ Inlinks (approximation — OnPage doesn't distinguish)
      outlinks,
      p.external_links_count ?? 0,
      p.external_links_count ?? 0, // Unique External Outlinks ≈ External Outlinks
      responseTime,
      redirectUrl,
      redirectType,
      '', // Spelling Errors — not available from OnPage API
      '', // Grammar Errors — not available from OnPage API
      p.size ?? '',
    ]));
  }

  return rows.join('\n');
}

/**
 * Generate all supplementary CSVs from OnPage data.
 * Returns a Map of filename → CSV content.
 */
export function transformToSupplementaryCsvs(
  pages: OnPagePage[],
  summary: OnPageSummary | null,
  microdata: OnPageMicrodataItem[],
  imageResources: OnPageResource[],
): Map<string, string> {
  const csvs = new Map<string, string>();

  // 1. Page Titles
  {
    const headers = ['Address', 'Title 1', 'Title 1 Length', 'Title 1 Pixel Width'];
    const rows = [toCsvRow(headers)];
    for (const p of pages) {
      if (p.resource_type !== 'html') continue;
      const title = p.meta?.title ?? '';
      rows.push(toCsvRow([p.url, title, title.length, '']));
    }
    csvs.set('page_titles_all.csv', rows.join('\n'));
  }

  // 2. Meta Descriptions
  {
    const headers = ['Address', 'Meta Description 1', 'Meta Description 1 Length', 'Meta Description 1 Pixel Width'];
    const rows = [toCsvRow(headers)];
    for (const p of pages) {
      if (p.resource_type !== 'html') continue;
      const desc = p.meta?.description ?? '';
      rows.push(toCsvRow([p.url, desc, desc.length, '']));
    }
    csvs.set('meta_description_all.csv', rows.join('\n'));
  }

  // 3. H1 Tags
  {
    const headers = ['Address', 'H1-1', 'H1-1 Length'];
    const rows = [toCsvRow(headers)];
    for (const p of pages) {
      if (p.resource_type !== 'html') continue;
      const h1 = p.meta?.htags?.h1?.[0] ?? '';
      rows.push(toCsvRow([p.url, h1, h1.length]));
    }
    csvs.set('h1_all.csv', rows.join('\n'));
  }

  // 4. Structured Data
  {
    const headers = ['Address', 'Schema Type', 'Properties'];
    const rows = [toCsvRow(headers)];
    for (const item of microdata) {
      const types = (item.types ?? []).join(', ');
      const props = JSON.stringify(item.properties ?? {}).slice(0, 500);
      rows.push(toCsvRow([item.url ?? '', types, props]));
    }
    csvs.set('structured_data_all.csv', rows.join('\n'));
  }

  // 5. Canonicals
  {
    const headers = ['Address', 'Canonical Link Element 1', 'Status'];
    const rows = [toCsvRow(headers)];
    for (const p of pages) {
      if (p.resource_type !== 'html') continue;
      const canonical = p.meta?.canonical ?? '';
      const isSelfRef = canonical === p.url || canonical === '' ? 'Self-Referencing' : 'Canonicalised';
      rows.push(toCsvRow([p.url, canonical, isSelfRef]));
    }
    csvs.set('canonicals_all.csv', rows.join('\n'));
  }

  // 6. Sitemaps — derive from page checks
  {
    const headers = ['Address', 'In Sitemap'];
    const rows = [toCsvRow(headers)];
    for (const p of pages) {
      if (p.resource_type !== 'html') continue;
      const inSitemap = p.checks?.sitemap ? 'Yes' : 'No';
      rows.push(toCsvRow([p.url, inSitemap]));
    }
    csvs.set('sitemaps_all.csv', rows.join('\n'));
  }

  // 7. Directives
  {
    const headers = ['Address', 'Meta Robots 1', 'X-Robots-Tag 1', 'Canonical Link Element 1'];
    const rows = [toCsvRow(headers)];
    for (const p of pages) {
      if (p.resource_type !== 'html') continue;
      rows.push(toCsvRow([
        p.url,
        deriveMetaRobots(p),
        '', // X-Robots-Tag not directly available
        p.meta?.canonical ?? '',
      ]));
    }
    csvs.set('directives_all.csv', rows.join('\n'));
  }

  // 8-10. Response code CSVs
  const errorPages4xx = pages.filter((p) => p.status_code >= 400 && p.status_code < 500);
  const redirectPages = pages.filter((p) => p.status_code >= 300 && p.status_code < 400);
  const errorPages5xx = pages.filter((p) => p.status_code >= 500);

  for (const [filename, subset] of [
    ['response_codes_client_error_4xx.csv', errorPages4xx],
    ['response_codes_redirection_3xx.csv', redirectPages],
    ['response_codes_server_error_5xx.csv', errorPages5xx],
  ] as const) {
    const headers = ['Address', 'Status Code', 'Status', 'Redirect URL'];
    const rows = [toCsvRow(headers)];
    for (const p of subset) {
      rows.push(toCsvRow([p.url, p.status_code, deriveStatus(p.status_code), p.redirect_url ?? '']));
    }
    csvs.set(filename, rows.join('\n'));
  }

  // 11. Images
  {
    const headers = ['Address', 'Status Code', 'Size (bytes)', 'Alt Text'];
    const rows = [toCsvRow(headers)];
    for (const img of imageResources) {
      rows.push(toCsvRow([img.url, img.status_code, img.size, '']));
    }
    csvs.set('images_all.csv', rows.join('\n'));
  }

  // 12. Issues Overview (from summary)
  if (summary) {
    const headers = ['Issue', 'Count'];
    const rows = [toCsvRow(headers)];
    const metrics = summary.page_metrics ?? {};
    const issueMap: Record<string, string> = {
      duplicate_title: 'Duplicate Title',
      duplicate_description: 'Duplicate Meta Description',
      duplicate_content: 'Duplicate Content',
      broken_links: 'Broken Links',
      broken_resources: 'Broken Resources',
      pages_with_redirect: 'Pages with Redirect',
    };
    for (const [key, label] of Object.entries(issueMap)) {
      if (metrics[key] != null && metrics[key] > 0) {
        rows.push(toCsvRow([label, metrics[key]]));
      }
    }
    // Add check-based issues from summary
    if (summary.domain_info?.checks) {
      for (const [check, value] of Object.entries(summary.domain_info.checks)) {
        if (value === false) {
          const label = check.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
          rows.push(toCsvRow([label, 1]));
        }
      }
    }
    csvs.set('issues_overview_report.csv', rows.join('\n'));
  }

  return csvs;
}
