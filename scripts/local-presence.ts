#!/usr/bin/env npx tsx
/**
 * local-presence.ts — Phase 6d: Local Presence Diagnostic (GBP + Citations)
 *
 * Queries DataForSEO for the client's GBP listing, extracts canonical NAP,
 * then checks citation presence across major directories via SERP-based detection.
 *
 * Usage:
 *   npx tsx scripts/local-presence.ts --domain <domain> --user-email <email>
 *   npx tsx scripts/local-presence.ts --domain <domain> --user-email <email> --force
 *
 * Environment variables (from .env or process.env):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  fetchGBPListing,
  scanCitations,
  expandState,
  type CanonicalNAP,
  type GBPResult,
  type CitationResult,
} from './dataforseo-business.js';

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
    console.error(
      'Usage: npx tsx scripts/local-presence.ts --domain <domain> --user-email <email> [--force]',
    );
    process.exit(1);
  }

  return {
    domain: flags.domain,
    userEmail: flags['user-email'],
    force: flags.force === 'true',
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
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
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

/**
 * Derive a business name from domain as last-resort fallback.
 * Splits on hyphens and known service/industry words.
 * E.g., "veteransplumbingcorp.com" → "Veterans Plumbing Corp"
 */
function domainToBusinessName(domain: string): string {
  let name = domain.replace(/\.(com|net|org|io|co|biz|us)$/i, '');
  // Split on hyphens, underscores, dots
  name = name.replace(/[-_.]/g, ' ');
  // Insert space before camelCase transitions
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  // Insert spaces around known service/industry words embedded in the string
  const serviceWords = [
    'plumbing', 'plumbers', 'heating', 'cooling', 'electric', 'electrical',
    'roofing', 'construction', 'medical', 'service', 'services', 'academy',
    'hvac', 'air', 'mechanical', 'restoration', 'fencing', 'landscaping',
    'veterans', 'boise', 'idaho', 'fox', 'talon', 'summit',
    'corp', 'inc', 'llc', 'pro', 'group', 'co',
  ];
  // Iteratively split: find longest matching word at each position
  const lower = name.toLowerCase().replace(/\s+/g, '');
  const words: string[] = [];
  let i = 0;
  while (i < lower.length) {
    let matched = false;
    // Try longest match first
    for (let len = Math.min(12, lower.length - i); len >= 2; len--) {
      const candidate = lower.slice(i, i + len);
      if (serviceWords.includes(candidate)) {
        words.push(candidate);
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Accumulate into current word or start new
      if (words.length === 0) words.push('');
      words[words.length - 1] += lower[i];
      i++;
    }
  }
  // Title case each word
  return words
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ============================================================
// Main logic
// ============================================================

async function runLocalPresence(cliArgs: CliArgs) {
  const env = loadEnv();
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');

  const sb = createClient(supabaseUrl, supabaseKey);
  const snapshotDate = todayStr();

  console.log(`\n=== Local Presence Diagnostic: ${cliArgs.domain} (${snapshotDate}) ===\n`);

  // 1. Resolve audit
  const { audit } = await resolveAudit(sb, cliArgs.domain, cliArgs.userEmail);
  console.log(`  Audit: ${audit.id} (status: ${audit.status})`);

  // 2. Recency check
  const { data: latestGbp } = await sb
    .from('gbp_snapshots')
    .select('snapshot_date')
    .eq('audit_id', audit.id)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestGbp && !cliArgs.force) {
    const days = daysSince(latestGbp.snapshot_date);
    if (days < 6) {
      console.log(`  Skipping — snapshot taken ${days} days ago (< 6 day threshold). Use --force to override.`);
      return;
    }
  }

  // 3. Resolve business name: audit.business_name → client_profiles.canonical_name → domain-derived
  let businessName = audit.business_name;

  if (!businessName) {
    const { data: profile } = await sb
      .from('client_profiles')
      .select('canonical_name')
      .eq('audit_id', audit.id)
      .maybeSingle();
    businessName = profile?.canonical_name || null;
  }

  if (!businessName) {
    businessName = domainToBusinessName(cliArgs.domain);
    console.log(`  WARNING: No business_name found, using domain-derived: "${businessName}"`);
  }

  const city = audit.market_city?.split(',')[0]?.trim() || '';
  const stateRaw = audit.market_state || '';
  const state = expandState(stateRaw);
  if (!city || !state) {
    console.log(`  WARNING: market_city or market_state missing on audit. GBP lookup may be less precise.`);
  }

  console.log(`  Business: "${businessName}", Location: ${city}, ${state}`);

  // 4. Fetch GBP listing
  console.log('\n--- GBP Lookup ---');
  const gbp: GBPResult = await fetchGBPListing(env, businessName, city, state);

  // Build canonical NAP from GBP, or fall back to client_profiles
  let canonicalNAP: CanonicalNAP = {
    name: gbp.canonical_name,
    address: gbp.canonical_address,
    phone: gbp.canonical_phone,
  };

  if (!gbp.listing_found) {
    console.log('  GBP not found — checking client_profiles for manual NAP...');
    const { data: profile } = await sb
      .from('client_profiles')
      .select('canonical_name, canonical_address, canonical_phone')
      .eq('audit_id', audit.id)
      .maybeSingle();

    if (profile?.canonical_name || profile?.canonical_address || profile?.canonical_phone) {
      canonicalNAP = {
        name: profile.canonical_name || businessName,
        address: profile.canonical_address || null,
        phone: profile.canonical_phone || null,
      };
      console.log('  Using client_profiles NAP as canonical.');
    } else {
      canonicalNAP = { name: businessName, address: null, phone: null };
      console.log('  No manual NAP — using business name only for citation matching.');
    }
  }

  // 5. Upsert gbp_snapshots (always — even when listing_found: false)
  const gbpRow = {
    audit_id: audit.id,
    snapshot_date: snapshotDate,
    listing_found: gbp.listing_found,
    match_confidence: gbp.match_confidence,
    matched_name: gbp.matched_name,
    category: gbp.category,
    additional_categories: gbp.additional_categories,
    rating: gbp.rating,
    review_count: gbp.review_count,
    photo_count: gbp.photo_count,
    is_claimed: gbp.is_claimed,
    website_url: gbp.website_url,
    work_hours: gbp.work_hours,
    attributes: gbp.attributes,
    canonical_name: canonicalNAP.name,
    canonical_address: canonicalNAP.address,
    canonical_phone: canonicalNAP.phone,
    cid: gbp.cid,
    place_id: gbp.place_id,
    gbp_missing: gbp.gbp_missing,
    raw_response: gbp.raw_response,
  };

  const { error: gbpErr } = await sb
    .from('gbp_snapshots')
    .upsert(gbpRow, { onConflict: 'audit_id,snapshot_date' });
  if (gbpErr) throw new Error(`gbp_snapshots upsert failed: ${gbpErr.message}`);
  console.log(`  GBP snapshot saved (listing_found: ${gbp.listing_found})`);

  // 6. Build Google citation row from GBP data (not SERP-scanned)
  const googleCitation: CitationResult = {
    directory_name: 'Google',
    directory_domain: 'google.com',
    listing_found: gbp.listing_found,
    listing_url: gbp.cid ? `https://maps.google.com/?cid=${gbp.cid}` : null,
    found_name: gbp.canonical_name,
    found_address: gbp.canonical_address,
    found_phone: gbp.canonical_phone,
    nap_match_name: gbp.listing_found ? true : null, // GBP IS the canonical source
    nap_match_address: gbp.listing_found ? true : null,
    nap_match_phone: gbp.listing_found ? true : null,
    nap_consistent: gbp.listing_found ? true : null,
    data_source: 'gbp',
    raw_snippet: null,
  };

  // 7. Scan citation directories via SERP
  console.log('\n--- Citation Scan (SERP) ---');
  const cityState = `${city}, ${state}`;
  const citationResults = await scanCitations(env, businessName, cityState, canonicalNAP);

  // 8. Combine Google + SERP citations (11 total)
  const allCitations = [googleCitation, ...citationResults];

  // 9. Batch upsert citation_snapshots
  const citationRows = allCitations.map((c) => ({
    audit_id: audit.id,
    snapshot_date: snapshotDate,
    directory_name: c.directory_name,
    directory_domain: c.directory_domain,
    listing_found: c.listing_found,
    listing_url: c.listing_url,
    found_name: c.found_name,
    found_address: c.found_address,
    found_phone: c.found_phone,
    nap_match_name: c.nap_match_name,
    nap_match_address: c.nap_match_address,
    nap_match_phone: c.nap_match_phone,
    nap_consistent: c.nap_consistent,
    data_source: c.data_source,
    raw_snippet: c.raw_snippet,
  }));

  const { error: citErr } = await sb
    .from('citation_snapshots')
    .upsert(citationRows, { onConflict: 'audit_id,snapshot_date,directory_name' });
  if (citErr) throw new Error(`citation_snapshots upsert failed: ${citErr.message}`);

  const foundCount = allCitations.filter((c) => c.listing_found).length;
  const napConsistentCount = allCitations.filter((c) => c.nap_consistent === true).length;
  console.log(`\n  Citations: ${foundCount}/${allCitations.length} found, ${napConsistentCount} NAP-consistent`);

  // 10. Log agent_runs
  await sb.from('agent_runs').insert({
    audit_id: audit.id,
    agent_name: 'local_presence',
    run_date: snapshotDate,
    status: 'completed',
    metadata: {
      gbp_found: gbp.listing_found,
      gbp_claimed: gbp.is_claimed,
      gbp_rating: gbp.rating,
      gbp_reviews: gbp.review_count,
      citations_found: foundCount,
      citations_total: allCitations.length,
      nap_consistent: napConsistentCount,
      snapshot_date: snapshotDate,
    },
  });

  console.log(`\n  Done. Local presence snapshot ${snapshotDate} for ${cliArgs.domain} complete.\n`);
}

// ============================================================
// Entry point
// ============================================================

const args = parseArgs();
runLocalPresence(args).catch((err) => {
  console.error(`\nFATAL: ${err.message}\n`);
  process.exit(1);
});
