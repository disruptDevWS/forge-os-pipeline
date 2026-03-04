#!/usr/bin/env npx tsx
/**
 * sync-to-dashboard.ts — Sync NanoClaw agent outputs to the Market Position Dashboard (Supabase).
 *
 * Usage:
 *   npx tsx scripts/sync-to-dashboard.ts --domain veteransplumbingcorp.com --user-email you@example.com
 *   npx tsx scripts/sync-to-dashboard.ts --domain veteransplumbingcorp.com --user-email you@example.com --skip-keywords
 *   npx tsx scripts/sync-to-dashboard.ts --domain veteransplumbingcorp.com --user-email you@example.com --agents jim,dwight
 *
 * Environment variables (from .env):
 *   SUPABASE_URL            — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Service role key (bypasses RLS)
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { parse as csvParse } from 'csv-parse/sync';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// CLI argument parsing
// ============================================================

interface CliArgs {
  domain: string;
  userEmail: string;
  skipKeywords: boolean;
  agents: string[]; // empty = all available
  date?: string; // YYYY-MM-DD override, else latest
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
    console.error('Usage: npx tsx scripts/sync-to-dashboard.ts --domain <domain> --user-email <email> [--skip-keywords] [--agents jim,dwight,michael,pam] [--date YYYY-MM-DD]');
    process.exit(1);
  }

  return {
    domain: flags.domain,
    userEmail: flags['user-email'],
    skipKeywords: flags['skip-keywords'] === 'true',
    agents: flags.agents ? flags.agents.split(',').map((a) => a.trim()) : [],
    date: flags.date,
  };
}

// ============================================================
// .env loader (reuse nanoclaw pattern — never touch process.env)
// ============================================================

function loadEnv(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return {};
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

// ============================================================
// Directory helpers
// ============================================================

const AUDITS_BASE = path.resolve(process.cwd(), 'audits');

function getLatestDateDir(agentDir: string): string | null {
  if (!fs.existsSync(agentDir)) return null;
  const entries = fs.readdirSync(agentDir).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort();
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

function agentDir(domain: string, agentRole: string, date?: string): string | null {
  const base = path.join(AUDITS_BASE, domain, agentRole);
  const dateStr = date ?? getLatestDateDir(base);
  if (!dateStr) return null;
  const full = path.join(base, dateStr);
  return fs.existsSync(full) ? full : null;
}

// ============================================================
// Snapshot versioning helpers
// ============================================================

async function getNextSnapshotVersion(sb: SupabaseClient, auditId: string, agentName: string): Promise<number> {
  const { data } = await sb
    .from('audit_snapshots')
    .select('snapshot_version')
    .eq('audit_id', auditId)
    .eq('agent_name', agentName)
    .order('snapshot_version', { ascending: false })
    .limit(1)
    .maybeSingle();
  return ((data as any)?.snapshot_version ?? 0) + 1;
}

async function recordSnapshot(
  sb: SupabaseClient,
  auditId: string,
  agentName: string,
  snapshotVersion: number,
  agentRunId: string | null,
  rowCount: number
): Promise<void> {
  await sb.from('audit_snapshots').insert({
    audit_id: auditId,
    agent_name: agentName,
    snapshot_version: snapshotVersion,
    agent_run_id: agentRunId,
    row_count: rowCount,
  });
}

async function updateStalenessTimestamp(sb: SupabaseClient, auditId: string, agentName: string): Promise<void> {
  const columnMap: Record<string, string> = {
    jim: 'research_snapshot_at',
    dwight: 'audit_snapshot_at',
    michael: 'strategy_snapshot_at',
    pam: 'execution_snapshot_at',
  };
  const col = columnMap[agentName];
  if (!col) return;
  await sb.from('audits').update({ [col]: new Date().toISOString() }).eq('id', auditId);
}

// ============================================================
// CTR + Revenue formula (ported from run-audit/index.ts)
// ============================================================

interface CtrBuckets {
  [key: string]: number;
}

function getBucketKey(position: number): string {
  if (position === 1) return '1';
  if (position === 2) return '2';
  if (position === 3) return '3';
  if (position >= 4 && position <= 5) return '4-5';
  if (position >= 6 && position <= 10) return '6-10';
  if (position >= 11 && position <= 20) return '11-20';
  if (position >= 21 && position <= 30) return '21-30';
  return '>30';
}

function getCtrForPosition(position: number, buckets: CtrBuckets, floorCtr: number): number {
  const key = getBucketKey(position);
  return buckets[key] ?? floorCtr;
}

function calculateKeywordOpportunity(
  keyword: { rank_pos: number; search_volume: number },
  targetCtr: number,
  ctrBuckets: CtrBuckets,
  floorCtr: number,
  crMin: number,
  crMax: number,
  acvMin: number,
  acvMax: number,
  crMid?: number,
  acvMid?: number
) {
  const currentCtr = getCtrForPosition(keyword.rank_pos, ctrBuckets, floorCtr);
  const currentTraffic = keyword.search_volume * currentCtr;
  const targetTraffic = keyword.search_volume * targetCtr;
  const deltaTraffic = Math.max(0, targetTraffic - currentTraffic);

  const effectiveCrMid = crMid ?? (crMin + crMax) / 2;
  const effectiveAcvMid = acvMid ?? (acvMin + acvMax) / 2;

  return {
    current_ctr: currentCtr,
    current_traffic: currentTraffic,
    target_ctr: targetCtr,
    target_traffic: targetTraffic,
    delta_traffic: deltaTraffic,
    delta_leads_low: deltaTraffic * crMin,
    delta_leads_high: deltaTraffic * crMax,
    delta_revenue_low: deltaTraffic * crMin * acvMin,
    delta_revenue_mid: deltaTraffic * effectiveCrMid * effectiveAcvMid,
    delta_revenue_high: deltaTraffic * crMax * acvMax,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ============================================================
// Jim research_summary.md parser
// ============================================================

interface ParsedResearchSummary {
  keywordOverview: {
    total_keywords: number;
    total_volume: number;
    avg_position: number;
    etv: number;
    paid_traffic_equivalent: number;
    top_10_count: number;
    near_miss_count: number;
    api_cost: number;
  };
  positionDistribution: Array<{ range: string; count: number; pct: number }>;
  brandedSplit: {
    branded: { count: number; volume: number; avg_position: number };
    non_branded: { count: number; volume: number; avg_position: number };
  };
  intentBreakdown: Array<{ intent: string; count: number; volume: number; pct_volume: number }>;
  topRankingUrls: Array<{ url: string; keywords: number; volume: number }>;
  competitorAnalysis: Array<{
    rank: number;
    domain: string;
    overlap_pct: number;
    shared_keywords: number;
    total_keywords: number;
    avg_position: number;
    etv: number;
  }>;
  competitorSummary: {
    veterans_keywords: number;
    veterans_avg_position: number;
    veterans_etv: number;
    competitor_avg_keywords: number;
    competitor_avg_position: number;
    competitor_avg_etv: number;
  };
  strikingDistance: Array<{
    keyword: string;
    volume: number;
    position: number;
    cpc: number | null;
    intent: string;
  }>;
  contentGapObservations: string[];
  keyTakeaways: Array<{ section: string; takeaway: string }>;
}

function parseResearchSummary(filePath: string): ParsedResearchSummary {
  const md = fs.readFileSync(filePath, 'utf-8');

  const result: ParsedResearchSummary = {
    keywordOverview: {
      total_keywords: 0, total_volume: 0, avg_position: 0,
      etv: 0, paid_traffic_equivalent: 0, top_10_count: 0,
      near_miss_count: 0, api_cost: 0,
    },
    positionDistribution: [],
    brandedSplit: {
      branded: { count: 0, volume: 0, avg_position: 0 },
      non_branded: { count: 0, volume: 0, avg_position: 0 },
    },
    intentBreakdown: [],
    topRankingUrls: [],
    competitorAnalysis: [],
    competitorSummary: {
      veterans_keywords: 0, veterans_avg_position: 0, veterans_etv: 0,
      competitor_avg_keywords: 0, competitor_avg_position: 0, competitor_avg_etv: 0,
    },
    strikingDistance: [],
    contentGapObservations: [],
    keyTakeaways: [],
  };

  // Helper: extract a section's table block by flexible heading match
  const sectionTable = (pattern: RegExp): string | null => {
    const m = md.match(pattern);
    if (!m) return null;
    const tableMatch = m[0].match(/\n(\|.+\|[\s\S]*?)(?=\n\*|\n##\s|$)/);
    return tableMatch ? tableMatch[1] : null;
  };

  // Helper: parse a number, stripping $, ~, commas, /mo suffix, and K/M/B suffixes
  const num = (s: string): number => {
    const clean = s.replace(/[$,~]/g, '').replace(/\/mo$/i, '').trim();
    if (clean.endsWith('B')) return parseFloat(clean) * 1_000_000_000;
    if (clean.endsWith('M')) return parseFloat(clean) * 1_000_000;
    if (clean.endsWith('K')) return parseFloat(clean) * 1_000;
    return parseFloat(clean) || 0;
  };

  // --- 2. Keyword Overview (| Metric | Value | format) ---
  const overviewBlock = sectionTable(/##\s*\d*\.?\s*Keyword\s+Overview[\s\S]*?(?=\n##\s|$)/i);
  if (overviewBlock) {
    const extract = (label: RegExp): number => {
      const m = overviewBlock.match(new RegExp(`\\|\\s*${label.source}\\s*\\|\\s*([^|]+)\\|`, 'i'));
      return m ? num(m[1]) : 0;
    };
    result.keywordOverview.total_keywords = extract(/Total (?:ranked )?keywords(?: tracked)?/);
    result.keywordOverview.total_volume = extract(/Total (?:monthly )?search volume/);
    result.keywordOverview.avg_position = extract(/Average position/);
    result.keywordOverview.etv = extract(/Estimated traffic value/);
    result.keywordOverview.paid_traffic_equivalent = extract(/Estimated paid traffic/);
    result.keywordOverview.top_10_count = extract(/Keywords in top 10/);
    result.keywordOverview.near_miss_count = extract(/(?:Near.miss|Striking.distance) keywords/);
  }

  const costMatch = md.match(/\*\*API Cost:\*\*\s*\$([\d.]+)/i);
  if (costMatch) result.keywordOverview.api_cost = parseFloat(costMatch[1]);

  // --- 3. Position Distribution ---
  const posBlock = sectionTable(/##\s*\d*\.?\s*Position\s+Distribution[\s\S]*?(?=\n##\s|$)/i);
  if (posBlock) {
    for (const row of posBlock.matchAll(/\|\s*([\d\-+]+)\s*\|\s*(\d+)\s*\|\s*([\d.]+)%?\s*\|/g)) {
      result.positionDistribution.push({
        range: row[1].trim(), count: parseInt(row[2], 10), pct: parseFloat(row[3]),
      });
    }
  }

  // --- 4. Branded vs Non-Branded ---
  const brandBlock = sectionTable(/##\s*\d*\.?\s*Branded\s+vs\.?\s+Non.?Branded[\s\S]*?(?=\n##\s|$)/i);
  if (brandBlock) {
    const bMatch = brandBlock.match(/\|\s*Branded[^|]*\|\s*~?(\d+)\s*\|\s*~?([\d,]+)\s*(?:\/mo)?\s*\|\s*~?([\d.]+)\s*\|/i);
    if (bMatch) {
      result.brandedSplit.branded = {
        count: parseInt(bMatch[1], 10), volume: num(bMatch[2]), avg_position: parseFloat(bMatch[3]),
      };
    }
    const nbMatch = brandBlock.match(/\|\s*Non.?branded\s*\|\s*~?(\d+)\s*\|\s*~?([\d,]+)\s*(?:\/mo)?\s*\|\s*~?([\d.]+)\s*\|/i);
    if (nbMatch) {
      result.brandedSplit.non_branded = {
        count: parseInt(nbMatch[1], 10), volume: num(nbMatch[2]), avg_position: parseFloat(nbMatch[3]),
      };
    }
  }

  // --- 5. Intent Breakdown ---
  const intentBlock = sectionTable(/##\s*\d*\.?\s*(?:Search\s+)?Intent\s+Breakdown[\s\S]*?(?=\n##\s|$)/i);
  if (intentBlock) {
    for (const row of intentBlock.matchAll(/\|\s*(Navigational|Commercial|Transactional|Informational)[^|]*\|\s*(\d+)\s*\|\s*~?([\d,]+)\s*\|\s*([\d.]+)%?\s*\|/gi)) {
      result.intentBreakdown.push({
        intent: row[1].trim(), count: parseInt(row[2], 10),
        volume: num(row[3]), pct_volume: parseFloat(row[4]),
      });
    }
    // If no pct column matched, compute from total volume
    if (result.intentBreakdown.length === 0) {
      for (const row of intentBlock.matchAll(/\|\s*(Navigational|Commercial|Transactional|Informational)[^|]*\|\s*(\d+)\s*\|\s*~?([\d,]+)\s*\|/gi)) {
        const vol = num(row[3]);
        result.intentBreakdown.push({
          intent: row[1].trim(), count: parseInt(row[2], 10), volume: vol,
          pct_volume: result.keywordOverview.total_volume > 0 ? Math.round(vol / result.keywordOverview.total_volume * 1000) / 10 : 0,
        });
      }
    }
  }

  // --- 6. Top Ranking URLs ---
  const urlBlock = sectionTable(/##\s*\d*\.?\s*Top\s+Ranking\s+URLs[\s\S]*?(?=\n##\s|$)/i);
  if (urlBlock) {
    for (const row of urlBlock.matchAll(/\|\s*(.+?)\s*\|\s*~?(\d+)\s*\|\s*~?([\d,]+)\s*\|/g)) {
      const url = row[1].trim();
      if (url.startsWith('URL') || url.includes('---') || url.startsWith('|')) continue;
      result.topRankingUrls.push({ url, keywords: parseInt(row[2], 10), volume: num(row[3]) });
    }
  }

  // --- 7. Competitor Analysis ---
  // Standard format: | # | Domain | Overlap % | Shared Keywords | Total Keywords | Avg Position | ETV |
  const compSection = md.match(/##\s*\d*\.?\s*Competitor[\s\S]*?###\s*(?:Top\s+\d+|Direct\s+Local)[^\n]*\n+(\|.+\|[\s\S]*?)(?=\n\n\*|\n\n###|\n\n##|\n###|\n##\s|$)/i);
  if (compSection) {
    const block = compSection[1];
    for (const row of block.matchAll(/\|\s*(\d+)\s*\|\s*(\S+)\s*\|\s*([\d.]+)%?\s*\|\s*([\d,]+)\s*\|\s*([\d,]+[MBK]?)\s*\|\s*([\d.]+)\s*\|\s*\$?([\d,]+[MBK]?)\s*\|/g)) {
      result.competitorAnalysis.push({
        rank: parseInt(row[1], 10), domain: row[2].trim(),
        overlap_pct: parseFloat(row[3]), shared_keywords: num(row[4]),
        total_keywords: Math.round(num(row[5])), avg_position: parseFloat(row[6]),
        etv: Math.round(num(row[7])),
      });
    }
  }

  // Client vs Competitor summary — generic (not hardcoded to any domain)
  const vsTable = md.match(/###\s*Client\s+vs[\s\S]*?\n(\|.+\|[\s\S]*?)(?=\n###|\n##\s|$)/i);
  if (vsTable) {
    // First data row is the client, extract competitor averages from remaining rows
    const dataRows = vsTable[1].matchAll(/\|\s*[^|]+\|\s*([\d,]+)\s*\|\s*([\d.]+)\s*\|\s*\$?([\d,]+)\s*\|/g);
    const compStats: { kw: number; pos: number; etv: number }[] = [];
    let isFirst = true;
    for (const row of dataRows) {
      if (row[0].includes('---') || row[0].includes('Metric')) continue;
      if (isFirst) { isFirst = false; continue; } // skip client row
      compStats.push({ kw: num(row[1]), pos: parseFloat(row[2]), etv: num(row[3]) });
    }
    if (compStats.length > 0) {
      result.competitorSummary.competitor_avg_keywords = Math.round(compStats.reduce((s, c) => s + c.kw, 0) / compStats.length);
      result.competitorSummary.competitor_avg_position = Math.round(compStats.reduce((s, c) => s + c.pos, 0) / compStats.length * 10) / 10;
      result.competitorSummary.competitor_avg_etv = Math.round(compStats.reduce((s, c) => s + c.etv, 0) / compStats.length);
    }
  }

  // --- 8. Striking Distance ---
  const sdBlock = sectionTable(/##\s*\d*\.?\s*Striking\s+Distance[\s\S]*?(?=\n##\s|$)/i);
  if (sdBlock) {
    for (const row of sdBlock.matchAll(/\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(\d+)\s*\|\s*([\d,]+)\s*\|\s*\$?([\d.]+|N\/A)\s*\|\s*(\w+)\s*\|/g)) {
      result.strikingDistance.push({
        keyword: row[2].trim(), position: parseInt(row[3], 10),
        volume: num(row[4]), cpc: row[5] === 'N/A' ? null : parseFloat(row[5]),
        intent: row[6].trim(),
      });
    }
  }

  // --- 9. Content Gap Observations ---
  const gapSection = md.match(/##\s*\d*\.?\s*Content\s+Gap\s+Observations[\s\S]*?(?=\n##\s|$)/i);
  if (gapSection) {
    for (const obs of gapSection[0].matchAll(/\d+\.\s*\*\*(.+?)\*\*\s*[—\-–]\s*(.+?)(?=\n\d+\.\s*\*\*|$)/gs)) {
      const title = obs[1].replace(/[:.]$/, '').trim();
      const body = obs[2].trim().split('\n')[0].trim();
      result.contentGapObservations.push(`${title}: ${body}`);
    }
  }

  // --- 10. Key Takeaways ---
  const takeawaySection = md.match(/##\s*\d*\.?\s*Key\s+Takeaways[\s\S]*?(?=\n##\s|$)/i);
  if (takeawaySection) {
    for (const t of takeawaySection[0].matchAll(/\*\*\[([^\]]+)\]\*\*\s*\n(.+?)(?=\n\*\*\[|$)/gs)) {
      result.keyTakeaways.push({
        section: t[1].trim().substring(0, 50),
        takeaway: t[2].trim().split('\n')[0].trim(),
      });
    }
  }

  return result;
}

// ============================================================
// Jim sync — ranked_keywords.json → audit_keywords + clusters + rollups
// ============================================================

interface RankedKeywordItem {
  keyword_data: {
    keyword: string;
    keyword_info: { search_volume: number; cpc: number | null; competition: number | null };
    search_intent_info?: { main_intent?: string };
  };
  ranked_serp_element: {
    serp_item: { rank_group: number; rank_absolute: number; url: string };
  };
}

function parseRankedKeywords(filePath: string) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const items: RankedKeywordItem[] = raw?.tasks?.[0]?.result?.[0]?.items ?? [];
  return items.map((item) => ({
    keyword: item.keyword_data?.keyword ?? '',
    rank_pos: item.ranked_serp_element?.serp_item?.rank_group ?? 0,
    search_volume: item.keyword_data?.keyword_info?.search_volume ?? 0,
    cpc: item.keyword_data?.keyword_info?.cpc ?? null,
    ranking_url: item.ranked_serp_element?.serp_item?.url ?? null,
    intent: item.keyword_data?.search_intent_info?.main_intent ?? null,
  }));
}

function extractTopic(keyword: string): string {
  const words = keyword.toLowerCase().split(/\s+/);
  const stop = ['near', 'me', 'in', 'the', 'a', 'an', 'best', 'top', 'local', 'cheap', 'affordable'];
  const meaningful = words.filter((w) => w.length > 2 && !stop.includes(w) && !/^\d+$/.test(w));
  return meaningful.slice(0, 3).join(' ') || 'general';
}

async function syncJim(
  sb: SupabaseClient,
  auditId: string,
  domain: string,
  date: string | undefined
) {
  const dir = agentDir(domain, 'research', date);
  if (!dir) {
    console.log('  [jim] No research directory found, skipping');
    return null;
  }

  const kwFile = path.join(dir, 'ranked_keywords.json');
  if (!fs.existsSync(kwFile)) {
    console.log('  [jim] No ranked_keywords.json found, skipping');
    return null;
  }

  console.log(`  [jim] Parsing ${kwFile}`);
  const keywords = parseRankedKeywords(kwFile);
  console.log(`  [jim] Found ${keywords.length} total keywords`);

  // Load assumptions for this audit
  const { data: assumptions } = await sb
    .from('audit_assumptions')
    .select('*')
    .eq('audit_id', auditId)
    .maybeSingle();

  if (!assumptions) {
    console.log('  [jim] No audit_assumptions found — cannot calculate revenue. Skipping keyword sync.');
    return null;
  }

  // Load CTR model
  const { data: ctrModel } = await sb
    .from('ctr_models')
    .select('*')
    .eq('id', assumptions.ctr_model_id)
    .maybeSingle();

  if (!ctrModel) {
    console.log('  [jim] No CTR model found, skipping');
    return null;
  }

  const ctrBuckets = ctrModel.buckets as CtrBuckets;

  // Near-miss filter
  const nearMiss = keywords.filter(
    (kw) =>
      kw.rank_pos >= assumptions.near_miss_min_pos &&
      kw.rank_pos <= assumptions.near_miss_max_pos &&
      kw.search_volume >= assumptions.min_volume
  );

  console.log(`  [jim] ${nearMiss.length} near-miss keywords (pos ${assumptions.near_miss_min_pos}-${assumptions.near_miss_max_pos}, vol >= ${assumptions.min_volume})`);

  // Idempotency: clear prior keyword/cluster/rollup data
  await sb.from('audit_keywords').delete().eq('audit_id', auditId);
  await sb.from('audit_clusters').delete().eq('audit_id', auditId);
  await sb.from('audit_rollups').delete().eq('audit_id', auditId);

  // Insert ALL keyword records with segment flags
  const allKeywordRecords = keywords.map((kw) => {
    const isNearMiss =
      kw.rank_pos >= assumptions.near_miss_min_pos &&
      kw.rank_pos <= assumptions.near_miss_max_pos &&
      kw.search_volume >= assumptions.min_volume;
    const isTop10 = kw.rank_pos >= 1 && kw.rank_pos <= 10;
    const isStrikingDistance = kw.rank_pos >= 11 && kw.rank_pos <= 20;

    // Only calculate revenue opportunity for near-miss keywords
    const opp = isNearMiss
      ? calculateKeywordOpportunity(
          kw,
          assumptions.target_ctr,
          ctrBuckets,
          assumptions.floor_ctr_over30,
          assumptions.cr_used_min,
          assumptions.cr_used_max,
          assumptions.acv_used_min,
          assumptions.acv_used_max,
          assumptions.cr_used_mid ?? undefined,
          assumptions.acv_used_mid ?? undefined
        )
      : {
          current_ctr: getCtrForPosition(kw.rank_pos, ctrBuckets, assumptions.floor_ctr_over30),
          current_traffic: kw.search_volume * getCtrForPosition(kw.rank_pos, ctrBuckets, assumptions.floor_ctr_over30),
          target_ctr: assumptions.target_ctr,
          target_traffic: 0,
          delta_traffic: 0,
          delta_leads_low: 0,
          delta_leads_high: 0,
          delta_revenue_low: 0,
          delta_revenue_mid: 0,
          delta_revenue_high: 0,
        };

    const topic = extractTopic(kw.keyword);
    return {
      audit_id: auditId,
      keyword: kw.keyword,
      rank_pos: kw.rank_pos,
      search_volume: kw.search_volume,
      cpc: kw.cpc,
      ranking_url: kw.ranking_url,
      intent: kw.intent,
      topic,
      cluster: topic, // initial cluster from extracted topic; refined after canonicalization
      is_near_miss: isNearMiss,
      is_top_10: isTop10,
      is_striking_distance: isStrikingDistance,
      ...opp,
    };
  });

  if (allKeywordRecords.length > 0) {
    // Batch insert (Supabase limit is ~1000 per call)
    for (let i = 0; i < allKeywordRecords.length; i += 500) {
      const batch = allKeywordRecords.slice(i, i + 500);
      const { error } = await sb.from('audit_keywords').insert(batch);
      if (error) throw new Error(`keyword insert failed: ${error.message}`);
    }
    console.log(`  [jim] Inserted ${allKeywordRecords.length} keywords (${nearMiss.length} near-miss)`);
  }

  // Pull back keywords for clustering (only near-miss for revenue calculations)
  const { data: kwRows } = await sb
    .from('audit_keywords')
    .select('keyword, rank_pos, search_volume, cpc, delta_traffic, delta_revenue_low, delta_revenue_mid, delta_revenue_high, delta_leads_low, delta_leads_high, canonical_key, canonical_topic, intent_type, intent, is_brand, is_near_miss, topic')
    .eq('audit_id', auditId)
    .eq('is_near_miss', true);

  // Cluster by canonical_key (or fall back to legacy topic)
  type ClusterAgg = {
    topic: string;
    positions: number[];
    keywords: string[];
    revLow: number;
    revMid: number;
    revHigh: number;
    leadsLow: number;
    leadsHigh: number;
    volMax: number;
    kwTotal: number;
    kwEligible: number;
  };

  const clusterMap = new Map<string, ClusterAgg>();

  for (const r of (kwRows ?? []) as any[]) {
    const key = r.canonical_key ?? r.topic ?? 'general';
    const topic = r.canonical_topic ?? r.topic ?? key;
    const vol = Number(r.search_volume ?? 0);
    const pos = Number(r.rank_pos ?? 0);
    const intent = String(r.intent_type ?? r.intent ?? r.topic ?? '').toLowerCase();
    const isBrand = r.is_brand === true;
    const eligible = !isBrand && (intent === 'commercial' || intent === 'transactional');
    const deltaTraffic = Number(r.delta_traffic ?? 0);

    const existing = clusterMap.get(key);
    if (existing) {
      existing.positions.push(pos);
      existing.keywords.push(r.keyword);
      if (eligible) {
        existing.revLow += Number(r.delta_revenue_low ?? 0);
        existing.revMid += Number(r.delta_revenue_mid ?? 0);
        existing.revHigh += Number(r.delta_revenue_high ?? 0);
        existing.leadsLow += Number(r.delta_leads_low ?? 0);
        existing.leadsHigh += Number(r.delta_leads_high ?? 0);
        existing.kwEligible++;
      }
      existing.volMax = Math.max(existing.volMax, vol);
      existing.kwTotal++;
    } else {
      clusterMap.set(key, {
        topic,
        positions: [pos],
        keywords: [r.keyword],
        revLow: eligible ? Number(r.delta_revenue_low ?? 0) : 0,
        revMid: eligible ? Number(r.delta_revenue_mid ?? 0) : 0,
        revHigh: eligible ? Number(r.delta_revenue_high ?? 0) : 0,
        leadsLow: eligible ? Number(r.delta_leads_low ?? 0) : 0,
        leadsHigh: eligible ? Number(r.delta_leads_high ?? 0) : 0,
        volMax: vol,
        kwTotal: 1,
        kwEligible: eligible ? 1 : 0,
      });
    }
  }

  const clusterRecords = Array.from(clusterMap.entries())
    .sort((a, b) => b[1].revHigh - a[1].revHigh)
    .map(([, c]) => {
      const minPos = Math.min(...c.positions);
      const maxPos = Math.max(...c.positions);
      return {
        audit_id: auditId,
        topic: c.topic,
        near_miss_positions: minPos === maxPos ? `${minPos}` : `${minPos}-${maxPos}`,
        total_volume: c.volMax,
        est_new_leads_low: round2(c.leadsLow),
        est_new_leads_high: round2(c.leadsHigh),
        est_revenue_low: round2(c.revLow),
        est_revenue_mid: round2(c.revMid),
        est_revenue_high: round2(c.revHigh),
        sample_keywords: c.keywords.slice(0, 5),
      };
    });

  if (clusterRecords.length > 0) {
    const { error } = await sb.from('audit_clusters').insert(clusterRecords);
    if (error) throw new Error(`cluster insert failed: ${error.message}`);
    console.log(`  [jim] Inserted ${clusterRecords.length} clusters`);
  }

  // Rollup
  const totalVol = clusterRecords.reduce((s, c) => s + c.total_volume, 0);
  const totalRevLow = clusterRecords.reduce((s, c) => s + c.est_revenue_low, 0);
  const totalRevMid = clusterRecords.reduce((s, c) => s + c.est_revenue_mid, 0);
  const totalRevHigh = clusterRecords.reduce((s, c) => s + c.est_revenue_high, 0);

  const { error: rollupErr } = await sb.from('audit_rollups').insert({
    audit_id: auditId,
    total_volume_analyzed: totalVol,
    near_miss_keyword_count: nearMiss.length,
    opportunity_topics_count: clusterRecords.length,
    monthly_revenue_low: round2(totalRevLow),
    monthly_revenue_mid: round2(totalRevMid),
    monthly_revenue_high: round2(totalRevHigh),
  });
  if (rollupErr) throw new Error(`rollup insert failed: ${rollupErr.message}`);

  console.log(`  [jim] Revenue range: $${round2(totalRevLow)} / $${round2(totalRevMid)} / $${round2(totalRevHigh)} per mo (low/mid/high)`);

  // Parse research_summary.md for site-level findings
  const summaryFile = path.join(dir, 'research_summary.md');
  let parsedSummary: ParsedResearchSummary | null = null;
  if (fs.existsSync(summaryFile)) {
    console.log(`  [jim] Parsing ${summaryFile} for site-level findings`);
    parsedSummary = parseResearchSummary(summaryFile);
    console.log(`  [jim] Extracted: ${parsedSummary.keywordOverview.total_keywords} total keywords, ${parsedSummary.competitorAnalysis.length} competitors, ${parsedSummary.strikingDistance.length} striking distance, ${parsedSummary.contentGapObservations.length} content gaps`);
  } else {
    console.log(`  [jim] No research_summary.md found — site-level findings will be empty`);
  }

  // Snapshot versioning
  const snapshotVersion = await getNextSnapshotVersion(sb, auditId, 'jim');

  // Create agent_runs record
  const runDate = date ?? getLatestDateDir(path.join(AUDITS_BASE, domain, 'research')) ?? new Date().toISOString().slice(0, 10);
  const { data: run } = await sb.from('agent_runs').insert({
    audit_id: auditId,
    agent_name: 'jim',
    run_date: runDate,
    status: 'completed',
    source_path: path.relative(AUDITS_BASE, dir),
    snapshot_version: snapshotVersion,
    metadata: { keyword_count: keywords.length, near_miss_count: nearMiss.length },
  }).select('id').single();

  const agentRunId = run?.id ?? null;

  // Record snapshot with site-level findings (direct insert, same pattern as Dwight)
  await sb.from('audit_snapshots').insert({
    audit_id: auditId,
    agent_name: 'jim',
    snapshot_version: snapshotVersion,
    agent_run_id: agentRunId,
    row_count: allKeywordRecords.length,
    // Site-level findings from research_summary.md
    research_summary_markdown: parsedSummary ? fs.readFileSync(summaryFile, 'utf-8') : null,
    keyword_overview: parsedSummary?.keywordOverview ?? {},
    position_distribution: parsedSummary?.positionDistribution ?? [],
    branded_split: parsedSummary?.brandedSplit ?? {},
    intent_breakdown: parsedSummary?.intentBreakdown ?? [],
    top_ranking_urls: parsedSummary?.topRankingUrls ?? [],
    competitor_analysis: parsedSummary?.competitorAnalysis ?? [],
    competitor_summary: parsedSummary?.competitorSummary ?? {},
    striking_distance: parsedSummary?.strikingDistance ?? [],
    content_gap_observations: parsedSummary?.contentGapObservations ?? [],
    key_takeaways: parsedSummary?.keyTakeaways ?? [],
  });

  // Update staleness timestamp
  await updateStalenessTimestamp(sb, auditId, 'jim');

  // Baseline snapshot capture (first sync only)
  const { count: baselineCount } = await sb
    .from('baseline_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('audit_id', auditId);

  if ((baselineCount ?? 0) === 0 && nearMiss.length > 0) {
    const baselineRecords = nearMiss.map((kw) => ({
      audit_id: auditId,
      keyword: kw.keyword,
      baseline_rank: kw.rank_pos,
      baseline_volume: kw.search_volume,
    }));
    for (let i = 0; i < baselineRecords.length; i += 500) {
      const batch = baselineRecords.slice(i, i + 500);
      await sb.from('baseline_snapshots').upsert(batch, { onConflict: 'audit_id,keyword' });
    }
    console.log(`  [jim] Captured ${baselineRecords.length} baseline snapshots`);
  }

  return agentRunId;
}

// ============================================================
// Dwight AUDIT_REPORT.md parser
// ============================================================

interface ParsedAuditReport {
  executiveSummary: string;
  prioritizedFixes: Array<{
    number: number;
    issue: string;
    affected_pages: string;
    fix: string;
    priority_tier: number;
    priority_label: string;
  }>;
  agenticReadiness: Array<{
    signal: string;
    status: string;
    weight: string;
  }>;
  structuredDataIssues: Array<{
    issue: string;
    description: string;
    severity: string;
  }>;
  headingIssues: Array<{
    url: string;
    issue_type: string;
    details: string;
  }>;
  securityIssues: Array<{
    issue: string;
    affected_pages: string;
    fix: string;
  }>;
  platformNotes: string;
  siteMetadata: Record<string, string>;
}

function parseAuditReport(filePath: string): ParsedAuditReport {
  const md = fs.readFileSync(filePath, 'utf-8');

  const result: ParsedAuditReport = {
    executiveSummary: '',
    prioritizedFixes: [],
    agenticReadiness: [],
    structuredDataIssues: [],
    headingIssues: [],
    securityIssues: [],
    platformNotes: '',
    siteMetadata: {},
  };

  // --- Executive Summary ---
  const execMatch = md.match(/##\s*Executive\s+Summary\s*\n([\s\S]*?)(?=\n---|\n##\s)/i);
  if (execMatch) {
    result.executiveSummary = execMatch[1].trim();
  }

  // --- Prioritized Fix List ---
  const prioritySections = md.matchAll(
    /###\s*Priority\s*(\d+)\s*[—–-]\s*(.+?)(?:\n|\r\n)([\s\S]*?)(?=###\s*Priority|\n##\s|$)/gi
  );
  for (const section of prioritySections) {
    const tier = parseInt(section[1], 10);
    const label = section[2].trim().replace(/\(.+\)/, '').trim();
    const body = section[3];

    const tableRows = body.matchAll(
      /\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/g
    );
    for (const row of tableRows) {
      const num = parseInt(row[1], 10);
      if (isNaN(num)) continue;
      result.prioritizedFixes.push({
        number: num,
        issue: row[2].trim(),
        affected_pages: row[3].trim(),
        fix: row[4].trim(),
        priority_tier: tier,
        priority_label: label,
      });
    }
  }

  // --- Agentic Readiness Scorecard ---
  const agenticMatch = md.match(
    /###\s*10\.4\s*Agentic\s+Readiness\s+Score[\s\S]*?\n(\|.+\|[\s\S]*?)(?=\n\*\*|\n---|\n##\s|$)/i
  );
  if (agenticMatch) {
    const tableBlock = agenticMatch[1];
    const rows = tableBlock.matchAll(
      /\|\s*(.+?)\s*\|\s*\*{0,2}(PASS|FAIL)\*{0,2}\s*\|\s*(.+?)\s*\|/gi
    );
    for (const row of rows) {
      result.agenticReadiness.push({
        signal: row[1].trim().replace(/^\|+\s*/, ''),
        status: row[2].trim().toUpperCase(),
        weight: row[3].trim().replace(/^\|+\s*/, ''),
      });
    }
  }

  // --- Structured Data Issues ---
  const schemaSection = md.match(
    /##\s*Section\s*6:\s*Structured\s+Data[\s\S]*?(?=\n##\s)/i
  );
  if (schemaSection) {
    // Format A: **Issue N: Title**\ndescription
    const formatA = schemaSection[0].matchAll(
      /\*\*Issue\s*(\d+):\s*(.+?)\*\*\s*\n([\s\S]*?)(?=\*\*Issue|\n---|\n##|$)/gi
    );
    for (const block of formatA) {
      const desc = block[3].trim().split('\n')[0].trim();
      result.structuredDataIssues.push({ issue: block[2].trim(), description: desc, severity: 'critical' });
    }
    // Format B: N. **Title** — description (numbered list under ### Issues)
    if (result.structuredDataIssues.length === 0) {
      const formatB = schemaSection[0].matchAll(
        /\d+\.\s*\*\*(.+?)\*\*\s*[—–-]\s*(.+?)(?=\n\d+\.\s*\*\*|\n\n---|\n##|$)/gs
      );
      for (const block of formatB) {
        result.structuredDataIssues.push({
          issue: block[1].trim(), description: block[2].trim().split('\n')[0].trim(), severity: 'critical',
        });
      }
    }
  }

  // --- Heading Issues ---
  const missingH1Match = md.match(
    /###\s*5\.1\s*Missing\s+H1[\s\S]*?\n(\|.+\|[\s\S]*?)(?=\n###|\n##\s|$)/i
  );
  if (missingH1Match) {
    const rows = missingH1Match[1].matchAll(/\|\s*(\/.+?)\s*\|\s*(.+?)\s*\|/g);
    for (const row of rows) {
      if (row[1].includes('---')) continue;
      result.headingIssues.push({
        url: row[1].trim(),
        issue_type: 'missing_h1',
        details: row[2].trim(),
      });
    }
  }

  const multiH1Match = md.match(
    /###\s*5\.2\s*Multiple\s+H1[\s\S]*?\n(\|.+\|[\s\S]*?)(?=\n###|\n##\s|$)/i
  );
  if (multiH1Match) {
    const rows = multiH1Match[1].matchAll(
      /\|\s*(\/.+?)\s*\|\s*"?(.+?)"?\s*\|\s*"?(.+?)"?\s*\|/g
    );
    for (const row of rows) {
      if (row[1].includes('---')) continue;
      result.headingIssues.push({
        url: row[1].trim(),
        issue_type: 'multiple_h1',
        details: `H1-1: ${row[2].trim()}, H1-2: ${row[3].trim()}`,
      });
    }
  }

  // --- Security Issues ---
  const secSection = md.match(
    /##\s*Section\s*9:\s*Security[\s\S]*?(?=\n##\s)/i
  );
  if (secSection) {
    const crossOrigin = secSection[0].match(
      /###\s*9\.1[\s\S]*?\*\*Fix:\*\*\s*(.+?)(?:\n|$)/i
    );
    if (crossOrigin) {
      result.securityIssues.push({
        issue: 'Unsafe cross-origin HTTP link without rel="noopener"',
        affected_pages: 'Sitewide (all pages)',
        fix: crossOrigin[1].trim(),
      });
    }

    const refPolicy = secSection[0].match(
      /###\s*9\.2[\s\S]*?Recommendation:\s*(.+?)(?:\n|$)/i
    );
    if (refPolicy) {
      result.securityIssues.push({
        issue: 'Missing Referrer-Policy header',
        affected_pages: 'Sitewide (all pages)',
        fix: refPolicy[1].trim(),
      });
    }

    const ext4xx = secSection[0].match(/###\s*9\.3[\s\S]*?(?=\n###|\n##|$)/i);
    if (ext4xx && ext4xx[0].includes('406')) {
      result.securityIssues.push({
        issue: 'Broken external link (406 Not Acceptable)',
        affected_pages: '/privacy-policy',
        fix: 'Update or remove the link to support.mozilla.org',
      });
    }
  }

  // --- Platform Notes ---
  const platformMatch = md.match(
    /##\s*Section\s*11:\s*Platform[\s\S]*?(?=\n##\s|\n---\s*\n##|$)/i
  );
  if (platformMatch) {
    result.platformNotes = platformMatch[0]
      .replace(/##\s*Section\s*11:\s*Platform\s*Observations\s*\n*/i, '')
      .trim();
  }

  // --- URL Identity Issues (Section 2) ---
  const urlIdentityIssues: Array<{ url: string; behavior: string }> = [];
  const urlIdSection = md.match(
    /##\s*Section\s*2:\s*URL\s+Identity[\s\S]*?(?=\n---|\n##\s)/i
  );
  if (urlIdSection) {
    const rows = urlIdSection[0].matchAll(
      /\|\s*`?(\/.+?)`?\s*\|\s*(.+?)\s*\|/g
    );
    for (const row of rows) {
      if (row[1].includes('---') || row[1].includes('Uppercase')) continue;
      urlIdentityIssues.push({
        url: row[1].trim(),
        behavior: row[2].trim(),
      });
    }
  }

  // --- Metadata Quality (Section 4) ---
  const metadataOverLengthTitles: Array<{ url: string; title: string; length: number; status: string }> = [];
  const metadataOverLengthDescs: Array<{ url: string; length: number }> = [];
  let metadataDeprecatedKeywords = false;

  const titleSection = md.match(
    /###\s*4\.1\s*Page\s+Titles[\s\S]*?(?=\n###\s*4\.2|\n##\s)/i
  );
  if (titleSection) {
    const rows = titleSection[0].matchAll(
      /\|\s*(\/.+?)\s*\|\s*(.+?)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\w+)\s*\|/g
    );
    for (const row of rows) {
      if (row[1].includes('---') || row[1].includes('URL')) continue;
      metadataOverLengthTitles.push({
        url: row[1].trim(),
        title: row[2].trim(),
        length: parseInt(row[3], 10),
        status: row[5].trim(),
      });
    }
  }

  const descSection = md.match(
    /###\s*4\.2\s*Meta\s+Descriptions[\s\S]*?(?=\n##\s)/i
  );
  if (descSection) {
    const rows = descSection[0].matchAll(
      /\|\s*(\/.+?)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/g
    );
    for (const row of rows) {
      if (row[1].includes('---') || row[1].includes('URL')) continue;
      metadataOverLengthDescs.push({
        url: row[1].trim(),
        length: parseInt(row[2], 10),
      });
    }
    metadataDeprecatedKeywords = /meta\s+keywords.*deprecated/i.test(descSection[0]);
  }

  // --- Image Health (Section 8) ---
  const imageIssues: { missing_alt: number; oversized: number; missing_size: number } = {
    missing_alt: 0, oversized: 0, missing_size: 0,
  };
  const imgSection = md.match(
    /##\s*Section\s*8:\s*Image\s+Health[\s\S]*?(?=\n---|\n##\s)/i
  );
  if (imgSection) {
    const altMatch = imgSection[0].match(/(\d+)\s*image.*missing\s+alt/i);
    if (altMatch) imageIssues.missing_alt = parseInt(altMatch[1], 10);
    const oversizeMatch = imgSection[0].match(/(\d+)\s*images?\s+exceed\s+100/i);
    if (oversizeMatch) imageIssues.oversized = parseInt(oversizeMatch[1], 10);
    const sizeAttrMatch = imgSection[0].match(/(\d+)\s*image.*missing.*(?:width|height|size\s+attributes)/i);
    if (sizeAttrMatch) imageIssues.missing_size = parseInt(sizeAttrMatch[1], 10);
  }

  // --- Site Metadata ---
  const toolMatch = md.match(/\*\*Tool:\*\*\s*(.+)/i);
  const dateMatch = md.match(/\*\*Audit Date:\*\*\s*(.+)/i);
  const scopeMatch = md.match(/\*\*Crawl Scope:\*\*\s*(.+)/i);

  result.siteMetadata = {
    crawl_tool: toolMatch?.[1]?.trim() ?? '',
    crawl_date: dateMatch?.[1]?.trim() ?? '',
    crawl_scope: scopeMatch?.[1]?.trim() ?? '',
    platform_detected: result.platformNotes.includes('DudaSite') ? 'DudaSite' : '',
    url_identity_issues: JSON.stringify(urlIdentityIssues),
    metadata_over_length_titles: JSON.stringify(metadataOverLengthTitles),
    metadata_over_length_descs: JSON.stringify(metadataOverLengthDescs),
    metadata_deprecated_keywords: metadataDeprecatedKeywords ? 'true' : 'false',
    image_missing_alt: String(imageIssues.missing_alt),
    image_oversized: String(imageIssues.oversized),
    image_missing_size: String(imageIssues.missing_size),
  };

  const passing = result.agenticReadiness.filter((a) => a.status === 'PASS').length;
  const total = result.agenticReadiness.length;
  if (total > 0) {
    const WEIGHT_POINTS: Record<string, number> = { High: 3, Medium: 2, Low: 1 };
    let earned = 0, maxPts = 0;
    for (const a of result.agenticReadiness) {
      const pts = WEIGHT_POINTS[a.weight] ?? 1;
      maxPts += pts;
      if (a.status === 'PASS') earned += pts;
    }
    const pct = maxPts > 0 ? Math.round((earned / maxPts) * 100) : 0;
    result.siteMetadata.agentic_readiness_score = `${pct}%`;
    result.siteMetadata.agentic_readiness_raw = `${passing}/${total}`;
    result.siteMetadata.agentic_readiness_points = `${earned}/${maxPts}`;
  }

  return result;
}

// ============================================================
// Dwight sync — internal_all.csv → agent_technical_pages
// ============================================================

const NEAR_DUP_THRESHOLD = 0.90;

async function syncDwight(
  sb: SupabaseClient,
  auditId: string,
  domain: string,
  date: string | undefined
) {
  const dir = agentDir(domain, 'auditor', date);
  if (!dir) {
    console.log('  [dwight] No auditor directory found, skipping');
    return null;
  }

  const csvFile = path.join(dir, 'internal_all.csv');
  if (!fs.existsSync(csvFile)) {
    console.log('  [dwight] No internal_all.csv found, skipping');
    return null;
  }

  console.log(`  [dwight] Parsing ${csvFile}`);
  let csvContent = fs.readFileSync(csvFile, 'utf-8');
  // Strip UTF-8 BOM if present (Screaming Frog exports include it)
  if (csvContent.charCodeAt(0) === 0xfeff) {
    csvContent = csvContent.slice(1);
  }
  const rows: Record<string, string>[] = csvParse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  // Clear prior technical pages for this audit
  await sb.from('agent_technical_pages').delete().eq('audit_id', auditId);

  const runDate = date ?? getLatestDateDir(path.join(AUDITS_BASE, domain, 'auditor')) ?? new Date().toISOString().slice(0, 10);

  // Create agent run record
  const { data: run } = await sb.from('agent_runs').insert({
    audit_id: auditId,
    agent_name: 'dwight',
    run_date: runDate,
    status: 'completed',
    source_path: path.relative(AUDITS_BASE, dir),
    metadata: { page_count: rows.length },
  }).select('id').single();

  const agentRunId = run?.id ?? null;

  // Load semantically_similar_report.csv if it exists (supplements internal_all.csv)
  // Also check the architecture directory as a fallback — semantic analysis may live there
  const semCandidates = [
    path.join(dir, 'semantically_similar_report.csv'),
  ];
  const archDir = agentDir(domain, 'architecture', date);
  if (archDir) {
    semCandidates.push(path.join(archDir, 'semantically_similar_report.csv'));
  }

  const semMap = new Map<string, { closestUrl: string; score: number }>();
  for (const semReportFile of semCandidates) {
    if (!fs.existsSync(semReportFile)) continue;
    let semCsv = fs.readFileSync(semReportFile, 'utf-8');
    if (semCsv.charCodeAt(0) === 0xfeff) semCsv = semCsv.slice(1);
    const semRows: Record<string, string>[] = csvParse(semCsv, { columns: true, skip_empty_lines: true, relax_column_count: true });
    for (const sr of semRows) {
      const addr = sr['Address'] || '';
      const closest = sr['Closest Semantically Similar Address'] || '';
      const score = parseFloat(sr['Semantic Similarity Score'] || '0') || 0;
      if (addr && score > 0 && !semMap.has(addr)) {
        semMap.set(addr, { closestUrl: closest, score });
      }
    }
    if (semMap.size > 0) {
      console.log(`  [dwight] Loaded ${semMap.size} semantic pairs from ${path.basename(path.dirname(semReportFile))} report`);
      break; // first source with data wins
    }
  }

  // Filter to HTML pages only
  const htmlRows = rows.filter((r) => {
    const ct = r['Content Type'] ?? '';
    return ct.includes('text/html') || ct === '';
  });

  const pageRecords = htmlRows.map((r) => {
    const url = r['Address'] ?? '';
    // Try inline columns first, fall back to semantic report
    let semScore = parseFloat(r['Semantic Similarity Score'] || '0') || null;
    let semUrl = r['Closest Semantically Similar Address'] || null;
    if (!semScore && semMap.has(url)) {
      const entry = semMap.get(url)!;
      semScore = entry.score;
      semUrl = entry.closestUrl;
    }
    let semanticFlag: string | null = null;
    if (semScore && semScore >= NEAR_DUP_THRESHOLD) {
      semanticFlag = 'NEAR-DUP';
    }

    // Build crawl_data with remaining useful columns
    const crawlData: Record<string, string | number | null> = {};
    const knownCols = new Set([
      'Address', 'Content Type', 'Status Code', 'Status', 'Indexability',
      'Title 1', 'H1-1', 'Meta Description 1', 'Word Count', 'Crawl Depth',
      'Inlinks', 'Outlinks', 'Closest Semantically Similar Address',
      'Semantic Similarity Score',
    ]);
    for (const [key, val] of Object.entries(r)) {
      if (!knownCols.has(key) && val) crawlData[key] = val;
    }

    return {
      audit_id: auditId,
      agent_run_id: agentRunId,
      url: r['Address'] ?? '',
      status_code: parseInt(r['Status Code'] || '0', 10) || null,
      word_count: parseInt(r['Word Count'] || '0', 10) || null,
      title: r['Title 1'] || null,
      h1: r['H1-1'] || null,
      meta_description: r['Meta Description 1'] || null,
      depth: parseInt(r['Crawl Depth'] || '0', 10) || null,
      indexability: r['Indexability'] || null,
      inlinks_count: parseInt(r['Inlinks'] || '0', 10) || null,
      outlinks_count: parseInt(r['Outlinks'] || '0', 10) || null,
      semantic_closest_url: semUrl,
      semantic_similarity_score: semScore,
      semantic_flag: semanticFlag,
      crawl_data: crawlData,
    };
  });

  if (pageRecords.length > 0) {
    for (let i = 0; i < pageRecords.length; i += 500) {
      const batch = pageRecords.slice(i, i + 500);
      const { error } = await sb.from('agent_technical_pages').insert(batch);
      if (error) throw new Error(`technical pages insert failed: ${error.message}`);
    }
    console.log(`  [dwight] Inserted ${pageRecords.length} technical pages`);
  }

  const flagged = pageRecords.filter((p) => p.semantic_flag);
  console.log(`  [dwight] ${flagged.length} pages with semantic flags`);

  // Parse AUDIT_REPORT.md for site-level findings — check current dir, then other date dirs
  let reportFile = path.join(dir, 'AUDIT_REPORT.md');
  if (!fs.existsSync(reportFile)) {
    const auditorBase = path.join(AUDITS_BASE, domain, 'auditor');
    if (fs.existsSync(auditorBase)) {
      const dateDirs = fs.readdirSync(auditorBase).filter((e: string) => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort().reverse();
      for (const d of dateDirs) {
        const candidate = path.join(auditorBase, d, 'AUDIT_REPORT.md');
        if (fs.existsSync(candidate)) { reportFile = candidate; break; }
      }
    }
  }
  let parsedReport: ParsedAuditReport | null = null;
  if (fs.existsSync(reportFile)) {
    console.log(`  [dwight] Parsing ${reportFile} for site-level findings`);
    parsedReport = parseAuditReport(reportFile);
    console.log(`  [dwight] Extracted: ${parsedReport.prioritizedFixes.length} fixes, ${parsedReport.agenticReadiness.length} agentic signals, ${parsedReport.structuredDataIssues.length} schema issues, ${parsedReport.headingIssues.length} heading issues, ${parsedReport.securityIssues.length} security issues, ${JSON.parse(parsedReport.siteMetadata.url_identity_issues || '[]').length} URL identity issues, ${JSON.parse(parsedReport.siteMetadata.metadata_over_length_titles || '[]').length} over-length titles`);
  } else {
    console.log(`  [dwight] No AUDIT_REPORT.md found in any auditor directory — site-level findings will be empty`);
  }

  // Record snapshot with site-level findings and update staleness
  const snapshotVersion = await getNextSnapshotVersion(sb, auditId, 'dwight');
  await sb.from('agent_runs').update({ snapshot_version: snapshotVersion }).eq('id', agentRunId);

  await sb.from('audit_snapshots').insert({
    audit_id: auditId,
    agent_name: 'dwight',
    snapshot_version: snapshotVersion,
    agent_run_id: agentRunId,
    row_count: pageRecords.length,
    executive_summary: parsedReport?.executiveSummary ?? null,
    prioritized_fixes: parsedReport?.prioritizedFixes ?? [],
    agentic_readiness: parsedReport?.agenticReadiness ?? [],
    structured_data_issues: parsedReport?.structuredDataIssues ?? [],
    heading_issues: parsedReport?.headingIssues ?? [],
    security_issues: parsedReport?.securityIssues ?? [],
    platform_notes: parsedReport?.platformNotes ?? null,
    site_metadata: parsedReport?.siteMetadata ?? {},
  });

  await updateStalenessTimestamp(sb, auditId, 'dwight');

  return agentRunId;
}

// ============================================================
// Michael sync — architecture_blueprint.md → agent_architecture_pages + blueprint
// ============================================================

interface ArchPage {
  url_slug: string;
  page_status: string;
  silo_name: string;
  role: string;
  primary_keyword: string;
  primary_keyword_volume: number;
  action_required: string;
}

function parseArchitectureBlueprint(filePath: string): { pages: ArchPage[]; markdown: string; summary: string } {
  const markdown = fs.readFileSync(filePath, 'utf-8');

  // Extract executive summary (first section content after the title)
  let summary = '';
  const summaryMatch = markdown.match(/##\s*Executive\s+Summary\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/i);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  }

  // Parse silo page assignments from markdown tables under "### Silo" headings.
  // Tables outside silo sections (cannibalization, metadata, schema, etc.) are skipped.
  const pages: ArchPage[] = [];
  const seenSlugs = new Set<string>();

  // Build a map of character offsets → silo names from "### Silo N: Name" headings
  const siloHeadings: Array<{ offset: number; name: string }> = [];
  const siloHeadingRegex = /^###\s+Silo\s+\d+:\s*(.+)$/gm;
  let siloMatch: RegExpExecArray | null;
  while ((siloMatch = siloHeadingRegex.exec(markdown)) !== null) {
    siloHeadings.push({ offset: siloMatch.index, name: siloMatch[1].trim() });
  }

  // Find the next heading after each silo to bound its range
  const allHeadingOffsets: number[] = [];
  const headingBoundaryRegex = /^#{2,3}\s/gm;
  let hm: RegExpExecArray | null;
  while ((hm = headingBoundaryRegex.exec(markdown)) !== null) {
    allHeadingOffsets.push(hm.index);
  }

  // Build offsets for ## headings (Part boundaries) to limit silo scope
  const partHeadingOffsets: number[] = [];
  const partHeadingRegex = /^##\s/gm;
  let pm: RegExpExecArray | null;
  while ((pm = partHeadingRegex.exec(markdown)) !== null) {
    partHeadingOffsets.push(pm.index);
  }

  function getSiloForOffset(offset: number): string | null {
    for (let i = siloHeadings.length - 1; i >= 0; i--) {
      if (offset >= siloHeadings[i].offset) {
        // Bound at: next silo heading, or next ## heading after this silo, whichever is first
        const nextSiloOffset = i + 1 < siloHeadings.length ? siloHeadings[i + 1].offset : Infinity;
        const nextPartOffset = partHeadingOffsets.find((o) => o > siloHeadings[i].offset) ?? Infinity;
        const bound = Math.min(nextSiloOffset, nextPartOffset);
        if (offset < bound) return siloHeadings[i].name;
        return null;
      }
    }
    return null;
  }

  const tableRegex = /\|(.+)\|\n\|[-\s|:]+\|\n((?:\|.+\|\n?)*)/g;
  let match: RegExpExecArray | null;

  while ((match = tableRegex.exec(markdown)) !== null) {
    // Only process tables inside silo sections
    const siloName = getSiloForOffset(match.index);
    if (!siloName) continue;

    const headerLine = match[1];
    const headers = headerLine.split('|').map((h) => h.trim().toLowerCase());

    // Check if this table has page-related columns — prefer url/slug/path over generic 'page'
    let slugIdx = headers.findIndex((h) => h.includes('slug') || h.includes('url') || h.includes('path'));
    if (slugIdx < 0) slugIdx = headers.findIndex((h) => h.includes('page'));
    if (slugIdx < 0) continue;

    const statusIdx = headers.findIndex((h) => h.includes('status') || h.includes('exists') || h.includes('new'));
    const siloColIdx = headers.findIndex((h) => h.includes('silo') || h.includes('cluster'));
    const roleIdx = headers.findIndex((h) => h.includes('role') || h.includes('type'));
    const kwIdx = headers.findIndex((h) => h.includes('keyword') || h.includes('target'));
    const volIdx = headers.findIndex((h) => h.includes('volume') || h.includes('vol'));
    const actionIdx = headers.findIndex((h) => h.includes('action') || h.includes('required') || h.includes('recommendation'));

    const rowLines = match[2].trim().split('\n');
    for (const rowLine of rowLines) {
      const cells = rowLine.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length < 2) continue;

      const slug = cells[slugIdx] ?? '';
      if (!slug || slug.startsWith('-')) continue;

      const cleanSlug = slug.replace(/^\//, '').replace(/`/g, '');
      // Deduplicate: first silo assignment wins
      if (seenSlugs.has(cleanSlug.toLowerCase())) continue;
      seenSlugs.add(cleanSlug.toLowerCase());

      pages.push({
        url_slug: cleanSlug,
        page_status: statusIdx >= 0 ? (cells[statusIdx] ?? '').toLowerCase().replace(/[*`]/g, '') : 'unknown',
        silo_name: siloColIdx >= 0 ? (cells[siloColIdx] ?? '').replace(/[*`]/g, '') : siloName,
        role: roleIdx >= 0 ? (cells[roleIdx] ?? '').replace(/[*`]/g, '') : '',
        primary_keyword: kwIdx >= 0 ? (cells[kwIdx] ?? '').replace(/[*`]/g, '') : '',
        primary_keyword_volume: volIdx >= 0 ? parseInt(cells[volIdx] ?? '0', 10) || 0 : 0,
        action_required: actionIdx >= 0 ? (cells[actionIdx] ?? '').toLowerCase().replace(/[*`]/g, '') : '',
      });
    }
  }

  return { pages, markdown, summary };
}

async function syncMichael(
  sb: SupabaseClient,
  auditId: string,
  domain: string,
  date: string | undefined
) {
  const dir = agentDir(domain, 'architecture', date);
  if (!dir) {
    console.log('  [michael] No architecture directory found, skipping');
    return null;
  }

  const blueprintFile = path.join(dir, 'architecture_blueprint.md');
  if (!fs.existsSync(blueprintFile)) {
    console.log('  [michael] No architecture_blueprint.md found, skipping');
    return null;
  }

  console.log(`  [michael] Parsing ${blueprintFile}`);
  const { pages, markdown, summary } = parseArchitectureBlueprint(blueprintFile);
  console.log(`  [michael] Extracted ${pages.length} architecture pages from tables`);

  // Clear prior data
  await sb.from('agent_architecture_pages').delete().eq('audit_id', auditId);
  await sb.from('agent_architecture_blueprint').delete().eq('audit_id', auditId);

  const runDate = date ?? getLatestDateDir(path.join(AUDITS_BASE, domain, 'architecture')) ?? new Date().toISOString().slice(0, 10);

  const { data: run } = await sb.from('agent_runs').insert({
    audit_id: auditId,
    agent_name: 'michael',
    run_date: runDate,
    status: 'completed',
    source_path: path.relative(AUDITS_BASE, dir),
    metadata: { page_count: pages.length, blueprint_size: markdown.length },
  }).select('id').single();

  const agentRunId = run?.id ?? null;

  // Insert pages
  if (pages.length > 0) {
    const pageRecords = pages.map((p) => ({
      audit_id: auditId,
      agent_run_id: agentRunId,
      url_slug: p.url_slug,
      page_status: p.page_status.includes('new') ? 'new' : p.page_status.includes('exist') ? 'exists' : p.page_status,
      silo_name: p.silo_name,
      role: p.role,
      primary_keyword: p.primary_keyword,
      primary_keyword_volume: p.primary_keyword_volume,
      action_required: p.action_required,
    }));
    const { error } = await sb.from('agent_architecture_pages').insert(pageRecords);
    if (error) throw new Error(`architecture pages insert failed: ${error.message}`);
    console.log(`  [michael] Inserted ${pageRecords.length} architecture pages`);
  }

  // Insert blueprint
  const snapshotVersion = await getNextSnapshotVersion(sb, auditId, 'michael');
  const { error: bpErr } = await sb.from('agent_architecture_blueprint').insert({
    audit_id: auditId,
    agent_run_id: agentRunId,
    blueprint_markdown: markdown,
    executive_summary: summary || null,
    snapshot_version: snapshotVersion,
  });
  if (bpErr) throw new Error(`blueprint insert failed: ${bpErr.message}`);
  console.log(`  [michael] Inserted blueprint (${Math.round(markdown.length / 1024)}KB)`);

  // Seed execution_pages with page_brief from architecture pages
  if (pages.length > 0) {
    const execRecords = pages.map((p) => ({
      audit_id: auditId,
      url_slug: p.url_slug,
      silo: p.silo_name || null,
      priority: p.action_required === 'create' ? 1 : p.action_required === 'optimize' ? 2 : p.action_required === 'differentiate' ? 3 : 4,
      status: 'not_started',
      page_brief: {
        silo_name: p.silo_name,
        role: p.role,
        primary_keyword: p.primary_keyword,
        primary_keyword_volume: p.primary_keyword_volume,
        action_required: p.action_required,
        page_status: p.page_status,
      },
      snapshot_version: snapshotVersion,
    }));

    // Upsert: if page exists, update page_brief but preserve status and Pam fields
    for (const rec of execRecords) {
      // Match existing record by slug (handle legacy leading-slash variants)
      const slug = rec.url_slug.replace(/^\/+/, '');
      const { data: existing } = await sb
        .from('execution_pages')
        .select('id')
        .eq('audit_id', auditId)
        .or(`url_slug.eq.${slug},url_slug.eq./${slug}`)
        .maybeSingle();

      if (existing) {
        await sb.from('execution_pages').update({
          url_slug: slug, // normalize
          page_brief: rec.page_brief,
          silo: rec.silo,
          priority: rec.priority,
          snapshot_version: rec.snapshot_version,
        }).eq('id', (existing as any).id);
      } else {
        await sb.from('execution_pages').insert({ ...rec, url_slug: slug });
      }
    }
    console.log(`  [michael] Seeded ${execRecords.length} execution page briefs`);
  }

  // Backfill audit_keywords.cluster from silo assignments
  // Strategy: match keywords to silos via (1) primary_keyword, (2) ranking_url → page slug
  const pagesWithSilo = pages.filter((p) => p.silo_name);
  if (pagesWithSilo.length > 0) {
    // Build slug → silo map (normalize slugs for matching)
    const siloBySlug = new Map<string, string>();
    const siloByKeyword = new Map<string, string>();
    for (const p of pagesWithSilo) {
      const slug = p.url_slug.replace(/^\/+/, '').toLowerCase();
      if (slug) siloBySlug.set(slug, p.silo_name);
      const kw = (p.primary_keyword ?? '').toLowerCase().trim();
      if (kw) siloByKeyword.set(kw, p.silo_name);
    }

    // Fetch all keywords with their ranking_url
    const { data: allKw } = await sb
      .from('audit_keywords')
      .select('id, keyword, ranking_url')
      .eq('audit_id', auditId);

    let siloUpdated = 0;
    for (const row of (allKw ?? []) as any[]) {
      const kwLower = String(row.keyword).toLowerCase().trim();
      let silo: string | undefined;

      // (1) Exact primary_keyword match
      silo = siloByKeyword.get(kwLower);

      // (2) Substring match on primary_keyword
      if (!silo && siloByKeyword.size > 0) {
        for (const [pk, siloName] of siloByKeyword) {
          if (kwLower.includes(pk) || pk.includes(kwLower)) {
            silo = siloName;
            break;
          }
        }
      }

      // (3) Match ranking_url against page slugs
      if (!silo && row.ranking_url) {
        const urlLower = String(row.ranking_url).toLowerCase();
        for (const [slug, siloName] of siloBySlug) {
          if (urlLower.includes(slug)) {
            silo = siloName;
            break;
          }
        }
      }

      if (silo) {
        await sb.from('audit_keywords').update({ cluster: silo }).eq('id', row.id);
        siloUpdated++;
      }
    }
    console.log(`  [michael] Backfilled cluster (silo) for ${siloUpdated} of ${(allKw ?? []).length} keywords`);
  }

  // Record snapshot and update staleness
  await sb.from('agent_runs').update({ snapshot_version: snapshotVersion }).eq('id', agentRunId);
  await recordSnapshot(sb, auditId, 'michael', snapshotVersion, agentRunId, pages.length);
  await updateStalenessTimestamp(sb, auditId, 'michael');

  return agentRunId;
}

// ============================================================
// Pam sync — content/{date}/{slug}/metadata.md + schema.json + content_outline.md
// ============================================================

function extractMetadataField(md: string, field: string): string | null {
  // Match patterns like "## Meta Title\n\n**Content**" or "## Meta Title\n\nContent"
  const regex = new RegExp(`##\\s*${field}[\\s\\S]*?\\n\\n([^#]+?)(?=\\n##|\\n#|$)`, 'i');
  const match = md.match(regex);
  if (!match) return null;
  // Clean up: remove markdown formatting, take first meaningful line
  const lines = match[1].trim().split('\n').filter((l) => l.trim());
  for (const line of lines) {
    const cleaned = line.replace(/\*\*/g, '').replace(/`/g, '').trim();
    if (cleaned && !cleaned.startsWith('(') && !cleaned.startsWith('Char') && !cleaned.startsWith('Rationale')) {
      return cleaned;
    }
  }
  return null;
}

function extractWordCountTarget(md: string): number | null {
  // Look for "Estimated Total Word Count" or similar
  const match = md.match(/(?:estimated|target|total)\s+(?:total\s+)?word\s+count[:\s]*(\d[\d,]*)/i);
  if (match) return parseInt(match[1].replace(/,/g, ''), 10);
  // Fallback: sum section word counts from table
  const tableMatch = md.match(/word\s*count.*?\n\|[-\s|]+\n((?:\|.+\n?)*)/i);
  if (tableMatch) {
    const rows = tableMatch[1].trim().split('\n');
    let total = 0;
    for (const row of rows) {
      const nums = row.match(/(\d[\d,]*)/g);
      if (nums) {
        total += parseInt(nums[nums.length - 1].replace(/,/g, ''), 10) || 0;
      }
    }
    if (total > 0) return total;
  }
  return null;
}

async function syncPam(
  sb: SupabaseClient,
  auditId: string,
  domain: string,
  date: string | undefined
) {
  const base = path.join(AUDITS_BASE, domain, 'content');
  const dateStr = date ?? getLatestDateDir(base);
  if (!dateStr) {
    console.log('  [pam] No content directory found, skipping');
    return null;
  }

  const contentDir = path.join(base, dateStr);
  if (!fs.existsSync(contentDir)) {
    console.log('  [pam] Content directory does not exist, skipping');
    return null;
  }

  // Each subdirectory under content/{date}/ is a page slug
  const slugDirs = fs.readdirSync(contentDir).filter((e) => {
    const full = path.join(contentDir, e);
    return fs.statSync(full).isDirectory();
  });

  if (slugDirs.length === 0) {
    console.log('  [pam] No page slug directories found, skipping');
    return null;
  }

  console.log(`  [pam] Found ${slugDirs.length} page slugs: ${slugDirs.join(', ')}`);

  const snapshotVersion = await getNextSnapshotVersion(sb, auditId, 'pam');

  // Also write to legacy table for backward compat
  await sb.from('agent_implementation_pages').delete().eq('audit_id', auditId);

  const runDate = dateStr;
  const { data: run } = await sb.from('agent_runs').insert({
    audit_id: auditId,
    agent_name: 'pam',
    run_date: runDate,
    status: 'completed',
    source_path: path.relative(AUDITS_BASE, contentDir),
    snapshot_version: snapshotVersion,
    metadata: { page_count: slugDirs.length },
  }).select('id').single();

  const agentRunId = run?.id ?? null;

  const pageRecords = [];
  for (const slug of slugDirs) {
    const slugPath = path.join(contentDir, slug);
    const metadataFile = path.join(slugPath, 'metadata.md');
    const schemaFile = path.join(slugPath, 'schema.json');
    const outlineFile = path.join(slugPath, 'content_outline.md');

    const metadataMd = fs.existsSync(metadataFile) ? fs.readFileSync(metadataFile, 'utf-8') : null;
    const schemaMd = fs.existsSync(schemaFile) ? fs.readFileSync(schemaFile, 'utf-8') : null;
    const outlineMd = fs.existsSync(outlineFile) ? fs.readFileSync(outlineFile, 'utf-8') : null;

    let schemaJson = null;
    if (schemaMd) {
      try {
        schemaJson = JSON.parse(schemaMd);
      } catch {
        console.log(`  [pam] Warning: invalid JSON in ${schemaFile}`);
      }
    }

    const metaTitle = metadataMd ? extractMetadataField(metadataMd, 'Meta Title') : null;
    const metaDesc = metadataMd ? extractMetadataField(metadataMd, 'Meta Description') : null;
    const h1 = metadataMd ? extractMetadataField(metadataMd, 'H1 Tag') : null;
    const intent = metadataMd ? extractMetadataField(metadataMd, 'Intent Classification') : null;
    const wordCount = outlineMd ? extractWordCountTarget(outlineMd) : null;

    pageRecords.push({
      audit_id: auditId,
      agent_run_id: agentRunId,
      url_slug: slug,
      meta_title: metaTitle,
      meta_description: metaDesc,
      h1_recommendation: h1,
      intent_classification: intent?.toLowerCase() ?? null,
      metadata_markdown: metadataMd,
      schema_json: schemaJson,
      content_outline_markdown: outlineMd,
      target_word_count: wordCount,
    });
  }

  // Write to legacy agent_implementation_pages (backward compat)
  if (pageRecords.length > 0) {
    const { error } = await sb.from('agent_implementation_pages').insert(pageRecords);
    if (error) throw new Error(`implementation pages insert failed: ${error.message}`);
    console.log(`  [pam] Inserted ${pageRecords.length} legacy implementation pages`);
  }

  // Upsert into execution_pages: update Pam fields, preserve page_brief and status
  for (const rec of pageRecords) {
    // Match existing record by slug (handle legacy leading-slash variants)
    const slug = rec.url_slug.replace(/^\/+/, '');
    const { data: existing } = await sb
      .from('execution_pages')
      .select('id, status')
      .eq('audit_id', auditId)
      .or(`url_slug.eq.${slug},url_slug.eq./${slug}`)
      .maybeSingle();

    const pamFields = {
      url_slug: slug, // normalize
      meta_title: rec.meta_title,
      meta_description: rec.meta_description,
      h1_recommendation: rec.h1_recommendation,
      intent_classification: rec.intent_classification,
      metadata_markdown: rec.metadata_markdown,
      schema_json: rec.schema_json,
      content_outline_markdown: rec.content_outline_markdown,
      target_word_count: rec.target_word_count,
      agent_run_id: agentRunId,
      snapshot_version: snapshotVersion,
    };

    if (existing) {
      // Promote not_started → brief_ready now that Pam has content; preserve other statuses
      const statusUpdate = (existing as any).status === 'not_started' ? { status: 'brief_ready' as const } : {};
      await sb.from('execution_pages').update({ ...pamFields, ...statusUpdate }).eq('id', (existing as any).id);
    } else {
      // New page from Pam — brief_ready since content already exists
      await sb.from('execution_pages').insert({
        audit_id: auditId,
        status: 'brief_ready',
        ...pamFields,
      });
    }
  }
  console.log(`  [pam] Upserted ${pageRecords.length} execution pages`);

  // Record snapshot and update staleness
  await recordSnapshot(sb, auditId, 'pam', snapshotVersion, agentRunId, pageRecords.length);
  await updateStalenessTimestamp(sb, auditId, 'pam');

  return agentRunId;
}

// ============================================================
// Main orchestrator
// ============================================================

const AGENT_ORDER = ['jim', 'dwight', 'michael', 'pam'] as const;
const PIPELINE_STATUS: Record<string, string> = {
  jim: 'research',
  dwight: 'audit',
  michael: 'architecture',
  pam: 'complete',
};

async function main() {
  const args = parseArgs();
  const env = loadEnv();

  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }

  const sb = createClient(supabaseUrl, serviceRoleKey);

  console.log(`\nSync Bridge — ${args.domain}`);
  console.log('='.repeat(50));

  // Resolve user ID from email
  const { data: userData } = await sb.auth.admin.listUsers();
  const user = userData?.users?.find((u: any) => u.email === args.userEmail);
  if (!user) {
    console.error(`User not found: ${args.userEmail}`);
    process.exit(1);
  }
  console.log(`User: ${args.userEmail} (${user.id})`);

  // Find or create audit record for this domain
  let { data: audit } = await sb
    .from('audits')
    .select('*')
    .eq('domain', args.domain)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!audit) {
    console.log('No existing audit found — creating one');
    const { data: newAudit, error } = await sb.from('audits').insert({
      user_id: user.id,
      domain: args.domain,
      service_key: 'plumbing',
      market_city: 'Boise',
      market_state: 'ID',
      status: 'draft',
      agent_pipeline_domain: args.domain,
    }).select().single();
    if (error) throw new Error(`Failed to create audit: ${error.message}`);
    audit = newAudit;
  }

  console.log(`Audit ID: ${audit!.id}`);

  // Determine which agents to sync
  const agentsToSync = args.agents.length > 0
    ? AGENT_ORDER.filter((a) => args.agents.includes(a))
    : AGENT_ORDER.filter(() => true); // all

  let lastCompletedAgent: string | null = null;

  for (const agent of agentsToSync) {
    // Skip Jim keywords if --skip-keywords
    if (agent === 'jim' && args.skipKeywords) {
      console.log(`\n[jim] Skipped (--skip-keywords)`);
      continue;
    }

    console.log(`\n--- ${agent.toUpperCase()} ---`);

    try {
      let runId: string | null = null;

      switch (agent) {
        case 'jim':
          runId = await syncJim(sb, audit!.id, args.domain, args.date);
          break;
        case 'dwight':
          runId = await syncDwight(sb, audit!.id, args.domain, args.date);
          break;
        case 'michael':
          runId = await syncMichael(sb, audit!.id, args.domain, args.date);
          break;
        case 'pam':
          runId = await syncPam(sb, audit!.id, args.domain, args.date);
          break;
      }

      if (runId) {
        lastCompletedAgent = agent;
      }
    } catch (err) {
      console.error(`  [${agent}] ERROR:`, err instanceof Error ? err.message : err);
      // Record failed run
      await sb.from('agent_runs').insert({
        audit_id: audit!.id,
        agent_name: agent,
        run_date: args.date ?? new Date().toISOString().slice(0, 10),
        status: 'failed',
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // Update pipeline status
  if (lastCompletedAgent) {
    const pipelineStatus = PIPELINE_STATUS[lastCompletedAgent] ?? lastCompletedAgent;
    await sb.from('audits').update({
      agent_pipeline_status: pipelineStatus,
      agent_pipeline_domain: args.domain,
    }).eq('id', audit!.id);
    console.log(`\nPipeline status: ${pipelineStatus}`);
  }

  // Set audit to completed if it has keywords
  if (agentsToSync.includes('jim') && !args.skipKeywords) {
    const { count } = await sb.from('audit_keywords').select('id', { count: 'exact', head: true }).eq('audit_id', audit!.id);
    if ((count ?? 0) > 0) {
      await sb.from('audits').update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      }).eq('id', audit!.id);
    }
  }

  console.log('\nSync complete.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
