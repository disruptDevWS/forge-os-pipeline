#!/usr/bin/env npx tsx
/**
 * verify-dwight.ts — Phase 1a: Post-Dwight Verification
 *
 * Runs HTTP-based verification checks against findings in AUDIT_REPORT.md
 * that are known to produce false negatives from DataForSEO's OnPage API:
 *
 *   Check A — Sitemap existence (HEAD /sitemap.xml, /sitemap_index.xml)
 *   Check B — Schema/structured data presence (GET homepage, parse ld+json)
 *   Check C — Redirect chain integrity (follow 3xx URLs with missing destinations)
 *   Check D — Robots.txt verification (GET /robots.txt, parse Disallow rules)
 *
 * Writes:
 *   - verification_results.json — structured corrections map for syncDwight
 *   - Annotates AUDIT_REPORT.md with human-readable [VERIFIED: ...] notes
 *
 * Usage:
 *   npx tsx scripts/verify-dwight.ts --domain <domain>
 *
 * Runs after Dwight QA, before Phase 1b (Strategy Brief).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const AUDITS_BASE = path.resolve(process.cwd(), 'audits');

// ============================================================
// Types
// ============================================================

interface VerificationCheck {
  check_id: string;
  check_name: string;
  passed: boolean;
  details: string;
  verified_at: string;
  verification_source: string;
}

interface FixCorrection {
  /** Regex pattern or substring to match against fix issue text */
  issue_pattern: string;
  /** What the verification found */
  finding: string;
  /** New status for the fix object */
  status: 'false_positive' | 'verified' | 'flagged';
  verified_at: string;
  verification_source: string;
  /** If the fix was a false positive, what the original priority_label was */
  original_priority_tier?: number;
}

interface RedirectResult {
  source_url: string;
  status_code: number;
  terminal_url: string;
  terminal_status: number;
  hops: number;
  chain_clean: boolean;
  error?: string;
}

interface VerificationResults {
  domain: string;
  verified_at: string;
  checks: VerificationCheck[];
  corrections: FixCorrection[];
  redirect_audit: RedirectResult[];
}

// ============================================================
// CLI
// ============================================================

function parseArgs(): { domain: string } {
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
  if (!flags.domain) {
    console.error('Usage: npx tsx scripts/verify-dwight.ts --domain <domain>');
    process.exit(1);
  }
  return { domain: flags.domain };
}

// ============================================================
// Directory helpers (same pattern as other scripts)
// ============================================================

function getLatestDateDir(baseDir: string): string | null {
  if (!fs.existsSync(baseDir)) return null;
  const entries = fs
    .readdirSync(baseDir)
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e))
    .sort();
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

function findAuditorDir(domain: string): string | null {
  const base = path.join(AUDITS_BASE, domain, 'auditor');
  const dateStr = getLatestDateDir(base);
  if (!dateStr) return null;
  const full = path.join(base, dateStr);
  return fs.existsSync(full) ? full : null;
}

// ============================================================
// Check A — Sitemap Existence
// ============================================================

async function checkSitemap(domain: string): Promise<VerificationCheck> {
  const now = new Date().toISOString();
  const candidates = [
    `https://${domain}/sitemap.xml`,
    `https://${domain}/sitemap_index.xml`,
    `https://www.${domain}/sitemap.xml`,
    `https://www.${domain}/sitemap_index.xml`,
  ];

  const found: string[] = [];

  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        found.push(url);
      }
    } catch {
      // timeout or network error — skip
    }
  }

  return {
    check_id: 'sitemap_existence',
    check_name: 'Sitemap Existence',
    passed: found.length > 0,
    details: found.length > 0
      ? `Sitemap confirmed at: ${found.join(', ')}`
      : `No sitemap found at any candidate path (${candidates.join(', ')})`,
    verified_at: now,
    verification_source: 'direct_http',
  };
}

// ============================================================
// Check B — Schema / Structured Data Presence
// ============================================================

async function checkSchema(domain: string): Promise<VerificationCheck> {
  const now = new Date().toISOString();

  // Try both www and non-www
  const urls = [`https://${domain}/`, `https://www.${domain}/`];
  let html = '';
  let fetchedUrl = '';

  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; ForgeOS/1.0; +https://forgegrowth.ai)',
        },
      });
      if (resp.ok) {
        html = await resp.text();
        fetchedUrl = url;
        break;
      }
    } catch {
      // try next
    }
  }

  if (!html) {
    return {
      check_id: 'schema_presence',
      check_name: 'Schema / Structured Data Presence',
      passed: false,
      details: 'Could not fetch homepage HTML — schema check inconclusive',
      verified_at: now,
      verification_source: 'direct_http',
    };
  }

  // Look for JSON-LD blocks
  const ldJsonBlocks: string[] = [];
  const ldJsonRegex =
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = ldJsonRegex.exec(html)) !== null) {
    ldJsonBlocks.push(match[1].trim());
  }

  // Look for Yoast schema graph specifically
  const hasYoastGraph = html.includes('yoast-schema-graph') || html.includes('schema-graph');

  // Extract @type values from JSON-LD
  const types = new Set<string>();
  for (const block of ldJsonBlocks) {
    try {
      const parsed = JSON.parse(block);
      extractTypes(parsed, types);
    } catch {
      // malformed JSON-LD — still counts as "present"
    }
  }

  const hasSchema = ldJsonBlocks.length > 0;

  return {
    check_id: 'schema_presence',
    check_name: 'Schema / Structured Data Presence',
    passed: hasSchema,
    details: hasSchema
      ? `${ldJsonBlocks.length} JSON-LD block(s) found on ${fetchedUrl}. ` +
        `Types: ${types.size > 0 ? Array.from(types).join(', ') : 'unparseable'}. ` +
        `Yoast graph: ${hasYoastGraph ? 'yes' : 'no'}`
      : `No JSON-LD or Yoast schema found on ${fetchedUrl}`,
    verified_at: now,
    verification_source: 'direct_http',
  };
}

function extractTypes(obj: any, types: Set<string>): void {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) extractTypes(item, types);
    return;
  }
  if (obj['@type']) {
    const t = obj['@type'];
    if (Array.isArray(t)) t.forEach((v: string) => types.add(v));
    else types.add(t);
  }
  if (obj['@graph'] && Array.isArray(obj['@graph'])) {
    for (const node of obj['@graph']) extractTypes(node, types);
  }
}

// ============================================================
// Check D — Robots.txt Verification
// ============================================================

/** User-agents we care about for crawl/AI blocking */
const ROBOTS_AGENTS_OF_INTEREST = [
  '*',
  'googlebot',
  'gptbot',
  'claudebot',
  'bytespider',
  'chatgpt-user',
  'google-extended',
  'ccbot',
  'anthropic-ai',
];

interface RobotsDirective {
  user_agent: string;
  disallow: string[];
  allow: string[];
}

function parseRobotsTxt(raw: string): RobotsDirective[] {
  const directives: RobotsDirective[] = [];
  let current: RobotsDirective | null = null;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;

    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (field === 'user-agent') {
      current = { user_agent: value, disallow: [], allow: [] };
      directives.push(current);
    } else if (field === 'disallow' && current) {
      if (value) current.disallow.push(value);
    } else if (field === 'allow' && current) {
      if (value) current.allow.push(value);
    }
  }

  return directives;
}

/** Check if a directive has broad blocking (Disallow: / without counteracting Allow) */
function hasBroadBlock(d: RobotsDirective): boolean {
  return d.disallow.some((rule) => rule === '/');
}

async function checkRobotsTxt(domain: string): Promise<VerificationCheck & { robotsContent?: string; parsedDirectives?: RobotsDirective[] }> {
  const now = new Date().toISOString();
  const candidates = [
    `https://${domain}/robots.txt`,
    `https://www.${domain}/robots.txt`,
  ];

  let robotsTxt = '';
  let fetchedUrl = '';

  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ForgeOS/1.0; +https://forgegrowth.ai)',
        },
      });
      if (resp.ok) {
        const contentType = resp.headers.get('content-type') || '';
        // Only accept text responses (some sites return HTML 404 pages with 200 status)
        if (contentType.includes('text/plain') || contentType.includes('text/html')) {
          const body = await resp.text();
          // Validate it looks like a robots.txt (not an HTML error page)
          if (body.toLowerCase().includes('user-agent') || body.toLowerCase().includes('disallow')) {
            robotsTxt = body;
            fetchedUrl = url;
            break;
          }
        }
      }
    } catch {
      // timeout or network error — try next
    }
  }

  if (!robotsTxt) {
    return {
      check_id: 'robots_txt',
      check_name: 'Robots.txt Verification',
      passed: true,
      details: `No valid robots.txt found at ${candidates.join(' or ')} — no crawl restrictions in place`,
      verified_at: now,
      verification_source: 'direct_http',
    };
  }

  const directives = parseRobotsTxt(robotsTxt);

  // Find directives for user-agents we care about
  const relevant = directives.filter((d) =>
    ROBOTS_AGENTS_OF_INTEREST.includes(d.user_agent.toLowerCase()),
  );

  const blockedAgents: string[] = [];
  const restrictedAgents: { agent: string; rules: string[] }[] = [];

  for (const d of relevant) {
    if (hasBroadBlock(d)) {
      blockedAgents.push(d.user_agent);
    } else if (d.disallow.length > 0) {
      restrictedAgents.push({ agent: d.user_agent, rules: d.disallow });
    }
  }

  const hasBlocking = blockedAgents.length > 0 || restrictedAgents.length > 0;

  let details = `Fetched ${fetchedUrl}. ${directives.length} user-agent directive(s) found. `;
  if (blockedAgents.length > 0) {
    details += `Broad blocking (Disallow: /) for: ${blockedAgents.join(', ')}. `;
  }
  if (restrictedAgents.length > 0) {
    details += `Partial restrictions for: ${restrictedAgents.map((r) => `${r.agent} (${r.rules.join(', ')})`).join('; ')}. `;
  }
  if (!hasBlocking) {
    details += 'No broad Disallow rules found for search engines or AI crawlers.';
  }

  return {
    check_id: 'robots_txt',
    check_name: 'Robots.txt Verification',
    passed: !hasBlocking,
    details,
    verified_at: now,
    verification_source: 'direct_http',
    robotsContent: robotsTxt,
    parsedDirectives: directives,
  };
}

// ============================================================
// Check C — Redirect Chain Integrity
// ============================================================

async function checkRedirects(
  auditorDir: string,
): Promise<{ check: VerificationCheck; redirectResults: RedirectResult[] }> {
  const now = new Date().toISOString();
  const redirectResults: RedirectResult[] = [];

  // Read internal_all.csv and find 3xx entries with missing redirect destinations
  const csvPath = path.join(auditorDir, 'internal_all.csv');
  if (!fs.existsSync(csvPath)) {
    return {
      check: {
        check_id: 'redirect_integrity',
        check_name: 'Redirect Chain Integrity',
        passed: true,
        details: 'No internal_all.csv found — redirect check skipped',
        verified_at: now,
        verification_source: 'direct_http',
      },
      redirectResults: [],
    };
  }

  let csvContent = fs.readFileSync(csvPath, 'utf-8');
  if (csvContent.charCodeAt(0) === 0xfeff) csvContent = csvContent.slice(1);

  // Simple CSV parsing — split on newlines, parse header, find 3xx rows
  const lines = csvContent.split('\n');
  if (lines.length < 2) {
    return {
      check: {
        check_id: 'redirect_integrity',
        check_name: 'Redirect Chain Integrity',
        passed: true,
        details: 'No data rows in internal_all.csv — redirect check skipped',
        verified_at: now,
        verification_source: 'direct_http',
      },
      redirectResults: [],
    };
  }

  // Parse header to find column indices
  const header = parseCsvLine(lines[0]);
  const addrIdx = header.findIndex(
    (h) => h.toLowerCase() === 'address',
  );
  const statusIdx = header.findIndex(
    (h) => h.toLowerCase() === 'status code',
  );
  const redirectUrlIdx = header.findIndex(
    (h) => h.toLowerCase() === 'redirect url',
  );

  if (addrIdx < 0 || statusIdx < 0) {
    return {
      check: {
        check_id: 'redirect_integrity',
        check_name: 'Redirect Chain Integrity',
        passed: true,
        details: 'Could not find Address/Status Code columns — redirect check skipped',
        verified_at: now,
        verification_source: 'direct_http',
      },
      redirectResults: [],
    };
  }

  // Find 3xx URLs with missing or empty redirect destination
  const redirectUrls: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCsvLine(lines[i]);
    const statusCode = parseInt(cols[statusIdx] || '0', 10);
    const redirectUrl = redirectUrlIdx >= 0 ? (cols[redirectUrlIdx] || '').trim() : '';

    if (statusCode >= 300 && statusCode < 400) {
      if (!redirectUrl) {
        redirectUrls.push(cols[addrIdx] || '');
      }
    }
  }

  // Also check the dedicated 3xx CSV for any additional entries
  const redirectCsvCandidates = [
    path.join(auditorDir, 'response_codes_redirection_3xx.csv'),
    path.join(auditorDir, 'redirection_3xx.csv'),
  ];
  for (const csvFile of redirectCsvCandidates) {
    if (!fs.existsSync(csvFile)) continue;
    let content = fs.readFileSync(csvFile, 'utf-8');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    const rLines = content.split('\n');
    if (rLines.length < 2) continue;
    const rHeader = parseCsvLine(rLines[0]);
    const rAddrIdx = rHeader.findIndex((h) => h.toLowerCase() === 'address');
    const rRedirectIdx = rHeader.findIndex(
      (h) => h.toLowerCase() === 'redirect url',
    );
    if (rAddrIdx < 0) continue;
    for (let i = 1; i < rLines.length; i++) {
      if (!rLines[i].trim()) continue;
      const cols = parseCsvLine(rLines[i]);
      const addr = (cols[rAddrIdx] || '').trim();
      const dest = rRedirectIdx >= 0 ? (cols[rRedirectIdx] || '').trim() : '';
      if (addr && !dest && !redirectUrls.includes(addr)) {
        redirectUrls.push(addr);
      }
    }
  }

  if (redirectUrls.length === 0) {
    return {
      check: {
        check_id: 'redirect_integrity',
        check_name: 'Redirect Chain Integrity',
        passed: true,
        details: 'All 3xx redirects have captured destinations — no verification needed',
        verified_at: now,
        verification_source: 'direct_http',
      },
      redirectResults: [],
    };
  }

  console.log(
    `  [verify] Following ${redirectUrls.length} redirect(s) with missing destinations...`,
  );

  // Follow each redirect chain (cap at 10 hops, cap total at 50 URLs)
  const urlsToCheck = redirectUrls.slice(0, 50);
  for (const sourceUrl of urlsToCheck) {
    const result = await followRedirectChain(sourceUrl);
    redirectResults.push(result);
  }

  const broken = redirectResults.filter((r) => !r.chain_clean);

  return {
    check: {
      check_id: 'redirect_integrity',
      check_name: 'Redirect Chain Integrity',
      passed: broken.length === 0,
      details:
        `Verified ${redirectResults.length} redirect chain(s). ` +
        (broken.length > 0
          ? `${broken.length} broken chain(s): ${broken.map((b) => b.source_url).join(', ')}`
          : 'All chains resolve cleanly.'),
      verified_at: now,
      verification_source: 'direct_http',
    },
    redirectResults,
  };
}

async function followRedirectChain(url: string): Promise<RedirectResult> {
  let currentUrl = url;
  let hops = 0;
  const maxHops = 10;
  let lastStatus = 0;

  while (hops < maxHops) {
    try {
      const resp = await fetch(currentUrl, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });

      lastStatus = resp.status;

      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (!location) {
          return {
            source_url: url,
            status_code: resp.status,
            terminal_url: currentUrl,
            terminal_status: resp.status,
            hops,
            chain_clean: false,
            error: `3xx response at ${currentUrl} with no Location header`,
          };
        }
        // Resolve relative URLs
        currentUrl = new URL(location, currentUrl).href;
        hops++;
        continue;
      }

      // Non-redirect response — this is the terminal
      return {
        source_url: url,
        status_code: lastStatus,
        terminal_url: currentUrl,
        terminal_status: resp.status,
        hops,
        chain_clean: resp.status >= 200 && resp.status < 400,
      };
    } catch (err: any) {
      return {
        source_url: url,
        status_code: 0,
        terminal_url: currentUrl,
        terminal_status: 0,
        hops,
        chain_clean: false,
        error: err.message || 'Network error following redirect',
      };
    }
  }

  return {
    source_url: url,
    status_code: lastStatus,
    terminal_url: currentUrl,
    terminal_status: 0,
    hops,
    chain_clean: false,
    error: `Redirect loop — exceeded ${maxHops} hops`,
  };
}

// Simple CSV line parser (handles quoted fields with commas)
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ============================================================
// Build corrections map from check results
// ============================================================

function buildCorrections(
  checks: VerificationCheck[],
  reportContent: string,
): FixCorrection[] {
  const corrections: FixCorrection[] = [];
  const now = new Date().toISOString();

  const sitemapCheck = checks.find((c) => c.check_id === 'sitemap_existence');
  const schemaCheck = checks.find((c) => c.check_id === 'schema_presence');
  const robotsCheck = checks.find((c) => c.check_id === 'robots_txt');

  // If sitemap exists but report flagged it as missing
  if (sitemapCheck?.passed) {
    const sitemapFlagged =
      /no\s+(xml\s+)?sitemap/i.test(reportContent) ||
      /sitemap.*missing/i.test(reportContent) ||
      /sitemap.*0%/i.test(reportContent) ||
      /in\s+sitemap:\s*no/i.test(reportContent);
    if (sitemapFlagged) {
      corrections.push({
        issue_pattern: 'sitemap',
        finding: sitemapCheck.details,
        status: 'false_positive',
        verified_at: now,
        verification_source: 'direct_http',
      });
    }
  }

  // If schema exists but report flagged it as absent
  if (schemaCheck?.passed) {
    const schemaFlagged =
      /zero\s+structured\s+data/i.test(reportContent) ||
      /no\s+structured\s+data/i.test(reportContent) ||
      /no\s+json-?ld/i.test(reportContent) ||
      /no\s+schema/i.test(reportContent) ||
      /structured\s+data.*missing/i.test(reportContent) ||
      /schema.*absent/i.test(reportContent);
    if (schemaFlagged) {
      corrections.push({
        issue_pattern: 'schema|structured.data',
        finding: schemaCheck.details,
        status: 'false_positive',
        verified_at: now,
        verification_source: 'direct_http',
      });
    }
  }

  // Robots.txt: report flagged blocking but verification found no broad rules → false_positive
  // If verification confirmed blocking → keep the issue (no correction emitted)
  if (robotsCheck) {
    const robotsFlagged =
      /robots\.txt.*block/i.test(reportContent) ||
      /robots\.txt.*restrict/i.test(reportContent) ||
      /robots\.txt.*disallow/i.test(reportContent) ||
      /blocked\s+by\s+robots/i.test(reportContent) ||
      /crawl.*blocked/i.test(reportContent) ||
      /robots\.txt.*prevent/i.test(reportContent) ||
      /ai\s+crawl(er)?s?\s+blocked/i.test(reportContent) ||
      /gptbot.*blocked/i.test(reportContent) ||
      /claudebot.*blocked/i.test(reportContent);

    if (robotsFlagged && robotsCheck.passed) {
      // Report flagged robots.txt issues, but direct fetch found no broad blocking
      corrections.push({
        issue_pattern: 'robots\\.txt|crawl.*block|ai.*crawl',
        finding: robotsCheck.details,
        status: 'false_positive',
        verified_at: now,
        verification_source: 'direct_http',
      });
    }
  }

  return corrections;
}

// ============================================================
// Annotate AUDIT_REPORT.md with human-readable corrections
// ============================================================

function annotateReport(
  reportPath: string,
  checks: VerificationCheck[],
  corrections: FixCorrection[],
  redirectResults: RedirectResult[],
): void {
  let content = fs.readFileSync(reportPath, 'utf-8');

  // Build verification summary section
  const verificationLines: string[] = [
    '',
    '---',
    '',
    '## Post-Dwight Verification (Phase 1a)',
    `**Verified at:** ${new Date().toISOString()}`,
    `**Method:** Direct HTTP checks against live site`,
    '',
  ];

  for (const check of checks) {
    const icon = check.passed ? 'PASS' : 'FAIL';
    verificationLines.push(`### ${check.check_name}: [${icon}]`);
    verificationLines.push(check.details);
    verificationLines.push('');
  }

  // Add correction annotations inline
  for (const correction of corrections) {
    if (correction.status === 'false_positive') {
      verificationLines.push(
        `**[VERIFIED — FALSE POSITIVE]:** Finding matching "${correction.issue_pattern}" ` +
          `retracted. ${correction.finding}`,
      );
      verificationLines.push('');
    }
  }

  // Add redirect audit results if any
  if (redirectResults.length > 0) {
    verificationLines.push('### Redirect Chain Resolution');
    verificationLines.push('');
    verificationLines.push(
      '| Source URL | Hops | Terminal URL | Terminal Status | Clean? |',
    );
    verificationLines.push(
      '|-----------|------|-------------|-----------------|--------|',
    );
    for (const r of redirectResults) {
      verificationLines.push(
        `| ${r.source_url} | ${r.hops} | ${r.terminal_url} | ${r.terminal_status || r.error || 'N/A'} | ${r.chain_clean ? 'Yes' : 'No'} |`,
      );
    }
    verificationLines.push('');
  }

  // Append verification section to the report
  content += '\n' + verificationLines.join('\n');

  fs.writeFileSync(reportPath, content, 'utf-8');
  console.log(`  [verify] Annotated ${path.basename(reportPath)} with verification results`);
}

// ============================================================
// Main
// ============================================================

async function main() {
  const { domain } = parseArgs();

  console.log(`\n=== Phase 1a: Verify Dwight — ${domain} ===\n`);

  const auditorDir = findAuditorDir(domain);
  if (!auditorDir) {
    console.log('  [verify] No auditor directory found — skipping verification');
    process.exit(0);
  }

  const reportPath = path.join(auditorDir, 'AUDIT_REPORT.md');
  if (!fs.existsSync(reportPath)) {
    console.log('  [verify] No AUDIT_REPORT.md found — skipping verification');
    process.exit(0);
  }

  const reportContent = fs.readFileSync(reportPath, 'utf-8');

  // Skip if already verified (idempotency)
  if (reportContent.includes('## Post-Dwight Verification (Phase 1a)')) {
    console.log('  [verify] Report already has verification section — skipping');
    process.exit(0);
  }

  // Run all checks in parallel
  console.log('  [verify] Running Check A (sitemap), Check B (schema), Check C (redirects), Check D (robots.txt)...');
  const [sitemapCheck, schemaCheck, redirectCheck, robotsCheck] = await Promise.all([
    checkSitemap(domain),
    checkSchema(domain),
    checkRedirects(auditorDir),
    checkRobotsTxt(domain),
  ]);

  const checks = [sitemapCheck, schemaCheck, redirectCheck.check, robotsCheck];

  for (const check of checks) {
    const icon = check.passed ? 'PASS' : 'FAIL';
    console.log(`  [verify] ${check.check_name}: [${icon}] ${check.details}`);
  }

  // Build corrections map
  const corrections = buildCorrections(checks, reportContent);

  if (corrections.length > 0) {
    console.log(
      `  [verify] ${corrections.length} correction(s) identified — will be applied at sync`,
    );
  } else {
    console.log('  [verify] No corrections needed — Dwight findings confirmed');
  }

  // Write structured verification_results.json
  const results: VerificationResults = {
    domain,
    verified_at: new Date().toISOString(),
    checks,
    corrections,
    redirect_audit: redirectCheck.redirectResults,
  };

  const resultsPath = path.join(auditorDir, 'verification_results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`  [verify] Wrote ${resultsPath}`);

  // Annotate AUDIT_REPORT.md (cosmetic — for disk artifact accuracy)
  annotateReport(reportPath, checks, corrections, redirectCheck.redirectResults);

  console.log('\n=== Phase 1a Complete ===\n');
}

main().catch((err) => {
  console.error('Phase 1a verification failed:', err);
  process.exit(1);
});
