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
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { callClaude as callClaudeAsync, initAnthropicClient } from './anthropic-client.js';

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
  // Fall through to process.env (Railway)
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

// callClaudeAsync replaced by import from anthropic-client.ts

/**
 * Extract the actual HTML content from Claude's output, stripping any
 * preamble (thinking/function-call syntax) and postamble (summary text).
 * Looks for the first `<!--` through the last `-->`.
 * Falls back to stripping code fences if no HTML comments found.
 */
function extractHtmlContent(raw: string): string {
  // Strategy 1: first <!-- through last -->
  const firstComment = raw.indexOf('<!--');
  const lastComment = raw.lastIndexOf('-->');
  if (firstComment !== -1 && lastComment !== -1 && lastComment > firstComment) {
    return raw.slice(firstComment, lastComment + 3).trim();
  }

  // Strategy 2: strip markdown code fences
  const fenced = raw.match(/```(?:html)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenced) return fenced[1].trim();

  // Strategy 3: return as-is
  return raw.trim();
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

  const metadataMarkdown = (page as any)?.metadata_markdown ?? null;
  const contentOutlineMarkdown = (page as any)?.content_outline_markdown ?? null;
  const schemaJson = (page as any)?.schema_json ?? null;

  if (!metadataMarkdown) {
    console.log(`  WARNING: metadata_markdown is null for /${normalizedSlug} — brief may be incomplete`);
  }
  if (!schemaJson) {
    console.log(`  WARNING: schema_json is null for /${normalizedSlug} — HTML will lack JSON-LD`);
  }

  return { metadataMarkdown, contentOutlineMarkdown, schemaJson, slug: normalizedSlug, domain, auditId };
}

// ============================================================
// Build Oscar prompt
// ============================================================

function loadOrCreateBrandVoice(domain: string, clientProfile?: Record<string, any> | null): string {
  const brandVoicePath = path.join(AUDITS_BASE, domain, 'configs', 'brand-voice.md');

  // Check for existing brand voice file
  if (fs.existsSync(brandVoicePath)) {
    return fs.readFileSync(brandVoicePath, 'utf-8');
  }

  // Auto-create from client_profiles.brand_voice_notes if available
  if (clientProfile?.brand_voice_notes) {
    const configDir = path.join(AUDITS_BASE, domain, 'configs');
    fs.mkdirSync(configDir, { recursive: true });
    const content = `# Brand Voice — ${domain}\n\n${clientProfile.brand_voice_notes}\n`;
    fs.writeFileSync(brandVoicePath, content, 'utf-8');
    console.log(`  Auto-created brand-voice.md from client profile`);
    return content;
  }

  return '';
}

function buildOscarPrompt(config: OscarConfig, brief: BriefData, clientProfile?: Record<string, any> | null, competitiveFallback?: string): string {
  const schemaStr = brief.schemaJson
    ? (typeof brief.schemaJson === 'string' ? brief.schemaJson : JSON.stringify(brief.schemaJson, null, 2))
    : 'No schema JSON-LD provided.';

  // Brand voice file
  const brandVoice = loadOrCreateBrandVoice(brief.domain, clientProfile);
  const brandVoiceSection = brandVoice
    ? `## Brand Voice — ${brief.domain}\n${brandVoice}\n\n---\n`
    : '';

  // Build client profile section
  let clientProfileSection = '';
  if (clientProfile) {
    const lines: string[] = ['## Client Profile'];
    if (clientProfile.business_name) lines.push(`- **Business Name**: ${clientProfile.business_name}`);
    if (clientProfile.years_in_business) lines.push(`- **Years in Business**: ${clientProfile.years_in_business}`);
    if (clientProfile.phone) lines.push(`- **Phone**: ${clientProfile.phone}`);
    if (clientProfile.review_count) lines.push(`- **Reviews**: ${clientProfile.review_count}${clientProfile.review_rating ? ` (${clientProfile.review_rating} avg)` : ''}`);
    if (clientProfile.founder_background) lines.push(`- **Founder Background**: ${clientProfile.founder_background}`);
    if (clientProfile.usps?.length > 0) lines.push(`- **USPs**: ${clientProfile.usps.join('; ')}`);
    if (clientProfile.service_differentiators) lines.push(`- **Differentiators**: ${clientProfile.service_differentiators}`);
    if (clientProfile.brand_voice_notes) lines.push(`\n**Brand Voice**: ${clientProfile.brand_voice_notes}`);
    clientProfileSection = lines.join('\n') + '\n\n---\n';
  }

  return `${config.systemPrompt}

---

${config.seoPlaybook}

---

${brandVoiceSection}
${clientProfileSection}
## Content Brief

### Metadata
${brief.metadataMarkdown || 'No metadata provided.'}

### Content Outline
${brief.contentOutlineMarkdown || 'No content outline provided.'}

### Schema JSON-LD
${schemaStr}

${competitiveFallback || ''}
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

    // 2. Load client profile
    let clientProfile: Record<string, any> | null = null;
    try {
      const { data } = await sb.from('client_profiles').select('*').eq('audit_id', req.audit_id).maybeSingle();
      clientProfile = data;
    } catch { /* table may not exist */ }

    // 3. Write client profile to disk if present
    if (clientProfile) {
      const profileDir = path.join(AUDITS_BASE, req.domain, 'configs');
      fs.mkdirSync(profileDir, { recursive: true });
      const profileLines: string[] = ['# Client Profile'];
      for (const [key, val] of Object.entries(clientProfile)) {
        if (val != null && key !== 'id' && key !== 'audit_id' && key !== 'created_at') {
          profileLines.push(`- **${key}**: ${Array.isArray(val) ? val.join('; ') : val}`);
        }
      }
      const date = todayStr();
      const slugDir = path.join(AUDITS_BASE, req.domain, 'content', date, slug);
      fs.mkdirSync(slugDir, { recursive: true });
      fs.writeFileSync(path.join(slugDir, 'client-profile.md'), profileLines.join('\n'), 'utf-8');
    }

    // 4. Competitive context fallback — if Pam's outline lacks it, build from competitor data
    let competitiveFallback = '';
    const hasCompetitiveContext = brief.contentOutlineMarkdown?.includes('## Competitive Context')
      || brief.contentOutlineMarkdown?.includes('### Competitive Context');
    if (!hasCompetitiveContext) {
      try {
        // Get page's cluster from execution_pages
        const normalizedSlug = slug.replace(/^\/+/, '');
        const { data: pageRow } = await sb
          .from('execution_pages')
          .select('silo')
          .eq('audit_id', req.audit_id)
          .or(`url_slug.eq.${normalizedSlug},url_slug.eq./${normalizedSlug}`)
          .maybeSingle();
        const cluster = (pageRow as any)?.silo;
        if (cluster) {
          const { data: competitors } = await sb
            .from('audit_topic_competitors')
            .select('domain, keyword_overlap_pct, avg_position')
            .eq('audit_id', req.audit_id)
            .eq('topic', cluster)
            .order('keyword_overlap_pct', { ascending: false })
            .limit(5);
          const { data: dominance } = await sb
            .from('audit_topic_dominance')
            .select('topic, client_avg_position, competitor_avg_position, gap_direction')
            .eq('audit_id', req.audit_id)
            .eq('topic', cluster)
            .maybeSingle();

          if (competitors && competitors.length > 0) {
            const lines: string[] = ['## Competitive Context (fallback — from competitor analysis)'];
            lines.push('| Domain | Keyword Overlap | Avg Position |');
            lines.push('|--------|----------------:|-------------:|');
            for (const c of competitors) {
              lines.push(`| ${c.domain} | ${c.keyword_overlap_pct ?? '—'}% | ${c.avg_position ? Number(c.avg_position).toFixed(1) : '—'} |`);
            }
            if (dominance) {
              lines.push(`\nClient avg position: ${Number((dominance as any).client_avg_position).toFixed(1)} | Competitor avg: ${Number((dominance as any).competitor_avg_position).toFixed(1)} | Gap: ${(dominance as any).gap_direction}`);
            }
            competitiveFallback = lines.join('\n');
            console.log(`  Injected competitive fallback: ${competitors.length} competitors for cluster "${cluster}"`);
          }
        }
      } catch {
        // Competitive fallback is optional
      }
    }

    // 5. Load Oscar config
    const config = loadOscarConfig();

    // 6. Build prompt
    const prompt = buildOscarPrompt(config, brief, clientProfile, competitiveFallback);

    // 7. Call Claude
    console.log('  Running claude --print (sonnet)...');
    const htmlOutput = await callClaudeAsync(prompt, 'sonnet');
    console.log(`  Claude output: ${htmlOutput.length} chars`);

    // 8. Write debug output (raw, before parsing)
    const debugDir = path.join(AUDITS_BASE, req.domain, 'content', '_debug');
    fs.mkdirSync(debugDir, { recursive: true });
    fs.writeFileSync(path.join(debugDir, `${slug}-oscar-raw.html`), htmlOutput, 'utf-8');

    // 9. Extract clean HTML — strip Claude preamble/postamble
    const cleanHtml = extractHtmlContent(htmlOutput);
    console.log(`  Cleaned HTML: ${cleanHtml.length} chars (stripped ${htmlOutput.length - cleanHtml.length})`);

    // 10. Validate output
    if (!cleanHtml.includes('<article>')) {
      console.log('  Warning: Output does not contain <article> tag');
    }

    // 11. Write HTML file
    const date = todayStr();
    const outDir = path.join(AUDITS_BASE, req.domain, 'content', date, slug);
    fs.mkdirSync(outDir, { recursive: true });
    const htmlPath = path.join(outDir, 'page.html');
    fs.writeFileSync(htmlPath, cleanHtml, 'utf-8');
    console.log(`  Written ${path.relative(process.cwd(), htmlPath)}`);

    // 12. Update execution_pages status
    const normalizedSlug = slug.replace(/^\/+/, '');
    const { data: existing } = await sb
      .from('execution_pages')
      .select('id')
      .eq('audit_id', req.audit_id)
      .or(`url_slug.eq.${normalizedSlug},url_slug.eq./${normalizedSlug}`)
      .maybeSingle();

    if (existing) {
      await sb.from('execution_pages').update({ status: 'in_progress', content_html: cleanHtml }).eq('id', (existing as any).id);
      console.log(`  Updated execution_page → in_progress (displays as draft_ready)`);
    }

    // 13. Mark oscar_request complete (polling mode only)
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

  // Initialize Anthropic SDK
  const anthropicKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_KEY || process.env.ANTHROPIC_KEY;
  if (!anthropicKey) {
    console.error('Missing ANTHROPIC_API_KEY (or ANTHROPIC_KEY) in .env or environment');
    process.exit(1);
  }
  initAnthropicClient(anthropicKey);

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
