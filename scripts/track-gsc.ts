/**
 * track-gsc.ts — Weekly GSC refresh, mirrors track-rankings.ts structure.
 *
 * Usage:
 *   npx tsx scripts/track-gsc.ts --domain <domain> --user-email <email> [--force]
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_SERVICE_ACCOUNT_JSON
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGscFetch } from './fetch-gsc-data.js';

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
    console.error('Usage: npx tsx scripts/track-gsc.ts --domain <domain> --user-email <email> [--force]');
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
// Main
// ============================================================

async function trackGsc(cliArgs: CliArgs) {
  const env = loadEnv();

  // Set env vars for google-auth.ts
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
  const snapshotDate = todayStr();

  console.log(`\n=== GSC Tracker: ${cliArgs.domain} (${snapshotDate}) ===\n`);

  // 1. Resolve audit
  const { audit } = await resolveAudit(sb, cliArgs.domain, cliArgs.userEmail);
  console.log(`  Audit: ${audit.id} (status: ${(audit as any).status})`);

  if ((audit as any).status !== 'completed') {
    console.log(`  Skipping — audit status is '${(audit as any).status}', not 'completed'`);
    return;
  }

  // 2. Recency check
  if (!cliArgs.force) {
    const { data: latestSnapshot } = await (sb as any)
      .from('gsc_page_snapshots')
      .select('snapshot_date')
      .eq('audit_id', audit.id)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestSnapshot) {
      const days = daysSince(latestSnapshot.snapshot_date);
      if (days < 6) {
        console.log(`  Skipping — GSC snapshot taken ${days} days ago (< 6 day threshold). Use --force to override.`);
        return;
      }
    }
  }

  // 3. Run GSC fetch
  const outputDir = path.join(AUDITS_BASE, cliArgs.domain, 'research', snapshotDate);
  const success = await runGscFetch(cliArgs.domain, audit.id, outputDir, sb);

  // 4. Log agent_runs
  await sb.from('agent_runs').insert({
    audit_id: audit.id,
    agent_name: 'gsc_tracker',
    run_date: snapshotDate,
    status: success ? 'completed' : 'skipped',
    metadata: {
      snapshot_date: snapshotDate,
      success,
    },
  });

  if (success) {
    console.log(`\n  Done. GSC snapshot ${snapshotDate} for ${cliArgs.domain} complete.\n`);
  } else {
    console.log(`\n  GSC tracking skipped for ${cliArgs.domain} (no connection or no data).\n`);
  }
}

const args = parseArgs();
trackGsc(args).catch((err) => {
  console.error(`\nFATAL: ${err.message}\n`);
  process.exit(1);
});
