/**
 * classify-keywords.ts — Lightweight classification extraction path
 *
 * Session B (2026-04-21): Replaces legacy Sonnet's group-level classification
 * with per-keyword classification via deterministic rules + Haiku batching.
 *
 * Fields extracted: is_brand, intent_type, primary_entity_type, intent (backfill), is_near_me
 * Also writes: canonicalize_mode on every keyword processed.
 *
 * Cost: ~$0.02-0.03 per 1000 keywords vs ~$0.30-0.50 for legacy Sonnet.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface KeywordRow {
  id: string;
  keyword: string;
  search_volume: number | null;
  topic: string | null;
}

export interface ClassificationResult {
  is_brand: boolean;
  intent_type: string;
  primary_entity_type: string;
  is_near_me: boolean;
}

interface ClassifyOptions {
  auditId: string;
  domain: string;
  serviceKey: string;
  canonicalizeMode: string;
  clientBusinessName?: string;
  competitorNames?: string[];
  verticalDefault?: string;
  coreServices?: string[];
}

// Injected callClaude — same pattern as hybrid/arbitrator.ts
type CallClaudeFn = (prompt: string, options: { model: string; phase: string }) => Promise<string>;
let _callClaude: CallClaudeFn | null = null;
export function _setClassifyCallClaude(fn: CallClaudeFn): void {
  _callClaude = fn;
}

/**
 * Classify all keywords for an audit using deterministic rules + Haiku.
 * Returns the count of keywords classified.
 */
export async function classifyKeywords(
  sb: SupabaseClient,
  keywords: KeywordRow[],
  opts: ClassifyOptions,
): Promise<{ classified: number; haikuCalls: number }> {
  if (!_callClaude) throw new Error('classifyKeywords: callClaude not injected. Call _setClassifyCallClaude first.');
  if (keywords.length === 0) return { classified: 0, haikuCalls: 0 };

  console.log(`  [classify] Starting classification for ${keywords.length} keywords (mode: ${opts.canonicalizeMode})`);

  // ── Step 1: Deterministic is_near_me ──────────────────────────
  const nearMeSet = new Set<string>();
  for (const kw of keywords) {
    if (kw.keyword.toLowerCase().includes(' near me')) {
      nearMeSet.add(kw.id);
    }
  }
  if (nearMeSet.size > 0) {
    console.log(`  [classify] ${nearMeSet.size} near-me keywords detected deterministically`);
  }

  // ── Step 2: Deterministic is_brand (partial) ──────────────────
  const brandNames = buildBrandPatterns(opts.domain, opts.clientBusinessName, opts.competitorNames);
  const deterministicBrand = new Map<string, boolean>();
  for (const kw of keywords) {
    const lower = kw.keyword.toLowerCase();
    const matched = brandNames.some((bn) => lower.includes(bn));
    if (matched) {
      deterministicBrand.set(kw.id, true);
    }
  }
  if (deterministicBrand.size > 0) {
    console.log(`  [classify] ${deterministicBrand.size} brand keywords detected deterministically`);
  }

  // ── Step 3: Haiku batch for intent_type, primary_entity_type, + unresolved is_brand ───
  // All keywords need intent_type and primary_entity_type from Haiku
  // (deterministic entity_type rules too fragile — vertical detection unreliable)
  const verticalDefault = opts.verticalDefault || 'Service';
  const HAIKU_BATCH_SIZE = 100;
  let haikuCalls = 0;
  const haikuResults = new Map<string, { intent_type: string; is_brand?: boolean; primary_entity_type?: string }>();

  for (let i = 0; i < keywords.length; i += HAIKU_BATCH_SIZE) {
    const batch = keywords.slice(i, i + HAIKU_BATCH_SIZE);
    const batchNum = Math.floor(i / HAIKU_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(keywords.length / HAIKU_BATCH_SIZE);

    if (totalBatches > 1) {
      console.log(`  [classify] Haiku batch ${batchNum}/${totalBatches} (${batch.length} keywords)`);
    }

    const kwList = batch
      .map((kw, idx) => {
        const needsBrand = !deterministicBrand.has(kw.id);
        return `${idx + 1}. "${kw.keyword}"${needsBrand ? ' [classify_brand]' : ''}`;
      })
      .join('\n');

    const prompt = `You are an SEO keyword classifier. Classify each keyword below.

For EVERY keyword, provide:
- intent_type: exactly one of "informational", "commercial", "transactional", "navigational"
- primary_entity_type: exactly one of "Service", "Course", "Product", "LocalBusiness", "FAQPage", "Article"

For keywords marked [classify_brand], ALSO provide:
- is_brand: true if the keyword contains a brand/company name, false otherwise

Intent definitions:
- "informational": seeking knowledge (what is, how to, why, guide, tips, facts, benefits)
- "commercial": researching/comparing options ("best", "vs", "review", "[service] [city]", evaluating providers)
- "transactional": ready to act NOW (buy, enroll, sign up, book, schedule, hire, "near me", get quote)
- "navigational": looking for a specific website/brand BY NAME

primary_entity_type definitions:
- "Service": a service the business performs (most common for local service businesses)
- "Course": an educational program with defined duration, credential, enrollment
- "Product": a physical or digital product
- "LocalBusiness": the business itself (use only for brand/homepage cluster)
- "FAQPage": primarily Q&A content with no single service anchor
- "Article": purely informational content not tied to a specific service or course

When uncertain between Service and Course: if the offering grants a credential or certification, use Course. If it's a job performed for a customer, use Service.
${opts.coreServices && opts.coreServices.length > 0 ? `\nWhen a keyword matches or closely relates to one of the business's listed services/programs, prefer Service (or Course for educational/training programs) over Article.\n` : ''}
Business context: ${opts.serviceKey || 'local service'} business, domain: ${opts.domain}${opts.coreServices && opts.coreServices.length > 0 ? `\nThis business specifically offers: ${opts.coreServices.join(', ')}` : ''}

KEYWORDS:
${kwList}

Respond with raw JSON only. No markdown fences. Array of objects:
[{"index": 1, "intent_type": "commercial", "primary_entity_type": "Course", "is_brand": false}, ...]
Only include is_brand for keywords marked [classify_brand]. Always include intent_type and primary_entity_type.`;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await _callClaude(prompt, { model: 'haiku', phase: 'classify' });
        haikuCalls++;
        const stripped = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const parsed = JSON.parse(stripped);
        const items = Array.isArray(parsed) ? parsed : parsed.keywords || parsed.results || [];

        for (const item of items) {
          const idx = (item.index ?? item.i) - 1;
          if (idx >= 0 && idx < batch.length) {
            haikuResults.set(batch[idx].id, {
              intent_type: normalizeIntent(item.intent_type),
              is_brand: item.is_brand,
              primary_entity_type: item.primary_entity_type,
            });
          }
        }
        break;
      } catch (err: any) {
        if (attempt === 1) {
          console.warn(`  [classify] Haiku batch ${batchNum} attempt 1 failed: ${err.message} — retrying`);
        } else {
          console.error(`  [classify] Haiku batch ${batchNum} attempt 2 failed: ${err.message} — using deterministic fallbacks`);
        }
      }
    }
  }

  // ── Step 5: Merge results and write to DB ─────────────────────
  let classified = 0;
  const DB_BATCH_SIZE = 50;

  for (let i = 0; i < keywords.length; i += DB_BATCH_SIZE) {
    const chunk = keywords.slice(i, i + DB_BATCH_SIZE);
    const promises = chunk.map((kw) => {
      const haiku = haikuResults.get(kw.id);
      const intentType = haiku?.intent_type || 'unknown';
      const isBrand = deterministicBrand.has(kw.id) ? true : (haiku?.is_brand ?? false);
      const isNearMe = nearMeSet.has(kw.id);
      const primaryEntityType = normalizeEntityType(haiku?.primary_entity_type) || verticalDefault;

      const payload: Record<string, unknown> = {
        is_brand: isBrand,
        intent_type: intentType,
        intent: intentType, // backward compat (addendum correction #4)
        is_near_me: isNearMe,
        primary_entity_type: primaryEntityType,
        canonicalize_mode: opts.canonicalizeMode,
      };

      return (sb as any).from('audit_keywords').update(payload).eq('id', kw.id);
    });

    const results = await Promise.all(promises);
    for (const r of results) {
      if (r.error) console.warn(`  [classify] Update failed: ${r.error.message}`);
      else classified++;
    }
  }

  console.log(`  [classify] Classified ${classified}/${keywords.length} keywords (${haikuCalls} Haiku calls, ${deterministicBrand.size} deterministic brand matches, ${nearMeSet.size} near-me)`);
  return { classified, haikuCalls };
}

// ── Helpers ─────────────────────────────────────────────────────

function buildBrandPatterns(domain: string, businessName?: string, competitors?: string[]): string[] {
  const patterns: string[] = [];
  // Extract business name from domain
  const domainBase = domain.replace(/\.(com|org|net|ai|io|co)$/i, '').replace(/[-_]/g, ' ').toLowerCase();
  if (domainBase.length >= 3) patterns.push(domainBase);
  // Explicit business name
  if (businessName) patterns.push(businessName.toLowerCase());
  // Competitor names
  if (competitors) {
    for (const c of competitors) {
      if (c.length >= 3) patterns.push(c.toLowerCase());
    }
  }
  return patterns;
}

const VALID_ENTITY_TYPES = ['Service', 'Course', 'Product', 'LocalBusiness', 'FAQPage', 'Article'];

function normalizeEntityType(raw: string | undefined): string | null {
  if (!raw) return null;
  // Case-insensitive match against valid types
  const match = VALID_ENTITY_TYPES.find((t) => t.toLowerCase() === raw.toLowerCase());
  return match || null;
}

function normalizeIntent(raw: string | undefined): string {
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase().trim();
  if (['informational', 'commercial', 'transactional', 'navigational'].includes(lower)) return lower;
  return 'unknown';
}
