#!/usr/bin/env npx tsx
/**
 * track-llm-mentions.ts — Standalone LLM visibility tracker.
 * Fetches current AI platform mention data for a domain and writes to Supabase.
 *
 * Usage:
 *   npx tsx scripts/track-llm-mentions.ts --domain <domain> --user-email <email>
 *   npx tsx scripts/track-llm-mentions.ts --domain <domain> --user-email <email> --force
 *
 * Environment variables (from .env or process.env):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fetchDomainMentions } from './dataforseo-llm-mentions.js';

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
    console.error('Usage: npx tsx scripts/track-llm-mentions.ts --domain <domain> --user-email <email> [--force]');
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

function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function daysSince(dateStr: string): number {
  const then = new Date(dateStr);
  const now = new Date();
  return Math.floor((now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24));
}

function nextDay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
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
// Main tracking logic
// ============================================================

async function trackLlmMentions(cliArgs: CliArgs) {
  const env = loadEnv();
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');

  const sb = createClient(supabaseUrl, supabaseKey);
  const snapshotDate = todayStr();

  console.log(`\n=== LLM Visibility Tracker: ${cliArgs.domain} (${snapshotDate}) ===\n`);

  // 1. Resolve audit
  const { audit } = await resolveAudit(sb, cliArgs.domain, cliArgs.userEmail);
  console.log(`  Audit: ${audit.id} (status: ${audit.status})`);

  if (audit.status !== 'completed') {
    console.log(`  Skipping — audit status is '${audit.status}', not 'completed'`);
    return;
  }

  // 2. Recency check (25-day threshold for monthly tracking)
  const { data: latestSnapshot } = await (sb as any)
    .from('llm_visibility_snapshots')
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

  // 3. Select keywords from audit_keywords (top 5 by volume)
  const { data: auditKeywords, error: kwErr } = await sb
    .from('audit_keywords')
    .select('keyword, search_volume, rank_pos, is_brand, is_near_me')
    .eq('audit_id', audit.id)
    .order('search_volume', { ascending: false });

  if (kwErr) throw new Error(`Failed to load audit_keywords: ${kwErr.message}`);

  const keywords = (auditKeywords ?? [])
    .filter((kw: any) => !kw.is_brand && !kw.is_near_me && (kw.rank_pos ?? 100) <= 30)
    .slice(0, 5)
    .map((kw: any) => kw.keyword);

  if (keywords.length === 0) {
    console.log('  No qualifying keywords found — skipping');
    return;
  }

  console.log(`  Selected ${keywords.length} keywords: ${keywords.join(', ')}`);

  // 4. Fetch domain mentions (no competitor re-check on cron — cost control)
  const { mentions, cost } = await fetchDomainMentions(env, cliArgs.domain, keywords);
  console.log(`  Fetched ${mentions.length} mention records ($${cost.toFixed(4)})`);

  // 5. Write to Supabase
  // Clear existing rows for this audit + date
  await (sb as any).from('llm_visibility_snapshots')
    .delete()
    .eq('audit_id', audit.id)
    .eq('snapshot_date', snapshotDate)
    .eq('domain', cliArgs.domain);

  await (sb as any).from('llm_mention_details')
    .delete()
    .eq('audit_id', audit.id)
    .gte('captured_at', `${snapshotDate}T00:00:00Z`)
    .lt('captured_at', `${nextDay(snapshotDate)}T00:00:00Z`);

  // Insert visibility snapshots
  const visRecords = mentions.map((m) => ({
    audit_id: audit.id,
    domain: cliArgs.domain,
    snapshot_date: snapshotDate,
    keyword: m.keyword,
    platform: m.platform,
    mention_count: m.mention_count,
    ai_search_volume: m.ai_search_volume || null,
    top_citation_domains: m.citation_sources,
    is_estimated: false,
  }));

  if (visRecords.length > 0) {
    const { error } = await (sb as any).from('llm_visibility_snapshots').upsert(visRecords, {
      onConflict: 'audit_id,snapshot_date,keyword,platform,domain',
    });
    if (error) throw new Error(`llm_visibility_snapshots upsert failed: ${error.message}`);
  }

  // Insert mention details
  const detailRecords: any[] = [];
  for (const m of mentions) {
    for (const text of m.mention_texts) {
      detailRecords.push({
        audit_id: audit.id,
        keyword: m.keyword,
        platform: m.platform,
        mention_text: text,
        citation_urls: [],
        source_domains: m.citation_sources,
      });
    }
  }

  if (detailRecords.length > 0) {
    const { error } = await (sb as any).from('llm_mention_details').insert(detailRecords);
    if (error) console.warn(`  llm_mention_details insert warning: ${error.message}`);
  }

  console.log(`  Written ${visRecords.length} snapshot records, ${detailRecords.length} detail records`);

  // 6. Log agent_runs
  await sb.from('agent_runs').insert({
    audit_id: audit.id,
    agent_name: 'llm_visibility_tracker',
    run_date: snapshotDate,
    status: 'completed',
    metadata: {
      keyword_count: keywords.length,
      mention_count: mentions.reduce((s, m) => s + m.mention_count, 0),
      cost,
      snapshot_date: snapshotDate,
    },
  });

  console.log(`\n  Done. LLM visibility snapshot ${snapshotDate} for ${cliArgs.domain} complete.\n`);
}

// ============================================================
// Entry point
// ============================================================

const args = parseArgs();
trackLlmMentions(args).catch((err) => {
  console.error(`\nFATAL: ${err.message}\n`);
  process.exit(1);
});
