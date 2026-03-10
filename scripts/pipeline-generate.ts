#!/usr/bin/env npx tsx
/**
 * pipeline-generate.ts — Generate agent artifacts for the post-audit pipeline.
 *
 * Subcommands:
 *   dwight           — Comprehensive Screaming Frog CLI crawl + Anthropic API → AUDIT_REPORT.md
 *   keyword-research — Service × city × intent matrix from Dwight's crawl → DataForSEO validation → audit_keywords (seeded)
 *   jim              — Call DataForSEO (ranked-keywords + competitors) → disk artifacts → Anthropic API narrative → audit_snapshots
 *   competitors      — Fetch SERP data via DataForSEO, populate audit_topic_competitors + audit_topic_dominance
 *   gap              — Synthesize competitive content gaps from Supabase data via Anthropic API
 *   michael          — Read disk artifacts (Jim + Dwight + Gap) → Anthropic API → architecture_blueprint.md
 *   validator        — Cross-check gap analysis vs architecture blueprint → coverage_validation.md
 *
 * Usage:
 *   npx tsx scripts/pipeline-generate.ts jim --domain <domain> --user-email <email>
 *   npx tsx scripts/pipeline-generate.ts competitors --domain <domain> --user-email <email>
 *   npx tsx scripts/pipeline-generate.ts michael --domain <domain> --user-email <email>
 *   npx tsx scripts/pipeline-generate.ts gap --domain <domain> --user-email <email>
 *   npx tsx scripts/pipeline-generate.ts dwight --domain <domain> --user-email <email>
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// .env loader (same pattern as sync-to-dashboard)
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
// CLI parsing
// ============================================================

interface CliArgs {
  subcommand: 'jim' | 'competitors' | 'michael' | 'dwight' | 'gap' | 'canonicalize' | 'validator' | 'keyword-research';
  domain: string;
  userEmail?: string;
  date?: string;
  seedMatrix?: string;
  competitorUrls?: string;
  mode: 'sales' | 'full';
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const subcommand = args[0] as CliArgs['subcommand'];
  if (!['jim', 'competitors', 'michael', 'dwight', 'gap', 'canonicalize', 'validator', 'keyword-research'].includes(subcommand)) {
    console.error('Usage: npx tsx scripts/pipeline-generate.ts <jim|competitors|gap|michael|dwight|canonicalize|validator|keyword-research> --domain <domain> --user-email <email> [--date YYYY-MM-DD] [--mode sales|full]');
    process.exit(1);
  }

  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      }
    }
  }

  if (!flags.domain) {
    console.error('--domain is required');
    process.exit(1);
  }

  const mode = (flags.mode === 'sales' ? 'sales' : 'full') as CliArgs['mode'];

  return {
    subcommand,
    domain: flags.domain,
    userEmail: flags['user-email'],
    date: flags.date,
    seedMatrix: flags['seed-matrix'],
    competitorUrls: flags['competitor-urls'],
    mode,
  };
}

// ============================================================
// Helpers
// ============================================================

const AUDITS_BASE = path.resolve(process.cwd(), 'audits');

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Strip Claude preamble/postamble from output. Claude sometimes prepends
 * XML-like tool-call artifacts (from leaked conversation transcripts).
 * Conservative: only strips obvious XML artifacts, not conversational text.
 */
function stripClaudePreamble(output: string): string {
  // Strip leading XML artifacts (e.g., <function_calls>...) that occasionally leak through
  let cleaned = output.replace(/^<function_calls>[\s\S]*?<\/function_calls>\s*/gm, '');
  // Strip trailing XML artifacts
  cleaned = cleaned.replace(/<function_calls>[\s\S]*?<\/function_calls>\s*$/gm, '');
  return cleaned.trim();
}

function callClaude(prompt: string, model = 'sonnet', timeoutMs = 600_000): string {
  const claudeBin = process.env.CLAUDE_BIN || '/home/forgegrowth/.local/bin/claude';
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('CLAUDE') || key === 'CLAUDECODE') delete childEnv[key];
  }
  const result = child_process.spawnSync(claudeBin, ['--print', '--model', model, '--tools', ''], {
    input: prompt,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env: childEnv,
  });
  if (result.error) {
    throw new Error(`claude spawn failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    const stdout = (result.stdout ?? '').trim();
    const detail = stderr.slice(0, 300) || stdout.slice(0, 300) || '(no output)';
    throw new Error(`claude exited ${result.status}: ${detail}`);
  }
  const output = stripClaudePreamble((result.stdout ?? '').trim());
  if (!output || output.startsWith('Error:')) {
    throw new Error(`claude returned error: ${output.slice(0, 200) || '(empty output)'}`);
  }
  return output;
}

/**
 * Async variant of callClaude using spawn (streaming) instead of spawnSync.
 * Avoids ETIMEDOUT on large prompts by reading stdout as it streams in.
 */
function callClaudeAsync(prompt: string, model = 'sonnet'): Promise<string> {
  return new Promise((resolve, reject) => {
    const claudeBin = process.env.CLAUDE_BIN || '/home/forgegrowth/.local/bin/claude';
    const childEnv = { ...process.env };
    // Strip all Claude session vars so the child doesn't inherit the parent conversation
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith('CLAUDE') || key === 'CLAUDECODE') delete childEnv[key];
    }
    const proc = child_process.spawn(claudeBin, ['--print', '--model', model, '--tools', ''], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    proc.stdout!.setEncoding('utf-8');
    proc.stderr!.setEncoding('utf-8');
    proc.stdout!.on('data', (chunk: string) => stdoutChunks.push(chunk));
    proc.stderr!.on('data', (chunk: string) => stderrChunks.push(chunk));

    proc.on('error', (err) => reject(new Error(`claude spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      const stdout = stdoutChunks.join('').trim();
      const stderr = stderrChunks.join('').trim();
      if (code !== 0) {
        const detail = stderr.slice(0, 300) || stdout.slice(0, 300) || '(no output)';
        reject(new Error(`claude exited ${code}: ${detail}`));
        return;
      }
      const cleaned = stripClaudePreamble(stdout);
      if (!cleaned || cleaned.startsWith('Error:')) {
        reject(new Error(`claude returned error: ${cleaned.slice(0, 200) || '(empty output)'}`));
        return;
      }
      resolve(cleaned);
    });

    proc.stdin!.write(prompt);
    proc.stdin!.end();
  });
}

function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  return fenced ? fenced[1].trim() : text.trim();
}

/** Validate that an artifact file has real content (not an error message or empty). */
function validateArtifact(filePath: string, label: string, minBytes = 500): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} was not produced at ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf-8').trim();
  if (content.startsWith('Error:') || content.startsWith('error:')) {
    throw new Error(`${label} contains an error instead of content: "${content.slice(0, 200)}"`);
  }
  if (content.length < minBytes) {
    throw new Error(`${label} is too small (${content.length} bytes, expected >=${minBytes}). Content: "${content.slice(0, 200)}"`);
  }
  // Detect conversational/narration output instead of the requested format.
  // Strip leading backticks/whitespace/code fences before testing.
  const contentStart = content.replace(/^[`\s]+/, '').slice(0, 300);
  const narrationPatterns = [
    /^I'll /i,
    /^Let me /i,
    /^Looking at /i,
    /^Here's (?:what|a|the)/i,
    /^Now (?:let|I'll)/i,
    /^The (?:report|file|analysis|output) (?:has been|is|was)/i,
    /^Key findings/i,
    /written to [`']/i,
  ];
  for (const pat of narrationPatterns) {
    if (pat.test(contentStart)) {
      throw new Error(`${label} contains narration instead of the requested format. First 200 chars: "${content.slice(0, 200)}"`);
    }
  }
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
// Service keyword seeds — used for auto-supplementing thin ranked-keywords results
// ============================================================

// Maps service_key → common sub-service search terms consumers actually type.
// When a domain has few organic rankings, these are crossed with locales to
// generate a synthetic keyword universe (same as seed-matrix mode but automatic).
const SERVICE_KEYWORD_SEEDS: Record<string, string[]> = {
  hvac: [
    'hvac', 'ac repair', 'air conditioning repair', 'furnace repair', 'heating repair',
    'hvac installation', 'ac installation', 'furnace installation', 'duct cleaning',
    'hvac maintenance', 'air conditioning service', 'heating and cooling',
    'ac replacement', 'furnace replacement', 'heat pump installation', 'mini split installation',
  ],
  plumbing: [
    'plumber', 'plumbing', 'drain cleaning', 'water heater repair', 'water heater installation',
    'sewer repair', 'leak repair', 'plumbing repair', 'emergency plumber',
    'sewer line replacement', 'toilet repair', 'faucet repair', 'garbage disposal repair',
    'tankless water heater', 'water line repair', 'sump pump installation',
  ],
  electrical: [
    'electrician', 'electrical repair', 'electrical panel upgrade', 'wiring repair',
    'outlet installation', 'ceiling fan installation', 'lighting installation',
    'generator installation', 'ev charger installation', 'electrical inspection',
    'circuit breaker repair', 'whole house rewiring', 'emergency electrician',
  ],
  roofing: [
    'roofing', 'roof repair', 'roof replacement', 'roof installation', 'roof inspection',
    'shingle repair', 'metal roofing', 'flat roof repair', 'roof leak repair',
    'gutter installation', 'gutter repair', 'storm damage roof repair', 'roofing contractor',
  ],
  remodeling: [
    'remodeling', 'kitchen remodeling', 'bathroom remodeling', 'home renovation',
    'basement remodeling', 'basement finishing', 'room addition', 'home addition',
    'whole house remodel', 'interior remodeling', 'general contractor',
    'kitchen renovation', 'bathroom renovation', 'home remodeling contractor',
  ],
  restoration: [
    'restoration', 'water damage restoration', 'fire damage restoration', 'mold remediation',
    'flood cleanup', 'storm damage repair', 'smoke damage restoration',
    'water damage repair', 'emergency restoration', 'disaster restoration',
  ],
  garage_doors: [
    'garage door repair', 'garage door installation', 'garage door opener repair',
    'garage door replacement', 'garage door spring repair', 'garage door opener installation',
    'emergency garage door repair', 'commercial garage door repair',
  ],
  landscaping: [
    'landscaping', 'landscape design', 'lawn care', 'lawn maintenance', 'tree trimming',
    'hardscaping', 'patio installation', 'retaining wall', 'irrigation installation',
    'sod installation', 'landscape lighting', 'yard cleanup', 'mulching service',
  ],
  pest_control: [
    'pest control', 'exterminator', 'termite treatment', 'bed bug treatment',
    'rodent control', 'ant control', 'mosquito control', 'wildlife removal',
    'cockroach exterminator', 'pest inspection', 'commercial pest control',
  ],
  fencing: [
    'fence installation', 'fence repair', 'wood fence', 'vinyl fence', 'chain link fence',
    'privacy fence', 'fence company', 'commercial fencing', 'iron fence', 'fence contractor',
  ],
  tree_service: [
    'tree service', 'tree removal', 'tree trimming', 'stump grinding', 'stump removal',
    'tree pruning', 'emergency tree removal', 'tree cutting', 'arborist',
    'land clearing', 'tree care',
  ],
  general_contractor: [
    'general contractor', 'home renovation', 'home remodeling', 'construction company',
    'home improvement', 'room addition', 'home addition', 'commercial construction',
    'new construction', 'design build', 'custom home builder',
  ],
  cleaning: [
    'cleaning service', 'house cleaning', 'maid service', 'deep cleaning',
    'commercial cleaning', 'office cleaning', 'move out cleaning', 'carpet cleaning',
    'window cleaning', 'janitorial service', 'post construction cleaning',
  ],
};

// Minimum ranked keywords before auto-supplementing with seed candidates.
// Below this threshold, DataForSEO returned too few organic results for a useful analysis.
const MIN_RANKED_KEYWORDS_THRESHOLD = 50;

// ============================================================
// Seed Mode helpers — synthetic keyword universe for new/zero-visibility sites
// ============================================================

interface SeedMatrix {
  business_type: string;
  services: string[];
  locales: string[];
  state: string;
}

function generateKeywordCandidates(matrix: SeedMatrix): string[] {
  const { business_type, services, locales, state } = matrix;
  const candidates = new Set<string>();

  for (const service of services) {
    // Near-me variant (no locale)
    candidates.add(`${service} near me`);

    for (const locale of locales) {
      candidates.add(`${service} ${locale}`);
      candidates.add(`${service} ${locale} ${state}`);
      candidates.add(`${service} cost ${locale}`);
      candidates.add(`${service} services ${locale}`);
    }
  }

  for (const locale of locales) {
    candidates.add(`${business_type} ${locale}`);
    candidates.add(`${business_type} ${locale} ${state}`);
    candidates.add(`best ${business_type} ${locale}`);
  }

  return [...candidates].map((k) => k.toLowerCase());
}

interface BulkVolumeResult {
  keyword: string;
  volume: number;
  cpc: number;
  competition: number | null;
  competition_level: string | null;
}

async function bulkKeywordVolume(
  env: Record<string, string>,
  keywords: string[],
): Promise<BulkVolumeResult[]> {
  const login = env.DATAFORSEO_LOGIN;
  const password = env.DATAFORSEO_PASSWORD;
  if (!login || !password) throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set in .env');

  const authString = Buffer.from(`${login}:${password}`).toString('base64');
  const results: BulkVolumeResult[] = [];

  // DataForSEO allows up to 1000 keywords per request — chunk if needed
  const CHUNK_SIZE = 1000;
  for (let i = 0; i < keywords.length; i += CHUNK_SIZE) {
    const chunk = keywords.slice(i, i + CHUNK_SIZE);
    console.log(`  Fetching volume for ${chunk.length} keywords (batch ${Math.floor(i / CHUNK_SIZE) + 1})...`);

    const resp = await fetch('https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live', {
      method: 'POST',
      headers: { Authorization: `Basic ${authString}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ keywords: chunk, location_code: 2840, language_code: 'en' }]),
    });
    if (!resp.ok) throw new Error(`DataForSEO search_volume HTTP ${resp.status}`);
    const data = await resp.json();

    for (const task of data?.tasks ?? []) {
      for (const item of task?.result ?? []) {
        if (item.search_volume && item.search_volume > 0) {
          results.push({
            keyword: item.keyword,
            volume: item.search_volume,
            cpc: item.cpc ?? 0,
            competition: item.competition ?? null,
            competition_level: item.competition_level ?? null,
          });
        }
      }
    }
  }

  return results;
}

function buildSyntheticRankedKeywords(volumeResults: BulkVolumeResult[]): any {
  return {
    tasks: [{
      result: [{
        total_count: volumeResults.length,
        items_count: volumeResults.length,
        items: volumeResults.map((v) => ({
          keyword_data: {
            keyword: v.keyword,
            keyword_info: {
              search_volume: v.volume,
              cpc: v.cpc,
              competition: v.competition,
              competition_level: v.competition_level,
            },
            search_intent_info: { main_intent: null },
            keyword_properties: { keyword_difficulty: null },
          },
          ranked_serp_element: {
            serp_item: { rank_group: 100, rank_absolute: 100, url: null },
          },
        })),
      }],
    }],
  };
}

// ============================================================
// Phase 3: Jim — DataForSEO calls → research artifacts → Claude narrative
// ============================================================

async function runJim(sb: SupabaseClient, auditId: string, domain: string, audit: any, seedMatrixPath?: string, competitorUrls?: string, mode: CliArgs['mode'] = 'full') {
  const env = loadEnv();
  const date = todayStr();
  const researchDir = path.join(AUDITS_BASE, domain, 'research', date);
  fs.mkdirSync(researchDir, { recursive: true });

  // --- Read Dwight's site inventory (if available) ---
  let siteInventory = '';
  const auditorDir = findLatestAuditorDir(domain);
  if (auditorDir) {
    const auditReportPath = path.join(auditorDir, 'AUDIT_REPORT.md');
    if (fs.existsSync(auditReportPath)) {
      const reportContent = fs.readFileSync(auditReportPath, 'utf-8');

      // Extract service pages — URLs under residential/commercial paths with H1/title
      const servicePageLines: string[] = [];
      const csvPath = path.join(auditorDir, 'internal_all.csv');
      if (fs.existsSync(csvPath)) {
        const csvContent = readCsvSafe(csvPath, false);
        const csvLines = csvContent.split('\n');
        const header = csvLines[0] ?? '';
        const cols = header.split(',').map((c) => c.replace(/"/g, '').trim().toLowerCase());
        const addrIdx = cols.indexOf('address');
        const h1Idx = cols.findIndex((c) => c === 'h1-1');
        const titleIdx = cols.findIndex((c) => c === 'title 1');

        for (const line of csvLines.slice(1)) {
          if (!line.trim()) continue;
          // Simple CSV parse for the columns we need
          const parts: string[] = [];
          let cur = '';
          let inQuote = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') { inQuote = !inQuote; cur += ch; }
            else if (ch === ',' && !inQuote) { parts.push(cur); cur = ''; }
            else { cur += ch; }
          }
          parts.push(cur);

          const addr = (parts[addrIdx] ?? '').replace(/"/g, '').trim();
          if (addr && /\/(service|residential|commercial|what-we-do)/i.test(addr)) {
            const h1 = (parts[h1Idx] ?? '').replace(/"/g, '').trim();
            const title = (parts[titleIdx] ?? '').replace(/"/g, '').trim();
            servicePageLines.push(`${addr} | H1: ${h1 || 'N/A'} | Title: ${title || 'N/A'}`);
          }
        }
      }

      // Extract location signals from the report
      const locationMatch = reportContent.match(/areaServed[^\n]*\n([\s\S]*?)(?=\n##|\n#|$)/i);
      const locationSignals = locationMatch ? locationMatch[1].trim().slice(0, 500) : '';

      // Extract platform
      const platformMatch = reportContent.match(/##[^#\n]*Platform\s+Observations[^\n]*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/i);
      const platformInfo = platformMatch ? platformMatch[1].trim().slice(0, 300) : '';

      if (servicePageLines.length > 0 || locationSignals || platformInfo) {
        siteInventory = `## Site Inventory (from Dwight's Crawl)\n`;
        if (servicePageLines.length > 0) {
          siteInventory += `### Service Pages (${servicePageLines.length} found)\nURL | H1 | Title\n${servicePageLines.join('\n')}\n\n`;
        } else {
          console.log('  Warning: No service pages found in Dwight\'s crawl data');
        }
        if (locationSignals) {
          siteInventory += `### Location Signals\n${locationSignals}\n\n`;
        } else {
          console.log('  Warning: No location signals found in Dwight\'s audit report');
        }
        if (platformInfo) {
          siteInventory += `### Platform\n${platformInfo}\n\n`;
        }
        console.log(`  Site inventory from Dwight: ${servicePageLines.length} service pages, location signals: ${locationSignals ? 'yes' : 'no'}, platform: ${platformInfo ? 'yes' : 'no'}`);
      } else {
        console.log('  Warning: Dwight\'s report produced no usable service pages, location signals, or platform info');
      }
    } else {
      console.log('  Warning: AUDIT_REPORT.md not found — Dwight may not have run');
    }
  } else {
    console.log('  Warning: No auditor directory found — Dwight has not run');
  }

  // --- Read KeywordResearch opportunities (if available) ---
  let kwResearchSection = '';
  const kwResearchResolved = resolveArtifactPath(domain, 'research', 'keyword_research_summary.md');
  if (kwResearchResolved) {
    kwResearchSection = fs.readFileSync(kwResearchResolved, 'utf-8');
    console.log(`  keyword_research_summary.md: ${kwResearchSection.length} chars`);
  } else {
    console.log('  Warning: keyword_research_summary.md not found — KeywordResearch may not have run');
  }

  const rankedFile = path.join(researchDir, 'ranked_keywords.json');
  const competitorsFile = path.join(researchDir, 'competitors.json');
  let isSeedMode = false;

  if (seedMatrixPath) {
    // ── Mode B: Synthetic keyword universe from seed matrix ──
    isSeedMode = true;
    console.log(`  Mode B: Seed matrix from ${seedMatrixPath}`);

    const matrixRaw = fs.readFileSync(seedMatrixPath, 'utf-8');
    const matrix: SeedMatrix = JSON.parse(matrixRaw);
    if (!matrix.business_type || !matrix.services?.length || !matrix.locales?.length || !matrix.state) {
      throw new Error('Seed matrix must have business_type, services[], locales[], and state');
    }

    // Generate keyword candidates from service-locale cross-product
    let candidates = generateKeywordCandidates(matrix);
    console.log(`  Generated ${candidates.length} keyword candidates from seed matrix`);

    // If competitor URLs provided, fetch their ranked keywords and merge
    if (competitorUrls) {
      const compDomains = competitorUrls.split(',').map((d) => d.trim()).filter(Boolean);
      console.log(`  Fetching competitor keywords from ${compDomains.length} domains...`);
      const scriptPath = path.resolve(process.cwd(), 'scripts/foundational_scout.sh');

      const competitorKeywords: string[] = [];
      const competitorItems: any[] = [];
      for (const compDomain of compDomains) {
        try {
          const compFile = path.join(researchDir, `competitor_${compDomain.replace(/\./g, '_')}.json`);
          child_process.execSync(
            `bash "${scriptPath}" "${compDomain}" ranked-keywords`,
            {
              encoding: 'utf-8',
              timeout: 120_000,
              stdio: ['pipe', 'pipe', 'pipe'],
              env: { ...process.env, DATAFORSEO_LOGIN: env.DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD: env.DATAFORSEO_PASSWORD },
            },
          );
          // foundational_scout.sh writes to audits/{domain}/research/{date}/ranked_keywords.json
          const compRankedFile = path.join(AUDITS_BASE, compDomain, 'research', date, 'ranked_keywords.json');
          if (fs.existsSync(compRankedFile)) {
            const compData = JSON.parse(fs.readFileSync(compRankedFile, 'utf-8'));
            for (const task of compData?.tasks ?? []) {
              for (const result of task?.result ?? []) {
                for (const item of result?.items ?? []) {
                  const kw = item.keyword_data?.keyword;
                  if (kw) {
                    competitorKeywords.push(kw.toLowerCase());
                    competitorItems.push(item);
                  }
                }
              }
            }
            console.log(`  ${compDomain}: ${competitorKeywords.length} keywords found`);
          }
        } catch (err: any) {
          console.log(`  Warning: competitor ${compDomain} fetch failed: ${err.message}`);
        }
      }

      // Merge competitor keywords into candidates (deduplicate)
      const beforeCount = candidates.length;
      const candidateSet = new Set(candidates);
      for (const kw of competitorKeywords) {
        candidateSet.add(kw);
      }
      candidates = [...candidateSet];
      console.log(`  Merged ${candidates.length - beforeCount} unique competitor keywords (total: ${candidates.length})`);

      // Write competitors.json stub with competitor domain info
      const competitorsStub = {
        tasks: [{
          result: [{
            total_count: compDomains.length,
            items: compDomains.map((d) => ({
              domain: d,
              avg_position: null,
              sum_position: null,
              intersections: null,
              full_domain_metrics: { organic: { count: null, etv: null } },
            })),
          }],
        }],
      };
      fs.writeFileSync(competitorsFile, JSON.stringify(competitorsStub, null, 2), 'utf-8');
    } else {
      // No competitor URLs — write empty competitors.json
      fs.writeFileSync(competitorsFile, JSON.stringify({ tasks: [{ result: [{ total_count: 0, items: [] }] }] }, null, 2), 'utf-8');
    }

    // Get search volume data for all candidates
    const volumeResults = await bulkKeywordVolume(env, candidates);
    console.log(`  ${volumeResults.length} keywords with volume > 0 (of ${candidates.length} candidates)`);

    // Build synthetic ranked_keywords.json in DataForSEO format
    const syntheticData = buildSyntheticRankedKeywords(volumeResults);
    fs.writeFileSync(rankedFile, JSON.stringify(syntheticData, null, 2), 'utf-8');
    console.log(`  ranked_keywords.json: ${(fs.statSync(rankedFile).size / 1024).toFixed(0)}KB (synthetic, rank_group=100)`);
  } else {
    // ── Mode A: Existing site — DataForSEO ranked-keywords + competitors ──
    const scriptPath = path.resolve(process.cwd(), 'scripts/foundational_scout.sh');

    console.log('  Calling DataForSEO ranked-keywords...');
    try {
      child_process.execSync(
        `bash "${scriptPath}" "${domain}" ranked-keywords`,
        {
          encoding: 'utf-8',
          timeout: 120_000,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, DATAFORSEO_LOGIN: env.DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD: env.DATAFORSEO_PASSWORD },
        },
      );
    } catch (err: any) {
      if (!fs.existsSync(rankedFile)) {
        throw new Error(`DataForSEO ranked-keywords failed: ${err.message}`);
      }
      console.log('  Warning: ranked-keywords exited non-zero but file exists — continuing');
    }
    if (!fs.existsSync(rankedFile)) throw new Error('ranked_keywords.json not produced');
    console.log(`  ranked_keywords.json: ${(fs.statSync(rankedFile).size / 1024).toFixed(0)}KB`);

    console.log('  Calling DataForSEO competitors...');
    try {
      child_process.execSync(
        `bash "${scriptPath}" "${domain}" competitors`,
        {
          encoding: 'utf-8',
          timeout: 120_000,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, DATAFORSEO_LOGIN: env.DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD: env.DATAFORSEO_PASSWORD },
        },
      );
    } catch (err: any) {
      if (!fs.existsSync(competitorsFile)) {
        throw new Error(`DataForSEO competitors failed: ${err.message}`);
      }
      console.log('  Warning: competitors exited non-zero but file exists — continuing');
    }
    if (!fs.existsSync(competitorsFile)) throw new Error('competitors.json not produced');
    console.log(`  competitors.json: ${(fs.statSync(competitorsFile).size / 1024).toFixed(0)}KB`);

    // ── Auto-supplement: if ranked-keywords returned too few results, generate
    //    synthetic keyword candidates from audit metadata (service_key × locales) ──
    const existingData = JSON.parse(fs.readFileSync(rankedFile, 'utf-8'));
    let existingCount = 0;
    for (const task of existingData?.tasks ?? []) {
      for (const result of task?.result ?? []) {
        existingCount += (result?.items?.length ?? 0);
      }
    }

    if (existingCount < MIN_RANKED_KEYWORDS_THRESHOLD) {
      const serviceKey = audit.service_key ?? '';
      const customLabel = audit.custom_service_label ?? '';
      const marketCity = audit.market_city ?? '';
      const marketState = audit.market_state ?? '';

      // Get service seed terms — try exact key, then custom label as fallback
      let serviceTerms = SERVICE_KEYWORD_SEEDS[serviceKey];
      if (!serviceTerms && customLabel) {
        // For custom categories, use the label itself as the base term
        serviceTerms = [customLabel.toLowerCase()];
      }

      if (serviceTerms && marketCity && marketState) {
        // Parse comma-separated locales from market_city
        const locales = marketCity.split(',').map((l: string) => l.trim()).filter(Boolean);
        console.log(`  Low keyword count (${existingCount} < ${MIN_RANKED_KEYWORDS_THRESHOLD}) — auto-supplementing from ${serviceTerms.length} service terms × ${locales.length} locale(s)`);

        // Build mini seed matrix and generate candidates
        const miniMatrix: SeedMatrix = {
          business_type: customLabel || serviceKey.replace(/_/g, ' '),
          services: serviceTerms,
          locales,
          state: marketState,
        };
        const candidates = generateKeywordCandidates(miniMatrix);

        // Remove keywords the domain already ranks for
        const existingKeywords = new Set<string>();
        for (const task of existingData?.tasks ?? []) {
          for (const result of task?.result ?? []) {
            for (const item of result?.items ?? []) {
              const kw = item?.keyword_data?.keyword?.toLowerCase();
              if (kw) existingKeywords.add(kw);
            }
          }
        }
        const newCandidates = candidates.filter((k) => !existingKeywords.has(k));
        console.log(`  ${newCandidates.length} new keyword candidates (${candidates.length} total, ${existingKeywords.size} already ranked)`);

        if (newCandidates.length > 0) {
          const volumeResults = await bulkKeywordVolume(env, newCandidates);
          console.log(`  ${volumeResults.length} supplementary keywords with volume > 0`);

          if (volumeResults.length > 0) {
            // Merge synthetic items into the existing ranked_keywords.json
            const syntheticItems = volumeResults.map((vr) => ({
              ranked_serp_element: { serp_item: { rank_group: 100, url: '' } },
              keyword_data: {
                keyword: vr.keyword,
                keyword_info: {
                  search_volume: vr.volume,
                  cpc: vr.cpc,
                  competition: vr.competition,
                  competition_level: vr.competition_level,
                },
                keyword_properties: { keyword_difficulty: null },
              },
            }));

            // Append to first task/result
            if (existingData.tasks?.[0]?.result?.[0]?.items) {
              existingData.tasks[0].result[0].items.push(...syntheticItems);
            }
            fs.writeFileSync(rankedFile, JSON.stringify(existingData, null, 2), 'utf-8');
            console.log(`  Merged: ${existingCount} ranked + ${syntheticItems.length} supplementary = ${existingCount + syntheticItems.length} total keywords`);
          }
        }
      } else {
        console.log(`  Low keyword count (${existingCount}) but no service_key/market_city metadata to supplement`);
      }
    }
  }

  // ── Common path: Parse JSON files and build rich prompt for Claude ──
  const rankedData = JSON.parse(fs.readFileSync(rankedFile, 'utf-8'));
  const competitorsData = JSON.parse(fs.readFileSync(competitorsFile, 'utf-8'));

  // Extract keywords from DataForSEO response
  const rawKeywords: any[] = [];
  for (const task of rankedData?.tasks ?? []) {
    for (const result of task?.result ?? []) {
      for (const item of result?.items ?? []) {
        rawKeywords.push(item);
      }
    }
  }
  const totalKeywords = rawKeywords.length;
  console.log(`  Parsed ${totalKeywords} keywords from ranked_keywords.json`);

  // Top 200 keywords by volume for prompt
  const top200 = rawKeywords
    .sort((a, b) => (b.keyword_data?.keyword_info?.search_volume ?? 0) - (a.keyword_data?.keyword_info?.search_volume ?? 0))
    .slice(0, 200);

  const keywordTable = top200
    .map((item) => {
      const kd = item.keyword_data ?? {};
      const ki = kd.keyword_info ?? {};
      const rankInfo = item.ranked_serp_element ?? {};
      return `${kd.keyword ?? ''} | ${rankInfo.serp_item?.rank_group ?? ''} | ${ki.search_volume ?? 0} | $${ki.cpc ?? 0} | ${kd.keyword_properties?.keyword_difficulty ?? ''} | ${ki.competition_level ?? ''} | ${rankInfo.serp_item?.url ?? ''}`;
    })
    .join('\n');

  // Extract competitors from DataForSEO response
  const rawCompetitors: any[] = [];
  for (const task of competitorsData?.tasks ?? []) {
    for (const result of task?.result ?? []) {
      for (const item of result?.items ?? []) {
        rawCompetitors.push(item);
      }
    }
  }

  const top50Competitors = rawCompetitors
    .sort((a, b) => (b.avg_position ? 1 / b.avg_position : 0) - (a.avg_position ? 1 / a.avg_position : 0))
    .slice(0, 50);

  const competitorTable = top50Competitors
    .map((c) => `${c.domain ?? ''} | ${c.avg_position?.toFixed(1) ?? ''} | ${c.sum_position ?? ''} | ${c.intersections ?? ''} | ${c.full_domain_metrics?.organic?.count ?? ''} | ${c.full_domain_metrics?.organic?.etv ?? ''}`)
    .join('\n');

  // Collect all ranked URLs
  const allUrls = [...new Set(
    rawKeywords
      .map((item) => item.ranked_serp_element?.serp_item?.url)
      .filter(Boolean),
  )];

  // Count organic vs supplemented keywords for prompt context
  const organicKeywords = rawKeywords.filter((item) => (item.ranked_serp_element?.serp_item?.rank_group ?? 100) < 100);
  const supplementedKeywords = rawKeywords.filter((item) => (item.ranked_serp_element?.serp_item?.rank_group ?? 100) >= 100);
  const wasAutoSupplemented = !isSeedMode && supplementedKeywords.length > 0 && organicKeywords.length < MIN_RANKED_KEYWORDS_THRESHOLD;

  // Step 4: Call Anthropic API (sonnet) for comprehensive research_summary.md
  console.log('  Generating research_summary.md via Anthropic API (sonnet)...');
  const seedModeNote = isSeedMode
    ? `\nNOTE: This is a NEW SITE with no existing organic rankings. All keyword data represents the target keyword universe derived from a service-locale matrix, not current ranking performance. Position data shows synthetic rank 100 (unranked). Focus analysis on: keyword universe quality, volume distribution, competitive landscape from competitors data, and prioritized content opportunities.\n`
    : '';
  const autoSupplementNote = wasAutoSupplemented
    ? `\nIMPORTANT: This domain has very low organic visibility (only ${organicKeywords.length} ranked keywords). The dataset has been supplemented with ${supplementedKeywords.length} high-opportunity target keywords for the ${audit.service_key?.replace(/_/g, ' ') ?? 'unknown'} industry in ${audit.market_city ?? 'unknown'}, ${audit.market_state ?? ''}. Keywords with Position = 100 are UNRANKED opportunity targets, not current rankings. Your analysis MUST focus on these opportunity keywords — evaluate their volume, CPC, competitive difficulty, and prioritize content recommendations around the highest-value targets. Do NOT focus primarily on the few branded/navigational terms the site currently ranks for.\n`
    : '';
  const salesModeNote = mode === 'sales'
    ? `\nSALES MODE — Produce a condensed report for a sales prospect. Follow these overrides:
- Section 1 (Executive Summary): 1 paragraph only
- Section 2 (Keyword Overview): keep the table
- Sections 3-6: SKIP entirely (do not output)
- Section 7 (Competitor Deep Dive): Top 5 competitors only
- Section 8 (Striking Distance): Top 10 keywords only
- Sections 9-10: 3 items max each
All other formatting rules still apply.\n`
    : '';
  const hasUpstreamData = !!(siteInventory || kwResearchSection);
  const upstreamNote = hasUpstreamData
    ? `\nYou have upstream data from Dwight (technical crawl) and KeywordResearch (validated opportunity matrix). Use these as your PRIMARY research foundation. The DataForSEO ranked-keywords data below supplements this with actual ranking positions.\n`
    : '';
  const fallbackNote = !hasUpstreamData && !isSeedMode
    ? `\nNOTE: No upstream data from Dwight or KeywordResearch is available. Using seed keyword fallback for supplementation.\n`
    : '';
  const narrativePrompt = `You are Jim, The Scout — a foundational search intelligence analyst. You have full DataForSEO data for ${domain}.

YOUR ENTIRE RESPONSE IS THE REPORT. Output ONLY the markdown content of research_summary.md — start with "# Research Summary" heading. Do NOT narrate, summarize what you did, or describe the file. Do NOT say "I'll write" or "Here's the report" or use backtick file paths. Just output the formatted report that Michael (The Architect) will use to plan the site's information architecture.
${seedModeNote}${autoSupplementNote}${salesModeNote}${upstreamNote}${fallbackNote}
${siteInventory ? `${siteInventory}\n` : ''}${kwResearchSection ? `## Keyword Opportunities (from KeywordResearch)\n${kwResearchSection}\n\n` : ''}## Raw Keyword Data (top 200 of ${totalKeywords} by volume)
Keyword | Position | Volume | CPC | Difficulty | Competition | Ranking URL
${keywordTable}

## Competitor Landscape (top 50 of ${rawCompetitors.length})
Domain | Avg Position | Sum Position | Shared Keywords | Total Organic Keywords | ETV
${competitorTable}

## All Ranked URLs on ${domain} (${allUrls.length} unique)
${allUrls.join('\n')}

## Total Dataset Stats
- Total keywords tracked: ${totalKeywords}
- Total competitors found: ${rawCompetitors.length}

## REQUIRED OUTPUT FORMAT — EXACT SECTION HEADINGS AND TABLE SCHEMAS
You MUST use these exact section headings and table column orders. The downstream parser depends on them.

### Section 1:
\`\`\`
## 1. Executive Summary
[2-3 paragraphs — current search visibility, competitive position, biggest opportunities]
\`\`\`

### Section 2 — use this EXACT table format:
\`\`\`
## 2. Keyword Overview
| Metric | Value |
|---|---|
| Total ranked keywords | [number] |
| Total search volume | [number]/mo |
| Average position | [number] |
| Estimated traffic value | $[number]/mo |
| Keywords in top 10 | [number] |
| Near-miss keywords (pos 11-20) | [number] |
\`\`\`

### Section 3 — use this EXACT table format:
\`\`\`
## 3. Position Distribution
| Range | Count | Pct |
|---|---|---|
| 1-3 | [n] | [n]% |
| 4-10 | [n] | [n]% |
| 11-20 | [n] | [n]% |
| 21-50 | [n] | [n]% |
| 51-100 | [n] | [n]% |
\`\`\`

### Section 4 — use this EXACT table format:
\`\`\`
## 4. Branded vs Non-Branded Analysis
| Segment | Count | Volume | Avg Position |
|---|---|---|---|
| Branded | [n] | [n]/mo | [n] |
| Non-branded | [n] | [n]/mo | [n] |
\`\`\`

### Section 5 — use this EXACT table format:
\`\`\`
## 5. Search Intent Breakdown
| Intent | Count | Volume | Pct Volume |
|---|---|---|---|
| Navigational | [n] | [n] | [n]% |
| Commercial | [n] | [n] | [n]% |
| Transactional | [n] | [n] | [n]% |
| Informational | [n] | [n] | [n]% |
\`\`\`

### Section 6 — use this EXACT table format:
\`\`\`
## 6. Top Ranking URLs
| URL | Keywords | Volume |
|---|---|---|
| [full url] | [n] | [n] |
\`\`\`

### Section 7 — use these EXACT sub-headings and table format:
\`\`\`
## 7. Competitor Deep Dive
### Top 15 Competitors
| # | Domain | Overlap % | Shared Keywords | Total Keywords | Avg Position | ETV |
|---|---|---|---|---|---|---|
| 1 | example.com | [n]% | [n] | [n] | [n] | $[n] |

### Client vs Key Competitor Comparison
| Metric | ${domain} | [competitor1] | [competitor2] | [competitor3] |
|---|---|---|---|---|
[comparison rows]
\`\`\`

### Section 8 — use this EXACT table format:
\`\`\`
## 8. Striking Distance Keywords (Positions 11-20)
| # | Keyword | Position | Volume | CPC | Intent |
|---|---|---|---|---|---|
| 1 | [keyword] | [n] | [n] | $[n] | Commercial |
\`\`\`

### Section 9 — use numbered bold headings:
\`\`\`
## 9. Content Gap Observations
1. **[Gap title]** — [explanation with specific keywords, URLs, competitors]
2. **[Gap title]** — [explanation]
[5-8 observations]
\`\`\`

### Section 10 — use bracketed section labels:
\`\`\`
## 10. Key Takeaways & Recommendations
**[SECTION LABEL — e.g. SERVICE PAGES]**
[recommendation with specific keywords and data]
[6-8 items total]
\`\`\`

## IMPORTANT RULES
- Use plain numbers (no tildes ~) in table cells. Round to whole numbers.
- Use /mo suffix for volume in Keyword Overview and Branded tables.
- Use $ prefix for dollar values.
- Do NOT add extra columns or change column order.
- Be specific — reference actual keywords, URLs, and competitor domains from the data.
- Add analysis commentary BELOW tables, not inside them.
- This is a professional deliverable, not a summary of summaries.`;

  const summaryMd = await callClaudeAsync(narrativePrompt, 'sonnet');
  const summaryPath = path.join(researchDir, 'research_summary.md');
  fs.writeFileSync(summaryPath, summaryMd, 'utf-8');
  validateArtifact(summaryPath, 'research_summary.md', 3000);
  console.log(`  Written research_summary.md (${summaryMd.length} chars) to ${path.relative(process.cwd(), researchDir)}/`);

  // Step 5: Insert audit_snapshots + agent_runs
  const { data: existingSnapshot } = await sb
    .from('audit_snapshots')
    .select('snapshot_version')
    .eq('audit_id', auditId)
    .eq('agent_name', 'jim')
    .order('snapshot_version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const snapshotVersion = ((existingSnapshot as any)?.snapshot_version ?? 0) + 1;

  const { data: run } = await sb.from('agent_runs').insert({
    audit_id: auditId,
    agent_name: 'jim',
    run_date: date,
    status: 'completed',
    snapshot_version: snapshotVersion,
    metadata: { keyword_count: totalKeywords, competitor_count: rawCompetitors.length, source: 'pipeline-generate/dataforseo' },
  }).select('id').single();

  const agentRunId = run?.id ?? null;

  await sb.from('audit_snapshots').insert({
    audit_id: auditId,
    agent_name: 'jim',
    snapshot_version: snapshotVersion,
    agent_run_id: agentRunId,
    row_count: totalKeywords,
    research_summary_markdown: summaryMd,
  });

  await sb.from('audits').update({ research_snapshot_at: new Date().toISOString() }).eq('id', auditId);

  console.log(`  Jim complete — ${totalKeywords} keywords, ${rawCompetitors.length} competitors, snapshot v${snapshotVersion}, run ${agentRunId}`);
}

// ============================================================
// Phase 6: Michael — Read disk artifacts + Supabase clusters → architecture blueprint
// ============================================================

/** Scan audits/{domain}/auditor/ for the latest date-named directory. */
function findLatestAuditorDir(domain: string): string | null {
  return findLatestDatedDir(path.join(AUDITS_BASE, domain, 'auditor'));
}

/**
 * Find the latest date-named subdirectory (YYYY-MM-DD) under basePath.
 * Returns the full path or null if none exist.
 */
function findLatestDatedDir(basePath: string): string | null {
  if (!fs.existsSync(basePath)) return null;
  const entries = fs.readdirSync(basePath).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort();
  if (entries.length === 0) return null;
  return path.join(basePath, entries[entries.length - 1]);
}

/**
 * Resolve a file from a dated directory, trying today first then falling back
 * to the most recent date dir that contains the file. Handles date rollover
 * between pipeline phases (e.g., Dwight ran yesterday, Jim runs today).
 */
function resolveArtifactPath(domain: string, subdir: 'research' | 'architecture', filename: string, preferredDate?: string): string | null {
  const basePath = path.join(AUDITS_BASE, domain, subdir);

  // Try preferred date first (today or explicit --date)
  const preferred = preferredDate ?? todayStr();
  const preferredPath = path.join(basePath, preferred, filename);
  if (fs.existsSync(preferredPath)) return preferredPath;

  // Fall back to most recent date dir containing the file
  if (!fs.existsSync(basePath)) return null;
  const dateDirs = fs.readdirSync(basePath).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort();
  for (let i = dateDirs.length - 1; i >= 0; i--) {
    const candidate = path.join(basePath, dateDirs[i], filename);
    if (fs.existsSync(candidate)) {
      if (dateDirs[i] !== preferred) {
        console.log(`  ${filename}: using ${dateDirs[i]}/ (date fallback from ${preferred})`);
      }
      return candidate;
    }
  }
  return null;
}

async function runMichael(sb: SupabaseClient, auditId: string, domain: string, researchDate?: string, mode: CliArgs['mode'] = 'full') {
  const today = todayStr();
  const researchDir = path.join(AUDITS_BASE, domain, 'research', researchDate ?? today);
  const archDir = path.join(AUDITS_BASE, domain, 'architecture', today);
  fs.mkdirSync(archDir, { recursive: true });

  console.log('  Gathering context from disk + Supabase...');

  // --- Supabase: audit metadata + clusters (has revenue estimates from syncJim) ---
  const { data: audit } = await sb
    .from('audits')
    .select('domain, service_key, market_city, market_state')
    .eq('id', auditId)
    .single();
  if (!audit) throw new Error('Audit metadata not found');

  const { data: clusterData } = await sb
    .from('audit_clusters')
    .select('topic, total_volume, est_revenue_low, est_revenue_high, sample_keywords, near_miss_positions')
    .eq('audit_id', auditId)
    .order('est_revenue_high', { ascending: false });
  const clusters = (clusterData ?? []) as any[];

  const clusterTable = clusters
    .map((c) => `${c.topic} | ${c.total_volume} | $${c.est_revenue_low}-$${c.est_revenue_high} | ${(c.sample_keywords ?? []).slice(0, 5).join(', ')}`)
    .join('\n');

  // --- Disk: Jim's research_summary.md (REQUIRED) ---
  const researchSummaryPath = resolveArtifactPath(domain, 'research', 'research_summary.md', researchDate);
  if (!researchSummaryPath) throw new Error('research_summary.md not found — Jim must run successfully first');
  validateArtifact(researchSummaryPath, 'research_summary.md (Jim must run successfully first)');
  const researchSummary = fs.readFileSync(researchSummaryPath, 'utf-8');
  console.log(`  research_summary.md: ${researchSummary.length} chars`);

  // --- Disk: Jim's ranked_keywords.json (REQUIRED — top 200 for keyword table) ---
  let keywordSection = '';
  const rankedPath = resolveArtifactPath(domain, 'research', 'ranked_keywords.json', researchDate);
  if (!rankedPath) throw new Error('ranked_keywords.json not found — Jim must run successfully first');
  validateArtifact(rankedPath, 'ranked_keywords.json (Jim must run successfully first)', 1000);
  {
    const rankedData = JSON.parse(fs.readFileSync(rankedPath, 'utf-8'));
    const rawKeywords: any[] = [];
    for (const task of rankedData?.tasks ?? []) {
      for (const result of task?.result ?? []) {
        for (const item of result?.items ?? []) {
          rawKeywords.push(item);
        }
      }
    }

    // Top 200 by volume
    const top200 = rawKeywords
      .sort((a, b) => (b.keyword_data?.keyword_info?.search_volume ?? 0) - (a.keyword_data?.keyword_info?.search_volume ?? 0))
      .slice(0, 200);

    const kwTable = top200
      .map((item) => {
        const kd = item.keyword_data ?? {};
        const ki = kd.keyword_info ?? {};
        const rankInfo = item.ranked_serp_element ?? {};
        return `${kd.keyword ?? ''} | ${rankInfo.serp_item?.rank_group ?? ''} | ${ki.search_volume ?? 0} | ${ki.competition_level ?? ''} | ${kd.keyword_properties?.keyword_difficulty ?? ''} | ${rankInfo.serp_item?.url ?? ''}`;
      })
      .join('\n');

    // Collect all ranked URLs
    const allUrls = [...new Set(
      rawKeywords
        .map((item) => item.ranked_serp_element?.serp_item?.url)
        .filter(Boolean)
        .map((u: string) => { try { return new URL(u).pathname; } catch { return u; } }),
    )];

    keywordSection = `## Keyword Data (top 200 of ${rawKeywords.length} by volume)
Keyword | Position | Volume | Competition | Difficulty | Ranking URL
${kwTable}

## Existing Pages on Site (${allUrls.length} unique URLs)
${allUrls.join('\n')}`;

    console.log(`  ranked_keywords.json: ${rawKeywords.length} keywords → top 200 for prompt`);
  }

  // --- Disk: Gap agent's content_gap_analysis.md ---
  let gapSection = '';
  const gapResolvedPath = resolveArtifactPath(domain, 'research', 'content_gap_analysis.md', researchDate);
  if (gapResolvedPath) {
    gapSection = fs.readFileSync(gapResolvedPath, 'utf-8');
    console.log(`  content_gap_analysis.md: ${gapSection.length} chars`);
  } else {
    console.log('  Warning: content_gap_analysis.md not found — Gap agent may not have run');
  }

  // --- Disk: Dwight's internal_all.csv (copied by Dwight step) ---
  let crawlSection = '';
  const internalAllResolved = resolveArtifactPath(domain, 'architecture', 'internal_all.csv');
  if (internalAllResolved) {
    const crawlContentRaw = readCsvSafe(internalAllResolved);
    const crawlContent = filterCsvColumns(crawlContentRaw, INTERNAL_ALL_KEEP_COLUMNS);
    const crawlSummary = summarizeCsv(crawlContent, 100);
    crawlSection = `## Crawl Data Summary (${crawlSummary.rowCount} pages from Screaming Frog)
${crawlSummary.header}
${crawlSummary.rows}`;
    console.log(`  internal_all.csv: ${crawlSummary.rowCount} pages`);
  } else {
    console.log('  Warning: internal_all.csv not found in architecture dir — Dwight may not have run');
  }

  // --- Disk: Semantic similarity data (cannibalization signals) ---
  let semanticSection = '';
  const semanticResolved = resolveArtifactPath(domain, 'architecture', 'semantically_similar_report.csv');
  if (semanticResolved) {
    const semanticContent = readCsvSafe(semanticResolved);
    const semanticSummary = summarizeCsv(semanticContent, 50);
    if (semanticSummary.rowCount > 0) {
      semanticSection = `## Semantic Similarity Data (${semanticSummary.rowCount} page pairs — cannibalization signals)
${semanticSummary.header}
${semanticSummary.rows}`;
      console.log(`  semantically_similar_report.csv: ${semanticSummary.rowCount} pairs`);
    }
  }

  // --- Disk: Dwight's AUDIT_REPORT.md — extract Platform Observations section ---
  let platformSection = '';
  const auditorDir = findLatestAuditorDir(domain);
  if (auditorDir) {
    const auditReportPath = path.join(auditorDir, 'AUDIT_REPORT.md');
    if (fs.existsSync(auditReportPath)) {
      const reportContent = fs.readFileSync(auditReportPath, 'utf-8');
      const platformMatch = reportContent.match(/##[^#\n]*Platform\s+Observations[^\n]*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/i);
      if (platformMatch) {
        platformSection = platformMatch[1].trim();
        console.log(`  Platform Observations from AUDIT_REPORT.md: ${platformSection.length} chars`);
      } else {
        console.log('  Warning: No Platform Observations section found in AUDIT_REPORT.md');
      }
    } else {
      console.log('  Warning: AUDIT_REPORT.md not found in auditor dir');
    }
  } else {
    console.log('  Warning: No auditor directory found — Dwight may not have run');
  }

  console.log(`  Context loaded: ${clusters.length} clusters, research=${!!researchSummary}, keywords=${!!keywordSection}, gap=${!!gapSection}, crawl=${!!crawlSection}, platform=${!!platformSection}`);

  // --- Build comprehensive prompt ---
  const prompt = `You are Michael, The Architect — an information architecture and semantic content strategist.

YOUR ENTIRE RESPONSE IS THE BLUEPRINT. Output ONLY the markdown content of architecture_blueprint.md — start with the "## Executive Summary" heading. Do NOT narrate, summarize what you did, or describe the file. Do NOT wrap in code fences. Just output the blueprint content directly.

## Task
Generate a complete site architecture blueprint for ${audit.domain} (${audit.service_key} in ${audit.market_city}, ${audit.market_state}).

${researchSummary ? `## Jim's Research Summary (Foundational Search Intelligence)\n${researchSummary}\n` : ''}
${keywordSection ? `${keywordSection}\n` : ''}
## Revenue Clusters (by opportunity — from syncJim with revenue estimates)
Topic | Volume | Revenue Range | Sample Keywords
${clusterTable || 'No cluster data available yet.'}

${crawlSection ? `${crawlSection}\n` : ''}
${semanticSection ? `${semanticSection}\n` : ''}
${gapSection ? `## Content Gap Intelligence\nThe following analysis was produced by the Gap agent. Your architecture MUST address every identified gap.\n\n${gapSection}\n` : ''}
${platformSection ? `## Platform Constraints (from Dwight's Technical Audit)\nThe following platform/CMS observations were identified by the technical auditor. Your architecture MUST account for these constraints.\n\n${platformSection}\n` : ''}
${mode === 'sales' ? `## SALES MODE OVERRIDE
This is a condensed sales prospect report. Follow these overrides:
- Executive Summary: 3-5 paragraphs strategic pitch focused on revenue opportunity
- Max 3 silos with 3-5 pages each
- Skip Cannibalization Warnings and Internal Linking Strategy sections entirely
- Use revenue opportunity language throughout — this is for a prospect, not an internal planning doc
` : ''}## Output Format — CRITICAL
You MUST produce output in this EXACT format. The parser depends on these heading patterns:

### Start with:
\`\`\`
## Executive Summary
[2-3 paragraphs analyzing current state and recommended architecture. Reference Jim's findings, crawl issues from Dwight, and gaps identified by the Gap agent.]
\`\`\`

### Then (only if Platform Constraints were provided above):
\`\`\`
## Platform Constraints
[CMS type, URL slug limitations, any required workarounds for the recommended architecture.]
\`\`\`

### Then for each silo (3-7 silos):
\`\`\`
### Silo N: [Silo Name]
[1-2 sentence description]

| URL Slug | Status | Silo | Role | Primary Keyword | Volume | Action |
|----------|--------|------|------|-----------------|--------|--------|
| service-slug | new/exists | Silo Name | pillar/cluster/support | target keyword | 1234 | create/optimize |
\`\`\`

### Then:
\`\`\`
## Cannibalization Warnings
[Any keyword cannibalization issues between pages — use semantic similarity data if available]

## Internal Linking Strategy
[Silo-based linking recommendations]
\`\`\`

## Rules
1. URL slugs: lowercase, hyphenated, no leading slash (e.g. "plumber-boise" not "/plumber-boise")
2. Status: "new" for pages to create, "exists" for pages already on the site (match against existing URLs / crawl data)
3. Each silo needs exactly 1 pillar page + 2-8 cluster/support pages
4. 3-7 silos total, organized by service category and intent
5. Primary keyword must come from the keyword data — use exact keyword text
6. Volume must match the keyword data
7. Action: "create" for new pages, "optimize" for existing pages
8. Every high-volume cluster topic should map to at least one page
9. Group related keywords into silos by semantic similarity and service category
10. Prioritize near-miss keywords (positions 11-20) — these have the fastest ROI
11. If Content Gap Intelligence is provided above, ensure every authority gap and unaddressed gap maps to at least one page in your architecture
12. If crawl data shows technical issues (broken pages, redirects), note them alongside affected URL slugs
13. If Platform Constraints are provided, validate all URL slugs against CMS limitations. Flag any pattern not natively achievable with the workaround required.
14. Do NOT use near-me keyword variants as primary_keyword for any page. Use the geographic variant instead (e.g. "plumber boise" not "plumber near me").

REMINDER: Your response IS the blueprint content — start with "## Executive Summary" and output the full architecture. No preamble, no narration, no summary of what you did.`;

  console.log('  Generating architecture blueprint via Anthropic API (sonnet)...');
  let result = await callClaudeAsync(prompt, 'sonnet');
  console.log(`  Blueprint: ${result.length} chars`);

  // Structural validation — blueprint must have Executive Summary + at least one Silo table
  const hasExecSummary = /##\s*Executive Summary/i.test(result);
  const hasSiloTable = /###\s*Silo\s+\d+/i.test(result);
  if (!hasExecSummary || !hasSiloTable) {
    console.log(`  WARNING: Blueprint incomplete (Executive Summary: ${hasExecSummary}, Silo tables: ${hasSiloTable}) — retrying...`);
    result = await callClaudeAsync(prompt, 'sonnet');
    console.log(`  Retry blueprint: ${result.length} chars`);
    const retryHasExec = /##\s*Executive Summary/i.test(result);
    const retryHasSilo = /###\s*Silo\s+\d+/i.test(result);
    if (!retryHasExec || !retryHasSilo) {
      console.error(`  ERROR: Blueprint still incomplete after retry (Executive Summary: ${retryHasExec}, Silo tables: ${retryHasSilo})`);
    }
  }

  // Write to disk
  const blueprintPath = path.join(archDir, 'architecture_blueprint.md');
  fs.writeFileSync(blueprintPath, result, 'utf-8');
  validateArtifact(blueprintPath, 'architecture_blueprint.md');
  console.log(`  Written architecture_blueprint.md to ${path.relative(process.cwd(), archDir)}/`);
}

// ============================================================
// Phase 4: Competitor SERP Analysis (DataForSEO)
// ============================================================

function normalizeDomain(raw: string): string {
  try {
    let u = raw.trim().toLowerCase();
    if (!u.startsWith('http://') && !u.startsWith('https://')) u = `https://${u}`;
    const parsed = new URL(u);
    let host = parsed.hostname;
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  } catch {
    let host = raw.split('/')[0].toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  }
}

function extractOrganicUrls(data: any): string[] {
  const urls: string[] = [];
  for (const task of data?.tasks ?? []) {
    for (const res of task?.result ?? []) {
      for (const item of res?.items ?? []) {
        if (item?.url) urls.push(item.url);
        if (item?.link) urls.push(item.link);
        if (item?.serp_item?.url) urls.push(item.serp_item.url);
        for (const nested of item?.items ?? []) {
          if (nested?.url) urls.push(nested.url);
          if (nested?.link) urls.push(nested.link);
        }
      }
    }
  }
  return urls;
}

async function fetchSerpOrganic(
  login: string, password: string, keyword: string, limit = 10,
): Promise<any> {
  const authString = Buffer.from(`${login}:${password}`).toString('base64');
  const resp = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/regular', {
    method: 'POST',
    headers: { Authorization: `Basic ${authString}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ keyword, location_name: 'United States', language_code: 'en', depth: limit }]),
  });
  if (!resp.ok) throw new Error(`DataForSEO HTTP ${resp.status}`);
  const data = await resp.json();
  if (data?.status_code && data.status_code !== 20000) throw new Error(`DataForSEO status ${data.status_code}`);
  return data;
}

// ============================================================
// Canonicalize — Claude-based semantic topic grouping
// ============================================================

async function runCanonicalize(sb: SupabaseClient, auditId: string, domain: string) {
  // Fetch audit metadata for context
  const { data: auditRow } = await sb
    .from('audits')
    .select('service_key, market_city, market_state')
    .eq('id', auditId)
    .single();
  const serviceKey = auditRow?.service_key ?? '';
  const city = auditRow?.market_city ?? '';
  const state = auditRow?.market_state ?? '';
  const locationCtx = [city, state].filter(Boolean).join(', ');

  // Fetch all keywords for this audit
  const { data: kwData, error: kwErr } = await sb
    .from('audit_keywords')
    .select('id, keyword, intent, search_volume, topic')
    .eq('audit_id', auditId);
  if (kwErr) throw new Error(`Failed to fetch keywords: ${kwErr.message}`);
  const keywords = (kwData ?? []) as { id: string; keyword: string; intent: string | null; search_volume: number; topic: string | null }[];

  if (keywords.length === 0) {
    console.log('  [canonicalize] No keywords found, skipping');
    return;
  }
  console.log(`  [canonicalize] ${keywords.length} keywords to classify`);

  // Build batches — if > 300 keywords, chunk by topic groups
  const MAX_BATCH = 250;
  let batches: typeof keywords[];

  if (keywords.length <= MAX_BATCH) {
    batches = [keywords];
  } else {
    // Group by extractTopic baseline, then greedily pack into batches
    const topicGroups = new Map<string, typeof keywords>();
    for (const kw of keywords) {
      const t = kw.topic || 'general';
      const arr = topicGroups.get(t);
      if (arr) arr.push(kw);
      else topicGroups.set(t, [kw]);
    }
    // Sort groups by size descending for greedy bin-packing
    const sorted = [...topicGroups.values()].sort((a, b) => b.length - a.length);
    batches = [];
    let current: typeof keywords = [];
    for (const group of sorted) {
      if (current.length + group.length > MAX_BATCH && current.length > 0) {
        batches.push(current);
        current = [];
      }
      // If a single group exceeds MAX_BATCH, push it as its own batch
      if (group.length > MAX_BATCH) {
        if (current.length > 0) { batches.push(current); current = []; }
        batches.push(group);
      } else {
        current.push(...group);
      }
    }
    if (current.length > 0) batches.push(current);
    console.log(`  [canonicalize] Split into ${batches.length} batches (${batches.map((b) => b.length).join(', ')} keywords)`);
  }

  // Process each batch
  type GroupResult = {
    canonical_key: string;
    canonical_topic: string;
    keywords: { index: number; is_brand: boolean; intent_type: string }[];
  };
  const allGroups: { group: GroupResult; kwId: string }[] = [];

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    if (batches.length > 1) console.log(`  [canonicalize] Processing batch ${bi + 1}/${batches.length} (${batch.length} keywords)...`);

    // Build numbered keyword list
    const kwList = batch.map((kw, i) => `${i + 1}. "${kw.keyword}" (vol: ${kw.search_volume ?? 0}, intent: ${kw.intent ?? 'unknown'})`).join('\n');

    const prompt = `You are an SEO keyword classifier for a ${serviceKey || 'local service'} business${locationCtx ? ` in ${locationCtx}` : ''}.

Below are ${batch.length} keywords numbered 1 to ${batch.length}. Group them into semantic topics.

RULES:
- Strip location names from topic labels (e.g., "boise ac repair" → "AC Repair")
- Merge synonyms and word-order variants (e.g., "ac repair" and "air conditioning repair" → same group)
- canonical_key: lowercase with underscores (e.g., "ac_repair", "water_heater_repair")
- canonical_topic: Title Case human-readable (e.g., "AC Repair", "Water Heater Repair")
- Target 10-30 groups total
- Mark branded keywords (company names, brand terms) with is_brand: true
- Classify intent_type for each keyword using standard SEO intent taxonomy:
  * "commercial" = researching/comparing services or providers. IMPORTANT: "[service] [city]" keywords like "basement remodeling naperville" or "plumber boise" are COMMERCIAL — the searcher is evaluating options, not yet committing. Most local service keywords fall here.
  * "transactional" = ready to act NOW with an explicit action verb like "hire", "book", "schedule", "buy", "order", "get quote". Without an action verb, it is NOT transactional.
  * "informational" = seeking knowledge — cost questions, how-to, guides (e.g., "basement finishing cost", "how to unclog drain")
  * "navigational" = looking for a specific brand/company BY NAME (e.g., "talon construction group", "ross dress for less boise"). ONLY use navigational when the keyword contains a recognizable brand name. Generic service keywords like "hvac contractors boise" or "air conditioning repair meridian" are NEVER navigational — they are commercial.
- Reference keywords by their number (index), not by string

KEYWORDS:
${kwList}

Respond with raw JSON only. No markdown code fences. Just the bare JSON object starting with {.

JSON schema:
{
  "groups": [
    {
      "canonical_key": "ac_repair",
      "canonical_topic": "AC Repair",
      "keywords": [
        { "index": 1, "is_brand": false, "intent_type": "commercial" }
      ]
    }
  ]
}`;

    try {
      const result = callClaude(prompt, 'haiku', 120_000);
      const parsed = JSON.parse(stripCodeFences(result));
      const groups: GroupResult[] = parsed.groups ?? [];

      for (const g of groups) {
        for (const kwRef of g.keywords) {
          const idx = kwRef.index - 1; // 1-indexed → 0-indexed
          if (idx >= 0 && idx < batch.length) {
            allGroups.push({ group: { ...g, keywords: [kwRef] }, kwId: batch[idx].id });
          }
        }
      }
      console.log(`  [canonicalize] Batch ${bi + 1}: ${groups.length} groups identified`);
    } catch (err: any) {
      console.warn(`  [canonicalize] Batch ${bi + 1} failed: ${err.message} — skipping batch`);
    }
  }

  if (allGroups.length === 0) {
    console.warn('  [canonicalize] No groups produced, downstream will use extractTopic() fallback');
    return;
  }

  // Deduplicate: if same canonical_key from multiple batches, keep the one with more keywords
  // (already handled — each keyword maps to exactly one group)

  // Detect near-me keywords deterministically (national volume, not locally actionable)
  const nearMeIds = new Set<string>();
  for (const { kwId } of allGroups) {
    const kw = keywords.find((k) => k.id === kwId);
    if (kw && kw.keyword.toLowerCase().includes(' near me')) {
      nearMeIds.add(kwId);
    }
  }
  if (nearMeIds.size > 0) {
    console.log(`  [canonicalize] Flagging ${nearMeIds.size} near-me keywords`);
  }

  // Batch update audit_keywords
  let updated = 0;
  const BATCH_SIZE = 50;
  for (let i = 0; i < allGroups.length; i += BATCH_SIZE) {
    const chunk = allGroups.slice(i, i + BATCH_SIZE);
    const promises = chunk.map(({ group, kwId }) =>
      sb.from('audit_keywords').update({
        canonical_key: group.canonical_key,
        canonical_topic: group.canonical_topic,
        cluster: group.canonical_topic,
        is_brand: group.keywords[0].is_brand,
        intent_type: group.keywords[0].intent_type,
        intent: group.keywords[0].intent_type,  // backfill intent for dashboard display
        is_near_me: nearMeIds.has(kwId),
      }).eq('id', kwId),
    );
    const results = await Promise.all(promises);
    for (const r of results) {
      if (r.error) console.warn(`  [canonicalize] Update failed: ${r.error.message}`);
      else updated++;
    }
  }

  // Count distinct groups
  const uniqueKeys = new Set(allGroups.map((g) => g.group.canonical_key));
  console.log(`  [canonicalize] Updated ${updated}/${keywords.length} keywords across ${uniqueKeys.size} topics`);

  // Post-canonicalize: clear is_near_miss for branded/navigational keywords
  // (is_brand and intent_type may have changed during canonicalization)
  const { data: staleNearMiss } = await sb.from('audit_keywords')
    .select('id')
    .eq('audit_id', auditId)
    .eq('is_near_miss', true)
    .or('is_brand.eq.true,intent_type.eq.navigational');
  if (staleNearMiss && staleNearMiss.length > 0) {
    const ids = staleNearMiss.map((r: any) => r.id);
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const chunk = ids.slice(i, i + BATCH_SIZE);
      await sb.from('audit_keywords')
        .update({ is_near_miss: false, delta_revenue_low: 0, delta_revenue_mid: 0, delta_revenue_high: 0, delta_leads_low: 0, delta_leads_high: 0, delta_traffic: 0 })
        .in('id', chunk);
    }
    console.log(`  [canonicalize] Cleared is_near_miss for ${ids.length} branded/navigational keywords`);
  }
}

async function runCompetitors(sb: SupabaseClient, auditId: string, domain: string) {
  const env = loadEnv();
  const dfLogin = env.DATAFORSEO_LOGIN;
  const dfPassword = env.DATAFORSEO_PASSWORD;
  if (!dfLogin || !dfPassword) throw new Error('Missing DATAFORSEO_LOGIN or DATAFORSEO_PASSWORD in .env');

  console.log('  Loading keywords from Supabase...');

  const { data: kwData } = await sb
    .from('audit_keywords')
    .select('keyword, search_volume, rank_pos, intent_type, is_brand, canonical_key, canonical_topic, cluster')
    .eq('audit_id', auditId);
  const keywords = (kwData ?? []) as any[];

  // Group by best available topic key: canonical_key > cluster
  // Filter: non-brand, commercial/transactional/unknown intent
  const eligible = keywords.filter((k) =>
    (k.canonical_key || k.cluster)
    && !k.is_brand
    && ['commercial', 'transactional', 'unknown'].includes(k.intent_type ?? 'unknown'),
  );

  if (eligible.length === 0) {
    console.log(`  No eligible keywords (need canonical_key or cluster, non-brand, commercial/transactional/unknown intent)`);
    console.log(`  Total keywords: ${keywords.length}, intent types: ${[...new Set(keywords.map((k) => k.intent_type))].join(', ')}`);
    return;
  }

  const topicMap = new Map<string, { label: string; maxVol: number; rows: any[] }>();
  for (const k of eligible) {
    const key = k.canonical_key || k.cluster;
    const label = k.canonical_topic || k.cluster || key;
    const existing = topicMap.get(key);
    if (!existing) {
      topicMap.set(key, { label, maxVol: k.search_volume ?? 0, rows: [k] });
    } else {
      existing.rows.push(k);
      if ((k.search_volume ?? 0) > existing.maxVol) existing.maxVol = k.search_volume ?? 0;
    }
  }

  const MAX_TOPICS = 20;
  const KW_PER_TOPIC = 5;
  const SERP_DEPTH = 10;

  const sortedTopics = [...topicMap.entries()]
    .sort((a, b) => b[1].maxVol - a[1].maxVol)
    .slice(0, MAX_TOPICS);

  console.log(`  ${eligible.length} eligible keywords across ${topicMap.size} topics (processing top ${sortedTopics.length})`);

  // Load directory exclusion list
  const { data: dirRows } = await sb.from('directory_domains').select('domain').eq('is_active', true);
  const exclusions = (dirRows ?? []).map((r: any) => String(r.domain || '').toLowerCase());

  const clientDomain = domain.replace(/^www\./, '').toLowerCase();

  // Clear prior data
  await sb.from('audit_topic_competitors').delete().eq('audit_id', auditId);
  await sb.from('audit_topic_dominance').delete().eq('audit_id', auditId);

  let topicsProcessed = 0;
  let serpCalls = 0;

  for (const [topicKey, topicData] of sortedTopics) {
    const repKeywords = topicData.rows
      .sort((a: any, b: any) => (b.search_volume ?? 0) - (a.search_volume ?? 0) || (a.rank_pos ?? 9999) - (b.rank_pos ?? 9999))
      .slice(0, KW_PER_TOPIC);

    const domainCounts: Record<string, number> = {};
    let anySucceeded = false;

    for (const kr of repKeywords) {
      try {
        const data = await fetchSerpOrganic(dfLogin, dfPassword, kr.keyword, SERP_DEPTH);
        serpCalls++;
        const urls = extractOrganicUrls(data).slice(0, SERP_DEPTH);
        for (const u of urls) {
          const d = normalizeDomain(u);
          if (!d) continue;
          if (exclusions.some((ex) => d === ex || d.endsWith('.' + ex))) continue;
          domainCounts[d] = (domainCounts[d] || 0) + 1;
        }
        anySucceeded = true;
      } catch (err: any) {
        console.log(`    Warning: SERP fetch failed for "${kr.keyword}": ${err.message}`);
      }
    }

    if (!anySucceeded) continue;

    const totalAppearances = Object.values(domainCounts).reduce((s, v) => s + v, 0);
    if (totalAppearances === 0) continue;

    // Insert competitors
    const competitorRecords = Object.entries(domainCounts).map(([dom, count]) => ({
      audit_id: auditId,
      canonical_key: topicKey,
      competitor_domain: dom,
      appearance_count: count,
      share: count / totalAppearances,
      is_client: dom === clientDomain,
    }));

    await sb.from('audit_topic_competitors').insert(competitorRecords);

    // Dominance summary
    const sorted = competitorRecords.sort((a, b) => b.share - a.share);
    const leader = sorted[0];
    const clientRec = competitorRecords.find((r) => r.competitor_domain === clientDomain);

    await sb.from('audit_topic_dominance').insert({
      audit_id: auditId,
      canonical_key: topicKey,
      canonical_topic: topicData.label,
      leader_domain: leader?.competitor_domain ?? '',
      leader_share: leader?.share ?? 0,
      client_domain: clientDomain,
      client_share: clientRec?.share ?? 0,
    });

    topicsProcessed++;
    console.log(`    [${topicsProcessed}/${sortedTopics.length}] ${topicData.label}: ${Object.keys(domainCounts).length} competitors (${repKeywords.length} SERP calls)`);
  }

  console.log(`  Competitor analysis complete: ${topicsProcessed} topics, ${serpCalls} SERP API calls`);

  // --- Classify competitor domains via LLM ---
  // Collect all unique non-client competitor domains inserted for this audit
  const { data: allCompRows } = await sb
    .from('audit_topic_competitors')
    .select('competitor_domain')
    .eq('audit_id', auditId)
    .eq('is_client', false);

  const uniqueDomains = Array.from(new Set((allCompRows ?? []).map((r: any) => r.competitor_domain)));
  if (uniqueDomains.length === 0) {
    console.log('  No competitor domains to classify');
    return;
  }

  // Fetch the audit's service_key for industry context
  const { data: auditMeta } = await sb
    .from('audits')
    .select('service_key, market_city, market_state')
    .eq('id', auditId)
    .single();

  const serviceKey = (auditMeta as any)?.service_key ?? 'unknown';
  const market = [(auditMeta as any)?.market_city, (auditMeta as any)?.market_state].filter(Boolean).join(', ');

  console.log(`  Classifying ${uniqueDomains.length} competitor domains (industry: ${serviceKey}, market: ${market})...`);

  // Batch classify — split into chunks of 80 domains per call to stay within token limits
  const CHUNK_SIZE = 80;
  const allClassifications: Record<string, string> = {};

  for (let i = 0; i < uniqueDomains.length; i += CHUNK_SIZE) {
    const chunk = uniqueDomains.slice(i, i + CHUNK_SIZE);
    const domainList = chunk.map((d, idx) => `${idx + 1}. ${d}`).join('\n');

    const classifyPrompt = `You are classifying competitor domains found in search results for a ${serviceKey} business in ${market || 'the US'}.

Client domain: ${clientDomain}

Classify each domain into exactly ONE category:
- "industry_competitor" — a business in the same industry (${serviceKey}) that competes for the same customers
- "aggregator" — a directory, review site, marketplace, or platform (e.g., yelp.com, angi.com, homeadvisor.com, bbb.org, thumbtack.com, youtube.com, facebook.com, mapquest.com, yellowpages.com)
- "brand_confusion" — a different business that shares a name fragment with the client but is NOT in the ${serviceKey} industry, OR a navigational result for a different company entirely
- "unrelated" — a business in a different industry that is not competing for ${serviceKey} customers

Domains to classify:
${domainList}

Respond with ONLY a JSON object mapping each domain to its category. Example:
{"example-hvac.com": "industry_competitor", "yelp.com": "aggregator", "foxservice.com": "brand_confusion"}`;

    try {
      const result = callClaude(classifyPrompt, 'haiku', 120_000);
      const parsed = JSON.parse(stripCodeFences(result));
      for (const [dom, type] of Object.entries(parsed)) {
        if (typeof type === 'string') {
          allClassifications[dom] = type;
        }
      }
      console.log(`    Classified chunk ${Math.floor(i / CHUNK_SIZE) + 1}: ${Object.keys(parsed).length} domains`);
    } catch (err: any) {
      console.log(`    Warning: Classification failed for chunk ${Math.floor(i / CHUNK_SIZE) + 1}: ${err.message}`);
      // Fall through — unclassified domains will have competitor_type = null
    }
  }

  // Batch update competitor_type in Supabase
  let updatedCount = 0;
  for (const [dom, type] of Object.entries(allClassifications)) {
    const { error } = await sb
      .from('audit_topic_competitors')
      .update({ competitor_type: type })
      .eq('audit_id', auditId)
      .eq('competitor_domain', dom);
    if (!error) updatedCount++;
  }

  const typeCounts: Record<string, number> = {};
  for (const type of Object.values(allClassifications)) {
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  }
  console.log(`  Classification complete: ${updatedCount}/${uniqueDomains.length} domains updated`);
  console.log(`    ${Object.entries(typeCounts).map(([t, c]) => `${t}: ${c}`).join(', ')}`);
}

// ============================================================
// Phase 5: Content Gap Analysis
// ============================================================

async function runGap(sb: SupabaseClient, auditId: string, domain: string) {
  console.log('  Gathering competitive data from Supabase...');

  // 1. Competitor data — filter out brand_confusion, aggregators, and unrelated domains
  const { data: compData } = await sb
    .from('audit_topic_competitors')
    .select('canonical_key, competitor_domain, appearance_count, share, is_client, competitor_type')
    .eq('audit_id', auditId);
  // Keep only industry competitors + client rows + unclassified (null) for backwards compat
  const competitors = ((compData ?? []) as any[]).filter(
    (c) => c.is_client || !c.competitor_type || c.competitor_type === 'industry_competitor',
  );

  // 2. Dominance scores — filter out topics where the leader is a non-industry domain
  const nonIndustryDomains = new Set(
    ((compData ?? []) as any[])
      .filter((c) => c.competitor_type && c.competitor_type !== 'industry_competitor' && !c.is_client)
      .map((c) => c.competitor_domain),
  );

  const { data: domData } = await sb
    .from('audit_topic_dominance')
    .select('canonical_key, canonical_topic, leader_domain, leader_share, client_domain, client_share')
    .eq('audit_id', auditId);
  const dominance = ((domData ?? []) as any[]).filter(
    (d) => !nonIndustryDomains.has(d.leader_domain),
  );

  // 3. Client keywords
  const { data: kwData } = await sb
    .from('audit_keywords')
    .select('keyword, rank_pos, search_volume, intent, intent_type, ranking_url, cluster, is_near_miss, is_near_me, cpc')
    .eq('audit_id', auditId);
  const keywords = (kwData ?? []) as any[];

  // 4. Clusters
  const { data: clusterData } = await sb
    .from('audit_clusters')
    .select('topic, total_volume, est_revenue_low, est_revenue_high, sample_keywords')
    .eq('audit_id', auditId)
    .order('est_revenue_high', { ascending: false });
  const clusters = (clusterData ?? []) as any[];

  // 5. Michael's planned pages (if they exist yet)
  const { data: archPages } = await sb
    .from('agent_architecture_pages')
    .select('url_slug, silo_name, role, primary_keyword, action_required')
    .eq('audit_id', auditId);
  const plannedPages = (archPages ?? []) as any[];

  console.log(`  Context: ${competitors.length} competitor entries, ${dominance.length} dominance scores, ${keywords.length} keywords, ${clusters.length} clusters, ${plannedPages.length} planned pages`);

  if (competitors.length === 0 && dominance.length === 0) {
    console.log('  No competitive data found — skipping gap analysis');
    return;
  }

  // Build compact summaries for the prompt
  // Dominance: lower client_share = weaker position
  const topDominance = dominance
    .sort((a, b) => (a.client_share ?? 0) - (b.client_share ?? 0))
    .slice(0, 30)
    .map((d) => `${d.canonical_topic ?? d.canonical_key} | client_share=${(d.client_share ?? 0).toFixed(2)} | leader=${d.leader_domain} share=${(d.leader_share ?? 0).toFixed(2)}`)
    .join('\n');

  // Aggregate competitors by domain
  const compByDomain = new Map<string, { topics: string[]; totalAppearances: number }>();
  for (const c of competitors) {
    const existing = compByDomain.get(c.competitor_domain) ?? { topics: [], totalAppearances: 0 };
    existing.topics.push(c.canonical_key);
    existing.totalAppearances += c.appearance_count ?? 0;
    compByDomain.set(c.competitor_domain, existing);
  }
  const topCompetitors = [...compByDomain.entries()]
    .sort((a, b) => b[1].totalAppearances - a[1].totalAppearances)
    .slice(0, 10)
    .map(([dom, d]) => `${dom}: ${d.totalAppearances} appearances, topics: ${d.topics.slice(0, 5).join(', ')}`)
    .join('\n');

  const clusterSummary = clusters.slice(0, 20)
    .map((c) => `${c.topic} | vol=${c.total_volume} | rev=$${c.est_revenue_low}-$${c.est_revenue_high} | samples: ${(c.sample_keywords ?? []).slice(0, 3).join(', ')}`)
    .join('\n');

  // Topics where client has low/zero share but competitor leads
  const weakTopics = dominance
    .filter((d) => (d.client_share ?? 0) < 0.05 && (d.leader_share ?? 0) > 0.1)
    .map((d) => `${d.canonical_topic ?? d.canonical_key}: client_share=${(d.client_share ?? 0).toFixed(2)}, leader=${d.leader_domain} share=${(d.leader_share ?? 0).toFixed(2)}`)
    .join('\n');

  const plannedSummary = plannedPages.length > 0
    ? plannedPages.map((p) => `${p.url_slug} (${p.silo_name}/${p.role}) → "${p.primary_keyword}" [${p.action_required}]`).join('\n')
    : 'No architecture plan exists yet.';

  const prompt = `You are a Content Gap Analyst. Given the competitive landscape data for ${domain}, produce a JSON analysis identifying where competitors rank but the client is absent or weak.

YOUR ENTIRE RESPONSE IS RAW JSON. Output ONLY the JSON object starting with {. No markdown, no code fences, no narration, no explanation before or after.

## Dominance Scores (worst first — low score = competitor dominates)
${topDominance || 'No dominance data available.'}

## Top Competitors
${topCompetitors || 'No competitor data available.'}

## Client Clusters by Revenue Opportunity
${clusterSummary || 'No cluster data available.'}

## Topics Where Client Is Absent/Weak But Competitors Rank Top-10
${weakTopics || 'None identified.'}

## Michael's Planned Architecture Pages
${plannedSummary}

## Output — JSON with these keys:

1. "authority_gaps": Array of objects with { topic, client_status ("absent"|"weak"|"behind"), client_position (null if absent), top_competitor, competitor_position, estimated_volume, revenue_opportunity, data_source ("SERP dominance"|"keyword overlap") }. Use "SERP dominance" for gaps identified from the Dominance Scores or Absent/Weak Topics sections; use "keyword overlap" for gaps from Client Clusters by Revenue Opportunity. Topics where competitors dominate and client is absent or ranking 50+. Max 15.

2. "format_gaps": Array of objects with { format, description, examples, competitor_using }. Content types competitors have that client lacks (e.g., FAQs, comparison pages, location pages, service+city pages, guides, cost calculators). Max 8.

3. "unaddressed_gaps": Array of objects with { topic, gap_type, reason }. Gaps from authority_gaps NOT covered by Michael's planned architecture pages. If no architecture exists, list all authority_gaps here. Max 10.

4. "priority_recommendations": Array of objects with { rank, action, target_keyword, estimated_volume, rationale }. Top 8 actionable items sorted by revenue opportunity.

5. "summary": 2-3 sentence executive summary of the competitive gap landscape. Note which data source (SERP dominance vs keyword overlap) drove the majority of identified gaps.

## QUALITY RULES for authority_gaps topics:
- Each topic must be a COMPLETE, meaningful service phrase (e.g., "AC repair", "furnace installation"). Never use truncated fragments like "boise heating and" or "repair boise".
- Deduplicate semantic equivalents: "air conditioner repair" and "air conditioning repair" are the same topic — pick one.
- Exclude brand/navigational queries (other companies' names, job listings, TV schedules).
- Exclude non-customer intent (job postings, supplier queries, industry news).
- Topics should be service-category level ("AC repair", "furnace installation"), not raw keyword strings.
- If two topics differ only by city name, merge into the service topic and note the city in revenue_opportunity.
- Do NOT use near-me keywords for revenue_opportunity estimates — near-me volume is national, not locally actionable.

CRITICAL: Respond with raw JSON only. No markdown code fences. Just the bare JSON object starting with {.

REMINDER: Your response IS the JSON object — start with { and end with }. No preamble, no narration.`;

  console.log('  Generating content gap analysis via Anthropic API...');
  let gapAnalysis: any;
  try {
    const result = await callClaudeAsync(prompt, 'sonnet');
    gapAnalysis = JSON.parse(stripCodeFences(result));
    console.log(`  Gap analysis: ${gapAnalysis.authority_gaps?.length ?? 0} authority gaps, ${gapAnalysis.format_gaps?.length ?? 0} format gaps, ${gapAnalysis.unaddressed_gaps?.length ?? 0} unaddressed, ${gapAnalysis.priority_recommendations?.length ?? 0} recommendations`);
  } catch (err: any) {
    throw new Error(`Content gap analysis failed: ${err.message}`);
  }

  // Write markdown to disk
  const gapMd = buildGapAnalysisMd(domain, gapAnalysis);
  const outDir = path.join(AUDITS_BASE, domain, 'research', todayStr());
  fs.mkdirSync(outDir, { recursive: true });
  const gapPath = path.join(outDir, 'content_gap_analysis.md');
  fs.writeFileSync(gapPath, gapMd, 'utf-8');
  validateArtifact(gapPath, 'content_gap_analysis.md', 200);
  console.log(`  Written content_gap_analysis.md to ${path.relative(process.cwd(), outDir)}/`);

  // Insert audit_snapshots + agent_runs
  const { data: existingSnapshot } = await sb
    .from('audit_snapshots')
    .select('snapshot_version')
    .eq('audit_id', auditId)
    .eq('agent_name', 'gap')
    .order('snapshot_version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const snapshotVersion = ((existingSnapshot as any)?.snapshot_version ?? 0) + 1;

  const { data: run } = await sb.from('agent_runs').insert({
    audit_id: auditId,
    agent_name: 'gap',
    run_date: todayStr(),
    status: 'completed',
    snapshot_version: snapshotVersion,
    metadata: {
      authority_gap_count: gapAnalysis.authority_gaps?.length ?? 0,
      format_gap_count: gapAnalysis.format_gaps?.length ?? 0,
      unaddressed_count: gapAnalysis.unaddressed_gaps?.length ?? 0,
      source: 'pipeline-generate',
    },
  }).select('id').single();

  const agentRunId = run?.id ?? null;

  await sb.from('audit_snapshots').insert({
    audit_id: auditId,
    agent_name: 'gap',
    snapshot_version: snapshotVersion,
    agent_run_id: agentRunId,
    row_count: gapAnalysis.authority_gaps?.length ?? 0,
    research_summary_markdown: gapMd,
    content_gap_observations: gapAnalysis.authority_gaps ?? [],
    key_takeaways: gapAnalysis.priority_recommendations ?? [],
    keyword_overview: {
      authority_gaps: gapAnalysis.authority_gaps ?? [],
      format_gaps: gapAnalysis.format_gaps ?? [],
      unaddressed_gaps: gapAnalysis.unaddressed_gaps ?? [],
      summary: gapAnalysis.summary ?? '',
    },
  });

  console.log(`  Gap analysis complete — snapshot v${snapshotVersion}, run ${agentRunId}`);
}

function buildGapAnalysisMd(domain: string, analysis: any): string {
  const lines: string[] = [];
  lines.push(`# Content Gap Analysis — ${domain}`);
  lines.push(`\n**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Source:** pipeline-generate.ts (synthesized from Supabase competitive data)\n`);

  if (analysis.summary) {
    lines.push(`## Executive Summary\n`);
    lines.push(analysis.summary + '\n');
  }

  if (analysis.authority_gaps?.length > 0) {
    lines.push('## Authority Gaps\n');
    lines.push('Topics where competitors dominate and client is absent or weak.\n');
    lines.push('| Topic | Client Status | Client Pos | Top Competitor | Comp Pos | Est. Volume | Revenue | Data Source |');
    lines.push('|-------|--------------|------------|----------------|----------|-------------|---------|-------------|');
    for (const g of analysis.authority_gaps) {
      lines.push(`| ${g.topic} | ${g.client_status} | ${g.client_position ?? 'N/A'} | ${g.top_competitor} | ${g.competitor_position} | ${g.estimated_volume ?? 'N/A'} | ${g.revenue_opportunity ?? 'N/A'} | ${g.data_source ?? 'N/A'} |`);
    }
  }

  if (analysis.format_gaps?.length > 0) {
    lines.push('\n## Content Format Gaps\n');
    lines.push('Content types competitors have that client lacks.\n');
    lines.push('| Format | Description | Examples | Competitor Using |');
    lines.push('|--------|------------|----------|-----------------|');
    for (const g of analysis.format_gaps) {
      lines.push(`| ${g.format} | ${g.description} | ${Array.isArray(g.examples) ? g.examples.join(', ') : g.examples ?? ''} | ${Array.isArray(g.competitor_using) ? g.competitor_using.join(', ') : g.competitor_using ?? ''} |`);
    }
  }

  if (analysis.unaddressed_gaps?.length > 0) {
    lines.push('\n## Unaddressed Gaps\n');
    lines.push('Gaps NOT covered by the current architecture plan.\n');
    lines.push('| Topic | Gap Type | Reason |');
    lines.push('|-------|----------|--------|');
    for (const g of analysis.unaddressed_gaps) {
      lines.push(`| ${g.topic} | ${g.gap_type} | ${g.reason} |`);
    }
  }

  if (analysis.priority_recommendations?.length > 0) {
    lines.push('\n## Priority Recommendations\n');
    lines.push('| Rank | Action | Target Keyword | Est. Volume | Rationale |');
    lines.push('|------|--------|---------------|-------------|-----------|');
    for (const r of analysis.priority_recommendations) {
      lines.push(`| ${r.rank} | ${r.action} | ${r.target_keyword} | ${r.estimated_volume ?? 'N/A'} | ${r.rationale} |`);
    }
  }

  return lines.join('\n');
}

// ============================================================
// Phase 1: Dwight — Comprehensive SF Crawl + Claude analysis
// ============================================================

function readCsvSafe(filePath: string, dropWideCols = true): string {
  if (!fs.existsSync(filePath)) return '';
  let content = fs.readFileSync(filePath, 'utf-8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  if (!dropWideCols) return content;

  // Drop columns wider than 500 chars (e.g. raw embedding vectors from Gemini)
  // These are useless for prompts and can blow up context (39KB per cell)
  const lines = content.split('\n');
  if (lines.length < 2) return content;

  // Simple CSV split — handles quoted fields with commas
  const parseLine = (line: string): string[] => {
    const cols: string[] = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuote = !inQuote; cur += ch; }
      else if (ch === ',' && !inQuote) { cols.push(cur); cur = ''; }
      else { cur += ch; }
    }
    cols.push(cur);
    return cols;
  };

  // Find columns to keep by sampling first few data rows
  const headerCols = parseLine(lines[0]);
  const keepIdx: number[] = [];
  const sampleRows = lines.slice(1, Math.min(6, lines.length)).filter((l) => l.trim());
  for (let c = 0; c < headerCols.length; c++) {
    const maxWidth = Math.max(...sampleRows.map((r) => (parseLine(r)[c] ?? '').length));
    if (maxWidth <= 500) keepIdx.push(c);
  }

  if (keepIdx.length === headerCols.length) return content; // nothing to drop

  const droppedNames = headerCols.filter((_, i) => !keepIdx.includes(i)).map((n) => n.replace(/"/g, ''));
  console.log(`  Dropped wide columns from CSV: ${droppedNames.join(', ')}`);

  return lines
    .filter((l) => l.trim())
    .map((line) => {
      const cols = parseLine(line);
      return keepIdx.map((i) => cols[i] ?? '').join(',');
    })
    .join('\n');
}

/**
 * Filter CSV to only include specified columns (by header name).
 * Uses the same parseLine logic as readCsvSafe. Case-insensitive match.
 */
function filterCsvColumns(content: string, keepColumns: string[]): string {
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return content;

  const parseLine = (line: string): string[] => {
    const cols: string[] = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuote = !inQuote; cur += ch; }
      else if (ch === ',' && !inQuote) { cols.push(cur); cur = ''; }
      else { cur += ch; }
    }
    cols.push(cur);
    return cols;
  };

  const headerCols = parseLine(lines[0]);
  const keepLower = new Set(keepColumns.map((c) => c.toLowerCase()));
  const keepIdx: number[] = [];
  for (let i = 0; i < headerCols.length; i++) {
    const name = headerCols[i].replace(/"/g, '').trim().toLowerCase();
    if (keepLower.has(name)) keepIdx.push(i);
  }

  if (keepIdx.length === 0) return content; // no matches, return as-is

  return lines
    .map((line) => {
      const cols = parseLine(line);
      return keepIdx.map((i) => cols[i] ?? '').join(',');
    })
    .join('\n');
}

// Columns from internal_all.csv that matter for a technical SEO audit.
// Dropping noise (pixel widths, CO2, hash, JS-specific links, semantic embeddings,
// secondary headings, etc.) cuts the prompt from ~1.3MB to ~300KB for a typical site.
const INTERNAL_ALL_KEEP_COLUMNS = [
  'Address', 'Content Type', 'Status Code', 'Status',
  'Indexability', 'Indexability Status',
  'Title 1', 'Title 1 Length',
  'Meta Description 1', 'Meta Description 1 Length',
  'H1-1', 'H1-1 Length',
  'H2-1', 'H2-1 Length',
  'Meta Robots 1', 'Canonical Link Element 1',
  'Word Count', 'Text Ratio', 'Readability',
  'Crawl Depth', 'Link Score',
  'Inlinks', 'Unique Inlinks', 'Outlinks', 'External Outlinks', 'Unique External Outlinks',
  'Response Time', 'Redirect URL', 'Redirect Type',
  'Spelling Errors', 'Grammar Errors',
  'Size (bytes)',
];

function summarizeCsv(content: string, maxRows = 200): { header: string; rows: string; rowCount: number; full: boolean } {
  const lines = content.split('\n').filter((l) => l.trim());
  const header = lines[0] ?? '';
  const dataLines = lines.slice(1);
  const rowCount = dataLines.length;
  const full = rowCount <= maxRows;
  const rows = dataLines.slice(0, maxRows).join('\n');
  return { header, rows, rowCount, full };
}

async function runDwight(domain: string) {
  const date = todayStr();
  const outDir = path.join(AUDITS_BASE, domain, 'auditor', date);
  fs.mkdirSync(outDir, { recursive: true });

  const url = domain.startsWith('http') ? domain : `https://${domain}`;

  {
    const sfBin = process.env.SF_BIN || 'screamingfrogseospider';

    // Check if semantic config exists — determines whether we include Content tabs
    const semanticConfig = path.resolve(process.cwd(), 'configs/semantic_config.seospiderconfig');
    const hasSemanticConfig = fs.existsSync(semanticConfig);

    // Build SF CLI command with comprehensive exports
    const exportTabsList = [
      'Internal:All', 'External:All',
      'Response Codes:Client Error (4xx)', 'Response Codes:Redirection (3xx)', 'Response Codes:Server Error (5xx)',
      'Page Titles:All', 'Meta Description:All',
      'H1:All', 'H2:All',
      'Images:All', 'Canonicals:All', 'Directives:All',
      'Sitemaps:All', 'Structured Data:All',
    ];
    // Content:All requires content analysis enabled via --config; without it SF produces ZERO output
    if (hasSemanticConfig) exportTabsList.push('Content:All');

    const bulkExportsList = [
      'Images:Images Missing Alt Text Inlinks',
      'Canonicals:Self Referencing Inlinks', 'Canonicals:Canonicalised Inlinks',
      'Response Codes:Internal:Internal Client Error (4xx) Inlinks',
      'Response Codes:Internal:Internal Redirection (3xx) Inlinks',
      'Security:Unsafe Cross-Origin Links',
      'Links:Internal Outlinks With No Anchor Text',
    ];
    if (hasSemanticConfig) bulkExportsList.push('Content:Semantically Similar', 'Content:Near Duplicates');

    const saveReportsList = ['Crawl Overview', 'Issues Overview'];

    if (hasSemanticConfig) {
      console.log('  Using semantic config — Content tabs + Gemini embeddings enabled');
    }

    // Clean output dir so stale files don't mask failures
    if (fs.existsSync(outDir)) {
      for (const f of fs.readdirSync(outDir)) {
        const fp = path.join(outDir, f);
        if (fs.statSync(fp).isFile()) fs.unlinkSync(fp);
      }
      console.log('  Cleaned stale output directory');
    }

    // Write SF command to a temp bash script — SF (Java) behaves differently when called
    // via Node.js spawnSync vs a real shell (process group, tty, env quirks).
    // Writing to a script and executing via bash guarantees identical behavior to manual runs.
    const shellEscape = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

    const exportTabsStr = exportTabsList.join(',');
    const bulkExportsStr = bulkExportsList.join(',');
    const saveReportsStr = saveReportsList.join(',');

    let sfCmd = `${shellEscape(sfBin)} \\\n  --crawl ${shellEscape(url)} \\\n  --headless \\\n  --output-folder ${shellEscape(outDir)} \\\n  --overwrite \\\n  --export-tabs ${shellEscape(exportTabsStr)} \\\n  --bulk-export ${shellEscape(bulkExportsStr)} \\\n  --save-report ${shellEscape(saveReportsStr)}`;
    if (hasSemanticConfig) {
      sfCmd += ` \\\n  --config ${shellEscape(semanticConfig)}`;
    }

    const tmpScript = path.join(outDir, '_sf_crawl.sh');
    fs.writeFileSync(tmpScript, `#!/bin/bash\nset -x\n${sfCmd}\n`, { mode: 0o755 });

    console.log(`  Crawling ${url} with Screaming Frog CLI (comprehensive)...`);
    console.log(`  Output directory: ${path.relative(process.cwd(), outDir)}/`);
    console.log(`  Script: ${tmpScript}`);

    // Execute via bash — inherits stdio for SF's verbose Java logging
    const sfResult = child_process.spawnSync('bash', [tmpScript], {
      timeout: 600_000,
      stdio: 'inherit',
      cwd: process.cwd(),
    });

    // Clean up temp script
    try { fs.unlinkSync(tmpScript); } catch {}

    if (sfResult.error) {
      throw new Error(`SF spawn failed: ${sfResult.error.message}`);
    }
    if (sfResult.status !== 0) {
      console.log(`  Warning: SF exited ${sfResult.status}`);
    }
  }

  // Count output files
  let outputFiles = fs.readdirSync(outDir).filter((f) => f.endsWith('.csv') || f.endsWith('.txt'));
  console.log(`  Crawl complete: ${outputFiles.length} files produced`);


  // Read primary CSV
  const csvFile = path.join(outDir, 'internal_all.csv');
  if (!fs.existsSync(csvFile)) {
    throw new Error(`Crawl completed but internal_all.csv not found at ${csvFile}`);
  }

  const internalAllRaw = readCsvSafe(csvFile);
  const internalAll = filterCsvColumns(internalAllRaw, INTERNAL_ALL_KEEP_COLUMNS);
  const internalSummary = summarizeCsv(internalAll);
  console.log(`  internal_all.csv: ${internalSummary.rowCount} pages (${INTERNAL_ALL_KEEP_COLUMNS.length} columns selected)`);

  // Read supplementary CSVs for richer prompt context
  const supplementary: { name: string; summary: string }[] = [];
  const suppFiles: Array<{ label: string; patterns: string[] }> = [
    { label: 'Page Titles', patterns: ['page_titles_all.csv'] },
    { label: 'Meta Descriptions', patterns: ['meta_description_all.csv'] },
    { label: 'H1 Tags', patterns: ['h1_all.csv'] },
    { label: 'Structured Data', patterns: ['structured_data_all.csv'] },
    { label: 'Canonicals', patterns: ['canonicals_all.csv'] },
    { label: 'Sitemaps', patterns: ['sitemaps_all.csv'] },
    { label: 'Directives', patterns: ['directives_all.csv'] },
    { label: '4xx Errors', patterns: ['client_error_4xx.csv', 'response_codes_client_error_4xx.csv'] },
    { label: '3xx Redirects', patterns: ['redirection_3xx.csv', 'response_codes_redirection_3xx.csv'] },
    { label: '5xx Errors', patterns: ['server_error_5xx.csv', 'response_codes_server_error_5xx.csv'] },
    { label: 'Images', patterns: ['images_all.csv'] },
  ];

  for (const sf of suppFiles) {
    for (const pattern of sf.patterns) {
      const filePath = path.join(outDir, pattern);
      if (fs.existsSync(filePath)) {
        const content = readCsvSafe(filePath);
        const s = summarizeCsv(content, 50);
        if (s.rowCount > 0) {
          supplementary.push({ name: sf.label, summary: `${s.rowCount} rows\n${s.header}\n${s.rows}` });
        }
        break;
      }
    }
  }

  // Read issues overview report if available
  let issuesOverview = '';
  const issuesPaths = [
    path.join(outDir, 'issues_reports', 'issues_overview_report.csv'),
    path.join(outDir, 'issues_overview_report.csv'),
  ];
  for (const ip of issuesPaths) {
    if (fs.existsSync(ip)) {
      issuesOverview = readCsvSafe(ip);
      break;
    }
  }

  // Read semantically similar report if available
  let semanticReport = '';
  const semanticPaths = [
    path.join(outDir, 'semantically_similar_report.csv'),
    path.join(outDir, 'bulk_exports', 'semantically_similar.csv'),
    path.join(outDir, 'Content_Semantically Similar.csv'),
  ];
  for (const sp of semanticPaths) {
    if (fs.existsSync(sp)) {
      semanticReport = readCsvSafe(sp);
      break;
    }
  }

  // Build comprehensive prompt
  console.log('  Generating AUDIT_REPORT.md via Anthropic API (sonnet)...');

  let supplementarySection = '';
  if (supplementary.length > 0) {
    supplementarySection = supplementary.map((s) => `### ${s.name}\n${s.summary}`).join('\n\n');
  }

  let issuesSection = '';
  if (issuesOverview) {
    const is = summarizeCsv(issuesOverview, 100);
    issuesSection = `## Issues Overview Report (${is.rowCount} issues)\n${is.header}\n${is.rows}`;
  }

  let semanticSection = '';
  if (semanticReport) {
    const ss = summarizeCsv(semanticReport, 50);
    semanticSection = `## Semantically Similar Pages (${ss.rowCount} pairs)\n${ss.header}\n${ss.rows}`;
  }

  const reportPrompt = `You are Dwight, a Technical SEO & Agentic Readiness Auditor. You have crawled ${domain} with Screaming Frog using comprehensive exports (${outputFiles.length} output files). Below is the full crawl data.

YOUR ENTIRE RESPONSE IS THE REPORT. Output ONLY the markdown content of AUDIT_REPORT.md — start with the "# Technical SEO" heading. Do NOT narrate, summarize, or describe what you are doing. Do NOT say "I'll analyze" or "Here's the report". Just output the report itself.

## Primary Crawl Data — Internal:All (${internalSummary.rowCount} pages${internalSummary.full ? ', complete' : `, showing first 200 of ${internalSummary.rowCount}`})
### CSV Header
${internalSummary.header}

### CSV Rows
${internalSummary.rows}

${supplementarySection ? `## Supplementary Crawl Exports\n${supplementarySection}` : ''}

${issuesSection}

${semanticSection}

## AUDIT_REPORT.md Format — You MUST follow this structure exactly:

\`\`\`
# Technical SEO & Agentic Readiness Audit
## ${domain}
**Audit Date:** ${date}
**Auditor:** Dwight (Forge Growth)
**Tool:** Screaming Frog SEO Spider
**Crawl Scope:** ${internalSummary.rowCount} internal pages (${outputFiles.length} export files)
**Output Directory:** \`audits/${domain}/auditor/${date}/\`

---

## Executive Summary
[2-3 paragraphs analyzing the site's technical SEO health and agentic readiness. Prioritize issues from critical to minor.]

---

## Section 1: Status Code Integrity
[Analyze status codes from the crawl data. Report 200s, 3xx redirects, 4xx/5xx errors with specific URLs.]

---

## Section 2: URL Identity
[Check for uppercase URLs, trailing slashes, duplicate URL variants. Report as a table.]

---

## Section 3: Canonical Correctness
[Analyze canonical tags — self-referencing, missing, or conflicting. Use canonicals_all data.]

---

## Section 4: Page Titles
### 4.1 Over-Length Titles
[Table: URL | Title | Length | Status for titles > 60 chars]

### 4.2 Meta Descriptions
[Table: URL | Length for descriptions > 155 chars]

---

## Section 5: Heading Structure
### 5.1 Missing H1
[Table of pages with no H1]

### 5.2 Multiple H1
[Table of pages with >1 H1, showing H1-1 and H1-2]

---

## Section 6: Structured Data
[Analyze JSON-LD/schema.org presence from structured_data_all. Report issues with numbered items.]

---

## Section 7: Sitemap Health
[Analyze sitemap coverage vs crawled pages using sitemaps data.]

---

## Section 8: Image Health
[Missing alt text, oversized images — use images export data.]

---

## Section 9: Security & Link Health
### 9.1 Cross-Origin Links
[Unsafe cross-origin links without rel="noopener"]

### 9.2 Referrer-Policy
[Missing or weak referrer policy]

---

## Section 10: Agentic Readiness
[Assess AI/LLM readiness signals]

### 10.4 Agentic Readiness Scorecard
| Signal | Status | Weight |
|--------|--------|--------|
| @graph entity graph | PASS/FAIL | High |
| LocalBusiness @id IRI | PASS/FAIL | High |
| Service-level schema | PASS/FAIL | High |
| .well-known/mcp.json | PASS/FAIL | Medium |
| areaServed markup | PASS/FAIL | Medium |
| sameAs to business profiles | PASS/FAIL | Medium |
| Consistent URL identity | PASS/FAIL | Medium |

---

## Section 11: Platform Observations
[Platform/CMS detection and known limitations.]
${semanticReport ? `\n---\n\n## Section 12: Content Similarity & Cannibalization\n[Analyze semantically similar pages. Flag potential cannibalization risks.]` : ''}

---

## Prioritized Fix List

### Priority 1 — Critical
| # | Issue | Affected Pages | Fix |
|---|-------|---------------|-----|

### Priority 2 — High
| # | Issue | Affected Pages | Fix |
|---|-------|---------------|-----|

### Priority 3 — Medium
| # | Issue | Affected Pages | Fix |
|---|-------|---------------|-----|
\`\`\`

IMPORTANT:
- Base ALL findings on the actual crawl CSV data provided above — you have ${outputFiles.length} export files worth of data
- Every issue must reference specific URLs from the crawl data
- The Agentic Readiness Scorecard (Section 10.4) is mandatory
- Priority tables must use numbered rows (| 1 |, | 2 |, etc.)
- Be thorough but factual — only report what you can verify from the data
- Your response IS the file content — start with "# Technical SEO & Agentic Readiness Audit" and output the full report. No preamble, no narration, no summary of what you did.`;

  console.log(`  Prompt size: ${reportPrompt.length} chars`);
  const report = await callClaudeAsync(reportPrompt, 'sonnet');
  const reportPath = path.join(outDir, 'AUDIT_REPORT.md');
  fs.writeFileSync(reportPath, report, 'utf-8');
  validateArtifact(reportPath, 'AUDIT_REPORT.md', 5000);
  console.log(`  Written AUDIT_REPORT.md (${report.length} chars)`);

  // Copy key files to architecture dir for Michael
  const archDir = path.join(AUDITS_BASE, domain, 'architecture', date);
  fs.mkdirSync(archDir, { recursive: true });

  fs.copyFileSync(csvFile, path.join(archDir, 'internal_all.csv'));
  console.log(`  Copied internal_all.csv to ${path.relative(process.cwd(), archDir)}/`);

  // Copy semantically similar report if it exists
  for (const sp of semanticPaths) {
    if (fs.existsSync(sp)) {
      fs.copyFileSync(sp, path.join(archDir, 'semantically_similar_report.csv'));
      console.log(`  Copied semantically_similar_report.csv to ${path.relative(process.cwd(), archDir)}/`);
      break;
    }
  }

  console.log(`  Dwight complete: ${internalSummary.rowCount} pages, ${outputFiles.length} export files`);
  console.log(`  Output: ${path.relative(process.cwd(), outDir)}/`);
}

// ============================================================
// Phase 2: Keyword Research — service × city × intent matrix
// ============================================================

// Maximum keyword candidates to send to DataForSEO bulk volume API
const MAX_KEYWORD_MATRIX_SIZE = 200;

async function runKeywordResearch(sb: SupabaseClient, auditId: string, domain: string, researchDate?: string) {
  const env = loadEnv();
  const today = todayStr();
  const researchDir = path.join(AUDITS_BASE, domain, 'research', researchDate ?? today);
  fs.mkdirSync(researchDir, { recursive: true });

  // --- Step 1: Read Dwight's AUDIT_REPORT.md ---
  const auditorDir = findLatestAuditorDir(domain);
  if (!auditorDir) throw new Error(`No auditor directory found for ${domain} — Dwight must run first`);

  const auditReportPath = path.join(auditorDir, 'AUDIT_REPORT.md');
  if (!fs.existsSync(auditReportPath)) throw new Error(`AUDIT_REPORT.md not found at ${auditReportPath} — Dwight must run first`);

  const reportContent = fs.readFileSync(auditReportPath, 'utf-8');
  console.log(`  AUDIT_REPORT.md: ${reportContent.length} chars`);

  // Get audit metadata (select * to avoid column-not-found errors on optional fields)
  const { data: auditRow, error: auditErr } = await sb
    .from('audits')
    .select('*')
    .eq('id', auditId)
    .single();
  if (auditErr || !auditRow) throw new Error(`Audit metadata not found: ${auditErr?.message ?? 'no row returned'}`);

  const serviceKey = auditRow.service_key ?? '';
  const customLabel = auditRow.custom_service_label ?? '';
  const marketCity = auditRow.market_city ?? '';
  const marketState = auditRow.market_state ?? '';
  const industryLabel = customLabel || serviceKey.replace(/_/g, ' ') || 'local service';

  // --- Step 1: Extract services + locations via LLM ---
  const extractionPrompt = `You are analyzing a technical SEO audit report for a ${industryLabel} business${marketCity ? ` in ${marketCity}, ${marketState}` : ''}.

Extract two lists from the report below:

1. SERVICES: All distinct services the business offers. Extract from:
   - Service page URLs (residential/commercial paths)
   - H1 headings and title tags on service pages
   - Structured data (Service schema, hasOfferCatalog)
   - Any service mentions in the executive summary

2. LOCATIONS: All cities, counties, or regions the business serves. Extract from:
   - areaServed schema markup
   - Service area page URLs and slugs
   - City names in page titles or H1s
   - Footer or contact information mentions

Rules:
- Normalize services to clean labels (e.g., "Kitchen Remodeling" not "/residential/kitchen-remodeling/")
- Normalize locations to city names only (e.g., "St. Charles" not "St. Charles, IL")
- Deduplicate (e.g., "kitchen remodel" and "kitchen remodeling" → "Kitchen Remodeling")
- If no services or locations are found, return empty arrays — do NOT guess

YOUR ENTIRE RESPONSE IS RAW JSON. Output ONLY the JSON object starting with {. No markdown, no code fences, no narration.

Respond with raw JSON only:
{
  "services": ["Kitchen Remodeling", "Bathroom Remodeling"],
  "locations": ["St. Charles", "Naperville"],
  "platform": "Squarespace|WordPress|Wix|unknown"
}

REMINDER: Your response IS the JSON — start with { and end with }. No preamble.

## AUDIT REPORT
${reportContent}`;

  console.log('  Extracting services + locations from AUDIT_REPORT.md via Haiku...');
  let extraction: { services: string[]; locations: string[]; platform: string };
  try {
    const extractResult = await callClaudeAsync(extractionPrompt, 'haiku');
    extraction = JSON.parse(stripCodeFences(extractResult));
  } catch (err: any) {
    throw new Error(`Service/location extraction failed: ${err.message}`);
  }

  const services = extraction.services ?? [];
  const locations = extraction.locations ?? [];
  const platform = extraction.platform ?? 'unknown';

  console.log(`  Services extracted (${services.length}): ${services.join(', ')}`);
  console.log(`  Locations extracted (${locations.length}): ${locations.join(', ')}`);
  console.log(`  Platform: ${platform}`);

  if (services.length === 0) {
    console.error('  ERROR: No services extracted from AUDIT_REPORT.md — cannot build keyword matrix');
    console.error('  Check the audit report for service page URLs, H1s, or structured data');
    return;
  }
  if (locations.length === 0) {
    console.error('  ERROR: No locations extracted from AUDIT_REPORT.md — cannot build keyword matrix');
    console.error('  Check the audit report for areaServed markup, service area pages, or city mentions');
    return;
  }

  // --- Step 2: Build the matrix ---
  interface MatrixKeyword {
    keyword: string;
    service: string;
    city: string;
    intent: 'commercial' | 'informational' | 'transactional';
    is_near_me: boolean;
    priority: number; // lower = higher priority
  }

  const matrix: MatrixKeyword[] = [];
  let priorityCounter = 0;

  // Primary city is the first (usually the business's main market)
  const primaryCity = locations[0];
  const secondaryCities = locations.slice(1);

  for (const service of services) {
    const svcLower = service.toLowerCase();

    // Commercial intent — primary city first
    matrix.push({ keyword: `${svcLower} ${primaryCity.toLowerCase()}`, service, city: primaryCity, intent: 'commercial', is_near_me: false, priority: priorityCounter++ });

    // Commercial intent — secondary cities
    for (const city of secondaryCities) {
      matrix.push({ keyword: `${svcLower} ${city.toLowerCase()}`, service, city, intent: 'commercial', is_near_me: false, priority: priorityCounter++ });
    }

    // Informational intent
    for (const city of locations) {
      matrix.push({ keyword: `${svcLower} cost ${city.toLowerCase()}`, service, city, intent: 'informational', is_near_me: false, priority: priorityCounter++ });
    }

    // Transactional intent
    for (const city of locations) {
      matrix.push({ keyword: `best ${svcLower} ${city.toLowerCase()}`, service, city, intent: 'transactional', is_near_me: false, priority: priorityCounter++ });
      matrix.push({ keyword: `${svcLower} contractor ${city.toLowerCase()}`, service, city, intent: 'transactional', is_near_me: false, priority: priorityCounter++ });
    }

    // Near-me variant — category signal only, flagged from the start
    matrix.push({ keyword: `${svcLower} near me`, service, city: '', intent: 'commercial', is_near_me: true, priority: priorityCounter++ });
  }

  // Cap at MAX_KEYWORD_MATRIX_SIZE
  const cappedMatrix = matrix.sort((a, b) => a.priority - b.priority).slice(0, MAX_KEYWORD_MATRIX_SIZE);
  console.log(`  Matrix: ${matrix.length} total candidates → capped to ${cappedMatrix.length}`);

  // --- Step 3: Validate with DataForSEO ---
  console.log('  Validating matrix with DataForSEO bulk volume...');
  const candidateKeywords = cappedMatrix.map((m) => m.keyword);
  const volumeResults = await bulkKeywordVolume(env, candidateKeywords);

  // Build lookup map
  const volumeMap = new Map<string, BulkVolumeResult>();
  for (const vr of volumeResults) {
    volumeMap.set(vr.keyword.toLowerCase(), vr);
  }

  // Merge volume data back into matrix, filter zero-volume zero-CPC
  const validated = cappedMatrix
    .map((m) => {
      const vol = volumeMap.get(m.keyword.toLowerCase());
      return {
        ...m,
        volume: vol?.volume ?? 0,
        cpc: vol?.cpc ?? 0,
        competition: vol?.competition ?? null,
        competition_level: vol?.competition_level ?? null,
      };
    })
    .filter((m) => m.volume > 0 || m.cpc > 0);

  // Sort by CPC descending (primary revenue signal), volume as tiebreaker
  validated.sort((a, b) => (b.cpc - a.cpc) || (b.volume - a.volume));

  console.log(`  Validated: ${validated.length} keywords with volume or CPC (of ${cappedMatrix.length} candidates)`);

  // Write raw results to disk
  const rawPath = path.join(researchDir, 'keyword_research_raw.json');
  fs.writeFileSync(rawPath, JSON.stringify(validated, null, 2), 'utf-8');
  console.log(`  Written keyword_research_raw.json (${validated.length} keywords)`);

  // --- Step 4: LLM synthesis ---
  // Check which services have existing pages from the crawl
  const internalAllPath = path.join(auditorDir, 'internal_all.csv');
  let existingUrls: string[] = [];
  if (fs.existsSync(internalAllPath)) {
    const csvContent = readCsvSafe(internalAllPath, false);
    const csvLines = csvContent.split('\n').slice(1).filter((l) => l.trim());
    existingUrls = csvLines.map((line) => {
      const firstComma = line.indexOf(',');
      return firstComma > 0 ? line.slice(0, firstComma).replace(/"/g, '').trim() : '';
    }).filter(Boolean);
  }

  const validatedTable = validated.slice(0, 100)
    .map((v) => `${v.keyword} | ${v.service} | ${v.city || 'N/A'} | ${v.intent} | ${v.volume} | $${v.cpc} | ${v.is_near_me ? 'yes' : 'no'}`)
    .join('\n');

  const synthesisPrompt = `You are a Keyword Research Analyst for a ${industryLabel} business in ${marketCity || 'unknown'}, ${marketState || ''}.

## Site Inventory (from Dwight's Crawl)
Services: ${services.join(', ')}
Locations: ${locations.join(', ')}
Platform: ${platform}
Existing pages: ${existingUrls.length} URLs crawled

## Validated Keyword Matrix (top 100 of ${validated.length}, sorted by CPC)
Keyword | Service | City | Intent | Volume | CPC | Near-Me
${validatedTable}

## Task
Analyze this keyword opportunity matrix and produce a JSON response:

1. Top opportunities by revenue signal (CPC × estimated achievable volume)
2. Flag any service the site claims to offer that has ZERO keyword volume in this market
3. Identify gaps: services with strong volume that have no existing page on the site
4. Score each keyword with priority_score: (cpc * volume) / 1000, rounded to 2 decimals

YOUR ENTIRE RESPONSE IS RAW JSON. Output ONLY the JSON object starting with {. No markdown, no code fences, no narration.

Respond with raw JSON only:
{
  "keyword_opportunities": [
    {
      "keyword": "string",
      "service": "string",
      "city": "string",
      "intent": "commercial|informational|transactional",
      "volume": 1000,
      "cpc": 5.50,
      "is_near_me": false,
      "has_existing_page": true,
      "priority_score": 5.50
    }
  ],
  "zero_volume_services": ["service name with no measurable demand"],
  "service_gaps": [
    { "service": "string", "total_volume": 1000, "top_keyword": "string", "has_page": false }
  ],
  "summary": "2-3 sentence executive summary"
}

REMINDER: Your response IS the JSON — start with { and end with }. No preamble.`;

  console.log('  Generating keyword research synthesis via Anthropic API (sonnet)...');
  let synthesis: any;
  try {
    const synthResult = await callClaudeAsync(synthesisPrompt, 'sonnet');
    synthesis = JSON.parse(stripCodeFences(synthResult));
  } catch (err: any) {
    throw new Error(`Keyword research synthesis failed: ${err.message}`);
  }

  const opportunities = synthesis.keyword_opportunities ?? [];
  console.log(`  Synthesis: ${opportunities.length} opportunities, ${(synthesis.zero_volume_services ?? []).length} zero-volume services, ${(synthesis.service_gaps ?? []).length} service gaps`);

  // Write summary markdown
  const summaryMd = buildKeywordResearchMd(domain, synthesis, services, locations);
  const summaryPath = path.join(researchDir, 'keyword_research_summary.md');
  fs.writeFileSync(summaryPath, summaryMd, 'utf-8');
  validateArtifact(summaryPath, 'keyword_research_summary.md', 200);
  console.log(`  Written keyword_research_summary.md to ${path.relative(process.cwd(), researchDir)}/`);

  // --- Step 5: Seed audit_keywords in Supabase ---
  if (opportunities.length > 0) {
    // Clear prior keyword_research rows for this audit to prevent duplicates on re-run.
    // PAIRED with: sync-to-dashboard.ts syncJim() which deletes source='ranked' and source=NULL.
    // Together these three deletes cover all source values. If the source column logic changes,
    // update both files.
    await sb.from('audit_keywords').delete().eq('audit_id', auditId).eq('source', 'keyword_research');

    const BATCH_SIZE = 50;
    let inserted = 0;
    for (let i = 0; i < opportunities.length; i += BATCH_SIZE) {
      const chunk = opportunities.slice(i, i + BATCH_SIZE);
      const rows = chunk.map((opp: any) => ({
        audit_id: auditId,
        keyword: opp.keyword,
        search_volume: opp.volume ?? 0,
        cpc: opp.cpc ?? 0,
        rank_pos: null,
        intent: opp.intent ?? null,
        is_near_me: opp.is_near_me ?? false,
        source: 'keyword_research',
      }));
      const { error } = await sb.from('audit_keywords').insert(rows);
      if (error) {
        console.warn(`  Warning: audit_keywords insert batch failed: ${error.message}`);
      } else {
        inserted += rows.length;
      }
    }
    console.log(`  Seeded ${inserted} keywords into audit_keywords (source: keyword_research)`);
  }

  console.log(`  KeywordResearch complete — ${validated.length} validated keywords, ${opportunities.length} opportunities`);
}

function buildKeywordResearchMd(domain: string, synthesis: any, services: string[], locations: string[]): string {
  const lines: string[] = [];
  lines.push(`# Keyword Research — ${domain}`);
  lines.push(`\n**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Source:** pipeline-generate.ts (service × city × intent matrix)`);
  lines.push(`**Services:** ${services.join(', ')}`);
  lines.push(`**Locations:** ${locations.join(', ')}\n`);

  if (synthesis.summary) {
    lines.push(`## Executive Summary\n`);
    lines.push(synthesis.summary + '\n');
  }

  const opportunities = synthesis.keyword_opportunities ?? [];
  if (opportunities.length > 0) {
    lines.push('## Opportunity Matrix\n');
    lines.push('Sorted by priority score (CPC × volume).\n');
    lines.push('| Keyword | Service | City | Intent | Volume | CPC | Near-Me | Has Page | Priority |');
    lines.push('|---------|---------|------|--------|--------|-----|---------|----------|----------|');
    for (const opp of opportunities) {
      lines.push(`| ${opp.keyword} | ${opp.service} | ${opp.city || 'N/A'} | ${opp.intent} | ${opp.volume} | $${opp.cpc} | ${opp.is_near_me ? 'yes' : 'no'} | ${opp.has_existing_page ? 'yes' : 'no'} | ${opp.priority_score} |`);
    }
  }

  const zeroVol = synthesis.zero_volume_services ?? [];
  if (zeroVol.length > 0) {
    lines.push('\n## Zero-Volume Services\n');
    lines.push('Services the site claims to offer but have no measurable keyword demand in this market.\n');
    for (const svc of zeroVol) {
      lines.push(`- ${svc}`);
    }
  }

  const gaps = synthesis.service_gaps ?? [];
  if (gaps.length > 0) {
    lines.push('\n## Service Gaps\n');
    lines.push('Services with strong search volume but no existing page on the site.\n');
    lines.push('| Service | Total Volume | Top Keyword | Has Page |');
    lines.push('|---------|-------------|-------------|----------|');
    for (const g of gaps) {
      lines.push(`| ${g.service} | ${g.total_volume} | ${g.top_keyword} | ${g.has_page ? 'yes' : 'no'} |`);
    }
  }

  return lines.join('\n');
}

// ============================================================
// Phase 6.5: Coverage Validator — cross-check gaps vs blueprint
// ============================================================

async function runValidator(sb: SupabaseClient, auditId: string, domain: string, researchDate?: string) {
  // Both artifacts required — resolve across date boundaries
  const gapResolved = resolveArtifactPath(domain, 'research', 'content_gap_analysis.md', researchDate);
  if (!gapResolved) throw new Error('content_gap_analysis.md not found — Gap agent must run first');

  const blueprintResolved = resolveArtifactPath(domain, 'architecture', 'architecture_blueprint.md');
  if (!blueprintResolved) throw new Error('architecture_blueprint.md not found — Michael must run first');

  const gapContent = fs.readFileSync(gapResolved, 'utf-8');
  const blueprintContent = fs.readFileSync(blueprintResolved, 'utf-8');

  console.log(`  Gap analysis: ${gapContent.length} chars, Blueprint: ${blueprintContent.length} chars`);

  const prompt = `You are a Coverage Validator. Compare the content gap analysis against the architecture blueprint and produce a structured coverage map.

## Content Gap Analysis
${gapContent}

## Architecture Blueprint
${blueprintContent}

## Task
For each gap identified in the analysis (authority_gaps, format_gaps, unaddressed_gaps), determine whether it is addressed by a page in the architecture blueprint.

A gap is "addressed" if a blueprint page's primary keyword, URL slug, or silo clearly targets the gap topic.
A gap is "partially_addressed" if a related page exists but doesn't directly target the gap.
A gap is "unaddressed" if no blueprint page covers it.

YOUR ENTIRE RESPONSE IS RAW JSON. Output ONLY the JSON object starting with {. No markdown, no code fences, no narration.

Respond with raw JSON only. Schema:
{
  "coverage": [
    { "gap_topic": "string", "gap_type": "authority|format|unaddressed", "blueprint_page": "url-slug or null", "status": "addressed|partially_addressed|unaddressed", "notes": "string" }
  ],
  "summary": "2-3 sentence summary of coverage quality"
}

REMINDER: Your response IS the JSON — start with { and end with }. No preamble.`;

  console.log('  Running coverage validation via Anthropic API (haiku)...');
  const result = await callClaudeAsync(prompt, 'haiku');
  let validation: { coverage: any[]; summary: string };
  try {
    validation = JSON.parse(stripCodeFences(result));
  } catch (err: any) {
    throw new Error(`Coverage validation JSON parse failed: ${err.message}`);
  }

  const coverage = validation.coverage ?? [];
  const addressed = coverage.filter((c) => c.status === 'addressed').length;
  const partial = coverage.filter((c) => c.status === 'partially_addressed').length;
  const unaddressed = coverage.filter((c) => c.status === 'unaddressed').length;

  console.log(`  Coverage: ${addressed} addressed, ${partial} partially addressed, ${unaddressed} unaddressed (of ${coverage.length} gaps)`);

  // Write markdown to disk — same directory as the gap analysis
  const validationMd = buildCoverageValidationMd(domain, validation);
  const outDir = path.dirname(gapResolved);
  const outPath = path.join(outDir, 'coverage_validation.md');
  fs.writeFileSync(outPath, validationMd, 'utf-8');
  console.log(`  Written coverage_validation.md to ${path.relative(process.cwd(), outDir)}/`);

  // Write to Supabase — DELETE + INSERT
  await sb.from('audit_coverage_validation').delete().eq('audit_id', auditId);
  if (coverage.length > 0) {
    const rows = coverage.map((c) => ({
      audit_id: auditId,
      gap_topic: c.gap_topic,
      gap_type: c.gap_type,
      blueprint_page: c.blueprint_page ?? null,
      status: c.status,
      notes: c.notes ?? null,
    }));
    const { error } = await sb.from('audit_coverage_validation').insert(rows);
    if (error) console.warn(`  Warning: Supabase insert failed: ${error.message}`);
    else console.log(`  Inserted ${rows.length} rows into audit_coverage_validation`);
  }

  console.log(`  Validator complete — ${addressed}/${coverage.length} gaps addressed`);
}

function buildCoverageValidationMd(domain: string, validation: { coverage: any[]; summary: string }): string {
  const lines: string[] = [];
  lines.push(`# Coverage Validation — ${domain}`);
  lines.push(`\n**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Source:** pipeline-generate.ts (gap vs blueprint cross-check)\n`);

  if (validation.summary) {
    lines.push(`## Summary\n`);
    lines.push(validation.summary + '\n');
  }

  const unaddressed = (validation.coverage ?? []).filter((c) => c.status === 'unaddressed' || c.status === 'partially_addressed');
  if (unaddressed.length > 0) {
    lines.push('## Unaddressed / Partially Addressed Gaps\n');
    lines.push('| Gap Topic | Gap Type | Status | Blueprint Page | Notes |');
    lines.push('|-----------|----------|--------|---------------|-------|');
    for (const c of unaddressed) {
      lines.push(`| ${c.gap_topic} | ${c.gap_type} | ${c.status} | ${c.blueprint_page ?? 'N/A'} | ${c.notes ?? ''} |`);
    }
  }

  const addressed = (validation.coverage ?? []).filter((c) => c.status === 'addressed');
  if (addressed.length > 0) {
    lines.push('\n## Addressed Gaps\n');
    lines.push('| Gap Topic | Gap Type | Blueprint Page | Notes |');
    lines.push('|-----------|----------|---------------|-------|');
    for (const c of addressed) {
      lines.push(`| ${c.gap_topic} | ${c.gap_type} | ${c.blueprint_page ?? 'N/A'} | ${c.notes ?? ''} |`);
    }
  }

  return lines.join('\n');
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = parseArgs();
  const env = loadEnv();

  // All subcommands need Supabase now (dwight needs it for --user-email to resolve audit for sync)
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }
  if (!args.userEmail) {
    console.error('--user-email is required');
    process.exit(1);
  }

  const sb = createClient(supabaseUrl, serviceRoleKey);
  const { audit } = await resolveAudit(sb, args.domain, args.userEmail);
  console.log(`  Audit: ${audit.id} (${audit.status})`);

  if (args.mode === 'sales') {
    await sb.from('audits').update({ mode: 'sales' }).eq('id', audit.id);
    console.log(`  Mode: sales`);
  }

  switch (args.subcommand) {
    case 'jim':
      await runJim(sb, audit.id, args.domain, audit, args.seedMatrix, args.competitorUrls, args.mode);
      break;
    case 'competitors':
      await runCompetitors(sb, audit.id, args.domain);
      break;
    case 'gap':
      await runGap(sb, audit.id, args.domain);
      break;
    case 'michael':
      await runMichael(sb, audit.id, args.domain, args.date, args.mode);
      break;
    case 'dwight':
      await runDwight(args.domain);
      break;
    case 'canonicalize':
      await runCanonicalize(sb, audit.id, args.domain);
      break;
    case 'validator':
      await runValidator(sb, audit.id, args.domain, args.date);
      break;
    case 'keyword-research':
      await runKeywordResearch(sb, audit.id, args.domain, args.date);
      break;
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message ?? err);
  process.exit(1);
});
