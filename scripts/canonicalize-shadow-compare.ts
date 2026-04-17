#!/usr/bin/env npx tsx
/**
 * canonicalize-shadow-compare.ts — Diff report for shadow-mode canonicalize output.
 *
 * Usage: npm run canonicalize:shadow-compare -- --audit-id <uuid>
 *
 * Reads audit_keywords for a given audit_id and compares legacy clustering
 * (canonical_key, canonical_topic) vs shadow-hybrid clustering
 * (shadow_canonical_key, shadow_canonical_topic).
 *
 * Shadow mode writes hybrid output to shadow_* columns, leaving legacy
 * output in the primary columns untouched. This script diffs the two.
 *
 * Only compares clustering output since hybrid mode handles only
 * canonical_key/canonical_topic.
 *
 * Environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createClient } from '@supabase/supabase-js';

// ── Env loading ──────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), '.env');
  const env: Record<string, string> = {};
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  }
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined && !env[key]) env[key] = val;
  }
  return env;
}

// ── CLI parsing ──────────────────────────────────────────────

function parseArgs(): { auditId: string } {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      }
    }
  }

  if (!flags['audit-id']) {
    console.error('Usage: npx tsx scripts/canonicalize-shadow-compare.ts --audit-id <uuid>');
    process.exit(1);
  }

  return { auditId: flags['audit-id'] };
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { auditId } = parseArgs();
  const env = loadEnv();

  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const sb = createClient(supabaseUrl, supabaseKey);

  // Fetch all keywords with both legacy and shadow columns
  const { data: keywords, error } = await (sb as any)
    .from('audit_keywords')
    .select('id, keyword, canonical_key, canonical_topic, shadow_canonical_key, shadow_canonical_topic, shadow_classification_method, shadow_similarity_score, shadow_arbitration_reason, canonicalize_mode')
    .eq('audit_id', auditId);

  if (error) {
    console.error(`Failed to fetch keywords: ${error.message}`);
    process.exit(1);
  }

  if (!keywords || keywords.length === 0) {
    console.error(`No keywords found for audit ${auditId}`);
    process.exit(1);
  }

  // Check if shadow data exists
  const withShadow = keywords.filter((kw: any) => kw.shadow_canonical_key !== null);
  if (withShadow.length === 0) {
    console.log(`# Shadow Comparison Report — Audit ${auditId}\n`);
    console.log('No shadow output found. Run canonicalize with `--canonicalize-mode shadow` first.');
    console.log(`Total keywords: ${keywords.length}`);
    return;
  }

  // ── Comparison ─────────────────────────────────────────────

  const agreed: Array<{ keyword: string; topic: string }> = [];
  const disagreed: Array<{
    keyword: string;
    legacyKey: string;
    legacyTopic: string;
    hybridKey: string;
    hybridTopic: string;
    method: string;
    reason: string;
    score: number | null;
  }> = [];
  const legacyOnly: Array<{ keyword: string; topic: string }> = [];
  const hybridOnly: Array<{ keyword: string; topic: string; method: string }> = [];

  for (const kw of keywords) {
    const legacyKey = kw.canonical_key;
    const shadowKey = kw.shadow_canonical_key;

    if (legacyKey && shadowKey) {
      if (legacyKey === shadowKey) {
        agreed.push({ keyword: kw.keyword, topic: kw.canonical_topic });
      } else {
        disagreed.push({
          keyword: kw.keyword,
          legacyKey,
          legacyTopic: kw.canonical_topic ?? '(none)',
          hybridKey: shadowKey,
          hybridTopic: kw.shadow_canonical_topic ?? '(none)',
          method: kw.shadow_classification_method ?? 'unknown',
          reason: kw.shadow_arbitration_reason ?? '',
          score: kw.shadow_similarity_score,
        });
      }
    } else if (legacyKey && !shadowKey) {
      legacyOnly.push({ keyword: kw.keyword, topic: kw.canonical_topic ?? '(none)' });
    } else if (shadowKey && !legacyKey) {
      hybridOnly.push({
        keyword: kw.keyword,
        topic: kw.shadow_canonical_topic ?? '(none)',
        method: kw.shadow_classification_method ?? 'unknown',
      });
    }
  }

  // Count shadow classification methods
  const methodCounts = new Map<string, number>();
  for (const kw of withShadow) {
    const method = kw.shadow_classification_method ?? 'unknown';
    methodCounts.set(method, (methodCounts.get(method) ?? 0) + 1);
  }

  // ── Output ─────────────────────────────────────────────────

  const totalCompared = agreed.length + disagreed.length;
  const agreementRate =
    totalCompared > 0 ? ((agreed.length / totalCompared) * 100).toFixed(1) : 'N/A';

  console.log(`# Shadow Comparison Report — Audit ${auditId}\n`);
  console.log(`## Summary\n`);
  console.log(`| Metric | Value |`);
  console.log(`|--------|-------|`);
  console.log(`| Total keywords | ${keywords.length} |`);
  console.log(`| With shadow data | ${withShadow.length} |`);
  console.log(`| Without shadow data | ${keywords.length - withShadow.length} |`);
  console.log(`| Agreement rate | ${agreementRate}% (${agreed.length}/${totalCompared}) |`);
  console.log(`| Disagreements | ${disagreed.length} |`);
  console.log(`| Legacy-only (no shadow) | ${legacyOnly.length} |`);
  console.log(`| Shadow-only (no legacy) | ${hybridOnly.length} |`);
  console.log('');

  console.log(`## Classification Methods (shadow/hybrid path)\n`);
  console.log(`| Method | Count |`);
  console.log(`|--------|-------|`);
  for (const [method, count] of [...methodCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`| ${method} | ${count} |`);
  }

  const arbRate =
    withShadow.length > 0
      ? (
          ((methodCounts.get('sonnet_arbitration_assigned') ?? 0) +
            (methodCounts.get('sonnet_arbitration_new_topic') ?? 0) +
            (methodCounts.get('sonnet_arbitration_merged') ?? 0)) /
          withShadow.length *
          100
        ).toFixed(1)
      : 'N/A';
  const lockRate =
    withShadow.length > 0
      ? (((methodCounts.get('prior_assignment_locked') ?? 0) / withShadow.length) * 100).toFixed(1)
      : 'N/A';
  console.log('');
  console.log(`Sonnet arbitration rate: ${arbRate}%`);
  console.log(`Prior-lock rate: ${lockRate}%`);
  console.log('');

  if (disagreed.length > 0) {
    console.log(`## Disagreements\n`);
    console.log(
      `| Keyword | Legacy | Hybrid | Method | Score | Reason |`,
    );
    console.log(
      `|---------|--------|--------|--------|-------|--------|`,
    );
    for (const d of disagreed.slice(0, 50)) {
      const score = d.score !== null ? d.score.toFixed(4) : '\u2014';
      console.log(
        `| ${d.keyword.slice(0, 40)} | ${d.legacyTopic} | ${d.hybridTopic} | ${d.method} | ${score} | ${d.reason.slice(0, 50)} |`,
      );
    }
    if (disagreed.length > 50) {
      console.log(`\n_...and ${disagreed.length - 50} more disagreements_`);
    }
    console.log('');
  }

  if (legacyOnly.length > 0 && legacyOnly.length <= 20) {
    console.log(`## Legacy-Only (no shadow classification)\n`);
    for (const l of legacyOnly) {
      console.log(`- "${l.keyword}" \u2192 ${l.topic}`);
    }
    console.log('');
  } else if (legacyOnly.length > 20) {
    console.log(`## Legacy-Only: ${legacyOnly.length} keywords (too many to list)\n`);
  }

  if (hybridOnly.length > 0 && hybridOnly.length <= 20) {
    console.log(`## Hybrid-Only (no legacy classification)\n`);
    for (const h of hybridOnly) {
      console.log(`- "${h.keyword}" \u2192 ${h.topic} (${h.method})`);
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error('Comparison failed:', err);
  process.exit(1);
});
