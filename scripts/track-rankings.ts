#!/usr/bin/env npx tsx
/**
 * track-rankings.ts — Performance tracking: snapshot keyword rankings from DataForSEO
 * and aggregate into cluster-level and page-level performance tables.
 *
 * Usage:
 *   npx tsx scripts/track-rankings.ts --domain <domain> --user-email <email>
 *   npx tsx scripts/track-rankings.ts --domain <domain> --user-email <email> --force
 *
 * Environment variables (from .env or process.env):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
    console.error('Usage: npx tsx scripts/track-rankings.ts --domain <domain> --user-email <email> [--force]');
    process.exit(1);
  }

  return {
    domain: flags.domain,
    userEmail: flags['user-email'],
    force: flags.force === 'true',
  };
}

// ============================================================
// .env loader (same pattern as sync-to-dashboard.ts)
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
// Cost logging (same pattern as pipeline-generate.ts)
// ============================================================

const AUDITS_BASE = path.resolve(process.cwd(), 'audits');

function logDataForSeoCost(endpoint: string, cost: number): void {
  const logPath = path.join(AUDITS_BASE, '.dataforseo_cost.log');
  const line = `${new Date().toISOString()} | ${endpoint} | $${cost.toFixed(4)}\n`;
  fs.appendFileSync(logPath, line);
}

// ============================================================
// Helpers
// ============================================================

function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function daysSince(dateStr: string): number {
  const then = new Date(dateStr);
  const now = new Date();
  return Math.floor((now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24));
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
// Fetch with retry (DATA-6)
// ============================================================

async function fetchWithRetry(url: string, init: RequestInit, label: string, maxAttempts = 3): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(url, init);
      // Retry on 5xx server errors
      if (resp.status >= 500 && attempt < maxAttempts) {
        const delay = 1000 * Math.pow(4, attempt - 1);
        console.warn(`  [retry] ${label} returned ${resp.status}. Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return resp;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts) {
        const delay = 1000 * Math.pow(4, attempt - 1);
        console.warn(`  [retry] ${label} network error: ${lastError.message}. Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
  }
  throw lastError ?? new Error(`${label} failed after ${maxAttempts} attempts`);
}

// ============================================================
// DataForSEO: Fetch current rankings
// ============================================================

interface RankedKeyword {
  keyword: string;
  position: number;
  volume: number;
  url: string;
  intent: string | null;
}

async function fetchRankedKeywords(domain: string, env: Record<string, string>): Promise<{ keywords: RankedKeyword[]; totalCount: number }> {
  const dfLogin = env.DATAFORSEO_LOGIN;
  const dfPassword = env.DATAFORSEO_PASSWORD;
  if (!dfLogin || !dfPassword) throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set');

  const authString = Buffer.from(`${dfLogin}:${dfPassword}`).toString('base64');
  const payload = [{
    target: domain,
    location_code: 2840,
    language_code: 'en',
    limit: 1000,
  }];

  console.log('  Fetching ranked keywords from DataForSEO...');
  const resp = await fetchWithRetry(
    'https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live',
    {
      method: 'POST',
      headers: { Authorization: `Basic ${authString}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    'DataForSEO ranked_keywords',
  );

  if (!resp.ok) throw new Error(`DataForSEO HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  logDataForSeoCost('ranked_keywords/live (performance)', 0.05);

  const keywords: RankedKeyword[] = [];
  let totalCount = 0;

  for (const task of data?.tasks ?? []) {
    for (const result of task?.result ?? []) {
      totalCount = result?.total_count ?? 0;
      for (const item of result?.items ?? []) {
        const kd = item.keyword_data;
        const se = item.ranked_serp_element;
        if (kd?.keyword) {
          keywords.push({
            keyword: kd.keyword,
            position: se?.serp_item?.rank_group ?? 100,
            volume: kd.keyword_info?.search_volume ?? 0,
            url: se?.serp_item?.url ?? '',
            intent: kd.search_intent_info?.main_intent ?? null,
          });
        }
      }
    }
  }

  console.log(`  ${keywords.length} ranked keywords found (total: ${totalCount})`);
  return { keywords, totalCount };
}

// ============================================================
// Main tracking logic
// ============================================================

async function trackRankings(cliArgs: CliArgs) {
  const env = loadEnv();
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');

  const sb = createClient(supabaseUrl, supabaseKey);
  const snapshotDate = todayStr();

  console.log(`\n=== Performance Tracker: ${cliArgs.domain} (${snapshotDate}) ===\n`);

  // 1. Resolve audit
  const { audit } = await resolveAudit(sb, cliArgs.domain, cliArgs.userEmail);
  console.log(`  Audit: ${audit.id} (status: ${audit.status})`);

  if (audit.status !== 'completed') {
    console.log(`  Skipping — audit status is '${audit.status}', not 'completed'`);
    return;
  }

  // 2. Recency check
  const { data: latestSnapshot } = await sb
    .from('ranking_snapshots')
    .select('snapshot_date')
    .eq('audit_id', audit.id)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestSnapshot && !cliArgs.force) {
    const days = daysSince(latestSnapshot.snapshot_date);
    if (days < 25) {
      console.log(`  Skipping — snapshot taken ${days} days ago (< 25 day threshold). Use --force to override.`);
      return;
    }
  }

  // 3. Load trackable keywords from audit_keywords
  const { data: auditKeywords, error: kwErr } = await sb
    .from('audit_keywords')
    .select('keyword, canonical_key, cluster, is_brand, intent_type, search_volume, rank_pos')
    .eq('audit_id', audit.id);

  if (kwErr) throw new Error(`Failed to load audit_keywords: ${kwErr.message}`);
  console.log(`  Loaded ${auditKeywords?.length ?? 0} audit keywords`);

  // Build keyword → metadata map (case-insensitive)
  const keywordMeta = new Map<string, {
    canonical_key: string | null;
    cluster: string | null;
    is_brand: boolean;
    intent_type: string | null;
    search_volume: number;
  }>();

  for (const kw of auditKeywords ?? []) {
    keywordMeta.set(kw.keyword.toLowerCase(), {
      canonical_key: kw.canonical_key,
      cluster: kw.cluster,
      is_brand: kw.is_brand ?? false,
      intent_type: kw.intent_type,
      search_volume: kw.search_volume ?? 0,
    });
  }

  // 4. Fetch current rankings from DataForSEO
  const { keywords: currentRankings, totalCount } = await fetchRankedKeywords(cliArgs.domain, env);

  // Build case-insensitive lookup of DataForSEO results
  const rankingMap = new Map<string, RankedKeyword>();
  for (const rk of currentRankings) {
    rankingMap.set(rk.keyword.toLowerCase(), rk);
  }

  // 5. Build ranking_snapshots records
  const snapshotRecords: any[] = [];
  const processedKeywords = new Set<string>();

  // First: keywords that appear in BOTH audit_keywords AND DataForSEO results
  for (const [kwLower, meta] of keywordMeta.entries()) {
    const ranking = rankingMap.get(kwLower);
    snapshotRecords.push({
      audit_id: audit.id,
      snapshot_date: snapshotDate,
      keyword: kwLower,
      rank_position: ranking?.position ?? null,
      ranking_url: ranking?.url ?? null,
      search_volume: ranking?.volume ?? meta.search_volume,
      canonical_key: meta.canonical_key,
      cluster: meta.cluster,
      is_brand: meta.is_brand,
      intent_type: meta.intent_type,
    });
    processedKeywords.add(kwLower);
  }

  // Second: keywords in DataForSEO results NOT in audit_keywords (new rankings)
  for (const [kwLower, ranking] of rankingMap.entries()) {
    if (!processedKeywords.has(kwLower)) {
      snapshotRecords.push({
        audit_id: audit.id,
        snapshot_date: snapshotDate,
        keyword: kwLower,
        rank_position: ranking.position,
        ranking_url: ranking.url,
        search_volume: ranking.volume,
        canonical_key: null,
        cluster: null,
        is_brand: false,
        intent_type: ranking.intent,
      });
    }
  }

  console.log(`  Built ${snapshotRecords.length} snapshot records (${rankingMap.size} from DataForSEO, ${keywordMeta.size} tracked)`);

  // 6. Upsert ranking_snapshots in batches
  let upsertedCount = 0;
  for (let i = 0; i < snapshotRecords.length; i += 500) {
    const batch = snapshotRecords.slice(i, i + 500);
    const { error } = await sb
      .from('ranking_snapshots')
      .upsert(batch, { onConflict: 'audit_id,snapshot_date,keyword' });
    if (error) throw new Error(`ranking_snapshots upsert failed: ${error.message}`);
    upsertedCount += batch.length;
  }
  console.log(`  Upserted ${upsertedCount} ranking snapshots`);

  // 7. Aggregate cluster_performance_snapshots
  await aggregateClusterPerformance(sb, audit.id, snapshotDate);

  // 8. Track published page performance
  await trackPublishedPages(sb, audit.id, snapshotDate);

  // 9. GA4 behavioral data (non-fatal)
  let ga4PageCount = 0;
  try {
    // Get published slugs
    const { data: publishedPages } = await sb
      .from('execution_pages')
      .select('url_slug')
      .eq('audit_id', audit.id)
      .not('published_at', 'is', null);

    const publishedSlugs = (publishedPages ?? []).map((p: any) => p.url_slug).filter(Boolean);

    if (publishedSlugs.length > 0) {
      // Set env vars for google-auth.ts (loadEnv already ran)
      if (env.GOOGLE_ADC_JSON) {
        process.env.GOOGLE_ADC_JSON = env.GOOGLE_ADC_JSON;
      }
      if (env.GOOGLE_APPLICATION_CREDENTIALS) {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = env.GOOGLE_APPLICATION_CREDENTIALS;
      }

      // Dynamic import to avoid loading when no GA4 connection
      const { runGa4Fetch } = await import('./fetch-ga4-data.js');
      const ga4Data = await runGa4Fetch(audit.id, publishedSlugs, sb);

      if (ga4Data.length > 0) {
        // Upsert ga4_page_snapshots
        const ga4Records = ga4Data.map((p) => ({
          audit_id: audit.id,
          snapshot_date: snapshotDate,
          page_url: p.page_url,
          total_sessions: p.total_sessions,
          total_conversions: p.total_conversions,
          total_revenue: p.total_revenue,
          organic_sessions: p.organic_sessions,
          organic_engaged_sessions: p.organic_engaged_sessions,
          organic_engagement_rate: p.organic_engagement_rate,
          organic_conversions: p.organic_conversions,
          organic_avg_session_dur: p.organic_avg_session_dur,
          organic_cr: p.organic_cr,
        }));

        for (let i = 0; i < ga4Records.length; i += 500) {
          const batch = ga4Records.slice(i, i + 500);
          const { error: ga4Err } = await (sb as any)
            .from('ga4_page_snapshots')
            .upsert(batch, { onConflict: 'audit_id,snapshot_date,page_url' });
          if (ga4Err) {
            console.warn(`  [ga4] ga4_page_snapshots upsert failed: ${ga4Err.message}`);
          }
        }
        console.log(`  [ga4] Upserted ${ga4Records.length} GA4 page snapshots`);
        ga4PageCount = ga4Records.length;

        // Update page_performance with GA4 behavioral columns
        for (const p of ga4Data) {
          const slug = p.page_url.replace(/^\/+/, '');
          if (!slug) continue;
          await (sb as any)
            .from('page_performance')
            .update({
              organic_sessions: p.organic_sessions,
              organic_engagement_rate: p.organic_engagement_rate,
              organic_cr: p.organic_cr,
              organic_conversions: p.organic_conversions,
              ga4_snapshot_date: snapshotDate,
            })
            .eq('audit_id', audit.id)
            .eq('url_slug', slug)
            .eq('snapshot_date', snapshotDate);
        }

        // Compute observed CR from pages with 30+ organic sessions
        const qualifiedPages = ga4Data.filter((p) => p.organic_sessions >= 30);
        if (qualifiedPages.length >= 3) {
          const totalSessions = qualifiedPages.reduce((s, p) => s + p.organic_sessions, 0);
          const totalConversions = qualifiedPages.reduce((s, p) => s + p.organic_conversions, 0);
          const observedCr = totalSessions > 0 ? totalConversions / totalSessions : 0;

          await (sb as any)
            .from('audit_assumptions')
            .update({
              observed_cr: Number(observedCr.toFixed(6)),
              observed_cr_source: 'ga4',
              observed_cr_updated_at: new Date().toISOString(),
              // Never set use_observed_cr = true — operator must enable manually
            })
            .eq('audit_id', audit.id);

          console.log(`  [ga4] Observed CR: ${(observedCr * 100).toFixed(4)}% (from ${qualifiedPages.length} pages, ${totalSessions} sessions)`);
        } else {
          console.log(`  [ga4] Insufficient data for observed CR (${qualifiedPages.length} pages with 30+ sessions, need 3+)`);
        }
      }
    }
  } catch (ga4Err: any) {
    console.warn(`  [ga4] GA4 fetch failed (non-fatal): ${ga4Err.message}`);
  }

  // 10. Log agent_runs
  await sb.from('agent_runs').insert({
    audit_id: audit.id,
    agent_name: 'performance_tracker',
    run_date: snapshotDate,
    status: 'completed',
    metadata: {
      keyword_count: snapshotRecords.length,
      dataforseo_total: totalCount,
      ranked_count: currentRankings.length,
      ga4_page_count: ga4PageCount,
      snapshot_date: snapshotDate,
    },
  });

  console.log(`\n  Done. Snapshot ${snapshotDate} for ${cliArgs.domain} complete.\n`);
}

// ============================================================
// Authority score helpers
// ============================================================

function positionWeight(position: number | null): number {
  if (!position) return 0.0;
  if (position <= 3) return 1.0;
  if (position <= 10) return 0.6;
  if (position <= 20) return 0.3;
  if (position <= 30) return 0.1;
  return 0.05;
}

function computeAuthorityScore(keywords: Array<{ rank_position: number | null }>): number {
  if (keywords.length === 0) return 0;
  const maxWeight = keywords.length * 1.0;
  const actualWeight = keywords.reduce(
    (sum, kw) => sum + positionWeight(kw.rank_position),
    0,
  );
  return Math.round((actualWeight / maxWeight) * 100 * 10) / 10;
}

// ============================================================
// Cluster aggregation
// ============================================================

async function aggregateClusterPerformance(sb: SupabaseClient, auditId: string, snapshotDate: string) {
  // Load this date's ranking snapshots
  const { data: snapshots, error } = await sb
    .from('ranking_snapshots')
    .select('keyword, rank_position, search_volume, canonical_key')
    .eq('audit_id', auditId)
    .eq('snapshot_date', snapshotDate);

  if (error) throw new Error(`Failed to load snapshots for aggregation: ${error.message}`);
  if (!snapshots || snapshots.length === 0) return;

  // Load canonical_topic mapping from audit_keywords
  const { data: kwTopics } = await sb
    .from('audit_keywords')
    .select('canonical_key, canonical_topic')
    .eq('audit_id', auditId)
    .not('canonical_key', 'is', null);

  const topicMap = new Map<string, string>();
  for (const kw of kwTopics ?? []) {
    if (kw.canonical_key && kw.canonical_topic) {
      topicMap.set(kw.canonical_key, kw.canonical_topic);
    }
  }

  // Group by canonical_key
  const clusters = new Map<string, {
    keywords: Array<{ rank_position: number | null; search_volume: number }>;
  }>();

  for (const snap of snapshots) {
    const key = snap.canonical_key || 'uncategorized';
    if (!clusters.has(key)) clusters.set(key, { keywords: [] });
    clusters.get(key)!.keywords.push({
      rank_position: snap.rank_position,
      search_volume: snap.search_volume ?? 0,
    });
  }

  // Load previous authority scores for delta computation
  const { data: prevScores } = await sb
    .from('cluster_performance_snapshots')
    .select('canonical_key, authority_score, snapshot_date')
    .eq('audit_id', auditId)
    .lt('snapshot_date', snapshotDate)
    .order('snapshot_date', { ascending: false });

  const prevScoreMap = new Map<string, number>();
  for (const row of prevScores ?? []) {
    // Take only the most recent previous score per cluster
    if (row.canonical_key && row.authority_score !== null && !prevScoreMap.has(row.canonical_key)) {
      prevScoreMap.set(row.canonical_key, Number(row.authority_score));
    }
  }

  // Build aggregation records
  const records: any[] = [];
  for (const [canonicalKey, data] of clusters.entries()) {
    if (canonicalKey === 'uncategorized') continue; // skip uncategorized

    const ranked = data.keywords.filter((k) => k.rank_position !== null);
    const positions = ranked.map((k) => k.rank_position!);

    const authorityScore = computeAuthorityScore(data.keywords);
    const prevScore = prevScoreMap.get(canonicalKey);
    const authorityScoreDelta = prevScore !== undefined
      ? Math.round((authorityScore - prevScore) * 10) / 10
      : null;

    records.push({
      audit_id: auditId,
      snapshot_date: snapshotDate,
      canonical_key: canonicalKey,
      canonical_topic: topicMap.get(canonicalKey) ?? null,
      keyword_count: data.keywords.length,
      avg_position: positions.length > 0
        ? Number((positions.reduce((a, b) => a + b, 0) / positions.length).toFixed(2))
        : null,
      keywords_p1_3: positions.filter((p) => p >= 1 && p <= 3).length,
      keywords_p4_10: positions.filter((p) => p >= 4 && p <= 10).length,
      keywords_p11_30: positions.filter((p) => p >= 11 && p <= 30).length,
      keywords_p31_100: positions.filter((p) => p >= 31).length,
      total_volume: data.keywords.reduce((s, k) => s + k.search_volume, 0),
      authority_score: authorityScore,
      authority_score_delta: authorityScoreDelta,
    });
  }

  if (records.length > 0) {
    for (let i = 0; i < records.length; i += 500) {
      const batch = records.slice(i, i + 500);
      const { error: upsertErr } = await sb
        .from('cluster_performance_snapshots')
        .upsert(batch, { onConflict: 'audit_id,snapshot_date,canonical_key' });
      if (upsertErr) throw new Error(`cluster_performance_snapshots upsert failed: ${upsertErr.message}`);
    }
  }

  console.log(`  Aggregated ${records.length} cluster performance records`);

  // Update audit_clusters with latest authority scores
  for (const rec of records) {
    if (rec.authority_score !== null) {
      await sb.from('audit_clusters')
        .update({
          authority_score: rec.authority_score,
          authority_score_updated_at: new Date().toISOString(),
        })
        .eq('audit_id', auditId)
        .eq('canonical_key', rec.canonical_key);
    }
  }

  if (records.length > 0) {
    console.log(`  Updated authority scores for ${records.length} clusters`);
  }
}

// ============================================================
// Published page performance tracking
// ============================================================

async function trackPublishedPages(sb: SupabaseClient, auditId: string, snapshotDate: string) {
  // Get published pages
  const { data: pages, error: pageErr } = await sb
    .from('execution_pages')
    .select('id, url_slug, silo, published_at')
    .eq('audit_id', auditId)
    .not('published_at', 'is', null);

  if (pageErr) throw new Error(`Failed to load published pages: ${pageErr.message}`);
  if (!pages || pages.length === 0) {
    console.log('  No published pages to track');
    return;
  }

  // Load today's ranking snapshots with ranking_url
  const { data: snapshots } = await sb
    .from('ranking_snapshots')
    .select('keyword, rank_position, search_volume, ranking_url')
    .eq('audit_id', auditId)
    .eq('snapshot_date', snapshotDate)
    .not('ranking_url', 'is', null);

  const records: any[] = [];

  for (const page of pages) {
    const slug = page.url_slug.replace(/^\/+/, '');
    if (!slug) continue;

    // Match ranking URLs containing this slug
    const matchedKeywords = (snapshots ?? []).filter((s) => {
      if (!s.ranking_url) return false;
      try {
        const urlPath = new URL(s.ranking_url).pathname.replace(/^\/+|\/+$/g, '');
        return urlPath === slug || urlPath.endsWith(slug);
      } catch {
        return s.ranking_url.includes(slug);
      }
    });

    const ranked = matchedKeywords.filter((k) => k.rank_position !== null);
    const positions = ranked.map((k) => k.rank_position!);

    records.push({
      audit_id: auditId,
      execution_page_id: page.id,
      url_slug: slug,
      silo: page.silo,
      snapshot_date: snapshotDate,
      published_at: page.published_at,
      current_avg_position: positions.length > 0
        ? Number((positions.reduce((a, b) => a + b, 0) / positions.length).toFixed(2))
        : null,
      keywords_gained_p1_10: positions.filter((p) => p <= 10).length,
      keywords_total: matchedKeywords.length,
    });
  }

  if (records.length > 0) {
    const { error: upsertErr } = await sb
      .from('page_performance')
      .upsert(records, { onConflict: 'audit_id,url_slug,snapshot_date' });
    if (upsertErr) throw new Error(`page_performance upsert failed: ${upsertErr.message}`);
  }

  console.log(`  Tracked ${records.length} published pages`);
}

// ============================================================
// Entry point
// ============================================================

const args = parseArgs();
trackRankings(args).catch((err) => {
  console.error(`\nFATAL: ${err.message}\n`);
  process.exit(1);
});
