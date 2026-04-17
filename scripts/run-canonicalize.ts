#!/usr/bin/env npx tsx
/**
 * run-canonicalize.ts — Standalone runner for Phase 3c (Canonicalize) + Phase 3d (Rebuild Clusters).
 *
 * Runs re-canonicalization without executing the full pipeline. Used by the
 * /recanonicalize endpoint when operators change keyword groupings or want
 * to refresh cluster structure.
 *
 * Usage:
 *   npx tsx scripts/run-canonicalize.ts --domain <domain> --user-email <email>
 *
 * Environment variables (from .env or process.env):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_KEY
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
  canonicalizeMode: 'legacy' | 'hybrid' | 'shadow';
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
    console.error('Usage: npx tsx scripts/run-canonicalize.ts --domain <domain> --user-email <email> [--canonicalize-mode legacy|hybrid|shadow]');
    process.exit(1);
  }

  const cmRaw = flags['canonicalize-mode'];
  const canonicalizeMode = (['legacy', 'hybrid', 'shadow'].includes(cmRaw) ? cmRaw : 'legacy') as CliArgs['canonicalizeMode'];

  return {
    domain: flags.domain,
    userEmail: flags['user-email'],
    canonicalizeMode,
  };
}

// ============================================================
// .env loader (same pattern as track-rankings.ts)
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
// Main
// ============================================================

async function main() {
  const { domain, userEmail, canonicalizeMode } = parseArgs();
  const env = loadEnv();

  // Validate env
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = env.ANTHROPIC_KEY || env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  if (!anthropicKey) {
    console.error('Missing ANTHROPIC_KEY');
    process.exit(1);
  }

  // Set process.env for modules that read it (callClaude, embeddings service)
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || anthropicKey;
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || supabaseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseKey;
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY;

  const sb = createClient(supabaseUrl, supabaseKey);
  const { audit } = await resolveAudit(sb, domain, userEmail);
  const auditId = audit.id;

  console.log(`Re-canonicalize: ${domain} (audit ${auditId}) [mode=${canonicalizeMode}]`);

  // Phase 3c: Canonicalize
  console.log('\n=== Phase 3c: Canonicalize ===');
  const { runCanonicalize } = await import('./pipeline-generate.js');
  await runCanonicalize(sb, auditId, domain, canonicalizeMode);

  // Phase 3d: Rebuild clusters + rollups (with status preservation)
  console.log('\n=== Phase 3d: Rebuild Clusters ===');
  const { rebuildClustersAndRollups } = await import('./sync-to-dashboard.js');
  await rebuildClustersAndRollups(sb, auditId, 'recanonicalize');

  // Re-backfill canonical_key on execution_pages
  console.log('\n=== Re-backfill execution_pages canonical_key ===');
  const pkToCanonical = new Map<string, string>();
  const { data: kwWithCanonical } = await sb
    .from('audit_keywords')
    .select('keyword, canonical_key')
    .eq('audit_id', auditId)
    .not('canonical_key', 'is', null);
  for (const row of (kwWithCanonical ?? []) as any[]) {
    pkToCanonical.set(String(row.keyword).toLowerCase().trim(), row.canonical_key);
  }

  const { data: pages } = await sb
    .from('execution_pages')
    .select('id, url_slug, primary_keyword')
    .eq('audit_id', auditId);

  let canonicalUpdated = 0;
  for (const p of (pages ?? []) as any[]) {
    const pk = (p.primary_keyword ?? '').toLowerCase().trim();
    const ck = pkToCanonical.get(pk);
    if (ck) {
      // BUG-1 fix: use normalized slug with .eq() instead of broken .or() syntax
      const slug = p.url_slug.replace(/^\/+/, '');
      await sb.from('execution_pages').update({ canonical_key: ck })
        .eq('audit_id', auditId)
        .eq('url_slug', slug);
      canonicalUpdated++;
    }
  }
  console.log(`  Re-backfilled canonical_key for ${canonicalUpdated} of ${(pages ?? []).length} pages`);

  // Log agent_runs entry (DATA-5: fixed field names to match schema)
  await sb.from('agent_runs').insert({
    audit_id: auditId,
    agent_name: 'recanonicalize',
    run_date: new Date().toISOString().slice(0, 10),
    status: 'completed',
    metadata: { notes: `Re-canonicalized ${domain}: ${canonicalUpdated} pages updated` },
  });

  console.log(`\nRe-canonicalize complete: ${domain}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Re-canonicalize failed:', err);
  process.exit(1);
});
