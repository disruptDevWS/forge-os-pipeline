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
  // New format: **Field:** value on the same line
  const boldRegex = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, 'i');
  const boldMatch = md.match(boldRegex);
  if (boldMatch) {
    const val = boldMatch[1].trim();
    // Skip template placeholders like [≤60 chars...]
    if (val && !val.startsWith('[')) return val;
  }

  // Old format: ## Field\n\nvalue
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
  content_outline_markdown: string | null;
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
    .select('*')
    .eq('audit_id', req.audit_id)
    .or(`url_slug.eq.${normalizedSlug},url_slug.eq./${normalizedSlug}`)
    .maybeSingle();

  const brief = (pageData?.page_brief ?? {}) as Record<string, any>;
  const canonicalKey = (pageData as any)?.canonical_key ?? null;

  // 3. Keywords for this page's cluster (via canonical_key)
  // Session B: join through canonical_key instead of silo/cluster.
  // canonical_key is the stable cluster identity. Pages with NULL canonical_key
  // fall through to the volume-based fallback.
  const siloName = req.silo_name ?? pageData?.silo ?? null;
  let keywords: KeywordRow[] = [];
  if (canonicalKey) {
    const { data } = await (sb as any)
      .from('audit_keywords')
      .select('keyword, search_volume, position, intent, ranking_url, cpc')
      .eq('audit_id', req.audit_id)
      .eq('canonical_key', canonicalKey);
    keywords = (data ?? []) as KeywordRow[];
  }
  // Fallback: top keywords by volume if canonical_key match returned empty
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
      .select('url_slug, silo, page_brief, status, meta_title, content_outline_markdown')
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

  // 7b. Strategy brief — Visibility Posture + Architecture Directive
  let strategyContext = '';
  try {
    const researchBase2 = path.join(AUDITS_BASE, req.domain, 'research');
    const researchDate2 = getLatestDateDir(researchBase2);
    if (researchDate2) {
      const briefPath = path.join(researchBase2, researchDate2, 'strategy_brief.md');
      if (fs.existsSync(briefPath)) {
        const briefContent = fs.readFileSync(briefPath, 'utf-8');
        const extractSection = (heading: string) => {
          const re = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |\\n---\\s*$|$)`);
          return re.exec(briefContent)?.[1]?.trim() ?? '';
        };
        const posture = extractSection('Visibility Posture');
        const archDirective = extractSection('Architecture Directive');
        const parts: string[] = [];
        if (posture) parts.push(`**Visibility Posture:** ${posture}`);
        if (archDirective) parts.push(`**Architecture Directive:**\n${archDirective}`);
        if (parts.length > 0) {
          strategyContext = parts.join('\n\n');
        }
      }
    }
  } catch {
    // Strategy brief is optional
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

  // 9. Entity type, entity map, and search intent from cluster data
  let primaryEntityType = 'Service';
  let entityMap: any = null;
  let searchIntent: string | null = null;
  if (canonicalKey) {
    try {
      const { data: clusterRow } = await (sb as any)
        .from('audit_clusters')
        .select('primary_entity_type')
        .eq('audit_id', req.audit_id)
        .eq('canonical_key', canonicalKey)
        .maybeSingle();
      primaryEntityType = (clusterRow as any)?.primary_entity_type ?? 'Service';
    } catch {
      // Column may not exist yet
    }
    try {
      interface StrategyQueryResult {
        entity_map: any;
        search_intent: string | null;
      }
      const { data: strategyRow } = await (sb as any)
        .from('cluster_strategy')
        .select('entity_map, search_intent')
        .eq('audit_id', req.audit_id)
        .eq('canonical_key', canonicalKey)
        .eq('status', 'active')
        .maybeSingle();
      const strategy = strategyRow as StrategyQueryResult | null;
      entityMap = strategy?.entity_map ?? null;
      searchIntent = strategy?.search_intent ?? null;
    } catch {
      // Column or table may not exist yet
    }
  }

  // 10. Buyer journey context from execution_pages
  const buyerStage = (pageData as any)?.buyer_stage ?? null;
  const strategyRationale = (pageData as any)?.strategy_rationale ?? null;

  // 11. Technical baseline from Dwight snapshot (agentic readiness + structured data issues)
  let technicalBaselineSection = '';
  try {
    const { data: dwightSnapshot } = await sb
      .from('audit_snapshots')
      .select('agentic_readiness, structured_data_issues')
      .eq('audit_id', req.audit_id)
      .eq('agent_name', 'dwight')
      .order('snapshot_version', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (dwightSnapshot) {
      const agenticReadiness = (dwightSnapshot as any).agentic_readiness ?? [];
      const structuredDataIssues = (dwightSnapshot as any).structured_data_issues ?? [];
      if (agenticReadiness.length > 0 || structuredDataIssues.length > 0) {
        technicalBaselineSection = `## Technical Baseline (from Dwight)\n`;
        if (agenticReadiness.length > 0) {
          technicalBaselineSection += `### Agentic Readiness Flags\n`;
          technicalBaselineSection += agenticReadiness.map((r: any) => `- ${typeof r === 'string' ? r : JSON.stringify(r)}`).join('\n');
          technicalBaselineSection += '\n';
        }
        if (structuredDataIssues.length > 0) {
          technicalBaselineSection += `### Structured Data Issues\n`;
          technicalBaselineSection += structuredDataIssues.map((r: any) => `- ${typeof r === 'string' ? r : JSON.stringify(r)}`).join('\n');
          technicalBaselineSection += '\n';
        }
        technicalBaselineSection += `IMPORTANT: These are site-level technical findings. Schema you produce must work within these constraints. If structured data issues are present, produce schema that resolves or works around them — do not produce schema that assumes a clean baseline.\n`;
      }
    }
  } catch {
    // Dwight snapshot may not exist
  }

  // 12. AI citation gaps from Gap agent snapshot
  let aiCitationGaps: any[] = [];
  try {
    // Reuse the gap snapshot data already fetched in step 8
    const { data: gapSnapshotForCitations } = await sb
      .from('audit_snapshots')
      .select('keyword_overview')
      .eq('audit_id', req.audit_id)
      .eq('agent_name', 'gap')
      .order('snapshot_version', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (gapSnapshotForCitations?.keyword_overview) {
      aiCitationGaps = ((gapSnapshotForCitations.keyword_overview as any).ai_citation_gaps ?? []);
    }
  } catch {
    // Gap snapshot may not exist
  }

  // 13. GBP canonical entity data
  let gbpEntitySection = '';
  try {
    const { data: gbpSnapshot } = await sb
      .from('gbp_snapshots')
      .select('listing_found, is_claimed, review_count, rating, canonical_name, canonical_address, canonical_phone')
      .eq('audit_id', req.audit_id)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if ((gbpSnapshot as any)?.listing_found && (gbpSnapshot as any)?.canonical_name) {
      const g = gbpSnapshot as any;
      gbpEntitySection = `## GBP Canonical Entity (Authoritative — use for Organization schema)\n`;
      gbpEntitySection += `- Canonical Name: ${g.canonical_name ?? '[PLACEHOLDER: business_name]'}\n`;
      gbpEntitySection += `- Canonical Address: ${g.canonical_address ?? '[PLACEHOLDER: address]'}\n`;
      gbpEntitySection += `- Canonical Phone: ${g.canonical_phone ?? '[PLACEHOLDER: phone]'}\n`;
      gbpEntitySection += `- Claimed: ${g.is_claimed ? 'yes' : 'no'}\n`;
      if (g.review_count) {
        gbpEntitySection += `- Reviews: ${g.review_count} (${g.rating} avg)\n`;
      }

      // Auto-populate GBP listing URL from citation_snapshots (Phase 6d writes this)
      try {
        const { data: googleCitation } = await sb
          .from('citation_snapshots')
          .select('listing_url')
          .eq('audit_id', req.audit_id)
          .eq('directory_name', 'Google')
          .order('snapshot_date', { ascending: false })
          .limit(1)
          .maybeSingle();
        if ((googleCitation as any)?.listing_url) {
          gbpEntitySection += `- GBP URL: ${(googleCitation as any).listing_url}\n`;
        }
      } catch {
        // citation_snapshots may not exist
      }

      gbpEntitySection += `\nIMPORTANT: Use these values verbatim in the Organization schema @graph. These are the canonical NAP values — do not derive name/address/phone from client_profiles if these values exist. Consistency between schema and GBP listing is required for entity disambiguation.\n`;
    }
  } catch {
    // GBP snapshot may not exist
  }

  // 14. Sibling content coverage (avoid duplication)
  let siblingCoverageSection = '';
  const siblingsWithBriefs = siblings.filter(
    (s) => s.content_outline_markdown && s.status !== 'not_started'
  );
  if (siblingsWithBriefs.length > 0) {
    siblingCoverageSection = `## Sibling Content Coverage (existing briefs — avoid duplication)\n`;
    siblingCoverageSection += `These sibling pages already have content briefs. Do not duplicate their coverage.\n\n`;
    for (const sib of siblingsWithBriefs) {
      const h2s = (sib.content_outline_markdown ?? '')
        .split('\n')
        .filter((line: string) => line.startsWith('## '))
        .map((line: string) => line.replace('## ', '').trim())
        .filter((h: string) => !h.toLowerCase().includes('outline') && !h.toLowerCase().includes('brief'))
        .slice(0, 6);
      if (h2s.length > 0) {
        siblingCoverageSection += `**/${sib.url_slug}** (${(sib.page_brief as any)?.role ?? 'unknown'}):\n`;
        siblingCoverageSection += h2s.map((h: string) => `  - ${h}`).join('\n') + '\n\n';
      }
    }
    siblingCoverageSection += `This page's outline must cover DIFFERENT angles from the above. Note explicitly in the outline which topics you are NOT covering because a sibling already covers them, and where to cross-link instead.\n`;
  }

  // 15. Performance context (OPTIMIZE mode only)
  let performanceContextSection = '';
  const actionType = req.action_type || 'create';
  if (actionType === 'optimize' && canonicalKey) {
    try {
      const { data: pagePerf } = await sb
        .from('page_performance')
        .select('current_avg_position, pre_publish_avg_position, keywords_gained_p1_10, keywords_total, published_at')
        .eq('audit_id', req.audit_id)
        .eq('url_slug', normalizedSlug)
        .order('snapshot_date', { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: rankingData } = await sb
        .from('ranking_snapshots')
        .select('keyword, position, search_volume, snapshot_date')
        .eq('audit_id', req.audit_id)
        .eq('canonical_key', canonicalKey)
        .order('snapshot_date', { ascending: false })
        .limit(30);

      if (pagePerf || (rankingData && rankingData.length > 0)) {
        performanceContextSection = `## Page Performance Context (OPTIMIZE — use to calibrate change scope)\n`;
        if (pagePerf) {
          const pp = pagePerf as any;
          performanceContextSection += `- Current avg position: ${pp.current_avg_position ?? 'unknown'}\n`;
          performanceContextSection += `- Pre-publish avg position: ${pp.pre_publish_avg_position ?? 'unknown'}\n`;
          performanceContextSection += `- Keywords in P1-10: ${pp.keywords_gained_p1_10 ?? 0} of ${pp.keywords_total ?? 0}\n`;
        }
        if (rankingData && rankingData.length > 0) {
          const strikingDistance = rankingData.filter((r: any) => r.position >= 11 && r.position <= 30);
          if (strikingDistance.length > 0) {
            performanceContextSection += `### Striking Distance Keywords (positions 11-30 — highest optimization priority)\n`;
            performanceContextSection += `| Keyword | Position | Volume |\n|---------|----------|--------|\n`;
            for (const kw of strikingDistance.slice(0, 10)) {
              performanceContextSection += `| ${(kw as any).keyword} | ${(kw as any).position} | ${(kw as any).search_volume} |\n`;
            }
          }
        }
        performanceContextSection += `\nIMPORTANT: The change specification for this OPTIMIZE page must prioritize striking distance keywords above all other changes. Content changes that do not address these specific ranking opportunities are lower priority.\n`;
      }

      // GSC first-party data for this page (if available)
      try {
        const { data: gscSnap } = await (sb as any)
          .from('gsc_page_snapshots')
          .select('clicks, impressions, ctr, avg_position, top_queries, snapshot_date')
          .eq('audit_id', req.audit_id)
          .eq('page_url', `/${normalizedSlug}`)
          .order('snapshot_date', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (gscSnap) {
          performanceContextSection += `\n### GSC First-Party Data (${(gscSnap as any).snapshot_date})\n`;
          performanceContextSection += `- Clicks: ${(gscSnap as any).clicks}\n`;
          performanceContextSection += `- Impressions: ${(gscSnap as any).impressions}\n`;
          performanceContextSection += `- CTR: ${((gscSnap as any).ctr * 100).toFixed(2)}%\n`;
          performanceContextSection += `- Avg Position: ${(gscSnap as any).avg_position}\n`;
          const topQueries = (gscSnap as any).top_queries ?? [];
          if (topQueries.length > 0) {
            performanceContextSection += `\n#### Top Queries for This Page\n`;
            performanceContextSection += `| Query | Clicks | Impressions | CTR | Position |\n|---|---|---|---|---|\n`;
            for (const q of topQueries) {
              performanceContextSection += `| ${q.query} | ${q.clicks} | ${q.impressions} | ${(q.ctr * 100).toFixed(2)}% | ${q.position?.toFixed(1) ?? '-'} |\n`;
            }
          }
          // Flag zero-click queries as table stakes
          const zeroClickQueries = topQueries.filter((q: any) => q.impressions >= 10 && q.clicks === 0);
          if (zeroClickQueries.length > 0) {
            performanceContextSection += `\n**[TABLE STAKES]** These queries have impressions but zero clicks — title/meta optimization targets:\n`;
            for (const q of zeroClickQueries) {
              performanceContextSection += `- "${q.query}" (${q.impressions} impressions, pos ${q.position?.toFixed(1) ?? '-'})\n`;
            }
          }
        }
      } catch {
        // GSC data is optional enrichment
      }
    } catch {
      // Performance data is optional enrichment
    }
  }

  // 16. Cluster strategy AI optimization targets
  let clusterAiTargets: any[] = [];
  if (canonicalKey) {
    try {
      const { data: strategyRow2 } = await (sb as any)
        .from('cluster_strategy')
        .select('ai_optimization_targets')
        .eq('audit_id', req.audit_id)
        .eq('canonical_key', canonicalKey)
        .eq('status', 'active')
        .maybeSingle();
      const targets = (strategyRow2 as any)?.ai_optimization_targets ?? [];
      if (Array.isArray(targets) && targets.length > 0) {
        const slug = req.page_url.replace(/^\/+/, '');
        clusterAiTargets = targets.filter(
          (t: any) => !t.applies_to_page || t.applies_to_page === `/${slug}` || t.applies_to_page === null
        );
      }
    } catch {
      // Column may not exist yet
    }
  }

  return { auditMeta, brief, keywords, siblings, blueprintExcerpt, siloName, serpEnrichment, clientProfile, authorityGaps, formatGaps, aiCitationGaps, marketContext, strategyContext, primaryEntityType, entityMap, searchIntent, buyerStage, strategyRationale, canonicalKey, technicalBaselineSection, gbpEntitySection, siblingCoverageSection, performanceContextSection, clusterAiTargets };
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
  const { auditMeta, brief, keywords, siblings, blueprintExcerpt, siloName, clientProfile, authorityGaps, formatGaps, aiCitationGaps, marketContext, strategyContext, primaryEntityType, entityMap, searchIntent, buyerStage, strategyRationale, technicalBaselineSection, gbpEntitySection, siblingCoverageSection, performanceContextSection, clusterAiTargets } = ctx;
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

  const domain = auditMeta.domain;
  const service_key = auditMeta.service_key;
  const market_city = auditMeta.market_city;
  const market_state = auditMeta.market_state;

  // Build AI citation gaps section
  let aiCitationGapsSection = '';
  if (aiCitationGaps.length > 0) {
    aiCitationGapsSection = `## AI Citation Gaps (from Gap Analysis)\n`;
    aiCitationGapsSection += `These gaps represent topics where competitors are cited in AI answers and this domain is not.\n\n`;
    aiCitationGapsSection += `| Topic | Gap Severity | Client Mentions | Competitor Mentions | Recommended Action |\n`;
    aiCitationGapsSection += `|-------|-------------|-----------------|--------------------|-----------------|\n`;
    for (const gap of aiCitationGaps) {
      aiCitationGapsSection += `| ${gap.topic} | ${gap.gap_severity} | ${gap.client_mentions ?? 0} | ${gap.competitor_mentions ?? 0} | ${gap.recommended_action ?? ''} |\n`;
    }
    aiCitationGapsSection += `\nFor sections addressing these topics, label them [AI CITATION GAP] in the Required Content Coverage section of the outline. Oscar will apply direct-answer structure to these sections.\n`;
  }

  // Build cluster AI targets section
  let clusterAiTargetsSection = '';
  if (clusterAiTargets.length > 0) {
    clusterAiTargetsSection = `## Cluster AI Optimization Targets (from Cluster Strategy — Opus)\n`;
    clusterAiTargetsSection += `These targets were identified by the Cluster Strategy agent. Use them as the basis for the Agentic and Voice Search Targets section of this brief.\n\n`;
    for (const target of clusterAiTargets) {
      clusterAiTargetsSection += `**Query:** ${target.query}\n`;
      clusterAiTargetsSection += `- Type: ${target.target_type}\n`;
      clusterAiTargetsSection += `- Pattern: ${target.structural_pattern}\n`;
      clusterAiTargetsSection += `- Condition: ${target.condition}\n`;
      clusterAiTargetsSection += `- Rationale: ${target.rationale}\n\n`;
    }
  }

  return `You are Pam, The Synthesizer — a content engineering agent for Forge Growth.

Your job is strategic content engineering. You are not producing a document template — you are making decisions about what this page needs to be, who it serves, how it builds topical authority, and what Oscar needs to know to write content that is genuinely useful to the reader and correctly optimized by construction.

## Action Type: ${actionType === 'create' ? 'CREATE — brand new page' : 'OPTIMIZE — existing page'}

${performanceContextSection}
## Page Identity
- Domain: ${domain}
- URL: /${slug}
- Silo: ${siloName ?? 'Unknown'}
- Role: ${pageRole}
- Service category: ${service_key}
- Primary Entity Type: ${primaryEntityType} (schema.org type — use for @type in JSON-LD)
- Market: ${market_city}, ${market_state}

${buyerStage ? `## Buyer Journey Context
- Buyer Stage Target: ${buyerStage}
- Source: Cluster strategy recommendation (not original architecture)
${strategyRationale ? `- Strategic Rationale: ${strategyRationale}` : ''}
IMPORTANT: This page was added to address a gap in the ${buyerStage} stage of the buyer journey.
The content brief must directly address the questions buyers have at this stage, not just target
the primary keyword. The page should guide the reader toward the next stage in their journey.` : ''}
## Target Keywords
${keywordTable}

## Sibling Pages in This Silo
${siblingsTable}

${siblingCoverageSection}
${strategyContext ? `## Strategy Brief (Phase 1b)\n${strategyContext}\n` : ''}
${marketContext ? `## Market Context\n${marketContext}\n` : ''}
## Architecture Blueprint Context
${blueprintExcerpt || 'No architecture blueprint available.'}

${technicalBaselineSection}
${buildContentGapSection(authorityGaps, formatGaps)}

${aiCitationGapsSection}
${entityMap ? `## Entity Map (from Cluster Strategy) — BINDING ENTITY CONTRACT\n${JSON.stringify(entityMap, null, 2)}\n\nThis entity_map is generated by Opus with full cluster context and is the authoritative entity model for every page in this cluster. Rules:\n- entity_map.entity_type is BINDING. Use it verbatim as the @type of the primary entity node in your schema @graph. Do NOT substitute a more specific type. Do NOT substitute a more general type. Do NOT second-guess the entity_map.\n- entity_map.key_attributes must appear as properties on the primary entity wherever the corresponding data is available.\n- The pillar page establishes the primary entity. Supporting pages reference it via sameAs or isRelatedTo where appropriate.\n- If the "Specificity" rule in the schema section below appears to recommend a different @type, the entity_map wins. The specificity rule is a fallback for pages without a cluster strategy — it does not apply here.\n` : ''}
${searchIntent ? `## Content Intent Guidance (from Cluster Strategy)
Cluster dominant intent: **${searchIntent}**
${searchIntent === 'commercial' ? '- Service page structure — lead with value proposition, features, social proof, CTA. Authoritative and confident tone.' : ''}${searchIntent === 'informational' ? '- Educational guide structure — lead with comprehensive answer, use progressive detail. Thorough and educational tone.' : ''}${searchIntent === 'transactional' ? '- Conversion-focused structure — lead with offer, pricing/comparison, trust signals, CTA. Direct and action-oriented tone.' : ''}${searchIntent === 'navigational' ? '- Brand-anchored structure — ensure brand entity consistency, direct paths to key resources.' : ''}${searchIntent === 'mixed' ? '- Balance educational depth with conversion elements. Match section structure to the dominant intent of each section.' : ''}
` : ''}
${buildSerpSection(ctx.serpEnrichment)}

${buildClientProfileSection(clientProfile)}

${gbpEntitySection}
---

## Output Format

Produce exactly three sentinel-delimited sections. The sentinel markers are parsed programmatically — they must appear exactly as shown.

---METADATA_START---

**Primary Keyword:** [the single keyword this page targets as its primary ranking signal]
**Intent:** commercial | transactional | informational
**Buyer Journey Stage:** awareness | consideration | decision | retention

**Meta Title:** [≤60 chars — primary keyword near front, brand at end if space permits]
Rationale: [one sentence — why this title serves both the user and the ranking goal]

**Meta Description:** [≤155 chars — expands on title, includes a secondary keyword or geo modifier, ends with implicit or explicit CTA]
Rationale: [one sentence]

**H1:** [matches or closely mirrors meta title intent — this is what the user reads first, not a keyword insertion exercise]
Rationale: [one sentence]

**Keyword-to-Element Mapping:**
| Keyword | Target Element | Notes |
|---------|---------------|-------|

**Implementation Notes:** [anything Oscar or a human editor needs to know before writing — e.g., OPTIMIZE: do not rewrite hero section, update FAQ block only; or CREATE: this is a pillar page, tone is authoritative, conversion-focused]

---METADATA_END---

---SCHEMA_START---

[Complete JSON-LD @graph. This schema is infrastructure — it contributes to the site's entity graph, not just individual page rich results.

ENTITY GRAPH PHILOSOPHY: Every page's schema should tell a coherent machine-readable story: this Organization, operating in this location, offers this Service, described on this WebPage. The @graph on each page extends the site-wide entity model — it does not start from scratch.

REQUIRED ENTITIES (all pages):
- Organization: consistent @id (https://${domain}/#organization), name, url, telephone, address — use [PLACEHOLDER: field] for any unknown values, never omit required fields
- WebPage: @id (https://${domain}/${slug}/#webpage), @type based on intent (ServicePage for commercial/transactional, Article for informational), name, url, isPartOf pointing to WebSite @id

CONDITIONAL ENTITIES (add when appropriate):
- Service: when the page targets a specific service — include name (must match canonical cluster topic), provider pointing to Organization @id, areaServed
- FAQPage: when the page includes Q&A content — include Question/Answer pairs that match the FAQ section in the outline exactly. This is an opportunity surface (featured snippets, PAA, AI Overviews), not the primary schema goal.
- HowTo: when the page includes sequential instructional content
- BreadcrumbList: on all non-homepage pages — reinforces site hierarchy for machine readers

@id IRI PATTERN (use consistently across all pages for this domain):
- Organization: https://${domain}/#organization
- WebSite: https://${domain}/#website
- WebPage: https://${domain}/${slug}/#webpage
- Service: https://${domain}/${slug}/#service

ENTITY AUTHORITY REQUIREMENTS:
- If GBP Canonical Entity data is provided above, use those values verbatim for Organization name, address, and telephone. Do not substitute values from client_profiles if GBP data exists — GBP is the authoritative external identifier.
- sameAs: Include on the Organization entity. Add all known external identifiers: Google Business Profile URL, LinkedIn company URL, state licensing or accreditation registry URL if applicable. If the GBP Canonical Entity section above includes a "GBP URL" value, use it directly as the first sameAs entry — do not placeholder it. Use [PLACEHOLDER: sameAs_linkedin], [PLACEHOLDER: sameAs_accreditation] for identifiers not provided above. Do not omit the sameAs property — placeholder unknown values rather than omitting them.
- Specificity (FALLBACK — only when no Entity Map is provided in the context above): Use the most specific Schema.org @type available. For vocational training programs, prefer EducationalOccupationalProgram over Service. For content pages about a program, prefer Course over Article. Generic types (Service, Article) are last resort. When an Entity Map IS provided, entity_map.entity_type is binding and overrides this rule — do not apply specificity reasoning to override a provided entity_map.
- Property saturation: Beyond @type, use relationship properties where they apply: teaches, occupationalCredentialAwarded, programPrerequisites for educational programs; hasPart, about, mentions for content pages; aggregateRating nested within the primary entity (never standalone).
- Agentic callability: On transactional and commercial pages, include a potentialAction on the primary Service or EducationalOccupationalProgram entity:
  { "@type": "ReserveAction", "target": "[PLACEHOLDER: enrollment_or_contact_url]" }
  or
  { "@type": "ScheduleAction", "target": "[PLACEHOLDER: scheduling_url]" }
  Use [PLACEHOLDER: action_target_url] if the URL is not known. Do not omit — this is the schema layer that makes the entity callable by AI agents.

PLACEHOLDER PROTOCOL: Use [PLACEHOLDER: field_name] for any unknown client data. Do not fabricate values. Do not omit fields — placeholder them so human editors know what requires completion.]

---SCHEMA_END---

---OUTLINE_START---

[Strategic content brief for Oscar. This is direction, not a script. Oscar has craft and judgment — give him what he needs to make good decisions, not a line-by-line prescription.

**Page Purpose:**
One paragraph. What is this page for? Who is reading it, at what stage of the buyer journey, and what do they need to leave with? How does this page build topical authority for the ${siloName ?? 'Unknown'} cluster?

**Content Strategy:**
- Primary angle: what makes this page's treatment of the topic distinct from generic competitor coverage
- Tone: derived from intent — commercial pages are confident and authoritative, transactional pages are direct and conversion-focused, informational pages are thorough and educational
- Depth signal: cover the topic completely for the user's intent — a transactional page should be concise and conversion-focused, an informational page should be comprehensive. Let intent drive length, not a word count target.

**Required Content Coverage:**
What this page must address to fully serve user intent and compete for the target keyword. List the topics, questions, and angles that must be covered — not the sections and their word counts. Oscar decides structure; Pam decides what must be in it.

Include:
- Core service/topic coverage (what the user came to understand or do)
- Trust and proof signals relevant to this business and market (license, insurance, years, certifications, reviews — whatever applies)
- PAA and query fan-out coverage: list the questions from SERP enrichment this page should answer. Mark each as:
  [TABLE STAKES] — must answer, competitors all cover this
  [OPPORTUNITY] — answer with a clear extractable response for AI Overview / featured snippet capture
  [DEPTH SIGNAL] — address if space permits, signals topical completeness
  [AI CITATION GAP] — this topic has a documented AI citation gap (from the AI Citation Gaps section above); answer with a direct, attributable, verifiable response. Oscar will apply direct-answer structure to these sections.
  [TIME-SENSITIVE] — the answer changes periodically (regulatory, scheduling, cost, exam format). Flag for Oscar to add a \`[PLACEHOLDER: last verified date]\` note. These are high-value citation targets but decay without maintenance signals.
- Geo and local signals: how this page establishes local relevance for ${market_city}, ${market_state}

${clusterAiTargetsSection}
**Agentic and Voice Search Targets:**
If Cluster Strategy AI targets are provided above (from the entity map / cluster strategy), use those as the basis. Otherwise derive from the SERP enrichment data.

For each target (2–3 per page):
- The query
- Target type: ai_overview | featured_snippet | voice | paa
- Structural pattern — choose the CORRECT pattern for this specific query's intent:
  - direct_answer: question-intent queries with a single clear answer; the section H2 is the question and the first sentence of the body paragraph is a complete answer
  - list: comparative or enumerative intent (how many, what are the steps, what does it include); 3–7 substantive items
  - table: comparative/spec intent (cost comparison, program options, scheduling matrix)
  - prose_elaboration: explanatory intent requiring context before answer; do NOT force a direct-answer opening
- The condition under which the pattern applies (why this query warrants this structure)

IMPORTANT: These structural patterns are conditional, not universal. A page that applies direct_answer to every section has no narrative flow and performs poorly for users. Oscar uses these targets to apply structure where intent warrants it — not as a mandate to restructure the entire page.

**Internal Linking:**
| Link To | Anchor Text | Placement Context | Direction |
|---------|-------------|------------------|-----------|
Direction: outbound (this page links out) or inbound (sibling should link here — flag for human).
Pillar pages receive links from clusters. Cluster pages link up to pillar. Support pages link to both.
Use descriptive, contextual anchor text — not "click here" or "learn more."

**Cluster Expansion Opportunities:**
Based on the keyword data, PAA questions, and gap analysis, identify 1–3 adjacent topic pages that would strengthen this cluster if they don't already exist in the architecture. Format as:
| Suggested Page | Target Keyword | Buyer Stage | Rationale |
These are recommendations for Michael and the content queue — not part of this page's brief.

${actionType === 'optimize' ? `**OPTIMIZE MODE — Change Specification:**
This is an existing page. Do not produce a full content brief. Produce a change specification:
For each content area: KEEP (no change needed and why), UPDATE (what to change, why, and what the updated version should accomplish), ADD (new content to insert — describe what and why), or REMOVE (what to cut and why).
Only provide full content direction for ADD items.` : ''}]

---OUTLINE_END---

## Quality Standards
1. Metadata rationale must justify each element in terms of both user intent and ranking signal — not just describe what it says
2. Schema must be a coherent @graph contribution — consistent @id IRIs, correct @type for page intent, all required entities present with placeholders for unknown values
3. FAQPage and HowTo schema are opportunities to be added when content warrants them — not required on every page
4. Required content coverage must address PAA questions with explicit [TABLE STAKES] / [OPPORTUNITY] / [DEPTH SIGNAL] / [AI CITATION GAP] / [TIME-SENSITIVE] classification
5. Internal linking map must specify direction and placement context — not just destination URLs
6. Cluster expansion opportunities are mandatory — minimum 1 suggestion per brief
7. For OPTIMIZE pages: change specification only, not a full rewrite brief
8. The brief should give Oscar strategic direction and content requirements — not prescribe structure or word counts
`;
}

// ============================================================
// Schema type drift detection
// ============================================================

/**
 * Walks a parsed JSON-LD schema and collects all @type values from every node
 * in the @graph. Handles both string and array @type values.
 */
function collectSchemaTypes(schemaJson: any): string[] {
  if (!schemaJson || typeof schemaJson !== 'object') return [];
  const types: string[] = [];
  const graph = Array.isArray(schemaJson['@graph']) ? schemaJson['@graph'] : [schemaJson];
  for (const node of graph) {
    if (!node || typeof node !== 'object') continue;
    const t = node['@type'];
    if (typeof t === 'string') types.push(t);
    else if (Array.isArray(t)) types.push(...t.filter((x) => typeof x === 'string'));
  }
  return types;
}

/**
 * Returns null if no drift (expected type found in schema), or a drift record
 * describing the mismatch. Used to log to agent_runs for dashboard surfacing.
 */
function detectSchemaTypeDrift(
  schemaJson: any,
  expectedType: string | undefined | null,
): { expected: string; actual: string[] } | null {
  if (!expectedType || typeof expectedType !== 'string') return null;
  const actual = collectSchemaTypes(schemaJson);
  if (actual.includes(expectedType)) return null;
  return { expected: expectedType, actual };
}

// ============================================================
// Output parsing & file writing
// ============================================================

function parseOutput(output: string) {
  const metadataMatch = output.match(/---METADATA_START---\n([\s\S]*?)\n---METADATA_END---/);
  const schemaMatch = output.match(/---SCHEMA_START---\n([\s\S]*?)\n---SCHEMA_END---/);
  const outlineMatch = output.match(/---OUTLINE_START---\n([\s\S]*?)\n---OUTLINE_END---/);

  const missingSections: string[] = [];
  if (!metadataMatch) missingSections.push('METADATA');
  if (!schemaMatch) missingSections.push('SCHEMA');
  if (!outlineMatch) missingSections.push('OUTLINE');
  if (missingSections.length > 0) {
    throw new Error(`Missing sentinel-delimited sections in Claude output: ${missingSections.join(', ')}. Output starts with: ${output.slice(0, 200)}`);
  }

  const metadataMd = metadataMatch[1].trim();
  const schemaRaw = schemaMatch[1].trim();
  const outlineMd = outlineMatch[1].trim();

  // Validate sections are non-empty
  const emptySections: string[] = [];
  if (metadataMd.length < 20) emptySections.push(`METADATA (${metadataMd.length} chars)`);
  if (schemaRaw.length < 20) emptySections.push(`SCHEMA (${schemaRaw.length} chars)`);
  if (outlineMd.length < 50) emptySections.push(`OUTLINE (${outlineMd.length} chars)`);
  if (emptySections.length > 0) {
    throw new Error(`Brief sections too short or empty: ${emptySections.join(', ')}`);
  }

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
  const h1 = extractMetadataField(parsed.metadataMd, 'H1 Tag') ?? extractMetadataField(parsed.metadataMd, 'H1');
  const intent = extractMetadataField(parsed.metadataMd, 'Intent Classification') ?? extractMetadataField(parsed.metadataMd, 'Intent');
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
    .eq('url_slug', normalizedSlug)
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

    // 3. Call Claude — Opus for pillar pages (strategic depth), Sonnet for all others
    const pageRole = req.page_role ?? ctx.brief?.role ?? 'service page';
    const pamModel = pageRole === 'pillar' ? 'opus' : 'sonnet';
    console.log(`  Running Pam via Anthropic API (${pamModel}, role: ${pageRole})...`);
    const result = await callClaudeAsync(prompt, { model: pamModel, phase: 'pam' });

    // Save raw output for debugging
    const debugFile = path.join(AUDITS_BASE, req.domain, 'content', '_debug', `${slug}-raw.md`);
    fs.mkdirSync(path.dirname(debugFile), { recursive: true });
    fs.writeFileSync(debugFile, result, 'utf-8');
    console.log(`  Raw output: ${result.length} chars`);

    // 4. Parse output
    const parsed = parseOutput(result);

    // 4a. Schema type drift check — if the prompt was given an entity_map,
    // assert that the produced schema includes the specified @type.
    // Drift is non-fatal: the brief still ships, but we log to agent_runs
    // so the dashboard can surface "schema drift detected" as an actionable signal.
    const expectedEntityType = ctx.entityMap?.entity_type;
    const drift = detectSchemaTypeDrift(parsed.schemaJson, expectedEntityType);
    if (drift) {
      console.warn(
        `  SCHEMA DRIFT: entity_map specified "${drift.expected}" but schema @types are [${drift.actual.join(', ')}]`,
      );
      try {
        await (sb as any).from('agent_runs').insert({
          audit_id: req.audit_id,
          agent_name: 'pam-schema-drift',
          run_date: new Date().toISOString().slice(0, 10),
          status: 'completed',
          metadata: {
            warning: 'schema_type_drift',
            url_slug: slug,
            canonical_key: ctx.canonicalKey ?? null,
            expected_type: drift.expected,
            actual_types: drift.actual,
            pam_request_id: req.id,
          },
        });
      } catch (logErr: any) {
        console.warn(`  Failed to log schema drift to agent_runs: ${logErr?.message ?? logErr}`);
      }
    }

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
