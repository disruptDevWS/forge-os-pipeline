/**
 * ai-visibility-analysis.ts — AI Visibility Assessment runner.
 *
 * SOW Section 2.5: Brand mention frequency, competitor citations,
 * structural gaps, and AI search volume across Google AIO + ChatGPT.
 *
 * Flow:
 * 1. Resolve audit + client profile
 * 2. Generate or accept queries
 * 3. Fetch domain mentions (DataForSEO)
 * 4. Fetch AI keyword volumes (DataForSEO)
 * 5. Fetch competitor mentions (DataForSEO)
 * 6. Sonnet synthesis (structural gaps + recommendations)
 * 7. Write disk artifacts + Supabase
 * 8. Log agent_runs
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  fetchDomainMentions,
  fetchCompetitorMentions,
  fetchAiKeywordVolumes,
  type LlmMention,
  type CompetitorMention,
  type AiKeywordVolume,
} from './dataforseo-llm-mentions.js';
import { callClaude } from './anthropic-client.js';
import { loadClientContextAsync, type ClientContext } from './client-context.js';

const AUDITS_BASE = path.resolve(process.cwd(), 'audits');

// ── Types ─────────────────────────────────────────────────────

export interface AiVisibilityRequest {
  domain: string;
  email: string;
  audit_id: string;
  keywords?: string[];
  competitor_domains?: string[];
}

export interface PerKeywordResult {
  keyword: string;
  ai_search_volume: number | null;
  google_mention_count: number;
  chatgpt_mention_count: number;
  google_top_citations: string[];
  chatgpt_top_citations: string[];
  client_cited_google: boolean;
  client_cited_chatgpt: boolean;
}

export interface CompetitorSummary {
  domain: string;
  google_mentions: number;
  chatgpt_mentions: number;
}

export interface AiVisibilityResult {
  generated_queries: string[];
  query_source: 'provided' | 'generated';
  keywords: PerKeywordResult[];
  competitor_summary: CompetitorSummary[];
  summary: {
    total_queries: number;
    google_cited_count: number;
    chatgpt_cited_count: number;
    top_citation_domains: string[];
    total_ai_volume: number;
  };
  synthesis_markdown: string;
  costs: {
    domain_mentions: number;
    competitor_mentions: number;
    ai_volume: number;
    synthesis: number;
    total: number;
  };
}

// ── Helpers ───────────────────────────────────────────────────

function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function nextDay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ── Query generation ──────────────────────────────────────────

async function generateAiVisibilityQueries(
  env: Record<string, string>,
  audit: Record<string, any>,
  clientProfile: Record<string, any> | null,
  clientContext: ClientContext | null,
): Promise<string[]> {
  // Assemble context for query generation
  const contextLines: string[] = [];

  // From client_profiles
  if (clientProfile) {
    if (clientProfile.business_name) contextLines.push(`Business: ${clientProfile.business_name}`);
    if (clientProfile.service_differentiators) contextLines.push(`Differentiators: ${clientProfile.service_differentiators}`);
    if (clientProfile.usps?.length) contextLines.push(`USPs: ${clientProfile.usps.join(', ')}`);
  }

  // From client_context (ClientContext interface)
  if (clientContext) {
    if (clientContext.services?.length) contextLines.push(`Core services: ${clientContext.services.join(', ')}`);
    if (clientContext.competitive_advantage) contextLines.push(`Competitive advantage: ${clientContext.competitive_advantage}`);
    if (clientContext.target_audience) contextLines.push(`Target audience: ${clientContext.target_audience}`);
    if (clientContext.business_model) contextLines.push(`Business model: ${clientContext.business_model}`);
  }

  // From audits.client_context raw JSONB (additional fields not mapped to ClientContext)
  const rawCtx = audit.client_context;
  if (rawCtx && typeof rawCtx === 'object') {
    if (rawCtx.service_area && !contextLines.some((l) => l.includes(rawCtx.service_area))) {
      contextLines.push(`Service area: ${rawCtx.service_area}`);
    }
  }

  // Fallback identifiers
  const serviceKey = audit.service_key || '';
  const city = audit.market_city || '';
  const state = audit.market_state || '';
  const domain = audit.domain || '';
  const geo = [city, state].filter(Boolean).join(', ');

  if (serviceKey && !contextLines.some((l) => l.toLowerCase().includes(serviceKey.toLowerCase()))) {
    contextLines.push(`Primary service: ${serviceKey}`);
  }
  if (geo) contextLines.push(`Market: ${geo}`);
  contextLines.push(`Domain: ${domain}`);

  const contextBlock = contextLines.join('\n');

  // If context is too sparse, use deterministic fallback
  if (contextLines.length <= 2) {
    console.log('  Sparse client context — using deterministic fallback queries');
    return buildFallbackQueries(serviceKey, city, state, domain);
  }

  const prompt = `YOUR ENTIRE RESPONSE IS THE JSON ARRAY.

You are generating search queries that a potential customer would type into ChatGPT or Google AI to find businesses like the one described below. These queries will be used to assess whether this business appears in AI-generated answers.

## Business Context
${contextBlock}

## Instructions
Generate 10-15 natural-language search queries spanning three intent buckets:

**Discovery** (4-5 queries): "best [service] in [location]", "top [service] providers near [location]", "[service] programs in [city/state]"
**Consideration** (3-5 queries): "how to choose a [service]", "what to look for in [service]", "is [certification/program] worth it"
**Comparison** (3-5 queries): "[business] reviews", "[service A] vs [service B] in [location]", "alternatives to [competitor type]"

Rules:
- Use natural, conversational phrasing (how people ask AI assistants)
- Include the location where relevant
- Mix brand-aware and brand-unaware queries
- Do NOT include the domain name in queries

Return ONLY a JSON array of strings. No explanation, no markdown fences.

YOUR ENTIRE RESPONSE IS THE JSON ARRAY.`;

  try {
    const raw = await callClaude(prompt, { model: 'haiku', maxTokens: 1024 });
    // Strip markdown fences if present
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    const queries = JSON.parse(cleaned);
    if (Array.isArray(queries) && queries.length >= 5) {
      console.log(`  Haiku generated ${queries.length} queries`);
      return queries.map(String).slice(0, 20);
    }
    throw new Error(`Expected array of 5+ queries, got ${queries?.length ?? 0}`);
  } catch (err: any) {
    console.log(`  Haiku query generation failed (${err.message}), using fallback`);
    return buildFallbackQueries(serviceKey, city, state, domain);
  }
}

function buildFallbackQueries(
  serviceKey: string,
  city: string,
  state: string,
  domain: string,
): string[] {
  const service = serviceKey || 'professional services';
  const geo = [city, state].filter(Boolean).join(', ') || '';
  const queries: string[] = [];

  if (geo) {
    queries.push(`best ${service} in ${geo}`);
    queries.push(`top ${service} providers ${geo}`);
    queries.push(`${service} near ${geo}`);
  } else {
    queries.push(`best ${service} providers`);
    queries.push(`top rated ${service}`);
    queries.push(`how to choose a ${service}`);
  }
  queries.push(`how to choose a ${service}`);
  queries.push(`${service} reviews`);

  return [...new Set(queries)];
}

// ── Sonnet synthesis ──────────────────────────────────────────

async function synthesizeAnalysis(
  domain: string,
  keywordResults: PerKeywordResult[],
  competitorSummary: CompetitorSummary[],
): Promise<{ markdown: string; cost: number }> {
  const clientCited = keywordResults.filter((k) => k.client_cited_google || k.client_cited_chatgpt);
  const notCited = keywordResults.filter((k) => !k.client_cited_google && !k.client_cited_chatgpt);

  // Collect all citation domains across keywords
  const allCitationDomains: Record<string, number> = {};
  for (const kw of keywordResults) {
    for (const d of [...kw.google_top_citations, ...kw.chatgpt_top_citations]) {
      if (d !== domain) {
        allCitationDomains[d] = (allCitationDomains[d] || 0) + 1;
      }
    }
  }
  const topCitedDomains = Object.entries(allCitationDomains)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([d, count]) => `${d} (${count} queries)`);

  const dataBlock = `## Domain: ${domain}

### Client Citation Summary
- Cited in Google AIO: ${clientCited.filter((k) => k.client_cited_google).length}/${keywordResults.length} queries
- Cited in ChatGPT: ${clientCited.filter((k) => k.client_cited_chatgpt).length}/${keywordResults.length} queries
- Not cited anywhere: ${notCited.length}/${keywordResults.length} queries

### Queries Where Client IS Cited
${clientCited.length > 0 ? clientCited.map((k) => `- "${k.keyword}" (Google: ${k.client_cited_google ? 'yes' : 'no'}, ChatGPT: ${k.client_cited_chatgpt ? 'yes' : 'no'})`).join('\n') : 'None'}

### Queries Where Client IS NOT Cited
${notCited.length > 0 ? notCited.map((k) => `- "${k.keyword}" (Google citations: ${k.google_top_citations.slice(0, 3).join(', ') || 'none'}, ChatGPT citations: ${k.chatgpt_top_citations.slice(0, 3).join(', ') || 'none'})`).join('\n') : 'All queries cite the client'}

### Top Citation Domains (competitors being cited instead)
${topCitedDomains.length > 0 ? topCitedDomains.map((d) => `- ${d}`).join('\n') : 'No citation domains found'}

### Competitor Mention Counts
${competitorSummary.length > 0 ? competitorSummary.map((c) => `- ${c.domain}: Google=${c.google_mentions}, ChatGPT=${c.chatgpt_mentions}`).join('\n') : 'No competitors analyzed'}`;

  const prompt = `YOUR ENTIRE RESPONSE IS THE ANALYSIS.

You are an SEO strategist analyzing AI platform visibility data for ${domain}. Write a structured analysis with actionable recommendations.

${dataBlock}

Write the following sections in markdown:

## Citation Source Analysis
Analyze which domains and content types AI platforms are citing instead of ${domain}. What patterns emerge? (e.g., are citation-winning pages listicles, guides, directories?)

## Structural Gaps
What content/structural elements is ${domain} likely missing that prevent AI citation? Consider:
- Schema markup and structured data
- Comprehensive topical authority signals
- Content format alignment with AI citation patterns
- E-E-A-T signals that AI platforms prioritize

## Recommendations
3-5 specific, actionable recommendations to improve AI visibility. Each should reference the data above. Format as numbered list with bold action title and explanation.

Keep each section concise (3-5 sentences for analysis sections, 1-2 sentences per recommendation explanation). Be specific to the data — do not give generic SEO advice.

YOUR ENTIRE RESPONSE IS THE ANALYSIS.`;

  const raw = await callClaude(prompt, { model: 'sonnet', maxTokens: 4096 });

  // Estimate Sonnet cost (~$3/1M input, ~$15/1M output, rough estimate)
  const estimatedCost = 0.02;

  return { markdown: raw, cost: estimatedCost };
}

// ── Report generation ─────────────────────────────────────────

function generateReport(
  domain: string,
  result: AiVisibilityResult,
  date: string,
): string {
  const lines: string[] = [];

  lines.push(`# AI Visibility Assessment — ${domain}`);
  lines.push(`Generated: ${date}`);
  lines.push('');

  // Executive summary
  const citedCount = result.keywords.filter((k) => k.client_cited_google || k.client_cited_chatgpt).length;
  const totalQueries = result.summary.total_queries;
  lines.push('## Executive Summary');
  lines.push('');
  lines.push(
    `${domain} was cited in ${citedCount} of ${totalQueries} AI queries tested ` +
    `(Google AIO: ${result.summary.google_cited_count}, ChatGPT: ${result.summary.chatgpt_cited_count}). ` +
    `${result.summary.top_citation_domains.length > 0 ? `Top competing citations come from ${result.summary.top_citation_domains.slice(0, 3).join(', ')}.` : 'No competing citation domains were identified.'} ` +
    `Total estimated AI search volume across tested queries: ${result.summary.total_ai_volume.toLocaleString()}/mo.`,
  );
  lines.push('');

  // AI Search Volume table
  lines.push('## AI Search Volume — Priority Queries');
  lines.push('');
  lines.push('| Query | AI Monthly Volume |');
  lines.push('|-------|------------------|');
  for (const kw of result.keywords) {
    const vol = kw.ai_search_volume != null ? kw.ai_search_volume.toLocaleString() : 'N/A';
    lines.push(`| ${kw.keyword} | ${vol} |`);
  }
  lines.push('');

  // Client visibility table
  lines.push('## Client Visibility');
  lines.push('');
  lines.push('| Query | Google AIO | ChatGPT |');
  lines.push('|-------|------------|---------|');
  for (const kw of result.keywords) {
    const g = kw.client_cited_google ? 'Cited' : 'Not cited';
    const c = kw.client_cited_chatgpt ? 'Cited' : 'Not cited';
    lines.push(`| ${kw.keyword} | ${g} | ${c} |`);
  }
  lines.push('');

  // Competitor table
  if (result.competitor_summary.length > 0) {
    lines.push('## Who AI Is Citing Instead');
    lines.push('');
    lines.push('| Domain | Google Mentions | ChatGPT Mentions |');
    lines.push('|--------|----------------|------------------|');
    for (const c of result.competitor_summary) {
      lines.push(`| ${c.domain} | ${c.google_mentions} | ${c.chatgpt_mentions} |`);
    }
    lines.push('');
  }

  // Sonnet synthesis sections
  lines.push(result.synthesis_markdown);
  lines.push('');

  // Methodology
  lines.push('## Methodology');
  lines.push('');
  lines.push(`Queries: ${result.generated_queries.join(', ')}`);
  lines.push(`Query source: ${result.query_source === 'generated' ? 'generated from client profile' : 'provided manually'}`);
  lines.push('Platforms: Google AI Overviews, ChatGPT');
  lines.push('Data: DataForSEO LLM Mentions API, AI Keyword Search Volume API');
  lines.push(`Run date: ${date}`);
  lines.push(`Estimated API cost: $${result.costs.total.toFixed(2)}`);

  return lines.join('\n');
}

// ── Main export ───────────────────────────────────────────────

export async function runAiVisibilityAnalysis(
  env: Record<string, string>,
  request: AiVisibilityRequest,
): Promise<AiVisibilityResult> {
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  }
  const sb = createClient(supabaseUrl, supabaseKey);
  const snapshotDate = todayStr();

  console.log(`\n=== AI Visibility Analysis: ${request.domain} ===\n`);

  // 1. Resolve audit
  const { data: userData } = await sb.auth.admin.listUsers();
  const user = userData?.users?.find((u: any) => u.email === request.email);
  if (!user) throw new Error(`User not found: ${request.email}`);

  const { data: audit } = await sb
    .from('audits')
    .select('*')
    .eq('id', request.audit_id)
    .maybeSingle();
  if (!audit) throw new Error(`Audit not found: ${request.audit_id}`);
  console.log(`  Audit: ${audit.id} (domain: ${audit.domain}, status: ${audit.status})`);

  // 2. Load client profile
  let clientProfile: Record<string, any> | null = null;
  try {
    const { data } = await sb.from('client_profiles').select('*').eq('audit_id', request.audit_id).maybeSingle();
    clientProfile = data;
  } catch { /* table may not exist */ }

  // Load client context (dual-store)
  const { context: clientContext } = await loadClientContextAsync(request.domain, sb, request.audit_id);

  // 3. Determine keywords
  let keywords: string[];
  let querySource: 'provided' | 'generated';

  if (request.keywords && request.keywords.length > 0) {
    keywords = request.keywords.slice(0, 50);
    querySource = 'provided';
    console.log(`  Using ${keywords.length} provided keywords`);
  } else {
    keywords = await generateAiVisibilityQueries(env, audit, clientProfile, clientContext);
    querySource = 'generated';
    console.log(`  Generated ${keywords.length} queries (source: client context + Haiku)`);
  }

  // 4. Fetch domain mentions
  console.log('  Fetching domain mentions...');
  const domainResult = await fetchDomainMentions(env, request.domain, keywords);
  console.log(`  Domain mentions: ${domainResult.mentions.length} records ($${domainResult.cost.toFixed(4)})`);

  // 5. Fetch AI keyword volumes
  console.log('  Fetching AI keyword volumes...');
  const volumeResult = await fetchAiKeywordVolumes(env, keywords);
  console.log(`  AI volumes: ${volumeResult.volumes.length} results ($${volumeResult.cost.toFixed(4)})`);

  // 6. Fetch competitor mentions
  const competitors = (request.competitor_domains ?? []).slice(0, 5);
  let competitorMentions: CompetitorMention[] = [];
  let competitorCost = 0;
  if (competitors.length > 0) {
    console.log(`  Fetching competitor mentions for ${competitors.length} domains...`);
    const compResult = await fetchCompetitorMentions(env, competitors, keywords);
    competitorMentions = compResult.mentions;
    competitorCost = compResult.cost;
    console.log(`  Competitor mentions: ${competitorMentions.length} records ($${competitorCost.toFixed(4)})`);
  }

  // 7. Merge per-keyword results
  const volumeMap = new Map<string, number | null>();
  for (const v of volumeResult.volumes) {
    volumeMap.set(v.keyword.toLowerCase(), v.ai_search_volume);
  }

  const mentionsByKeyword = new Map<string, { google: LlmMention | null; chatgpt: LlmMention | null }>();
  for (const m of domainResult.mentions) {
    const key = m.keyword.toLowerCase();
    if (!mentionsByKeyword.has(key)) {
      mentionsByKeyword.set(key, { google: null, chatgpt: null });
    }
    const entry = mentionsByKeyword.get(key)!;
    if (m.platform === 'google') entry.google = m;
    else if (m.platform === 'chat_gpt') entry.chatgpt = m;
  }

  const keywordResults: PerKeywordResult[] = keywords.map((kw) => {
    const key = kw.toLowerCase();
    const entry = mentionsByKeyword.get(key) || { google: null, chatgpt: null };
    const googleMention = entry.google;
    const chatgptMention = entry.chatgpt;

    return {
      keyword: kw,
      ai_search_volume: volumeMap.get(key) ?? null,
      google_mention_count: googleMention?.mention_count ?? 0,
      chatgpt_mention_count: chatgptMention?.mention_count ?? 0,
      google_top_citations: googleMention?.citation_sources ?? [],
      chatgpt_top_citations: chatgptMention?.citation_sources ?? [],
      client_cited_google: googleMention?.citation_sources?.some(
        (s) => s.includes(request.domain) || request.domain.includes(s),
      ) ?? false,
      client_cited_chatgpt: chatgptMention?.citation_sources?.some(
        (s) => s.includes(request.domain) || request.domain.includes(s),
      ) ?? false,
    };
  });

  // 8. Build competitor summary
  const competitorSummary: CompetitorSummary[] = [];
  if (competitors.length > 0) {
    for (const compDomain of competitors) {
      const compMentions = competitorMentions.filter((m) => m.domain === compDomain);
      competitorSummary.push({
        domain: compDomain,
        google_mentions: compMentions.filter((m) => m.platform === 'google').reduce((s, m) => s + m.mention_count, 0),
        chatgpt_mentions: compMentions.filter((m) => m.platform === 'chat_gpt').reduce((s, m) => s + m.mention_count, 0),
      });
    }
  }

  // 9. Build summary
  const allCitationDomains: Record<string, number> = {};
  for (const kw of keywordResults) {
    for (const d of [...kw.google_top_citations, ...kw.chatgpt_top_citations]) {
      if (!d.includes(request.domain)) {
        allCitationDomains[d] = (allCitationDomains[d] || 0) + 1;
      }
    }
  }
  const topCitationDomains = Object.entries(allCitationDomains)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([d]) => d);

  const summary = {
    total_queries: keywords.length,
    google_cited_count: keywordResults.filter((k) => k.client_cited_google).length,
    chatgpt_cited_count: keywordResults.filter((k) => k.client_cited_chatgpt).length,
    top_citation_domains: topCitationDomains,
    total_ai_volume: keywordResults.reduce((s, k) => s + (k.ai_search_volume ?? 0), 0),
  };

  // 10. Sonnet synthesis
  console.log('  Running Sonnet synthesis...');
  const synthesis = await synthesizeAnalysis(request.domain, keywordResults, competitorSummary);
  console.log('  Synthesis complete');

  const costs = {
    domain_mentions: domainResult.cost,
    competitor_mentions: competitorCost,
    ai_volume: volumeResult.cost,
    synthesis: synthesis.cost,
    total: domainResult.cost + competitorCost + volumeResult.cost + synthesis.cost,
  };

  const result: AiVisibilityResult = {
    generated_queries: keywords,
    query_source: querySource,
    keywords: keywordResults,
    competitor_summary: competitorSummary,
    summary,
    synthesis_markdown: synthesis.markdown,
    costs,
  };

  // 11. Write disk artifacts
  const outputDir = path.join(AUDITS_BASE, request.domain, 'research', snapshotDate);
  fs.mkdirSync(outputDir, { recursive: true });

  const dataPath = path.join(outputDir, 'ai_visibility_data.json');
  fs.writeFileSync(dataPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`  Written ${path.relative(process.cwd(), dataPath)}`);

  const reportMarkdown = generateReport(request.domain, result, snapshotDate);
  const reportPath = path.join(outputDir, 'ai_visibility_report.md');
  fs.writeFileSync(reportPath, reportMarkdown, 'utf-8');
  console.log(`  Written ${path.relative(process.cwd(), reportPath)}`);

  // 12. Supabase writes
  await writeToSupabase(sb, request, result, snapshotDate);

  // 13. Log agent_runs
  await sb.from('agent_runs').insert({
    audit_id: request.audit_id,
    agent_name: 'ai_visibility_analysis',
    run_date: snapshotDate,
    status: 'completed',
    metadata: {
      query_source: querySource,
      keyword_count: keywords.length,
      competitor_count: competitors.length,
      total_cost: costs.total,
    },
  });

  console.log(`\n  AI Visibility Analysis complete for ${request.domain}. Cost: $${costs.total.toFixed(2)}\n`);
  return result;
}

// ── Supabase writes ───────────────────────────────────────────

async function writeToSupabase(
  sb: SupabaseClient,
  request: AiVisibilityRequest,
  result: AiVisibilityResult,
  snapshotDate: string,
): Promise<void> {
  const auditId = request.audit_id;
  const domain = request.domain;

  // Clear existing rows for this audit + date (scoped delete)
  await (sb as any).from('llm_visibility_snapshots')
    .delete()
    .eq('audit_id', auditId)
    .eq('snapshot_date', snapshotDate)
    .eq('domain', domain);

  await (sb as any).from('llm_mention_details')
    .delete()
    .eq('audit_id', auditId)
    .gte('captured_at', `${snapshotDate}T00:00:00Z`)
    .lt('captured_at', `${nextDay(snapshotDate)}T00:00:00Z`);

  // Insert visibility snapshots — one row per keyword × platform
  const visRecords: any[] = [];
  for (const kw of result.keywords) {
    const googleCitations = kw.google_top_citations;
    const chatgptCitations = kw.chatgpt_top_citations;

    visRecords.push({
      audit_id: auditId,
      domain,
      snapshot_date: snapshotDate,
      keyword: kw.keyword,
      platform: 'google',
      mention_count: kw.google_mention_count,
      ai_search_volume: kw.ai_search_volume,
      top_citation_domains: googleCitations,
      is_estimated: false,
    });

    visRecords.push({
      audit_id: auditId,
      domain,
      snapshot_date: snapshotDate,
      keyword: kw.keyword,
      platform: 'chat_gpt',
      mention_count: kw.chatgpt_mention_count,
      ai_search_volume: kw.ai_search_volume,
      top_citation_domains: chatgptCitations,
      is_estimated: false,
    });
  }

  if (visRecords.length > 0) {
    const { error } = await (sb as any).from('llm_visibility_snapshots').upsert(visRecords, {
      onConflict: 'audit_id,snapshot_date,keyword,platform,domain',
    });
    if (error) console.warn(`  llm_visibility_snapshots upsert warning: ${error.message}`);
    else console.log(`  Upserted ${visRecords.length} visibility snapshot rows`);
  }

  // Insert mention details — citation domain records per keyword × platform
  const detailRecords: any[] = [];
  for (const kw of result.keywords) {
    if (kw.google_top_citations.length > 0) {
      detailRecords.push({
        audit_id: auditId,
        keyword: kw.keyword,
        platform: 'google',
        mention_text: null,
        citation_urls: [],
        source_domains: kw.google_top_citations,
      });
    }
    if (kw.chatgpt_top_citations.length > 0) {
      detailRecords.push({
        audit_id: auditId,
        keyword: kw.keyword,
        platform: 'chat_gpt',
        mention_text: null,
        citation_urls: [],
        source_domains: kw.chatgpt_top_citations,
      });
    }
  }

  if (detailRecords.length > 0) {
    const { error } = await (sb as any).from('llm_mention_details').insert(detailRecords);
    if (error) console.warn(`  llm_mention_details insert warning: ${error.message}`);
    else console.log(`  Inserted ${detailRecords.length} mention detail rows`);
  }
}

// ── CLI entry point ───────────────────────────────────────────

/**
 * When run directly (npx tsx scripts/ai-visibility-analysis.ts),
 * reads JSON request from --json arg and outputs result JSON to stdout.
 * Used by pipeline-server-standalone.ts to invoke this synchronously.
 */
if (process.argv[1]?.endsWith('ai-visibility-analysis.ts') || process.argv[1]?.endsWith('ai-visibility-analysis.js')) {
  const jsonArg = process.argv.find((a) => a.startsWith('--json='));
  if (!jsonArg) {
    console.error('Usage: npx tsx scripts/ai-visibility-analysis.ts --json=\'{"domain":"...","email":"...","audit_id":"..."}\' ');
    process.exit(1);
  }

  const envPath = path.resolve(process.cwd(), '.env');
  let env: Record<string, string> = {};
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
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
  } else {
    for (const [key, val] of Object.entries(process.env)) {
      if (val !== undefined) env[key] = val;
    }
  }

  const request: AiVisibilityRequest = JSON.parse(jsonArg.slice('--json='.length));
  runAiVisibilityAnalysis(env, request)
    .then((result) => {
      // Output result as JSON on a sentinel-wrapped line for easy extraction
      console.log('__AI_VIS_RESULT_START__');
      console.log(JSON.stringify(result));
      console.log('__AI_VIS_RESULT_END__');
      process.exit(0);
    })
    .catch((err) => {
      console.error(`FATAL: ${err.message}`);
      // Output error as JSON too
      console.log('__AI_VIS_RESULT_START__');
      console.log(JSON.stringify({ error: err.message }));
      console.log('__AI_VIS_RESULT_END__');
      process.exit(1);
    });
}
