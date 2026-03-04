#!/usr/bin/env npx tsx
/**
 * generate-content.ts — Oscar content production agent
 *
 * Takes Pam's completed content brief and produces production-ready semantic HTML.
 *
 * Usage:
 *   npx tsx scripts/generate-content.ts --domain veteransplumbingcorp.com --slug drain-cleaning-boise
 *   npx tsx scripts/generate-content.ts --domain veteransplumbingcorp.com   # poll oscar_requests for domain
 *   npx tsx scripts/generate-content.ts                                      # poll all oscar_requests
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as child_process from 'node:child_process';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// .env loader
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
// Helpers
// ============================================================

const AUDITS_BASE = path.resolve(process.cwd(), 'audits');
const CONFIGS_BASE = path.resolve(process.cwd(), 'configs', 'oscar');

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getLatestDateDir(baseDir: string): string | null {
  if (!fs.existsSync(baseDir)) return null;
  const entries = fs.readdirSync(baseDir).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort();
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

function callClaudeAsync(prompt: string, model = 'sonnet'): Promise<string> {
  return new Promise((resolve, reject) => {
    const claudeBin = process.env.CLAUDE_BIN || '/home/forgegrowth/.local/bin/claude';
    const childEnv = { ...process.env };
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
      if (!stdout || stdout.startsWith('Error:')) {
        reject(new Error(`claude returned error: ${stdout.slice(0, 200) || '(empty output)'}`));
        return;
      }
      resolve(stdout);
    });

    proc.stdin!.write(prompt);
    proc.stdin!.end();
  });
}

// ============================================================
// CLI parsing
// ============================================================

interface CliFlags {
  domain?: string;
  slug?: string;
}

function parseFlags(): CliFlags {
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
  return { domain: flags.domain, slug: flags.slug };
}

// ============================================================
// Resolve audit by domain (no user-email required)
// ============================================================

async function resolveAuditByDomain(sb: SupabaseClient, domain: string): Promise<string> {
  const { data: audit } = await sb
    .from('audits')
    .select('id')
    .eq('domain', domain)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!audit) throw new Error(`No audit found for domain: ${domain}`);
  return (audit as any).id;
}

// ============================================================
// Load Oscar config files
// ============================================================

interface OscarConfig {
  systemPrompt: string;
  seoPlaybook: string;
}

function loadOscarConfig(): OscarConfig {
  const systemPromptPath = path.join(CONFIGS_BASE, 'system-prompt.md');
  const seoPlaybookPath = path.join(CONFIGS_BASE, 'seo-playbook.md');

  if (!fs.existsSync(systemPromptPath)) throw new Error(`Oscar system prompt not found: ${systemPromptPath}`);
  if (!fs.existsSync(seoPlaybookPath)) throw new Error(`Oscar SEO playbook not found: ${seoPlaybookPath}`);

  return {
    systemPrompt: fs.readFileSync(systemPromptPath, 'utf-8'),
    seoPlaybook: fs.readFileSync(seoPlaybookPath, 'utf-8'),
  };
}

// ============================================================
// Gather brief data
// ============================================================

interface BriefData {
  metadataMarkdown: string | null;
  contentOutlineMarkdown: string | null;
  schemaJson: any | null;
  slug: string;
  domain: string;
  auditId: string;
}

async function gatherBrief(
  sb: SupabaseClient, auditId: string, slug: string, domain: string
): Promise<BriefData> {
  const normalizedSlug = slug.replace(/^\/+/, '');

  // Try Supabase first
  const { data: page } = await sb
    .from('execution_pages')
    .select('metadata_markdown, content_outline_markdown, schema_json')
    .eq('audit_id', auditId)
    .or(`url_slug.eq.${normalizedSlug},url_slug.eq./${normalizedSlug}`)
    .maybeSingle();

  let metadataMarkdown = (page as any)?.metadata_markdown ?? null;
  let contentOutlineMarkdown = (page as any)?.content_outline_markdown ?? null;
  let schemaJson = (page as any)?.schema_json ?? null;

  // Fallback to disk if DB fields are null
  const contentBase = path.join(AUDITS_BASE, domain, 'content');
  const latestDate = getLatestDateDir(contentBase);
  if (latestDate) {
    const slugDir = path.join(contentBase, latestDate, normalizedSlug);

    if (!metadataMarkdown) {
      const diskPath = path.join(slugDir, 'metadata.md');
      if (fs.existsSync(diskPath)) {
        metadataMarkdown = fs.readFileSync(diskPath, 'utf-8');
        console.log(`  Loaded metadata.md from disk fallback`);
      }
    }

    if (!contentOutlineMarkdown) {
      const diskPath = path.join(slugDir, 'content_outline.md');
      if (fs.existsSync(diskPath)) {
        contentOutlineMarkdown = fs.readFileSync(diskPath, 'utf-8');
        console.log(`  Loaded content_outline.md from disk fallback`);
      }
    }

    if (!schemaJson) {
      const diskPath = path.join(slugDir, 'schema.json');
      if (fs.existsSync(diskPath)) {
        try {
          schemaJson = JSON.parse(fs.readFileSync(diskPath, 'utf-8'));
          console.log(`  Loaded schema.json from disk fallback`);
        } catch {
          console.log(`  Warning: Could not parse disk schema.json`);
        }
      }
    }
  }

  return { metadataMarkdown, contentOutlineMarkdown, schemaJson, slug: normalizedSlug, domain, auditId };
}

// ============================================================
// Build Oscar prompt
// ============================================================

function buildOscarPrompt(config: OscarConfig, brief: BriefData): string {
  const schemaStr = brief.schemaJson
    ? (typeof brief.schemaJson === 'string' ? brief.schemaJson : JSON.stringify(brief.schemaJson, null, 2))
    : 'No schema JSON-LD provided.';

  return `${config.systemPrompt}

---

${config.seoPlaybook}

---

## Content Brief

### Metadata
${brief.metadataMarkdown || 'No metadata provided.'}

### Content Outline
${brief.contentOutlineMarkdown || 'No content outline provided.'}

### Schema JSON-LD
${schemaStr}

---

Produce the semantic HTML now. Follow the execution process defined in your system prompt.`;
}

// ============================================================
// Process a single content request
// ============================================================

interface OscarRequest {
  id: string | null;        // null for direct CLI mode
  audit_id: string;
  page_url: string;
  domain: string;
}

async function processOscarRequest(sb: SupabaseClient, req: OscarRequest) {
  const slug = req.page_url.replace(/^\/+/, '');
  console.log(`\nProcessing: /${slug} for ${req.domain}`);

  // Mark as processing (polling mode only)
  if (req.id) {
    await sb.from('oscar_requests').update({ status: 'processing' }).eq('id', req.id);
  }

  try {
    // 1. Gather brief
    const brief = await gatherBrief(sb, req.audit_id, slug, req.domain);
    if (!brief.contentOutlineMarkdown) {
      throw new Error(`No content outline found for /${slug} — has Pam generated a brief?`);
    }
    console.log(`  Brief: metadata=${brief.metadataMarkdown ? 'yes' : 'no'}, outline=${brief.contentOutlineMarkdown.length} chars, schema=${brief.schemaJson ? 'yes' : 'no'}`);

    // 2. Load Oscar config
    const config = loadOscarConfig();

    // 3. Build prompt
    const prompt = buildOscarPrompt(config, brief);

    // 4. Call Claude
    console.log('  Running claude --print (sonnet)...');
    const htmlOutput = await callClaudeAsync(prompt, 'sonnet');
    console.log(`  Claude output: ${htmlOutput.length} chars`);

    // 5. Write debug output
    const debugDir = path.join(AUDITS_BASE, req.domain, 'content', '_debug');
    fs.mkdirSync(debugDir, { recursive: true });
    fs.writeFileSync(path.join(debugDir, `${slug}-oscar-raw.html`), htmlOutput, 'utf-8');

    // 6. Validate output
    if (!htmlOutput.includes('<article>')) {
      console.log('  Warning: Output does not contain <article> tag');
    }

    // 7. Write HTML file
    const date = todayStr();
    const outDir = path.join(AUDITS_BASE, req.domain, 'content', date, slug);
    fs.mkdirSync(outDir, { recursive: true });
    const htmlPath = path.join(outDir, 'page.html');
    fs.writeFileSync(htmlPath, htmlOutput, 'utf-8');
    console.log(`  Written ${path.relative(process.cwd(), htmlPath)}`);

    // 8. Update execution_pages status
    const normalizedSlug = slug.replace(/^\/+/, '');
    const { data: existing } = await sb
      .from('execution_pages')
      .select('id')
      .eq('audit_id', req.audit_id)
      .or(`url_slug.eq.${normalizedSlug},url_slug.eq./${normalizedSlug}`)
      .maybeSingle();

    if (existing) {
      await sb.from('execution_pages').update({ status: 'content_ready' }).eq('id', (existing as any).id);
      console.log(`  Updated execution_page → content_ready`);
    }

    // 9. Mark oscar_request complete (polling mode only)
    if (req.id) {
      await sb.from('oscar_requests').update({
        status: 'complete',
        completed_at: new Date().toISOString(),
      }).eq('id', req.id);
    }

    console.log(`  Done: /${slug} → content_ready`);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`  FAILED: ${msg}`);
    if (req.id) {
      await sb.from('oscar_requests').update({
        status: 'failed',
        error_message: msg.slice(0, 500),
      }).eq('id', req.id);
    }
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  const env = loadEnv();
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }

  const sb = createClient(supabaseUrl, serviceRoleKey);
  const flags = parseFlags();

  // Direct mode: --domain X --slug Y
  if (flags.domain && flags.slug) {
    console.log(`Direct mode: ${flags.domain} / ${flags.slug}`);
    const auditId = await resolveAuditByDomain(sb, flags.domain);
    const req: OscarRequest = {
      id: null,
      audit_id: auditId,
      page_url: flags.slug,
      domain: flags.domain,
    };
    await processOscarRequest(sb, req);
    return;
  }

  // Polling mode: read from oscar_requests table
  console.log('Polling mode: checking oscar_requests...');
  try {
    let query = sb
      .from('oscar_requests')
      .select('*')
      .eq('status', 'pending')
      .order('requested_at', { ascending: true });

    if (flags.domain) {
      query = query.eq('domain', flags.domain);
    }

    const { data: requests, error } = await query;
    if (error) {
      console.warn(`Warning: oscar_requests query failed (table may not exist): ${error.message}`);
      console.log('Use --domain X --slug Y for direct mode without the oscar_requests table.');
      return;
    }

    if (!requests || requests.length === 0) {
      console.log('No pending oscar_requests found.');
      return;
    }

    console.log(`Found ${requests.length} pending request(s)`);

    for (const row of requests) {
      const req: OscarRequest = {
        id: row.id,
        audit_id: row.audit_id,
        page_url: row.page_url,
        domain: row.domain,
      };
      await processOscarRequest(sb, req);
    }
  } catch (err: any) {
    console.warn(`Warning: oscar_requests polling failed: ${err.message}`);
    console.log('Use --domain X --slug Y for direct mode.');
  }

  console.log('\nAll requests processed.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
