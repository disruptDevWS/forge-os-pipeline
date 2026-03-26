/**
 * dataforseo-llm-mentions.ts — DataForSEO LLM Mentions API client
 *
 * Fetches AI platform mention data (ChatGPT, Google AI Overview) for a domain
 * and its competitors. Used by Jim (Phase 3) and the monthly LLM tracking cron.
 *
 * Auth: Basic auth from DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD.
 * Cost tracking: appends to audits/.dataforseo_cost.log.
 * Budget guard: LLM_MENTIONS_BUDGET env var (default $1.00).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const DATAFORSEO_API = 'https://api.dataforseo.com/v3';
const COST_LOG = path.resolve(process.cwd(), 'audits/.dataforseo_cost.log');

// Budget env vars:
//   LLM_DOMAIN_BUDGET     — max spend on domain mention calls (default $1.00)
//   LLM_COMPETITOR_BUDGET — max spend on competitor mention calls (default $0.50)
//   LLM_MENTIONS_BUDGET   — legacy fallback for LLM_DOMAIN_BUDGET (still honored)
const DEFAULT_DOMAIN_BUDGET = 1.0;
const DEFAULT_COMPETITOR_BUDGET = 0.5;

// ── Types ─────────────────────────────────────────────────────

export interface LlmMention {
  keyword: string;
  platform: string;
  mention_count: number;
  ai_search_volume: number;
  citation_sources: string[];
  mention_texts: string[];
}

export interface CompetitorMention {
  domain: string;
  keyword: string;
  platform: string;
  mention_count: number;
  is_estimated: boolean;
}

export interface LlmMentionsResult {
  domain_mentions: LlmMention[];
  competitor_mentions: CompetitorMention[];
  queried_keywords: string[];
  queried_competitors: string[];
  total_cost: number;
  timestamp: string;
  competitor_budget_skipped: boolean;
}

interface RankedKeywordItem {
  keyword_data?: {
    keyword?: string;
    keyword_info?: { search_volume?: number };
    keyword_properties?: { keyword_difficulty?: number };
  };
  ranked_serp_element?: {
    serp_item?: { rank_group?: number };
  };
}

// ── Auth & helpers ────────────────────────────────────────────

function makeAuthHeader(env: Record<string, string>): string {
  const login = env.DATAFORSEO_LOGIN;
  const password = env.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set');
  }
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
}

function logCost(operation: string, cost: number): void {
  const line = `${new Date().toISOString()} | llm-mentions | ${operation} | $${cost.toFixed(4)}\n`;
  try {
    fs.mkdirSync(path.dirname(COST_LOG), { recursive: true });
    fs.appendFileSync(COST_LOG, line);
  } catch {
    // Non-fatal
  }
}

function getDomainBudget(env: Record<string, string>): number {
  const val = env.LLM_DOMAIN_BUDGET ?? env.LLM_MENTIONS_BUDGET;
  if (val) {
    const parsed = parseFloat(val);
    if (!isNaN(parsed)) return parsed;
  }
  return DEFAULT_DOMAIN_BUDGET;
}

function getCompetitorBudget(env: Record<string, string>): number {
  const val = env.LLM_COMPETITOR_BUDGET;
  if (val) {
    const parsed = parseFloat(val);
    if (!isNaN(parsed)) return parsed;
  }
  return DEFAULT_COMPETITOR_BUDGET;
}

async function apiCall(
  endpoint: string,
  auth: string,
  body: any,
): Promise<any> {
  const url = `${DATAFORSEO_API}${endpoint}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`DataForSEO ${endpoint} HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

// ── Keyword & competitor selection ────────────────────────────

/**
 * Select top keywords for LLM mention queries.
 * Reads ranked_keywords.json, returns top N by volume where rank_group <= 30.
 * Excludes near-me variants and branded terms.
 */
export function selectLlmKeywords(rankedKeywordsPath: string, limit = 5): string[] {
  if (!fs.existsSync(rankedKeywordsPath)) return [];

  const data = JSON.parse(fs.readFileSync(rankedKeywordsPath, 'utf-8'));
  const items: RankedKeywordItem[] = [];
  for (const task of data?.tasks ?? []) {
    for (const result of task?.result ?? []) {
      for (const item of result?.items ?? []) {
        items.push(item);
      }
    }
  }

  return items
    .filter((item) => {
      const kw = item.keyword_data?.keyword?.toLowerCase() ?? '';
      const rank = item.ranked_serp_element?.serp_item?.rank_group ?? 100;
      if (rank > 30) return false;
      if (/near\s*me/i.test(kw)) return false;
      // Simple brand exclusion: skip if keyword looks like a domain name
      if (kw.includes('.com') || kw.includes('.org') || kw.includes('.net')) return false;
      return true;
    })
    .sort((a, b) =>
      (b.keyword_data?.keyword_info?.search_volume ?? 0) -
      (a.keyword_data?.keyword_info?.search_volume ?? 0),
    )
    .slice(0, limit)
    .map((item) => item.keyword_data?.keyword ?? '')
    .filter(Boolean);
}

/**
 * Select top competitor domains for LLM mention comparison.
 * Takes raw competitor items (already filtered of aggregators), returns top N by shared keyword count.
 */
export function selectLlmCompetitors(
  rawCompetitors: Array<{ domain?: string; intersections?: number }>,
  isAggregator: (domain: string) => boolean,
  limit = 3,
): string[] {
  return rawCompetitors
    .filter((c) => c.domain && !isAggregator(c.domain))
    .sort((a, b) => (b.intersections ?? 0) - (a.intersections ?? 0))
    .slice(0, limit)
    .map((c) => c.domain!)
    .filter(Boolean);
}

// ── AI Keyword Volume type ───────────────────────────────────

export interface AiKeywordVolume {
  keyword: string;
  ai_search_volume: number | null;
}

// ── AI Keyword Search Volume ─────────────────────────────────

/**
 * Fetch AI search volumes for a batch of keywords.
 * Uses /v3/ai_optimization/ai_keyword_data/keywords_search_volume/live
 * Non-fatal — returns empty array on failure.
 */
export async function fetchAiKeywordVolumes(
  env: Record<string, string>,
  keywords: string[],
): Promise<{ volumes: AiKeywordVolume[]; cost: number }> {
  if (keywords.length === 0) return { volumes: [], cost: 0 };

  try {
    const auth = makeAuthHeader(env);
    const payload = [
      {
        language_name: 'English',
        location_code: 2840,
        keywords,
      },
    ];

    const data = await apiCall(
      '/ai_optimization/ai_keyword_data/keywords_search_volume/live',
      auth,
      payload,
    );
    const task = data?.tasks?.[0];
    const cost = task?.cost ?? 0;
    logCost('ai_keyword_volume', cost);

    const volumes: AiKeywordVolume[] = [];
    for (const item of task?.result ?? []) {
      for (const kwItem of item?.items ?? []) {
        volumes.push({
          keyword: kwItem.keyword ?? '',
          ai_search_volume: kwItem.ai_search_volume ?? null,
        });
      }
    }

    return { volumes, cost };
  } catch (err: any) {
    console.log(`  Warning: AI keyword volume fetch failed: ${err.message}`);
    return { volumes: [], cost: 0 };
  }
}

// ── Core API functions ────────────────────────────────────────

const PLATFORMS = ['google', 'chat_gpt'] as const;

/**
 * Fetch domain mentions across AI platforms for a set of keywords.
 * Uses /v3/ai_optimization/llm_mentions/search/live
 */
export async function fetchDomainMentions(
  env: Record<string, string>,
  domain: string,
  keywords: string[],
): Promise<{ mentions: LlmMention[]; cost: number }> {
  const auth = makeAuthHeader(env);
  const budget = getDomainBudget(env);
  let totalCost = 0;
  const mentions: LlmMention[] = [];

  for (const platform of PLATFORMS) {
    if (totalCost >= budget) {
      console.log(`  LLM mentions domain budget exceeded ($${totalCost.toFixed(2)} >= $${budget.toFixed(2)}), skipping ${platform}`);
      break;
    }

    for (const keyword of keywords) {
      if (totalCost >= budget) break;

      try {
        const payload = [
          {
            target: [
              { domain, search_filter: 'include', search_scope: ['sources'], include_subdomains: true },
              { keyword, search_filter: 'include', search_scope: ['answer'] },
            ],
            platform,
            location_code: 2840,
            language_code: 'en',
            limit: 10,
          },
        ];

        const data = await apiCall('/ai_optimization/llm_mentions/search/live', auth, payload);
        const task = data?.tasks?.[0];
        const cost = task?.cost ?? 0;
        totalCost += cost;
        logCost(`search/${platform}/${keyword}`, cost);

        const resultItems = task?.result?.[0]?.items ?? [];
        const citationSources: string[] = [];
        const mentionTexts: string[] = [];
        let aiSearchVolume = 0;

        for (const item of resultItems) {
          if (item.answer) {
            mentionTexts.push(item.answer.slice(0, 500));
          }
          if (item.ai_search_volume && item.ai_search_volume > aiSearchVolume) {
            aiSearchVolume = item.ai_search_volume;
          }
          for (const src of item.sources ?? []) {
            if (src.domain && !citationSources.includes(src.domain)) {
              citationSources.push(src.domain);
            }
          }
        }

        mentions.push({
          keyword,
          platform,
          mention_count: resultItems.length,
          ai_search_volume: aiSearchVolume,
          citation_sources: citationSources,
          mention_texts: mentionTexts,
        });
      } catch (err: any) {
        console.log(`  Warning: LLM mention fetch failed for "${keyword}" on ${platform}: ${err.message}`);
        mentions.push({
          keyword,
          platform,
          mention_count: 0,
          ai_search_volume: 0,
          citation_sources: [],
          mention_texts: [],
        });
      }
    }
  }

  return { mentions, cost: totalCost };
}

/**
 * Fetch aggregated mention metrics for competitor domains.
 * Uses /v3/ai_optimization/llm_mentions/aggregated_metrics/live
 */
export async function fetchCompetitorMentions(
  env: Record<string, string>,
  competitorDomains: string[],
  keywords: string[],
): Promise<{ mentions: CompetitorMention[]; cost: number; completed_all: boolean }> {
  const auth = makeAuthHeader(env);
  const budget = getCompetitorBudget(env);
  let totalCost = 0;
  const mentions: CompetitorMention[] = [];
  let callsCompleted = 0;
  const callsExpected = competitorDomains.length * PLATFORMS.length;

  for (const platform of PLATFORMS) {
    if (totalCost >= budget) break;

    for (const competitorDomain of competitorDomains) {
      if (totalCost >= budget) break;

      try {
        const targets: any[] = [
          { domain: competitorDomain, search_filter: 'include', search_scope: ['sources'], include_subdomains: true },
        ];
        // Add all keywords as answer-scope filters
        for (const kw of keywords) {
          targets.push({ keyword: kw, search_filter: 'include', search_scope: ['answer'] });
        }

        const payload = [
          {
            target: targets.slice(0, 10), // API limit: max 10 targets
            platform,
            location_code: 2840,
            language_code: 'en',
          },
        ];

        const data = await apiCall('/ai_optimization/llm_mentions/aggregated_metrics/live', auth, payload);
        const task = data?.tasks?.[0];
        const cost = task?.cost ?? 0;
        totalCost += cost;
        logCost(`aggregated/${platform}/${competitorDomain}`, cost);

        const total = task?.result?.[0]?.total;
        const locationMetrics = total?.location?.[0];
        const mentionCount = locationMetrics?.mentions ?? 0;

        // Create per-keyword entries based on aggregate (actual per-keyword breakdown not available from aggregated endpoint)
        for (const kw of keywords) {
          mentions.push({
            domain: competitorDomain,
            keyword: kw,
            platform,
            mention_count: Math.round(mentionCount / keywords.length),
            is_estimated: true,
          });
        }
        callsCompleted++;
      } catch (err: any) {
        console.log(`  Warning: Competitor mention fetch failed for ${competitorDomain} on ${platform}: ${err.message}`);
        for (const kw of keywords) {
          mentions.push({
            domain: competitorDomain,
            keyword: kw,
            platform,
            mention_count: 0,
            is_estimated: true,
          });
        }
        callsCompleted++;
      }
    }
  }

  return { mentions, cost: totalCost, completed_all: callsCompleted === callsExpected };
}

/**
 * Full LLM mentions fetch: domain + competitors.
 * Writes llm_mentions.json to disk.
 */
export async function fetchAllLlmMentions(
  env: Record<string, string>,
  domain: string,
  keywords: string[],
  competitorDomains: string[],
  outputDir: string,
): Promise<LlmMentionsResult | null> {
  if (keywords.length === 0) {
    console.log('  No keywords for LLM mentions — skipping');
    return null;
  }

  console.log(`  Fetching LLM mentions for ${domain} (${keywords.length} keywords, ${competitorDomains.length} competitors)...`);

  const domainResult = await fetchDomainMentions(env, domain, keywords);
  let competitorResult = { mentions: [] as CompetitorMention[], cost: 0, completed_all: true };

  if (competitorDomains.length > 0) {
    competitorResult = await fetchCompetitorMentions(env, competitorDomains, keywords);
  }

  const competitorBudgetSkipped = competitorDomains.length > 0 && !competitorResult.completed_all;
  const totalCost = domainResult.cost + competitorResult.cost;
  console.log(`  LLM mentions complete: ${domainResult.mentions.length} domain mentions, ${competitorResult.mentions.length} competitor mentions ($${totalCost.toFixed(4)})`);

  const result: LlmMentionsResult = {
    domain_mentions: domainResult.mentions,
    competitor_mentions: competitorResult.mentions,
    queried_keywords: keywords,
    queried_competitors: competitorDomains,
    total_cost: totalCost,
    timestamp: new Date().toISOString(),
    competitor_budget_skipped: competitorBudgetSkipped,
  };

  // Write disk artifact
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'llm_mentions.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`  Written llm_mentions.json to ${path.relative(process.cwd(), outputDir)}/`);

  return result;
}
