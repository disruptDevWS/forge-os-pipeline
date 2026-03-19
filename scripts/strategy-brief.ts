#!/usr/bin/env npx tsx
/**
 * strategy-brief.ts — Phase 1b: Strategy Brief
 *
 * Synthesizes Dwight output + Scout output + client profile into a strategic
 * framing document that shapes Phase 2 (keyword matrix), Michael (architecture),
 * and Pam (content briefs).
 *
 * Usage:
 *   npx tsx scripts/strategy-brief.ts --domain <domain> --user-email <email>
 *   npx tsx scripts/strategy-brief.ts --domain <domain> --user-email <email> --force
 *
 * Environment variables (from .env or process.env):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_KEY
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { callClaude, initAnthropicClient } from './anthropic-client.js';
import { loadClientContextAsync, buildClientContextPrompt } from './client-context.js';
import type { DashboardExtras } from './client-context.js';

const AUDITS_BASE = path.resolve(process.cwd(), 'audits');

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
      'Usage: npx tsx scripts/strategy-brief.ts --domain <domain> --user-email <email> [--force]',
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

function findLatestDatedDir(basePath: string): string | null {
  if (!fs.existsSync(basePath)) return null;
  const entries = fs.readdirSync(basePath).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort();
  if (entries.length === 0) return null;
  return path.join(basePath, entries[entries.length - 1]);
}

/**
 * Resolve a file from a dated directory, trying today first then falling back
 * to the most recent date dir that contains the file.
 */
function resolveArtifact(domain: string, subdir: string, filename: string): string | null {
  const basePath = path.join(AUDITS_BASE, domain, subdir);
  const today = todayStr();
  const todayPath = path.join(basePath, today, filename);
  if (fs.existsSync(todayPath)) return todayPath;

  if (!fs.existsSync(basePath)) return null;
  const dateDirs = fs.readdirSync(basePath).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort();
  for (let i = dateDirs.length - 1; i >= 0; i--) {
    const candidate = path.join(basePath, dateDirs[i], filename);
    if (fs.existsSync(candidate)) {
      if (dateDirs[i] !== today) {
        console.log(`  ${filename}: using ${dateDirs[i]}/ (date fallback from ${today})`);
      }
      return candidate;
    }
  }
  return null;
}

// ============================================================
// Input gathering
// ============================================================

interface BriefInputs {
  auditReport: string | null;
  scopeJson: any | null;
  scoutMarkdown: string | null;
  clientContext: string | null;
  clientProfile: Record<string, any> | null;
  dashboardExtras: DashboardExtras;
  geoMode: string;
  marketGeos: any;
  serviceKey: string;
  domain: string;
}

async function gatherInputs(sb: SupabaseClient, audit: any, domain: string): Promise<BriefInputs> {
  // 1. AUDIT_REPORT.md — cross-date fallback
  let auditReport: string | null = null;
  const reportPath = resolveArtifact(domain, 'auditor', 'AUDIT_REPORT.md');
  if (reportPath) {
    auditReport = fs.readFileSync(reportPath, 'utf-8');
    // Truncate to 20KB for prompt sizing
    if (auditReport.length > 20_000) {
      auditReport = auditReport.slice(0, 20_000) + '\n\n[... truncated to 20KB ...]';
    }
    console.log(`  AUDIT_REPORT.md: ${auditReport.length} chars`);
  } else {
    console.log('  WARNING: No AUDIT_REPORT.md found — brief will have limited technical context');
  }

  // 2. scope.json (optional — Scout may not have run)
  let scopeJson: any = null;
  const scoutDir = findLatestDatedDir(path.join(AUDITS_BASE, domain, 'scout'));
  if (scoutDir) {
    const scopePath = path.join(scoutDir, 'scope.json');
    if (fs.existsSync(scopePath)) {
      try {
        scopeJson = JSON.parse(fs.readFileSync(scopePath, 'utf-8'));
        console.log(`  scope.json: loaded (${scopeJson.topics?.length ?? 0} topics, ${scopeJson.gap_summary?.total ?? 0} gap keywords)`);
      } catch {
        console.log('  WARNING: scope.json parse failed — continuing without Scout data');
      }
    }
  }

  // 3. Scout gap report markdown (optional)
  let scoutMarkdown: string | null = null;
  if (scoutDir) {
    const mdFiles = fs.readdirSync(scoutDir).filter((f) => f.startsWith('scout-') && f.endsWith('.md'));
    if (mdFiles.length > 0) {
      scoutMarkdown = fs.readFileSync(path.join(scoutDir, mdFiles[0]), 'utf-8');
      // Truncate to 8KB
      if (scoutMarkdown.length > 8_000) {
        scoutMarkdown = scoutMarkdown.slice(0, 8_000) + '\n\n[... truncated to 8KB ...]';
      }
      console.log(`  Scout report: ${scoutMarkdown.length} chars`);
    }
  }

  // 4. Client context (disk first, then Supabase fallback)
  const { context: clientCtx, extras: dashboardExtras } = await loadClientContextAsync(domain, sb, audit.id);
  const clientContext = clientCtx ? buildClientContextPrompt(clientCtx, 'michael') : null;
  if (clientContext) {
    console.log('  Client context: loaded');
  }

  // 5. client_profiles row (optional)
  let clientProfile: Record<string, any> | null = null;
  try {
    const { data } = await sb
      .from('client_profiles')
      .select('canonical_name, canonical_address, canonical_phone, business_name, years_in_business, usps, service_differentiators')
      .eq('audit_id', audit.id)
      .maybeSingle();
    clientProfile = data;
    if (clientProfile) console.log('  Client profile: loaded from Supabase');
  } catch {
    // Table may not exist
  }

  return {
    auditReport,
    scopeJson,
    scoutMarkdown,
    clientContext,
    clientProfile,
    dashboardExtras,
    geoMode: audit.geo_mode || 'city',
    marketGeos: audit.market_geos || {},
    serviceKey: audit.service_key || audit.custom_service_label || '',
    domain,
  };
}

// ============================================================
// Prompt construction
// ============================================================

function buildPrompt(inputs: BriefInputs): string {
  const sections: string[] = [];

  // Geo context
  const geoDesc = describeGeo(inputs.geoMode, inputs.marketGeos);

  sections.push(`You are a strategic SEO analyst. Synthesize the inputs below into a strategy brief that will direct the keyword research, architecture, and content phases of an SEO audit pipeline.

## Business Context
- Domain: ${inputs.domain}
- Industry/Service: ${inputs.serviceKey || 'unknown'}
- Geo Mode: ${inputs.geoMode}
- Target Markets: ${geoDesc}
`);

  if (inputs.clientContext) {
    sections.push(inputs.clientContext);
  }

  // Dashboard-only fields useful for strategic framing
  const extraLines: string[] = [];
  if (inputs.dashboardExtras.service_area) {
    extraLines.push(`Service area: ${inputs.dashboardExtras.service_area}`);
  }
  if (inputs.dashboardExtras.notes) {
    extraLines.push(`Additional context: ${inputs.dashboardExtras.notes}`);
  }
  if (extraLines.length > 0) {
    sections.push(extraLines.join('\n'));
  }

  if (inputs.clientProfile) {
    const cp = inputs.clientProfile;
    const profileLines: string[] = ['## Client Profile (from Supabase)'];
    if (cp.canonical_name) profileLines.push(`Business name: ${cp.canonical_name}`);
    if (cp.canonical_address) profileLines.push(`Address: ${cp.canonical_address}`);
    if (cp.years_in_business) profileLines.push(`Years in business: ${cp.years_in_business}`);
    if (cp.usps?.length) profileLines.push(`USPs: ${cp.usps.join(', ')}`);
    if (cp.service_differentiators?.length) profileLines.push(`Differentiators: ${cp.service_differentiators.join(', ')}`);
    sections.push(profileLines.join('\n'));
  }

  if (inputs.auditReport) {
    sections.push(`## Technical Audit (Dwight — AUDIT_REPORT.md)
${inputs.auditReport}`);
  }

  if (inputs.scopeJson) {
    const scope = inputs.scopeJson;
    const scopeLines: string[] = ['## Scout External Visibility Assessment (scope.json)'];
    if (scope.services?.length) scopeLines.push(`Discovered services: ${scope.services.join(', ')}`);
    if (scope.locales?.length) scopeLines.push(`Discovered locales: ${scope.locales.join(', ')}`);
    if (scope.gap_summary) {
      scopeLines.push(`Total ranked keywords: ${scope.gap_summary.total ?? 'unknown'}`);
      scopeLines.push(`Defending (top 10): ${scope.gap_summary.defending ?? 0}`);
      scopeLines.push(`Weak (11-30): ${scope.gap_summary.weak ?? 0}`);
      scopeLines.push(`Gaps (not ranking): ${scope.gap_summary.gaps ?? 0}`);
      if (scope.gap_summary.top_opportunities?.length) {
        scopeLines.push(`\nTop gap opportunities:`);
        for (const opp of scope.gap_summary.top_opportunities.slice(0, 10)) {
          scopeLines.push(`- ${opp.keyword} (vol: ${opp.volume}, cpc: ${opp.cpc})`);
        }
      }
    }
    if (scope.total_opportunity_volume) {
      scopeLines.push(`Total opportunity volume: ${scope.total_opportunity_volume}/mo`);
    }
    sections.push(scopeLines.join('\n'));
  }

  if (inputs.scoutMarkdown) {
    sections.push(`## Scout Research Report (competitive intelligence)
${inputs.scoutMarkdown}`);
  }

  if (!inputs.scopeJson && !inputs.scoutMarkdown) {
    sections.push(`## Scout Data
No Scout data available. Base visibility posture on Dwight's crawl signals only. Do not speculate about external visibility or competitor landscape.`);
  }

  // Output instructions
  sections.push(`## Task

Produce a strategy brief with exactly these four sections. Each section must be actionable and specific to this business — no generic advice.

### Section 1: Visibility Posture
Characterize the gap between current footprint and target market using ONE of these labels:
- "New Market Entry" — near-zero non-branded visibility in target markets
- "Local Authority with Gaps" — established in core geo but missing topical coverage
- "Established Presence — Topical Expansion" — strong core presence, needs breadth
- "Multi-State Scaling" — local authority in one market, expanding to new states/regions
- "National Brand Building" — building national presence from regional or niche base

Then write 2-3 sentences explaining WHY this label fits based on the data: current ranking footprint, gap analysis, geo scope vs actual presence.

### Section 2: Keyword Research Directive
Provide explicit instructions for keyword matrix construction. Address:
1. What keyword buckets to target, in priority order (e.g., "national unmodified terms," "state-level variants," "city-level terms")
2. What NOT to optimize around (e.g., "do not target local rankings in non-service-area cities")
3. Whether the current ranking footprint is a valid signal or a misleading anchor
4. Any specific term patterns to include or exclude based on the business model

### Section 3: Architecture Directive
List 3-5 structural requirements for the site architecture. Examples:
- "State landing pages required before topical cluster build"
- "Service hub pages should be geo-agnostic; location pages link to hubs"
- "Brand entity resolution is prerequisite — consolidate name variants"
- "Existing thin pages should be merged, not supplemented"

### Section 4: Risk Flags
List risks that will degrade downstream output if not surfaced. Use severity labels:
- [BLOCKING] — must be resolved before architecture can proceed
- [WARNING] — will reduce output quality if ignored
- [INFO] — context that improves downstream decisions

YOUR ENTIRE RESPONSE IS THE STRATEGY BRIEF. Output ONLY the markdown content starting with "## Visibility Posture". No preamble, no code fences, no narration.`);

  return sections.join('\n\n');
}

function describeGeo(geoMode: string, marketGeos: any): string {
  if (!marketGeos) return geoMode;
  switch (geoMode) {
    case 'city':
      return (marketGeos.cities ?? []).join(', ') || 'unknown cities';
    case 'metro':
      return (marketGeos.metros ?? []).join(', ') || 'unknown metros';
    case 'state':
      return (marketGeos.states ?? []).join(', ') || 'unknown states';
    case 'national':
      return 'United States (national)';
    default:
      return geoMode;
  }
}

// ============================================================
// Main
// ============================================================

async function runStrategyBrief(cliArgs: CliArgs) {
  const env = loadEnv();
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = env.ANTHROPIC_KEY || env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !supabaseKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  if (!anthropicKey) throw new Error('ANTHROPIC_KEY not set');

  initAnthropicClient(anthropicKey);

  const sb = createClient(supabaseUrl, supabaseKey);
  const date = todayStr();

  console.log(`\n=== Strategy Brief: ${cliArgs.domain} (${date}) ===\n`);

  // 1. Resolve audit
  const { audit } = await resolveAudit(sb, cliArgs.domain, cliArgs.userEmail);
  console.log(`  Audit: ${audit.id} (status: ${audit.status})`);

  // 2. Check if today's brief already exists
  const outDir = path.join(AUDITS_BASE, cliArgs.domain, 'research', date);
  const outPath = path.join(outDir, 'strategy_brief.md');
  if (fs.existsSync(outPath) && !cliArgs.force) {
    console.log(`  Skipping — strategy_brief.md already exists for ${date}. Use --force to override.`);
    return;
  }

  // 3. Gather inputs
  const inputs = await gatherInputs(sb, audit, cliArgs.domain);

  if (!inputs.auditReport && !inputs.scopeJson) {
    console.log('  WARNING: No AUDIT_REPORT.md and no scope.json — skipping strategy brief generation');
    return;
  }

  // 4. Build prompt and call Sonnet
  const prompt = buildPrompt(inputs);
  console.log(`  Prompt: ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`);
  console.log('  Generating strategy brief via Anthropic API (sonnet)...');

  const result = await callClaude(prompt, { model: 'sonnet', phase: 'strategy-brief', maxTokens: 8192 });

  // 5. Write to disk
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, result, 'utf-8');
  console.log(`  Written strategy_brief.md (${result.length} chars) to ${path.relative(process.cwd(), outDir)}/`);

  // 6. Log agent_runs
  await sb.from('agent_runs').insert({
    audit_id: audit.id,
    agent_name: 'strategy_brief',
    run_date: date,
    status: 'completed',
    metadata: {
      has_audit_report: !!inputs.auditReport,
      has_scout: !!inputs.scopeJson,
      has_scout_markdown: !!inputs.scoutMarkdown,
      has_client_context: !!inputs.clientContext,
      has_client_profile: !!inputs.clientProfile,
      geo_mode: inputs.geoMode,
      prompt_chars: prompt.length,
      output_chars: result.length,
    },
  });

  console.log(`\n  Done. Strategy brief for ${cliArgs.domain} complete.\n`);
}

// ============================================================
// Entry point
// ============================================================

const args = parseArgs();
runStrategyBrief(args).catch((err) => {
  console.error(`\nFATAL: ${err.message}\n`);
  process.exit(1);
});
