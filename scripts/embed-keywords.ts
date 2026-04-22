/**
 * embed-keywords.ts — Pre-warm the embeddings cache for audit keywords.
 *
 * Called at end of Phase 2 (keyword_research keywords) and Phase 3b (all keywords)
 * so that Phase 3c canonicalize gets near-100% cache hits.
 *
 * Non-fatal: embedding failures are logged as warnings but never halt the pipeline.
 */

import { createClient } from '@supabase/supabase-js';
import { embedBatch } from '../src/embeddings/index.js';
import type { ContentType } from '../src/embeddings/index.js';

const PAGE_SIZE = 1000;

/**
 * Fetch audit_keywords and embed them, pre-warming the embeddings table cache.
 *
 * @param sb       Supabase client (service role)
 * @param auditId  Audit UUID
 * @param source   Filter by source ('keyword_research' | 'ranked') or null for all
 * @param label    Log label for tracing (e.g. 'phase-2', 'phase-3b')
 */
export async function embedAuditKeywords(
  sb: ReturnType<typeof createClient>,
  auditId: string,
  source: string | null,
  label: string,
): Promise<void> {
  const t0 = Date.now();
  try {
    // Paginated fetch of (id, keyword) from audit_keywords
    const allRows: Array<{ id: string; keyword: string }> = [];
    let offset = 0;
    while (true) {
      let query = sb
        .from('audit_keywords')
        .select('id, keyword')
        .eq('audit_id', auditId);
      if (source) {
        query = query.eq('source', source);
      }
      const { data, error } = await query
        .range(offset, offset + PAGE_SIZE - 1)
        .order('id');
      if (error) {
        console.warn(`  [embed-keywords/${label}] Failed to fetch keywords: ${error.message}`);
        return;
      }
      if (!data || data.length === 0) break;
      allRows.push(...(data as Array<{ id: string; keyword: string }>));
      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    if (allRows.length === 0) {
      console.log(`  [embed-keywords/${label}] No keywords to embed`);
      return;
    }

    // Build embedBatch input — contentId = audit_keywords.id (matches pre-cluster.ts)
    const items = allRows.map((row) => ({
      text: row.keyword,
      contentType: 'keyword' as ContentType,
      contentId: row.id,
    }));

    const results = await embedBatch(items);

    // Count outcomes
    let cacheHits = 0;
    let openaiCalls = 0;
    let failed = 0;
    for (const r of results) {
      if (r === null) {
        failed++;
      } else if (r.fromCache) {
        cacheHits++;
      } else {
        openaiCalls++;
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `  [embed-keywords/${label}] ${allRows.length} keywords, ${cacheHits} cache hits, ${openaiCalls} OpenAI calls, ${failed} failed in ${elapsed}s`,
    );
  } catch (err: any) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.warn(
      `  [embed-keywords/${label}] Non-fatal embedding error after ${elapsed}s: ${err.message ?? err}`,
    );
  }
}
