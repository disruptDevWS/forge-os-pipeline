/**
 * fetch-gsc-data.ts — Google Search Console Search Analytics fetcher.
 *
 * Runs as Phase 1c in the pipeline, and reused by track-gsc.ts for weekly refresh.
 *
 * Usage:
 *   npx tsx scripts/fetch-gsc-data.ts --domain <domain> --user-email <email> [--force]
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_SERVICE_ACCOUNT_JSON
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getServiceAccountAccessToken, getAnalyticsConnection } from './google-auth.js';

// ============================================================
// CLI argument parsing
// ============================================================

interface CliArgs {
  domain: string;
  userEmail: string;
  force: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    }
  }

  if (!flags.domain || !flags['user-email']) {
    console.error('Usage: npx tsx scripts/fetch-gsc-data.ts --domain <domain> --user-email <email> [--force]');
    process.exit(1);
  }

  return {
    domain: flags.domain,
    userEmail: flags['user-email'],
    force: flags.force === 'true',
  };
}

// ============================================================
// .env loader
// ============================================================

function loadEnv(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    const env: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
    return env;
  }
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined) env[key] = val;
  }
  return env;
}

// ============================================================
// Helpers
// ============================================================

const AUDITS_BASE = path.resolve(process.cwd(), 'audits');

function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function resolveAudit(sb: SupabaseClient, domain: string, userEmail: string) {
  const { data: userData } = await sb.auth.admin.listUsers();
  const user = userData?.users?.find((u: any) => u.email === userEmail);
  if (!user) throw new Error(`User not found: ${userEmail}`);

  const { data: audit } = await sb
    .from('audits')
    .select('*')
    .eq('domain', domain)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!audit) throw new Error(`No audit found for ${domain} / ${userEmail}`);
  return { audit, userId: user.id };
}

// ============================================================
// GSC API types
// ============================================================

interface GscPageRow {
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface GscQueryPageRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface GscPageData {
  page_url: string;
  clicks: number;
  impressions: number;
  ctr: number;
  avg_position: number;
  top_queries: Array<{ query: string; clicks: number; impressions: number; ctr: number; position: number }>;
}

// ============================================================
// GSC API fetch
// ============================================================

const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

async function fetchGscSearchAnalytics(
  propertyUrl: string,
  startDate: string,
  endDate: string,
  token: string,
): Promise<{ pageRows: GscPageRow[]; queryPageRows: GscQueryPageRow[] }> {
  const encodedProperty = encodeURIComponent(propertyUrl);
  const apiBase = `https://www.googleapis.com/webmasters/v3/sites/${encodedProperty}/searchAnalytics/query`;

  // Call 1: Page-level data (top 500 pages)
  console.log('  Fetching GSC page-level data...');
  const pageResp = await fetch(apiBase, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      startDate,
      endDate,
      dimensions: ['page'],
      rowLimit: 500,
      dataState: 'final',
    }),
  });

  if (!pageResp.ok) {
    const errText = await pageResp.text();
    throw new Error(`GSC page query failed (${pageResp.status}): ${errText}`);
  }

  const pageData = await pageResp.json();
  const pageRows: GscPageRow[] = (pageData.rows ?? []).map((r: any) => ({
    page: r.keys[0],
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
  console.log(`  GSC pages: ${pageRows.length} rows`);

  // Call 2: Query × page data (top 1000 for top_queries assignment)
  console.log('  Fetching GSC query×page data...');
  const queryPageResp = await fetch(apiBase, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      startDate,
      endDate,
      dimensions: ['query', 'page'],
      rowLimit: 1000,
      dataState: 'final',
    }),
  });

  if (!queryPageResp.ok) {
    const errText = await queryPageResp.text();
    throw new Error(`GSC query×page query failed (${queryPageResp.status}): ${errText}`);
  }

  const queryPageData = await queryPageResp.json();
  const queryPageRows: GscQueryPageRow[] = (queryPageData.rows ?? []).map((r: any) => ({
    query: r.keys[0],
    page: r.keys[1],
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
  console.log(`  GSC query×page: ${queryPageRows.length} rows`);

  return { pageRows, queryPageRows };
}

// ============================================================
// Data processing
// ============================================================

function normalizePageUrl(fullUrl: string): string {
  try {
    const url = new URL(fullUrl);
    return url.pathname.replace(/\/+$/, '') || '/';
  } catch {
    return fullUrl;
  }
}

function processGscData(pageRows: GscPageRow[], queryPageRows: GscQueryPageRow[]): GscPageData[] {
  // Group query×page rows by page
  const queryMap = new Map<string, GscQueryPageRow[]>();
  for (const row of queryPageRows) {
    const page = normalizePageUrl(row.page);
    if (!queryMap.has(page)) queryMap.set(page, []);
    queryMap.get(page)!.push(row);
  }

  // Build page data with top 5 queries per page
  const pages: GscPageData[] = pageRows.map((row) => {
    const pagePath = normalizePageUrl(row.page);
    const queries = queryMap.get(pagePath) ?? [];
    // Sort by clicks desc, take top 5
    const topQueries = queries
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, 5)
      .map((q) => ({
        query: q.query,
        clicks: q.clicks,
        impressions: q.impressions,
        ctr: q.ctr,
        position: q.position,
      }));

    return {
      page_url: pagePath,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      avg_position: Number(row.position.toFixed(2)),
      top_queries: topQueries,
    };
  });

  // Sort by clicks desc
  pages.sort((a, b) => b.clicks - a.clicks);
  return pages;
}

function identifyZeroClickQueries(queryPageRows: GscQueryPageRow[]): Array<{ query: string; impressions: number; position: number }> {
  // Aggregate by query across all pages
  const queryAgg = new Map<string, { impressions: number; clicks: number; position: number; count: number }>();
  for (const row of queryPageRows) {
    const existing = queryAgg.get(row.query);
    if (existing) {
      existing.impressions += row.impressions;
      existing.clicks += row.clicks;
      existing.position = (existing.position * existing.count + row.position) / (existing.count + 1);
      existing.count++;
    } else {
      queryAgg.set(row.query, { impressions: row.impressions, clicks: row.clicks, position: row.position, count: 1 });
    }
  }

  // Zero-click: 10+ impressions, 0 clicks
  const zeroClick: Array<{ query: string; impressions: number; position: number }> = [];
  for (const [query, agg] of queryAgg) {
    if (agg.impressions >= 10 && agg.clicks === 0) {
      zeroClick.push({ query, impressions: agg.impressions, position: Number(agg.position.toFixed(1)) });
    }
  }

  return zeroClick.sort((a, b) => b.impressions - a.impressions);
}

// ============================================================
// Disk artifact generation
// ============================================================

function generateGscSummary(pages: GscPageData[], zeroClickQueries: Array<{ query: string; impressions: number; position: number }>, propertyUrl: string, dateRange: { start: string; end: string }): string {
  const totalClicks = pages.reduce((s, p) => s + p.clicks, 0);
  const totalImpressions = pages.reduce((s, p) => s + p.impressions, 0);
  const avgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;

  let md = `# GSC Search Performance Summary\n\n`;
  md += `**Property**: ${propertyUrl}\n`;
  md += `**Date Range**: ${dateRange.start} to ${dateRange.end}\n`;
  md += `**Data Source**: Google Search Console (first-party, verified)\n\n`;

  md += `## Overview\n`;
  md += `| Metric | Value |\n|---|---|\n`;
  md += `| Total Clicks | ${totalClicks.toLocaleString()} |\n`;
  md += `| Total Impressions | ${totalImpressions.toLocaleString()} |\n`;
  md += `| Average CTR | ${(avgCtr * 100).toFixed(2)}% |\n`;
  md += `| Pages with Traffic | ${pages.filter((p) => p.clicks > 0).length} |\n`;
  md += `| Total Pages Indexed | ${pages.length} |\n\n`;

  md += `## Top Pages by Clicks\n`;
  md += `| Page | Clicks | Impressions | CTR | Avg Position |\n|---|---|---|---|---|\n`;
  for (const p of pages.slice(0, 20)) {
    md += `| ${p.page_url} | ${p.clicks} | ${p.impressions} | ${(p.ctr * 100).toFixed(2)}% | ${p.avg_position} |\n`;
  }
  md += '\n';

  if (zeroClickQueries.length > 0) {
    md += `## Zero-Click Queries (10+ impressions, 0 clicks)\n`;
    md += `These queries have visibility but no clicks — candidates for title/meta optimization.\n\n`;
    md += `| Query | Impressions | Avg Position |\n|---|---|---|\n`;
    for (const q of zeroClickQueries.slice(0, 20)) {
      md += `| ${q.query} | ${q.impressions} | ${q.position} |\n`;
    }
    md += '\n';
  }

  md += `## CTR Analysis Note\n`;
  md += `Compare observed CTR against modeled CTR assumption. Where observed CTR is significantly below modeled CTR at equivalent positions, the priority is title/meta optimization, not ranking improvement.\n`;

  return md;
}

// ============================================================
// Exported runner
// ============================================================

export async function runGscFetch(
  domain: string,
  auditId: string,
  outputDir: string,
  sb: SupabaseClient,
): Promise<boolean> {
  // Get analytics connection
  const connection = await getAnalyticsConnection(sb, auditId);
  if (!connection || !connection.gsc_property_url) {
    console.log('  No active GSC connection found — skipping GSC data fetch');
    return false;
  }

  const propertyUrl = connection.gsc_property_url;
  console.log(`  GSC property: ${propertyUrl}`);

  // Get access token
  const token = await getServiceAccountAccessToken([GSC_SCOPE]);

  // Date range: 28 days, ending 3 days ago (GSC data delay)
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 3);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 28);

  const dateRange = {
    start: startDate.toISOString().slice(0, 10),
    end: endDate.toISOString().slice(0, 10),
  };
  console.log(`  Date range: ${dateRange.start} to ${dateRange.end}`);

  // Fetch data
  const { pageRows, queryPageRows } = await fetchGscSearchAnalytics(
    propertyUrl,
    dateRange.start,
    dateRange.end,
    token,
  );

  if (pageRows.length === 0) {
    console.log('  GSC returned 0 page rows — no data to process');
    return false;
  }

  // Process
  const pages = processGscData(pageRows, queryPageRows);
  const zeroClickQueries = identifyZeroClickQueries(queryPageRows);

  console.log(`  Processed ${pages.length} pages, ${zeroClickQueries.length} zero-click queries`);

  // Write disk artifacts
  fs.mkdirSync(outputDir, { recursive: true });

  const gscDataPath = path.join(outputDir, 'gsc_data.json');
  fs.writeFileSync(gscDataPath, JSON.stringify({ pages, zeroClickQueries, dateRange, propertyUrl }, null, 2));
  console.log(`  Written: ${gscDataPath}`);

  const summaryPath = path.join(outputDir, 'gsc_summary.md');
  const summary = generateGscSummary(pages, zeroClickQueries, propertyUrl, dateRange);
  fs.writeFileSync(summaryPath, summary);
  console.log(`  Written: ${summaryPath}`);

  // Upsert into gsc_page_snapshots
  const snapshotDate = todayStr();
  const snapshotRecords = pages.map((p) => ({
    audit_id: auditId,
    snapshot_date: snapshotDate,
    page_url: p.page_url,
    clicks: p.clicks,
    impressions: p.impressions,
    ctr: p.ctr,
    avg_position: p.avg_position,
    top_queries: p.top_queries,
  }));

  let upsertedCount = 0;
  for (let i = 0; i < snapshotRecords.length; i += 500) {
    const batch = snapshotRecords.slice(i, i + 500);
    const { error } = await (sb as any)
      .from('gsc_page_snapshots')
      .upsert(batch, { onConflict: 'audit_id,snapshot_date,page_url' });
    if (error) {
      console.warn(`  gsc_page_snapshots upsert failed: ${error.message}`);
    } else {
      upsertedCount += batch.length;
    }
  }
  console.log(`  Upserted ${upsertedCount} GSC page snapshots`);

  // Update last_gsc_sync_at
  await (sb as any)
    .from('analytics_connections')
    .update({ last_gsc_sync_at: new Date().toISOString() })
    .eq('audit_id', auditId);

  return true;
}

// ============================================================
// CLI entry point
// ============================================================

async function main() {
  const cliArgs = parseArgs();
  const env = loadEnv();

  // Set env vars for google-auth.ts to pick up
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  }
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = env.GOOGLE_APPLICATION_CREDENTIALS;
  }

  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');

  const sb = createClient(supabaseUrl, supabaseKey);
  const date = todayStr();

  console.log(`\n=== GSC Data Fetch: ${cliArgs.domain} (${date}) ===\n`);

  // Resolve audit
  const { audit } = await resolveAudit(sb, cliArgs.domain, cliArgs.userEmail);
  console.log(`  Audit: ${audit.id} (status: ${(audit as any).status})`);

  const outputDir = path.join(AUDITS_BASE, cliArgs.domain, 'research', date);
  const success = await runGscFetch(cliArgs.domain, audit.id, outputDir, sb);

  if (success) {
    console.log(`\n  Done. GSC data fetch complete for ${cliArgs.domain}.\n`);
  } else {
    console.log(`\n  GSC data fetch skipped for ${cliArgs.domain} (no connection or no data).\n`);
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}\n`);
  process.exit(1);
});
