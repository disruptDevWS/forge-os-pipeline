#!/usr/bin/env npx tsx
/**
 * generate-cluster-strategy.ts — Cluster activation: generates a strategy
 * document for a canonical_key cluster, marks cluster active, and flags
 * execution_pages as cluster_active.
 *
 * Usage:
 *   npx tsx scripts/generate-cluster-strategy.ts --domain <domain> --canonical-key <key> --user-email <email>
 *
 * Environment variables (from .env or process.env):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { callClaude, initAnthropicClient } from './anthropic-client.js';
import { loadClientContextAsync, buildClientContextPrompt } from './client-context.js';

// ============================================================
// CLI argument parsing
// ============================================================

interface CliArgs {
  domain: string;
  canonicalKey: string;
  userEmail: string;
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

  if (!flags.domain || !flags['canonical-key'] || !flags['user-email']) {
    console.error('Usage: npx tsx scripts/generate-cluster-strategy.ts --domain <domain> --canonical-key <key> --user-email <email>');
    process.exit(1);
  }

  return {
    domain: flags.domain,
    canonicalKey: flags['canonical-key'],
    userEmail: flags['user-email'],
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
// Artifact resolution (same logic as pipeline-generate.ts)
// ============================================================

const AUDITS_BASE = path.resolve(process.cwd(), 'audits');

function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function resolveArtifactPath(domain: string, subdir: 'research' | 'architecture', filename: string): string | null {
  const basePath = path.join(AUDITS_BASE, domain, subdir);
  const preferred = todayStr();
  const preferredPath = path.join(basePath, preferred, filename);
  if (fs.existsSync(preferredPath)) return preferredPath;

  if (!fs.existsSync(basePath)) return null;
  const dateDirs = fs.readdirSync(basePath).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort();
  for (let i = dateDirs.length - 1; i >= 0; i--) {
    const candidate = path.join(basePath, dateDirs[i], filename);
    if (fs.existsSync(candidate)) {
      console.log(`  [cluster-strategy] ${filename}: using ${dateDirs[i]}/ (date fallback)`);
      return candidate;
    }
  }
  return null;
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = parseArgs();
  const env = loadEnv();

  const sbUrl = env.SUPABASE_URL;
  const sbKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = env.ANTHROPIC_API_KEY || env.ANTHROPIC_KEY;
  if (!sbUrl || !sbKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not set');

  const sb = createClient(sbUrl, sbKey);
  initAnthropicClient(anthropicKey);

  console.log(`[cluster-strategy] Generating strategy for ${args.domain} / ${args.canonicalKey}`);

  // 1. Resolve audit
  const { audit, userId } = await resolveAudit(sb, args.domain, args.userEmail);
  const auditId = audit.id;

  // 2. Load cluster
  const { data: cluster } = await sb
    .from('audit_clusters')
    .select('*')
    .eq('audit_id', auditId)
    .eq('canonical_key', args.canonicalKey)
    .maybeSingle();

  if (!cluster) throw new Error(`Cluster not found: ${args.canonicalKey} for audit ${auditId}`);

  // 3. Load keywords for this cluster
  const { data: keywords } = await sb
    .from('audit_keywords')
    .select('keyword, search_volume, rank_pos, intent_type, is_brand, is_near_me, delta_revenue_mid, cpc')
    .eq('audit_id', auditId)
    .eq('canonical_key', args.canonicalKey)
    .eq('is_brand', false);

  const kwList = (keywords ?? []) as any[];
  console.log(`  [cluster-strategy] ${kwList.length} keywords in cluster`);

  // 4. Load execution_pages for this cluster
  const { data: pages } = await sb
    .from('execution_pages')
    .select('url_slug, silo, priority, status, page_brief, meta_title, content_html')
    .eq('audit_id', auditId)
    .eq('canonical_key', args.canonicalKey);

  const pageList = (pages ?? []) as any[];
  console.log(`  [cluster-strategy] ${pageList.length} execution pages in cluster`);

  // 5. Load gap analysis
  const { data: gapSnapshot } = await sb
    .from('audit_snapshots')
    .select('data')
    .eq('audit_id', auditId)
    .eq('agent', 'gap')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const gapData = gapSnapshot?.data ?? {};

  // 6. Load competitors for relevant topics
  const { data: competitors } = await sb
    .from('audit_topic_competitors')
    .select('topic, competitor_domain, appearance_count, share')
    .eq('audit_id', auditId)
    .order('appearance_count', { ascending: false })
    .limit(20);

  // 7. Client context
  const { context: clientCtx } = await loadClientContextAsync(args.domain, sb, auditId);
  const clientCtxPrompt = clientCtx ? buildClientContextPrompt(clientCtx, 'cluster-strategy') : '';

  // 8. Load research_summary.md for strategic context (striking distance, key takeaways)
  let researchContext = '';
  const researchPath = resolveArtifactPath(args.domain, 'research', 'research_summary.md');
  if (researchPath) {
    const fullResearch = fs.readFileSync(researchPath, 'utf-8');
    // Extract key strategic sections: striking distance (§8) and key takeaways (§10)
    const section8Match = fullResearch.match(/## 8\.\s*Striking Distance[\s\S]*?(?=## 9\.|$)/i);
    const section10Match = fullResearch.match(/## 10\.\s*Key Takeaways[\s\S]*$/i);
    const sections: string[] = [];
    if (section8Match) sections.push(section8Match[0].trim());
    if (section10Match) sections.push(section10Match[0].trim());
    if (sections.length > 0) {
      researchContext = `## Market Intelligence (from Research Summary)\n\n${sections.join('\n\n')}`;
      console.log(`  [cluster-strategy] Loaded research context: ${sections.length} sections from research_summary.md`);
    }
  } else {
    console.log(`  [cluster-strategy] research_summary.md not found on disk (may be Railway-only)`);
  }

  // 9. Build prompt
  const kwTable = kwList
    .sort((a: any, b: any) => (b.search_volume ?? 0) - (a.search_volume ?? 0))
    .slice(0, 50)
    .map((kw: any) => `| ${kw.keyword} | ${kw.search_volume ?? 0} | ${kw.rank_pos ?? '-'} | ${kw.intent_type ?? '-'} | $${(kw.delta_revenue_mid ?? 0).toFixed(0)} |`)
    .join('\n');

  const pageTable = pageList
    .map((p: any) => {
      const brief = p.page_brief ?? {};
      const hasContent = !!p.content_html;
      return `| ${p.url_slug} | ${brief.role ?? '-'} | ${brief.primary_keyword ?? '-'} | ${p.status} | ${hasContent ? 'Yes' : 'No'} |`;
    })
    .join('\n');

  const gapAuthority = Array.isArray(gapData.authority_gaps) ? gapData.authority_gaps.slice(0, 10) : [];
  const gapFormat = Array.isArray(gapData.format_gaps) ? gapData.format_gaps.slice(0, 10) : [];

  const gapSection = gapAuthority.length > 0
    ? `## Authority Gaps\n${gapAuthority.map((g: any) => `- ${g.topic ?? g.keyword ?? 'unknown'}: ${g.gap_description ?? g.notes ?? ''}`).join('\n')}`
    : '';

  const formatGapSection = gapFormat.length > 0
    ? `## Format Gaps\n${gapFormat.map((g: any) => `- ${g.format ?? g.gap_type ?? 'unknown'}: ${g.description ?? g.notes ?? ''}`).join('\n')}`
    : '';

  const competitorSection = (competitors ?? []).length > 0
    ? `## Top Competitors\n| Domain | Appearances | Share |\n|--------|------------|-------|\n${(competitors ?? []).map((c: any) => `| ${c.competitor_domain} | ${c.appearance_count} | ${(c.share * 100).toFixed(0)}% |`).join('\n')}`
    : '';

  const prompt = `YOUR ENTIRE RESPONSE IS THE CLUSTER STRATEGY DOCUMENT.

You are an SEO content strategist analyzing a single topic cluster for a local service business.

## Cluster: ${cluster.canonical_topic ?? args.canonicalKey}
- Total Volume: ${cluster.total_volume ?? 0}
- Revenue Opportunity (mid): $${(cluster.est_revenue_mid ?? 0).toFixed(0)}/mo
- Keywords: ${kwList.length}
- Existing Pages: ${pageList.length}

## Keywords
| Keyword | Volume | Position | Intent | Revenue/mo |
|---------|--------|----------|--------|------------|
${kwTable}

## Current Pages
| URL Slug | Role | Primary Keyword | Status | Has Content |
|----------|------|----------------|--------|-------------|
${pageTable}

${gapSection}

${formatGapSection}

${competitorSection}

${clientCtxPrompt}

${researchContext}

---

Produce a cluster strategy with the following sections:

### 1. Buyer Journey Map
Map keywords to buyer stages (Awareness → Consideration → Decision → Retention). Identify which stages have coverage and which are gaps.

Output as JSON:
\`\`\`json
{ "stages": [{ "stage": "awareness|consideration|decision|retention", "keywords": ["kw1", "kw2"], "has_page": true/false, "gap_severity": "none|low|high" }] }
\`\`\`

### 2. Page Coverage Analysis
For each existing page, evaluate: is it targeting the right keywords? Does it cover the right buyer stage? What's missing?

### 3. Recommended New Pages
Pages that should be created to fill gaps. Each recommendation:
- URL slug
- Primary keyword + volume
- Buyer stage
- Content type (service page, FAQ, guide, comparison, location page)
- Priority (1=critical, 2=important, 3=nice-to-have)

Output as JSON:
\`\`\`json
{ "pages": [{ "url_slug": "/slug", "primary_keyword": "kw", "volume": 100, "buyer_stage": "consideration", "content_type": "service_page", "priority": 1, "rationale": "why" }] }
\`\`\`

### 4. Format Gaps
Content formats competitors use that this cluster lacks (video, FAQ schema, comparison tables, calculators, before/after galleries, etc.)

Output as JSON:
\`\`\`json
{ "gaps": [{ "format": "faq_schema", "priority": "high|medium|low", "rationale": "why" }] }
\`\`\`

### 5. AI & Search Optimization Notes
Specific recommendations for AI overview optimization, featured snippet targeting, and People Also Ask coverage for this cluster's keywords.

### 6. Production Sequence
Ordered list of content to produce first for maximum impact.

---

IMPORTANT FORMATTING RULES:
- Sections 1, 3, and 4 MUST contain valid JSON blocks (fenced with \`\`\`json ... \`\`\`).
- Sections 2, 5, and 6 are markdown prose.
- Do not include any preamble before "### 1. Buyer Journey Map".

REMINDER: Your response IS the cluster strategy document — start with "### 1. Buyer Journey Map". No preamble, no narration.`;

  console.log(`  [cluster-strategy] Calling Claude (Opus)...`);
  const result = await callClaude(prompt, { model: 'opus', phase: 'cluster-strategy' });

  // 9. Parse JSON sections from the response
  const extractJson = (text: string, sectionName: string): any => {
    const jsonRegex = /```json\s*\n([\s\S]*?)```/g;
    let match;
    const allMatches: string[] = [];
    while ((match = jsonRegex.exec(text)) !== null) {
      allMatches.push(match[1].trim());
    }

    // Match by section order: 1=buyer_stages, 3=recommended_pages, 4=format_gaps
    const sectionOrder: Record<string, number> = { buyer_stages: 0, recommended_pages: 1, format_gaps: 2 };
    const idx = sectionOrder[sectionName] ?? -1;
    if (idx >= 0 && idx < allMatches.length) {
      try {
        return JSON.parse(allMatches[idx]);
      } catch {
        console.warn(`  [cluster-strategy] Failed to parse JSON for ${sectionName}`);
      }
    }
    return null;
  };

  const buyerStages = extractJson(result, 'buyer_stages');
  const recommendedPages = extractJson(result, 'recommended_pages');
  const formatGaps = extractJson(result, 'format_gaps');

  // Extract AI optimization notes (Section 5)
  const aiNotesMatch = result.match(/### 5\.\s*AI.*?Optimization.*?\n([\s\S]*?)(?=### 6\.|$)/i);
  const aiOptimizationNotes = aiNotesMatch ? aiNotesMatch[1].trim() : null;

  // 10. Upsert cluster_strategy
  const { error: stratErr } = await sb.from('cluster_strategy').upsert({
    audit_id: auditId,
    canonical_key: args.canonicalKey,
    canonical_topic: cluster.canonical_topic ?? cluster.topic,
    strategy_markdown: result,
    recommended_pages: recommendedPages,
    buyer_stages: buyerStages,
    format_gaps: formatGaps,
    ai_optimization_notes: aiOptimizationNotes,
    generated_at: new Date().toISOString(),
    model_used: 'opus',
  }, { onConflict: 'audit_id,canonical_key' });

  if (stratErr) throw new Error(`cluster_strategy upsert failed: ${stratErr.message}`);
  console.log(`  [cluster-strategy] Strategy saved to cluster_strategy`);

  // 11. Activate the cluster
  const { error: clusterErr } = await sb
    .from('audit_clusters')
    .update({
      status: 'active',
      activated_at: new Date().toISOString(),
      activated_by: userId,
    })
    .eq('audit_id', auditId)
    .eq('canonical_key', args.canonicalKey);

  if (clusterErr) console.warn(`  [cluster-strategy] Failed to activate cluster: ${clusterErr.message}`);
  else console.log(`  [cluster-strategy] Cluster status → active`);

  // 12. Flag execution_pages as cluster_active
  const { error: pageErr, count: pageCount } = await sb
    .from('execution_pages')
    .update({ cluster_active: true })
    .eq('audit_id', auditId)
    .eq('canonical_key', args.canonicalKey);

  if (pageErr) console.warn(`  [cluster-strategy] Failed to flag pages: ${pageErr.message}`);
  else console.log(`  [cluster-strategy] Flagged ${pageCount ?? 0} pages as cluster_active`);

  // 13. Log agent_runs
  const { error: runErr } = await sb.from('agent_runs').insert({
    audit_id: auditId,
    agent_name: 'cluster_strategy',
    status: 'completed',
    input_tokens: 0,
    output_tokens: 0,
    metadata: {
      canonical_key: args.canonicalKey,
      keywords: kwList.length,
      pages: pageList.length,
    },
  });
  if (runErr) console.warn(`  [cluster-strategy] agent_runs insert failed: ${runErr.message}`);

  console.log(`[cluster-strategy] Done: ${args.domain} / ${args.canonicalKey}`);
}

main().catch((err) => {
  console.error(`[cluster-strategy] FATAL: ${err.message}`);
  process.exit(1);
});
