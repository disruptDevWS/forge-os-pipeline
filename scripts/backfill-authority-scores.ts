#!/usr/bin/env npx tsx
/**
 * backfill-authority-scores.ts — One-time backfill to compute authority scores
 * for all existing cluster_performance_snapshots rows.
 *
 * Uses audit_keywords as the denominator (full addressable keyword set) since
 * older snapshots may not have contained all keywords.
 *
 * Usage:
 *   npx tsx scripts/backfill-authority-scores.ts
 *   npx tsx scripts/backfill-authority-scores.ts --domain <domain>
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
// Authority score helpers (same as track-rankings.ts)
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
// Main
// ============================================================

async function main() {
  const env = loadEnv();
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const sb = createClient(supabaseUrl, supabaseKey);

  // Parse optional --domain flag
  const args = process.argv.slice(2);
  let domainFilter: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--domain' && args[i + 1]) {
      domainFilter = args[i + 1];
    }
  }

  // Find audits with existing snapshots
  let auditQuery = sb
    .from('audits')
    .select('id, domain')
    .eq('status', 'completed');
  if (domainFilter) {
    auditQuery = auditQuery.eq('domain', domainFilter);
  }
  const { data: audits, error: auditErr } = await auditQuery;
  if (auditErr) throw new Error(`Failed to load audits: ${auditErr.message}`);
  if (!audits || audits.length === 0) {
    console.log('No audits found.');
    return;
  }

  console.log(`Processing ${audits.length} audit(s)...\n`);

  for (const audit of audits) {
    const auditId = audit.id;
    console.log(`=== ${audit.domain} (${auditId}) ===`);

    // Load full addressable keyword set per canonical_key
    const { data: kwData } = await sb
      .from('audit_keywords')
      .select('keyword, canonical_key')
      .eq('audit_id', auditId)
      .not('canonical_key', 'is', null);

    const addressableByCluster = new Map<string, Set<string>>();
    for (const kw of kwData ?? []) {
      if (!kw.canonical_key) continue;
      if (!addressableByCluster.has(kw.canonical_key)) {
        addressableByCluster.set(kw.canonical_key, new Set());
      }
      addressableByCluster.get(kw.canonical_key)!.add(kw.keyword.toLowerCase().trim());
    }

    if (addressableByCluster.size === 0) {
      console.log('  No canonical_key keywords — skipping');
      continue;
    }

    // Get distinct snapshot dates
    const { data: snapDates } = await sb
      .from('cluster_performance_snapshots')
      .select('snapshot_date')
      .eq('audit_id', auditId)
      .order('snapshot_date', { ascending: true });

    const dates = [...new Set((snapDates ?? []).map((r: any) => r.snapshot_date))];
    if (dates.length === 0) {
      console.log('  No snapshot dates — skipping');
      continue;
    }

    console.log(`  ${dates.length} snapshot date(s), ${addressableByCluster.size} clusters`);

    let prevScoreMap = new Map<string, number>();

    for (const snapshotDate of dates) {
      // Load ranking_snapshots for this date
      const { data: rankings } = await sb
        .from('ranking_snapshots')
        .select('keyword, rank_position, canonical_key')
        .eq('audit_id', auditId)
        .eq('snapshot_date', snapshotDate);

      // Build position lookup: keyword → rank_position
      const positionByKeyword = new Map<string, number | null>();
      for (const r of rankings ?? []) {
        positionByKeyword.set(r.keyword.toLowerCase().trim(), r.rank_position);
      }

      // Compute authority score per cluster using audit_keywords as denominator
      const currentScoreMap = new Map<string, number>();
      for (const [canonicalKey, keywords] of addressableByCluster.entries()) {
        const kwPositions = [...keywords].map((kw) => ({
          rank_position: positionByKeyword.get(kw) ?? null,
        }));
        const score = computeAuthorityScore(kwPositions);
        currentScoreMap.set(canonicalKey, score);

        const prevScore = prevScoreMap.get(canonicalKey);
        const delta = prevScore !== undefined
          ? Math.round((score - prevScore) * 10) / 10
          : null;

        // Update the cluster_performance_snapshots row
        await sb
          .from('cluster_performance_snapshots')
          .update({
            authority_score: score,
            authority_score_delta: delta,
          })
          .eq('audit_id', auditId)
          .eq('snapshot_date', snapshotDate)
          .eq('canonical_key', canonicalKey);
      }

      prevScoreMap = currentScoreMap;
    }

    // Update audit_clusters with the latest score (from the most recent snapshot date)
    const latestDate = dates[dates.length - 1];
    const { data: latestScores } = await sb
      .from('cluster_performance_snapshots')
      .select('canonical_key, authority_score')
      .eq('audit_id', auditId)
      .eq('snapshot_date', latestDate);

    let updated = 0;
    for (const row of latestScores ?? []) {
      if (row.canonical_key && row.authority_score !== null) {
        await sb.from('audit_clusters')
          .update({
            authority_score: row.authority_score,
            authority_score_updated_at: new Date().toISOString(),
          })
          .eq('audit_id', auditId)
          .eq('canonical_key', row.canonical_key);
        updated++;
      }
    }

    console.log(`  Backfilled ${dates.length} date(s), updated ${updated} cluster(s)\n`);
  }

  console.log('Backfill complete.');
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
