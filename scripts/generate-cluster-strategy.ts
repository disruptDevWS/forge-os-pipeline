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

function mapContentTypeToRole(contentType: string): string {
  const map: Record<string, string> = {
    pillar_page: 'pillar',
    service_page: 'cluster',
    comparison: 'support',
    comparison_page: 'support',
    cost_guide: 'support',
    faq: 'support',
    faq_hub: 'support',
    guide: 'support',
    process_guide: 'support',
    calculator: 'support',
    informational: 'support',
    location_page: 'cluster',
  };
  return map[contentType] ?? 'support';
}

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
- Entity Type: ${(cluster as any).primary_entity_type ?? 'Service'} (schema.org type for the pillar page)
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

### 0. Entity Map

Define the canonical entity this cluster is built around. This entity definition governs the schema markup on the pillar page and how supporting pages reference the cluster's central subject.

Output as JSON:
\`\`\`json
{
  "entity": {
    "type": "${(cluster as any).primary_entity_type ?? 'Service'}",
    "name": "canonical name for this entity as it should appear in schema markup",
    "key_attributes": [
      "attribute name: description of what this attribute captures"
    ],
    "related_entities": [
      {
        "type": "schema.org type",
        "name": "entity name",
        "relationship": "how this entity relates to the primary entity",
        "warrants_own_page": true
      }
    ],
    "schema_notes": "Specific schema implementation notes for this entity type in this vertical"
  }
}
\`\`\`

Rules for key_attributes:
- List only attributes meaningful for this entity type that the client actually has or should have
- For Course: provider, duration, credential_issued, accrediting_body, delivery_mode, prerequisites
- For Service: provider, serviceArea, serviceType, hasOfferCatalog
- Do not list generic schema attributes that add no signal

Rules for related_entities:
- Include entities that appear naturally in supporting content for this cluster
- warrants_own_page: true = this entity should have a dedicated page in the cluster
- warrants_own_page: false = this entity appears as supporting content on existing pages

### 1. Buyer Journey Map
Map keywords to buyer stages (Awareness → Consideration → Decision → Retention). Identify which stages have coverage and which are gaps.

For each stage, identify the SPECIFIC QUESTIONS a buyer in this vertical asks at that stage —
not generic stage descriptions. For a medical training cluster, Consideration stage questions
might be "How long does EMT certification take?", "What's the difference between EMT-Basic and AEMT?",
"Is this program accredited?" These specific questions are the content targets for pages at that stage.

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

Recommended pages must go BEYOND what the current page manifest already covers.
Do not recommend pages that duplicate existing page slugs.
For each recommended page, the rationale must name the specific buyer stage question it answers
and why that question is not currently addressed by existing pages.
Priority 1 = addresses a missing Consideration or Decision stage gap with keyword volume evidence.
Priority 2 = addresses a missing Awareness or Retention stage with volume evidence.
Priority 3 = format gap (comparison, calculator, cost guide) without strong keyword volume but with competitive evidence.

When recommending new pages, cross-reference the entity map from Section 0:
- Pages for related_entities where warrants_own_page: true should appear as priority 1 or 2 recommendations
- Each recommended page should specify which entity it targets
- Schema type for each recommended page should be consistent with its entity type from the entity map

### 4. Format Gaps
Content formats competitors use that this cluster lacks (video, FAQ schema, comparison tables, calculators, before/after galleries, etc.)

Output as JSON:
\`\`\`json
{ "gaps": [{ "format": "faq_schema", "priority": "high|medium|low", "rationale": "why" }] }
\`\`\`

### 5. AI & Search Optimization Targets

Identify the 3–5 highest-value AI/search optimization opportunities for this cluster.

Output as JSON:
\`\`\`json
{
  "ai_targets": [
    {
      "query": "the specific query to target",
      "target_type": "ai_overview|featured_snippet|voice|paa",
      "structural_pattern": "direct_answer|list|table|prose_elaboration",
      "applies_to_page": "/url-slug or null if cluster-wide",
      "condition": "why this query warrants this specific pattern — the intent signal that justifies the structural choice",
      "rationale": "why this page/cluster should own this answer"
    }
  ]
}
\`\`\`

Focus on queries where:
- The cluster has topical authority signals (strong keyword positions or volume)
- A specific structural pattern would create a clear retrieval advantage
- The answer is verifiable, specific, and attributable to this business

Do not produce generic optimization recommendations (e.g., "add FAQ schema"). Produce specific query targets with explicit structural justifications.

### 6. Production Sequence
Ordered list of content to produce first for maximum impact.

---

IMPORTANT FORMATTING RULES:
- Sections 0, 1, 3, 4, and 5 MUST contain valid JSON blocks (fenced with \`\`\`json ... \`\`\`).
- Sections 2 and 6 are markdown prose.
- Do not include any preamble before "### 0. Entity Map".

REMINDER: Your response IS the cluster strategy document — start with "### 0. Entity Map". No preamble, no narration.`;

  console.log(`  [cluster-strategy] Calling Claude (Opus)...`);
  const result = await callClaude(prompt, { model: 'opus', phase: 'cluster-strategy' });

  // 9. Parse JSON sections — header-based extraction (immune to section ordering and stray JSON blocks)
  const extractJsonBySection = (text: string, sectionHeader: RegExp): any => {
    const sectionMatch = text.match(sectionHeader);
    if (!sectionMatch || sectionMatch.index === undefined) return null;

    const sectionStart = sectionMatch.index + sectionMatch[0].length;
    // Find the next section header (### followed by number) or end of text
    const nextSection = text.slice(sectionStart).search(/\n### \d+\./);
    const sectionText = nextSection >= 0
      ? text.slice(sectionStart, sectionStart + nextSection)
      : text.slice(sectionStart);

    // Find the FIRST fenced JSON block in this section
    const jsonMatch = sectionText.match(/```json\s*\n([\s\S]*?)```/);
    if (!jsonMatch) return null;

    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch (err) {
      console.warn(`  [cluster-strategy] Failed to parse JSON in ${sectionHeader}: ${(err as Error).message}`);
      return null;
    }
  };

  const entityMap = extractJsonBySection(result, /### 0\.\s*Entity Map/i);
  const buyerStages = extractJsonBySection(result, /### 1\.\s*Buyer Journey Map/i);
  const recommendedPages = extractJsonBySection(result, /### 3\.\s*Recommended New Pages/i);
  const formatGaps = extractJsonBySection(result, /### 4\.\s*Format Gaps/i);

  // Extract AI optimization targets (Section 5 — structured JSON)
  let aiOptimizationTargets: any[] = [];
  try {
    const section5Json = extractJsonBySection(result, /### 5\.\s*AI.*?Optimization.*?Targets/i);
    if (section5Json?.ai_targets && Array.isArray(section5Json.ai_targets)) {
      aiOptimizationTargets = section5Json.ai_targets;
    }
  } catch (e) {
    console.warn('[cluster-strategy] Could not parse Section 5 AI targets:', e);
  }
  // Fallback: extract prose for ai_optimization_notes (backward compat)
  const aiNotesMatch = result.match(/### 5\.\s*AI.*?Optimization.*?\n([\s\S]*?)(?=### 6\.|$)/i);
  const aiOptimizationNotes = aiNotesMatch ? aiNotesMatch[1].trim() : null;

  // 10. Upsert cluster_strategy
  const { error: stratErr } = await (sb as any).from('cluster_strategy').upsert({
    audit_id: auditId,
    canonical_key: args.canonicalKey,
    canonical_topic: cluster.canonical_topic ?? cluster.topic,
    strategy_markdown: result,
    recommended_pages: recommendedPages,
    buyer_stages: buyerStages,
    format_gaps: formatGaps,
    ai_optimization_notes: aiOptimizationNotes,
    ai_optimization_targets: aiOptimizationTargets.length > 0 ? aiOptimizationTargets : null,
    entity_map: entityMap,
    generated_at: new Date().toISOString(),
    model_used: 'claude-opus-4-6',
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

  // 11b. Write recommended pages from cluster strategy into execution_pages
  const recPages = recommendedPages?.pages ?? [];
  if (recPages.length > 0) {
    const { data: existingPages } = await sb
      .from('execution_pages')
      .select('url_slug')
      .eq('audit_id', auditId);

    const existingSlugs = new Set((existingPages ?? []).map((p: any) =>
      (p.url_slug as string).replace(/^\/+/, '').toLowerCase()
    ));

    const candidates = recPages
      .filter((p: any) => !existingSlugs.has((p.url_slug ?? '').replace(/^\/+/, '').toLowerCase()));

    let inserted = 0;
    for (const p of candidates) {
      const slug = (p.url_slug ?? '').replace(/^\/+/, '');
      if (!slug) continue;

      // Re-check at insert time (handles concurrent activations)
      // BUG-1 fix: use normalized slug with .eq() instead of broken .or() syntax
      const { data: exists } = await sb
        .from('execution_pages')
        .select('id')
        .eq('audit_id', auditId)
        .eq('url_slug', slug)
        .maybeSingle();
      if (exists) continue;

      const { error } = await (sb as any).from('execution_pages').insert({
        audit_id: auditId,
        url_slug: slug,
        silo: cluster.canonical_topic ?? null,
        canonical_key: args.canonicalKey,
        priority: p.priority === 1 ? 1 : p.priority === 2 ? 2 : 3,
        status: 'not_started',
        page_brief: {
          silo_name: cluster.canonical_topic ?? null,
          role: mapContentTypeToRole(p.content_type ?? ''),
          primary_keyword: p.primary_keyword ?? null,
          primary_keyword_volume: p.volume ?? null,
          action_required: 'create',
          page_status: 'new',
        },
        cluster_active: true,
        source: 'cluster_strategy',
        buyer_stage: p.buyer_stage ?? null,
        strategy_rationale: p.rationale ?? null,
      });
      if (error) {
        console.warn(`  [cluster-strategy] Warning: Failed to insert page ${slug}: ${error.message}`);
      } else {
        inserted++;
      }
    }
    if (inserted > 0) {
      console.log(`  [cluster-strategy] Added ${inserted} buyer-journey pages to execution_pages`);
    } else if (candidates.length > 0) {
      console.log(`  [cluster-strategy] No new pages to add (all ${recPages.length} recommended pages already exist)`);
    }
  }

  // 12. Flag execution_pages as cluster_active
  const { error: pageErr, count: pageCount } = await sb
    .from('execution_pages')
    .update({ cluster_active: true })
    .eq('audit_id', auditId)
    .eq('canonical_key', args.canonicalKey);

  if (pageErr) console.warn(`  [cluster-strategy] Failed to flag pages: ${pageErr.message}`);
  else console.log(`  [cluster-strategy] Flagged ${pageCount ?? 0} pages as cluster_active`);

  // 12b. Also activate Michael-sourced pages in the same silo that missed the canonical_key
  // backfill (primary_keyword mismatch leaves canonical_key = null, causing step 12 to miss them).
  // Set canonical_key here too so deactivation works correctly.
  const clusterTopic = cluster.canonical_topic ?? cluster.topic;
  if (clusterTopic) {
    const { error: siloErr, count: siloCount } = await sb
      .from('execution_pages')
      .update({ cluster_active: true, canonical_key: args.canonicalKey })
      .eq('audit_id', auditId)
      .eq('silo', clusterTopic)
      .is('canonical_key', null);
    if (siloErr) console.warn(`  [cluster-strategy] Silo-match activation failed: ${siloErr.message}`);
    else if (siloCount) console.log(`  [cluster-strategy] Activated ${siloCount} additional page(s) by silo match (canonical_key was null)`);
  }

  // 13. Log agent_runs
  const { error: runErr } = await sb.from('agent_runs').insert({
    audit_id: auditId,
    agent_name: 'cluster_strategy',
    status: 'completed',
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
