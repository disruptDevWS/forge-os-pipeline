#!/usr/bin/env npx tsx
/**
 * generate-brief.ts — On-demand brief generation processor
 *
 * Polls `pam_requests` table for pending rows, gathers context,
 * calls `claude --print` to generate a content brief, writes output
 * files, and upserts directly into `execution_pages`.
 *
 * Usage:
 *   npx tsx scripts/generate-brief.ts
 *   npx tsx scripts/generate-brief.ts --domain veteransplumbingcorp.com   # filter by domain
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { callClaude as callClaudeAsync, initAnthropicClient } from './anthropic-client.js';

// ============================================================
// .env loader (same as sync-to-dashboard — never touch process.env)
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
// Directory helpers
// ============================================================

const AUDITS_BASE = path.resolve(process.cwd(), 'audits');

function getLatestDateDir(baseDir: string): string | null {
  if (!fs.existsSync(baseDir)) return null;
  const entries = fs.readdirSync(baseDir).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort();
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// callClaudeAsync replaced by import from anthropic-client.ts

// ============================================================
// Field extraction (duplicated from sync-to-dashboard — no import)
// ============================================================

function extractMetadataField(md: string, field: string): string | null {
  const regex = new RegExp(`##\\s*${field}[\\s\\S]*?\\n\\n([^#]+?)(?=\\n##|\\n#|$)`, 'i');
  const match = md.match(regex);
  if (!match) return null;
  const lines = match[1].trim().split('\n').filter((l) => l.trim());
  for (const line of lines) {
    // Extract value from blockquote lines (> Actual Value)
    const bqMatch = line.match(/^>\s*(.+)/);
    if (bqMatch) return bqMatch[1].trim();
    const cleaned = line.replace(/\*\*/g, '').replace(/`/g, '').trim();
    if (cleaned && !cleaned.startsWith('(') && !cleaned.startsWith('Char') && !cleaned.startsWith('Rationale') && !cleaned.startsWith('Recommended')) {
      return cleaned;
    }
  }
  return null;
}

function extractWordCountTarget(md: string): number | null {
  // Match "Total Word Count Target: 1,900–2,100 words" — use the upper bound of the range
  const rangeMatch = md.match(/(?:estimated|target|total)\s+(?:total\s+)?word\s+count[:\s]*(\d[\d,]*)\s*[–\-—]\s*(\d[\d,]*)/i);
  if (rangeMatch) return parseInt(rangeMatch[2].replace(/,/g, ''), 10);
  // Match single number: "Total Word Count: 1,800"
  const match = md.match(/(?:estimated|target|total)\s+(?:total\s+)?word\s+count[:\s]*(\d[\d,]*)/i);
  if (match) return parseInt(match[1].replace(/,/g, ''), 10);
  // Fallback: sum from a word count table
  const tableMatch = md.match(/word\s*count.*?\n\|[-\s|]+\n((?:\|.+\n?)*)/i);
  if (tableMatch) {
    const rows = tableMatch[1].trim().split('\n');
    let total = 0;
    for (const row of rows) {
      const nums = row.match(/(\d[\d,]*)/g);
      if (nums) {
        total += parseInt(nums[nums.length - 1].replace(/,/g, ''), 10) || 0;
      }
    }
    if (total > 0) return total;
  }
  return null;
}

// ============================================================
// Context gathering
// ============================================================

interface PamRequest {
  id: string;
  audit_id: string;
  page_url: string;
  silo_name: string | null;
  page_role: string | null;
  target_keywords: any;
  action_type: string;
  domain: string;
  status: string;
  error_message: string | null;
  requested_at: string;
  completed_at: string | null;
}

interface AuditMeta {
  domain: string;
  service_key: string;
  market_city: string;
  market_state: string;
}

interface KeywordRow {
  keyword: string;
  search_volume: number | null;
  position: number | null;
  intent: string | null;
  ranking_url: string | null;
  cpc: number | null;
}

interface SiblingPage {
  url_slug: string;
  silo: string | null;
  page_brief: any;
  status: string;
  meta_title: string | null;
}

async function gatherContext(sb: SupabaseClient, req: PamRequest) {
  // 1. Audit metadata
  const { data: audit } = await sb
    .from('audits')
    .select('domain, service_key, market_city, market_state')
    .eq('id', req.audit_id)
    .single();
  if (!audit) throw new Error(`Audit ${req.audit_id} not found`);
  const auditMeta = audit as AuditMeta;

  // 2. Page data from execution_pages
  const normalizedSlug = req.page_url.replace(/^\/+/, '');
  const { data: pageData } = await sb
    .from('execution_pages')
    .select('page_brief, url_slug, silo')
    .eq('audit_id', req.audit_id)
    .or(`url_slug.eq.${normalizedSlug},url_slug.eq./${normalizedSlug}`)
    .maybeSingle();

  const brief = (pageData?.page_brief ?? {}) as Record<string, any>;

  // 3. Keywords for this silo/cluster
  const siloName = req.silo_name ?? pageData?.silo ?? null;
  let keywords: KeywordRow[] = [];
  if (siloName) {
    const { data } = await sb
      .from('audit_keywords')
      .select('keyword, search_volume, position, intent, ranking_url, cpc')
      .eq('audit_id', req.audit_id)
      .eq('cluster', siloName);
    keywords = (data ?? []) as KeywordRow[];
  }
  // Fallback: all keywords if cluster match returned empty
  if (keywords.length === 0) {
    const { data } = await sb
      .from('audit_keywords')
      .select('keyword, search_volume, position, intent, ranking_url, cpc')
      .eq('audit_id', req.audit_id)
      .order('search_volume', { ascending: false })
      .limit(50);
    keywords = (data ?? []) as KeywordRow[];
  }

  // 4. Sibling pages in same silo
  let siblings: SiblingPage[] = [];
  if (siloName) {
    const { data } = await sb
      .from('execution_pages')
      .select('url_slug, silo, page_brief, status, meta_title')
      .eq('audit_id', req.audit_id)
      .eq('silo', siloName);
    siblings = (data ?? []) as SiblingPage[];
  }

  // 5. Architecture blueprint excerpt
  let blueprintExcerpt = '';
  try {
    const blueprintBase = path.join(AUDITS_BASE, req.domain, 'architecture');
    const blueprintDate = getLatestDateDir(blueprintBase);
    if (blueprintDate) {
      const blueprintPath = path.join(blueprintBase, blueprintDate, 'architecture_blueprint.md');
      if (fs.existsSync(blueprintPath)) {
        const blueprintMd = fs.readFileSync(blueprintPath, 'utf-8');
        // Extract the silo section relevant to this page
        if (siloName) {
          const siloRegex = new RegExp(
            `(#{1,3}\\s*(?:.*?${escapeRegex(siloName)}.*?)\\n[\\s\\S]*?)(?=\\n#{1,3}\\s|$)`,
            'i'
          );
          const siloMatch = blueprintMd.match(siloRegex);
          blueprintExcerpt = siloMatch ? siloMatch[1].trim() : '';
        }
        if (!blueprintExcerpt) {
          // Fallback: include the first 2000 chars of the blueprint
          blueprintExcerpt = blueprintMd.slice(0, 2000);
        }
      }
    }
  } catch {
    // Blueprint is optional context
  }
  if (!blueprintExcerpt) {
    console.log(`  WARNING: No architecture blueprint context for /${req.page_url} — brief generated without silo structure`);
  }

  // 6. SERP enrichment (DataForSEO Advanced — optional)
  let serpEnrichment: SerpEnrichment | null = null;
  const env = loadEnv();
  const dfLogin = env.DATAFORSEO_LOGIN;
  const dfPassword = env.DATAFORSEO_PASSWORD;
  const primaryKeyword = (req.target_keywords as any)?.[0]
    ?? (brief as any)?.primary_keyword
    ?? null;

  if (primaryKeyword && dfLogin && dfPassword) {
    try {
      console.log(`  Fetching SERP Advanced for "${primaryKeyword}"...`);
      const serpRaw = await fetchSerpAdvanced(dfLogin, dfPassword, primaryKeyword);
      const parsed = parseSerpData(serpRaw, primaryKeyword);
      // Filter aggregator domains from organic results
      const aggregators = await loadAggregatorDomains(sb);
      parsed.topOrganic = filterAggregators(parsed.topOrganic, aggregators, auditMeta.domain);
      serpEnrichment = parsed;
      console.log(`  SERP: ${parsed.peopleAlsoAsk.length} PAA, ${parsed.peopleAlsoSearch.length} PAS, ${parsed.topOrganic.length} organics`);
    } catch (err: any) {
      console.log(`  Warning: SERP enrichment failed: ${err.message} — continuing without it`);
    }
  }

  // 7. Jim's research summary — striking distance + key takeaways
  let marketContext = '';
  try {
    const researchBase = path.join(AUDITS_BASE, req.domain, 'research');
    const researchDate = getLatestDateDir(researchBase);
    if (researchDate) {
      const summaryPath = path.join(researchBase, researchDate, 'research_summary.md');
      if (fs.existsSync(summaryPath)) {
        const summaryMd = fs.readFileSync(summaryPath, 'utf-8');
        // Extract ## Striking Distance and ## Key Takeaways sections
        const sections = summaryMd.split(/\n(?=##\s)/);
        for (const section of sections) {
          if (/^##\s*\d*\.?\s*Striking\s+Distance/i.test(section) || /^##\s*\d*\.?\s*Key\s+Takeaways/i.test(section)) {
            marketContext += section.trim() + '\n\n';
          }
        }
      }
    }
  } catch {
    // Research summary is optional
  }
  if (!marketContext) {
    console.log(`  WARNING: No market context for /${req.page_url} — brief generated without striking distance data`);
  }

  // 8. Content gap data from Phase 5 (Gap agent)
  let authorityGaps: any[] = [];
  let formatGaps: any[] = [];
  try {
    const { data: gapSnapshot } = await sb
      .from('audit_snapshots')
      .select('keyword_overview')
      .eq('audit_id', req.audit_id)
      .eq('agent_name', 'gap')
      .order('snapshot_version', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (gapSnapshot?.keyword_overview) {
      const kw = gapSnapshot.keyword_overview as any;
      // Top 5 authority gaps by estimated volume, excluding near-me
      authorityGaps = (kw.authority_gaps ?? [])
        .filter((g: any) => !g.is_near_me)
        .sort((a: any, b: any) => (b.estimated_volume ?? 0) - (a.estimated_volume ?? 0))
        .slice(0, 5);
      // Format gaps not already addressed by this page's silo
      formatGaps = (kw.format_gaps ?? [])
        .filter((g: any) => !siloName || !g.addressed_by_silo || g.addressed_by_silo !== siloName);
    }
  } catch {
    // Gap snapshot may not exist
  }

  // 8. Client profile (brand brief)
  let clientProfile: Record<string, any> | null = null;
  try {
    const { data } = await sb
      .from('client_profiles')
      .select('*')
      .eq('audit_id', req.audit_id)
      .maybeSingle();
    clientProfile = data;
  } catch {
    // Table may not exist yet
  }

  return { auditMeta, brief, keywords, siblings, blueprintExcerpt, siloName, serpEnrichment, clientProfile, authorityGaps, formatGaps, marketContext };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// SERP enrichment (DataForSEO Advanced endpoint)
// ============================================================

interface SerpEnrichment {
  keyword: string;
  serpFeatures: Record<string, boolean>;
  peopleAlsoAsk: Array<{
    question: string;
    answerType: 'snippet' | 'ai_overview';
    sourceDomain: string | null;
    answerSnippet: string | null;
    seedQuestion: string | null;
  }>;
  peopleAlsoSearch: string[];
  topOrganic: Array<{
    rank: number;
    url: string;
    domain: string;
    title: string;
    description: string;
    isFeaturedSnippet: boolean;
  }>;
}

async function fetchSerpAdvanced(
  login: string, password: string, keyword: string, locationCode = 2840
): Promise<any> {
  const authString = Buffer.from(`${login}:${password}`).toString('base64');
  const resp = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/advanced', {
    method: 'POST',
    headers: { Authorization: `Basic ${authString}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{
      keyword,
      location_code: locationCode,
      language_code: 'en',
      device: 'desktop',
      os: 'windows',
      depth: 10,
      people_also_ask_click_depth: 2,
    }]),
  });
  if (!resp.ok) throw new Error(`DataForSEO Advanced HTTP ${resp.status}`);
  const data = await resp.json();
  if (data?.status_code && data.status_code !== 20000) throw new Error(`DataForSEO status ${data.status_code}`);
  return data;
}

function parseSerpData(data: any, keyword: string): SerpEnrichment {
  const items: any[] = [];
  for (const task of data?.tasks ?? []) {
    for (const result of task?.result ?? []) {
      for (const item of result?.items ?? []) {
        items.push(item);
      }
    }
  }

  // SERP feature flags
  const featureTypes = new Set(items.map((i: any) => i.type));
  const serpFeatures: Record<string, boolean> = {
    has_local_pack: featureTypes.has('local_pack'),
    has_featured_snippet: featureTypes.has('featured_snippet'),
    has_people_also_ask: featureTypes.has('people_also_ask'),
    has_people_also_search: featureTypes.has('people_also_search'),
    has_knowledge_graph: featureTypes.has('knowledge_graph'),
    has_ai_overview: featureTypes.has('ai_overview'),
    has_images: featureTypes.has('images'),
    has_video: featureTypes.has('video'),
    has_ads_top: items.some((i: any) => i.type === 'paid' && (i.rank_group ?? 99) <= 4),
    has_ads_bottom: items.some((i: any) => i.type === 'paid' && (i.rank_group ?? 0) > 4),
  };

  // People Also Ask
  const peopleAlsoAsk: SerpEnrichment['peopleAlsoAsk'] = [];
  for (const item of items) {
    if (item.type === 'people_also_ask') {
      for (const el of item.items ?? []) {
        const expanded = el.expanded_element ?? [];
        const isAiOverview = expanded.some((e: any) => e.type === 'ai_overview' || e.type === 'sgei');
        peopleAlsoAsk.push({
          question: el.title ?? el.question ?? '',
          answerType: isAiOverview ? 'ai_overview' : 'snippet',
          sourceDomain: el.domain ?? el.url ? extractDomainFromUrl(el.url) : null,
          answerSnippet: el.description ?? el.snippet ?? null,
          seedQuestion: el.seed_question ?? null,
        });
      }
    }
  }

  // People Also Search
  const peopleAlsoSearch: string[] = [];
  for (const item of items) {
    if (item.type === 'people_also_search') {
      for (const el of item.items ?? []) {
        if (el.title) peopleAlsoSearch.push(el.title);
      }
    }
  }

  // Top organic results
  const topOrganic: SerpEnrichment['topOrganic'] = [];
  for (const item of items) {
    if (item.type === 'organic') {
      topOrganic.push({
        rank: item.rank_group ?? item.rank_absolute ?? 0,
        url: item.url ?? '',
        domain: item.domain ?? extractDomainFromUrl(item.url) ?? '',
        title: item.title ?? '',
        description: item.description ?? '',
        isFeaturedSnippet: item.is_featured_snippet === true,
      });
    }
  }

  return { keyword, serpFeatures, peopleAlsoAsk, peopleAlsoSearch, topOrganic };
}

function extractDomainFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

const AGGREGATOR_DOMAINS_FALLBACK = [
  'yelp.com', 'angi.com', 'homeadvisor.com', 'thumbtack.com', 'bbb.org',
  'yellowpages.com', 'manta.com', 'nextdoor.com', 'facebook.com', 'mapquest.com', 'youtube.com',
];

async function loadAggregatorDomains(sb: SupabaseClient): Promise<string[]> {
  try {
    const { data } = await sb.from('directory_domains').select('domain').eq('is_active', true);
    if (data && data.length > 0) return data.map((r: any) => String(r.domain || '').toLowerCase());
  } catch {
    // Table may not exist — use fallback
  }
  return AGGREGATOR_DOMAINS_FALLBACK;
}

function filterAggregators(
  organics: SerpEnrichment['topOrganic'],
  aggregators: string[],
  clientDomain: string,
): SerpEnrichment['topOrganic'] {
  const clientNorm = clientDomain.replace(/^www\./, '').toLowerCase();
  return organics.filter((o) => {
    const d = o.domain.toLowerCase();
    if (d === clientNorm || d.endsWith('.' + clientNorm)) return false;
    if (aggregators.some((agg) => d === agg || d.endsWith('.' + agg))) return false;
    return true;
  });
}

// ============================================================
// Prompt construction
// ============================================================

function buildSerpSection(serp: SerpEnrichment | null): string {
  if (!serp) return '';

  const parts: string[] = [`## SERP Competitive Data — "${serp.keyword}"`];

  // SERP features
  const featureList = Object.entries(serp.serpFeatures)
    .filter(([, v]) => v)
    .map(([k]) => k.replace(/^has_/, '').replace(/_/g, ' '));
  parts.push(`\n### SERP Features Present\n${featureList.length > 0 ? featureList.join(', ') : 'None detected'}`);

  // People Also Ask
  if (serp.peopleAlsoAsk.length > 0) {
    parts.push(`\n### People Also Ask (${serp.peopleAlsoAsk.length} questions)`);
    for (const paa of serp.peopleAlsoAsk) {
      const src = paa.sourceDomain ? ` (source: ${paa.sourceDomain})` : '';
      const seed = paa.seedQuestion ? ` [seed: "${paa.seedQuestion}"]` : '';
      parts.push(`- **${paa.question}** — ${paa.answerType}${src}${seed}`);
    }
  }

  // People Also Search
  if (serp.peopleAlsoSearch.length > 0) {
    parts.push(`\n### People Also Search\n${serp.peopleAlsoSearch.map((q) => `- ${q}`).join('\n')}`);
  }

  // Top organic competitors
  if (serp.topOrganic.length > 0) {
    parts.push(`\n### Top Organic Competitors (${serp.topOrganic.length} results, aggregators excluded)`);
    parts.push('| Rank | Domain | Title | Description |');
    parts.push('|------|--------|-------|-------------|');
    for (const o of serp.topOrganic) {
      const desc = (o.description || '').slice(0, 120).replace(/\|/g, '\\|');
      const title = (o.title || '').replace(/\|/g, '\\|');
      parts.push(`| ${o.rank} | ${o.domain} | ${title} | ${desc} |`);
    }
  }

  // Competitive context generation instructions
  parts.push(`
## Competitive Context Generation Instructions

When generating the content outline, you MUST also produce a Competitive Context section at the end of the outline (inside the ---OUTLINE_START--- / ---OUTLINE_END--- block). This section uses the SERP data above.

Rules:
1. Separate PAA questions into three categories:
   a. Questions answered by competitor pages (standard snippets) — table-stakes content the page MUST address
   b. Questions answered by AI Overview — content opportunities (ownable whitespace where direct answers can displace AI-generated responses)
   c. Second-tier questions (seed_question not null) — deeper intent patterns worth monitoring
2. List People Also Search queries, noting which align with brief keywords vs. new territory
3. Synthesize Content Gap Opportunities — actionable insights, not just restated data
4. Write a Differentiation Summary referencing this client's specific competitive advantage relative to THIS keyword's SERP
5. Format as structured prose and tables, not raw data dumps`);

  return parts.join('\n');
}

function buildContentGapSection(authorityGaps: any[], formatGaps: any[]): string {
  if (authorityGaps.length === 0 && formatGaps.length === 0) return '';

  const parts: string[] = ['## Content Gap Intelligence'];

  if (authorityGaps.length > 0) {
    parts.push('\n### Authority Gaps — topics competitors rank for that this page should address');
    parts.push('| Topic | Top Competitor | Est. Volume | Revenue Opportunity | Data Source |');
    parts.push('|-------|---------------|------------|--------------------:|-------------|');
    for (const g of authorityGaps) {
      parts.push(`| ${g.topic ?? g.keyword ?? '—'} | ${g.top_competitor ?? g.competitor ?? '—'} | ${g.estimated_volume ?? '—'} | ${g.revenue_opportunity ?? '—'} | ${g.data_source ?? '—'} |`);
    }
  }

  if (formatGaps.length > 0) {
    parts.push('\n### Format Gaps — content formats top competitors use that are absent from this domain');
    for (const g of formatGaps) {
      parts.push(`- **${g.format ?? g.gap_type ?? 'Unknown'}**: ${g.description ?? ''} ${g.competitor_using ? `(used by: ${g.competitor_using})` : ''}`);
    }
  }

  parts.push('\nEach authority gap relevant to this page\'s intent must be addressed in at least one section of the content outline. Format gaps should be reflected in the section structure where appropriate.');

  return parts.join('\n');
}

function buildClientProfileSection(profile: Record<string, any> | null): string {
  if (!profile) {
    return `## Client Profile — NOT PROVIDED
Use placeholder brackets for any client-specific claims (years in business, review count, phone number, founder background). Do not fabricate specifics.`;
  }

  const lines: string[] = ['## Client Profile'];
  if (profile.business_name) lines.push(`- **Business Name**: ${profile.business_name}`);
  if (profile.years_in_business) lines.push(`- **Years in Business**: ${profile.years_in_business}`);
  if (profile.phone) lines.push(`- **Phone**: ${profile.phone}`);
  if (profile.review_count) lines.push(`- **Reviews**: ${profile.review_count} reviews${profile.review_rating ? ` (${profile.review_rating} avg rating)` : ''}`);
  if (profile.founder_background) lines.push(`- **Founder Background**: ${profile.founder_background}`);
  if (profile.usps && profile.usps.length > 0) lines.push(`- **USPs**: ${profile.usps.join('; ')}`);
  if (profile.service_differentiators) lines.push(`- **Service Differentiators**: ${profile.service_differentiators}`);
  if (profile.brand_voice_notes) lines.push(`\n**Brand Voice**: ${profile.brand_voice_notes}`);

  return lines.join('\n');
}

function buildPrompt(
  req: PamRequest,
  ctx: Awaited<ReturnType<typeof gatherContext>>
): string {
  const { auditMeta, brief, keywords, siblings, blueprintExcerpt, siloName, clientProfile, authorityGaps, formatGaps, marketContext } = ctx;
  const slug = req.page_url.replace(/^\/+/, '');
  const actionType = req.action_type || 'create';
  const pageRole = req.page_role ?? brief?.role ?? 'service page';
  const pageStatus = brief?.page_status ?? (actionType === 'create' ? 'new' : 'exists');

  // Build keyword table
  const keywordTable = keywords.length > 0
    ? [
        '| Keyword | Volume/mo | Current Position | CPC | Intent |',
        '|---------|-----------|-----------------|-----|--------|',
        ...keywords.map((k) =>
          `| ${k.keyword} | ${k.search_volume ?? '—'} | ${k.position ?? '—'} | ${k.cpc != null ? `$${k.cpc.toFixed(2)}` : '—'} | ${k.intent ?? '—'} |`
        ),
      ].join('\n')
    : 'No keyword data available. Use best judgment based on the page topic and domain context.';

  // Build siblings table
  const siblingsTable = siblings.length > 0
    ? [
        '| URL | Role | Status | Has Brief |',
        '|-----|------|--------|-----------|',
        ...siblings.map((s) => {
          const sBrief = s.page_brief as Record<string, any> | null;
          const sSlug = s.url_slug.replace(/^\/+/, '');
          return `| /${sSlug} | ${sBrief?.role ?? '—'} | ${s.status} | ${s.meta_title ? 'Yes' : 'No'} |`;
        }),
      ].join('\n')
    : 'No sibling pages found for this silo.';

  return `You are Pam, The Synthesizer — a content engineering agent for Forge Growth.

## Your Task
Generate a complete content brief for the page /${slug} on ${auditMeta.domain}.

## Action Type: ${actionType === 'create' ? 'CREATE — This is a brand new page. Write from scratch.' : 'OPTIMIZE — This page already exists. Improve and restructure the existing content.'}

## Domain Context
- Domain: ${auditMeta.domain}
- Service category: ${auditMeta.service_key}
- Market: ${auditMeta.market_city}, ${auditMeta.market_state}

## Page Context
- URL: /${slug}
- Silo: ${siloName ?? 'Unknown'}
- Role: ${pageRole}
- Page status: ${pageStatus}

## Target Keywords
${keywordTable}

## Sibling Pages in This Silo
${siblingsTable}
IMPORTANT: Your content outline MUST include internal links to/from these sibling pages. Each link should use descriptive anchor text matching the target page's primary keyword, not generic text like "learn more."

${marketContext ? `## Market Context
Use striking distance keywords to identify where the client has existing ranking momentum that this page can accelerate. Reference key takeaways when writing competitive differentiation and content direction for each section.

${marketContext}` : ''}
## Architecture Blueprint Context
${blueprintExcerpt || 'No architecture blueprint available.'}

${buildContentGapSection(authorityGaps, formatGaps)}

${buildSerpSection(ctx.serpEnrichment)}

${buildClientProfileSection(clientProfile)}

## Output Format
You MUST produce exactly three sections, delimited by sentinel markers:

---METADATA_START---
[Full metadata.md — include: Meta Title with character count and Fact-Feel-Proof breakdown, Meta Description with character count and Fact-Feel-Proof breakdown, H1 Tag Recommendation with rationale and differentiation from other pages, Intent Classification with explanation, Keyword-to-Element Mapping table, Implementation Notes for the CMS]
---METADATA_END---

---SCHEMA_START---
[Complete JSON-LD @graph with Organization, WebSite, WebPage, Service, and FAQPage entities. Use REPLACE placeholders for unknown values like phone, address, images. Include areaServed cities from the silo context.]
---SCHEMA_END---

---OUTLINE_START---
[Full content_outline.md — include: keyword targets table with volume/position/target, section-by-section outline with H2/H3 structure, word count targets per section, content direction for each section, keywords to use naturally per section, internal linking map (links FROM and TO this page), content differentiation table showing how this page differs from siblings, total word count estimate]
---OUTLINE_END---

## Quality Standards (match the /plumber-boise benchmark)
1. Every meta element must have a Fact-Feel-Proof breakdown table
2. Content outline sections must have specific word count targets that sum to the total
3. Each section must have explicit "Keywords to use naturally" guidance
4. Internal linking must be contextual with descriptive anchor text
5. Content differentiation must explain how this page avoids cannibalization with siblings
6. FAQs must match the FAQPage schema entities exactly
7. For OPTIMIZE pages: acknowledge what exists and specify what to change, not rewrite
`;
}

// ============================================================
// Output parsing & file writing
// ============================================================

function parseOutput(output: string) {
  const metadataMatch = output.match(/---METADATA_START---\n([\s\S]*?)\n---METADATA_END---/);
  const schemaMatch = output.match(/---SCHEMA_START---\n([\s\S]*?)\n---SCHEMA_END---/);
  const outlineMatch = output.match(/---OUTLINE_START---\n([\s\S]*?)\n---OUTLINE_END---/);

  if (!metadataMatch || !schemaMatch || !outlineMatch) {
    throw new Error('Missing sentinel-delimited sections in Claude output');
  }

  const metadataMd = metadataMatch[1].trim();
  const schemaRaw = schemaMatch[1].trim();
  const outlineMd = outlineMatch[1].trim();

  // Parse schema JSON — handle markdown fences if present
  let schemaJson: any = null;
  const jsonBlock = schemaRaw.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
  const jsonStr = jsonBlock ? jsonBlock[1].trim() : schemaRaw;
  try {
    schemaJson = JSON.parse(jsonStr);
  } catch {
    console.warn('  Warning: Could not parse schema JSON, storing as raw text');
    schemaJson = { _raw: schemaRaw };
  }

  return { metadataMd, schemaJson, schemaRaw, outlineMd };
}

function writeOutputFiles(domain: string, slug: string, parsed: ReturnType<typeof parseOutput>) {
  const date = todayStr();
  const outDir = path.join(AUDITS_BASE, domain, 'content', date, slug);
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(path.join(outDir, 'metadata.md'), parsed.metadataMd, 'utf-8');
  fs.writeFileSync(
    path.join(outDir, 'schema.json'),
    typeof parsed.schemaJson === 'object' && parsed.schemaJson !== null && !parsed.schemaJson._raw
      ? JSON.stringify(parsed.schemaJson, null, 2)
      : parsed.schemaRaw,
    'utf-8'
  );
  fs.writeFileSync(path.join(outDir, 'content_outline.md'), parsed.outlineMd, 'utf-8');

  console.log(`  Written 3 files to ${path.relative(process.cwd(), outDir)}/`);
  return outDir;
}

// ============================================================
// Supabase upsert (self-contained, no syncPam dependency)
// ============================================================

async function upsertExecutionPage(
  sb: SupabaseClient,
  auditId: string,
  slug: string,
  parsed: ReturnType<typeof parseOutput>
) {
  const normalizedSlug = slug.replace(/^\/+/, '');

  const metaTitle = extractMetadataField(parsed.metadataMd, 'Meta Title');
  const metaDesc = extractMetadataField(parsed.metadataMd, 'Meta Description');
  const h1 = extractMetadataField(parsed.metadataMd, 'H1 Tag');
  const intent = extractMetadataField(parsed.metadataMd, 'Intent Classification');
  const wordCount = extractWordCountTarget(parsed.outlineMd);

  const pamFields = {
    url_slug: normalizedSlug,
    meta_title: metaTitle,
    meta_description: metaDesc,
    h1_recommendation: h1,
    intent_classification: intent?.toLowerCase() ?? null,
    metadata_markdown: parsed.metadataMd,
    schema_json: parsed.schemaJson?._raw ? null : parsed.schemaJson,
    content_outline_markdown: parsed.outlineMd,
    target_word_count: wordCount,
    status: 'brief_ready' as const,
  };

  const { data: existing } = await sb
    .from('execution_pages')
    .select('id, status')
    .eq('audit_id', auditId)
    .or(`url_slug.eq.${normalizedSlug},url_slug.eq./${normalizedSlug}`)
    .maybeSingle();

  if (existing) {
    const { error } = await sb.from('execution_pages').update(pamFields).eq('id', (existing as any).id);
    if (error) throw new Error(`execution_pages update failed: ${error.message}`);
    console.log(`  Updated execution_page ${(existing as any).id} → brief_ready`);
  } else {
    const { error } = await sb.from('execution_pages').insert({
      audit_id: auditId,
      ...pamFields,
      snapshot_version: 1,
    });
    if (error) throw new Error(`execution_pages insert failed: ${error.message}`);
    console.log(`  Inserted new execution_page for /${normalizedSlug}`);
  }
}

// ============================================================
// Process a single request
// ============================================================

async function processRequest(sb: SupabaseClient, req: PamRequest) {
  const slug = req.page_url.replace(/^\/+/, '');
  console.log(`\nProcessing: /${slug} (${req.action_type}) for ${req.domain}`);

  // Mark as processing
  await sb.from('pam_requests').update({ status: 'processing' }).eq('id', req.id);

  try {
    // 1. Gather context
    const ctx = await gatherContext(sb, req);
    console.log(`  Context: ${ctx.keywords.length} keywords, ${ctx.siblings.length} siblings, blueprint: ${ctx.blueprintExcerpt ? 'yes' : 'no'}`);

    // 2. Build prompt
    const prompt = buildPrompt(req, ctx);

    // 3. Call claude --print (async spawn to avoid timeout on large prompts)
    console.log('  Running claude --print...');
    const result = await callClaudeAsync(prompt);

    // Save raw output for debugging
    const debugFile = path.join(AUDITS_BASE, req.domain, 'content', '_debug', `${slug}-raw.md`);
    fs.mkdirSync(path.dirname(debugFile), { recursive: true });
    fs.writeFileSync(debugFile, result, 'utf-8');
    console.log(`  Raw output: ${result.length} chars`);

    // 4. Parse output
    const parsed = parseOutput(result);

    // 5. Write files
    writeOutputFiles(req.domain, slug, parsed);

    // 6. Upsert into execution_pages
    await upsertExecutionPage(sb, req.audit_id, slug, parsed);

    // 7. Mark complete
    await sb.from('pam_requests').update({
      status: 'complete',
      completed_at: new Date().toISOString(),
    }).eq('id', req.id);

    console.log(`  Done: /${slug} → complete`);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`  FAILED: ${msg}`);
    await sb.from('pam_requests').update({
      status: 'failed',
      error_message: msg.slice(0, 500),
    }).eq('id', req.id);
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

  // Optional domain filter from CLI
  const domainArg = process.argv.find((a) => a.startsWith('--domain='))?.split('=')[1]
    ?? (process.argv.includes('--domain') ? process.argv[process.argv.indexOf('--domain') + 1] : undefined);

  // Fetch pending requests
  let query = sb
    .from('pam_requests')
    .select('*')
    .eq('status', 'pending')
    .order('requested_at', { ascending: true });

  if (domainArg) {
    query = query.eq('domain', domainArg);
  }

  const { data: requests, error } = await query;
  if (error) {
    console.error('Failed to fetch pam_requests:', error.message);
    process.exit(1);
  }

  if (!requests || requests.length === 0) {
    console.log('No pending brief requests found.');
    return;
  }

  console.log(`Found ${requests.length} pending request(s)`);

  for (const req of requests as PamRequest[]) {
    await processRequest(sb, req);
  }

  console.log('\nAll requests processed.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
