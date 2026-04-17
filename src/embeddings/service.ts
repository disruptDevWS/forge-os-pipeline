import OpenAI from 'openai';
import { getSupabaseAdmin } from '../supabase.js';
import {
  ACTIVE_EMBEDDING_MODEL,
  OPENAI_MODEL_NAME,
  EMBEDDING_BATCH_SIZE,
  DEFAULT_SIMILARITY_THRESHOLD,
} from './config.js';
import { contentHash } from './hash.js';

/**
 * Parse a pgvector embedding from Supabase.
 * Supabase/PostgREST returns vector columns as strings like "[0.1,0.2,...]".
 * OpenAI returns native number arrays. This normalizes both forms.
 */
function parseVector(v: unknown): number[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return JSON.parse(v);
  throw new Error(`Unexpected vector format: ${typeof v}`);
}

let _openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

/** Reset OpenAI singleton (for testing). */
export function _resetOpenAI(): void {
  _openai = null;
}

// ── Types ─────────────────────────────────────────────────────

export type ContentType =
  | 'keyword'
  | 'page_section'
  | 'cluster_seed'
  | 'client_context';

export interface FindSimilarOptions {
  threshold?: number;
  limit?: number;
  excludeContentId?: string;
  excludeContentHash?: string;
}

export interface EmbeddingResult {
  embedding: number[];
  fromCache: boolean;
}

export interface SimilarityMatch {
  content_id: string;
  similarity: number;
  text_input: string;
}

// ── embed() ───────────────────────────────────────────────────

/**
 * Embed a single text. Checks cache via content_hash; calls OpenAI on miss.
 * Returns null on API failure (caller decides retry/fallback).
 */
export async function embed(
  text: string,
  contentType: ContentType,
  contentId: string,
): Promise<EmbeddingResult | null> {
  const hash = contentHash(text);
  const sb = getSupabaseAdmin();

  // Cache check: any row with this hash + active model version
  const { data: cached } = await sb
    .from('embeddings')
    .select('embedding')
    .eq('content_hash', hash)
    .eq('model_version', ACTIVE_EMBEDDING_MODEL)
    .limit(1)
    .single();

  if (cached?.embedding) {
    const vec = parseVector(cached.embedding);
    // Upsert the content_type/content_id mapping if this is a different entity
    // sharing the same text (e.g., same keyword in different contexts)
    await sb.from('embeddings').upsert(
      {
        content_type: contentType,
        content_id: contentId,
        content_hash: hash,
        text_input: text,
        embedding: vec,
        model_version: ACTIVE_EMBEDDING_MODEL,
      },
      { onConflict: 'content_type,content_id,model_version' },
    );
    return { embedding: vec, fromCache: true };
  }

  // API call
  let vector: number[];
  try {
    const response = await getOpenAI().embeddings.create({
      model: OPENAI_MODEL_NAME,
      input: text,
    });
    vector = response.data[0].embedding;
  } catch (err) {
    console.error('[embeddings] OpenAI API failure:', err);
    return null;
  }

  // Persist
  const { error } = await sb.from('embeddings').upsert(
    {
      content_type: contentType,
      content_id: contentId,
      content_hash: hash,
      text_input: text,
      embedding: vector,
      model_version: ACTIVE_EMBEDDING_MODEL,
    },
    { onConflict: 'content_type,content_id,model_version' },
  );

  if (error) {
    console.error('[embeddings] Persist failure:', error);
    // Still return the vector — embedding succeeded, persistence failed
  }

  return { embedding: vector, fromCache: false };
}

// ── embedBatch() ──────────────────────────────────────────────

/**
 * Batch embed multiple texts efficiently.
 * Splits into cache-hits and cache-misses; only calls OpenAI for misses.
 * Returns array aligned with input order; nulls for any individual failures.
 */
export async function embedBatch(
  items: Array<{ text: string; contentType: ContentType; contentId: string }>,
): Promise<Array<EmbeddingResult | null>> {
  if (items.length === 0) return [];

  const sb = getSupabaseAdmin();

  // 1. Hash all inputs
  const hashes = items.map((item) => contentHash(item.text));

  // 2. Single cache query for all hashes
  const uniqueHashes = [...new Set(hashes)];
  const { data: cachedRows } = await sb
    .from('embeddings')
    .select('content_hash, embedding')
    .in('content_hash', uniqueHashes)
    .eq('model_version', ACTIVE_EMBEDDING_MODEL);

  const cacheMap = new Map<string, number[]>();
  for (const row of cachedRows ?? []) {
    cacheMap.set(row.content_hash, parseVector(row.embedding));
  }

  // 3. Build list of misses (indices into original array)
  const missIndices: number[] = [];
  const missTexts: string[] = [];
  const results: Array<EmbeddingResult | null> = new Array(items.length).fill(null);

  for (let i = 0; i < items.length; i++) {
    const cached = cacheMap.get(hashes[i]);
    if (cached) {
      results[i] = { embedding: cached, fromCache: true };
    } else {
      missIndices.push(i);
      missTexts.push(items[i].text);
    }
  }

  // 4. Batch OpenAI calls in chunks of EMBEDDING_BATCH_SIZE
  if (missTexts.length > 0) {
    const allNewVectors: Array<number[] | null> = new Array(missTexts.length).fill(null);

    for (let chunk = 0; chunk < missTexts.length; chunk += EMBEDDING_BATCH_SIZE) {
      const chunkTexts = missTexts.slice(chunk, chunk + EMBEDDING_BATCH_SIZE);
      try {
        const response = await getOpenAI().embeddings.create({
          model: OPENAI_MODEL_NAME,
          input: chunkTexts,
        });
        // OpenAI returns embeddings in same order as input
        for (let j = 0; j < response.data.length; j++) {
          allNewVectors[chunk + j] = response.data[j].embedding;
        }
      } catch (err) {
        console.error(
          `[embeddings] Batch API failure (chunk ${chunk}–${chunk + chunkTexts.length}):`,
          err,
        );
        // Leave nulls for this chunk — partial failure handling
      }
    }

    // 5. Upsert all new embeddings
    const upsertRows: Array<Record<string, unknown>> = [];
    for (let m = 0; m < missIndices.length; m++) {
      const vec = allNewVectors[m];
      if (!vec) continue;

      const idx = missIndices[m];
      results[idx] = { embedding: vec, fromCache: false };

      upsertRows.push({
        content_type: items[idx].contentType,
        content_id: items[idx].contentId,
        content_hash: hashes[idx],
        text_input: items[idx].text,
        embedding: vec,
        model_version: ACTIVE_EMBEDDING_MODEL,
      });
    }

    if (upsertRows.length > 0) {
      const { error } = await sb
        .from('embeddings')
        .upsert(upsertRows, { onConflict: 'content_type,content_id,model_version' });

      if (error) {
        console.error('[embeddings] Batch persist failure:', error);
        // Results already populated — persistence failure is non-fatal
      }
    }
  }

  // 6. Upsert cache-hit rows that may have different content_type/content_id
  const cacheHitUpserts: Array<Record<string, unknown>> = [];
  for (let i = 0; i < items.length; i++) {
    if (results[i]?.fromCache) {
      cacheHitUpserts.push({
        content_type: items[i].contentType,
        content_id: items[i].contentId,
        content_hash: hashes[i],
        text_input: items[i].text,
        embedding: results[i]!.embedding,
        model_version: ACTIVE_EMBEDDING_MODEL,
      });
    }
  }

  if (cacheHitUpserts.length > 0) {
    await sb
      .from('embeddings')
      .upsert(cacheHitUpserts, { onConflict: 'content_type,content_id,model_version' });
  }

  return results;
}

// ── getEmbedding() ────────────────────────────────────────────

/**
 * Retrieve a single stored embedding by content_type + content_id.
 * Returns null if not found. Never calls OpenAI — read-only accessor.
 */
export async function getEmbedding(
  contentType: ContentType,
  contentId: string,
): Promise<number[] | null> {
  const sb = getSupabaseAdmin();

  const { data } = await sb
    .from('embeddings')
    .select('embedding')
    .eq('content_type', contentType)
    .eq('content_id', contentId)
    .eq('model_version', ACTIVE_EMBEDDING_MODEL)
    .limit(1)
    .single();

  if (!data?.embedding) return null;
  return parseVector(data.embedding);
}

// ── getEmbeddingsBatch() ──────────────────────────────────────

/**
 * Retrieve multiple stored embeddings in a single query.
 * Returns array aligned with input order; nulls for misses.
 * Never calls OpenAI — read-only batch accessor.
 */
export async function getEmbeddingsBatch(
  items: Array<{ contentType: ContentType; contentId: string }>,
): Promise<Array<number[] | null>> {
  if (items.length === 0) return [];

  const sb = getSupabaseAdmin();

  // Single query for all content_ids of the same content_type
  // Group by content_type to minimize queries
  const byType = new Map<ContentType, Array<{ idx: number; contentId: string }>>();
  for (let i = 0; i < items.length; i++) {
    const { contentType, contentId } = items[i];
    const arr = byType.get(contentType);
    if (arr) arr.push({ idx: i, contentId });
    else byType.set(contentType, [{ idx: i, contentId }]);
  }

  const results: Array<number[] | null> = new Array(items.length).fill(null);

  for (const [ct, entries] of byType) {
    const ids = entries.map((e) => e.contentId);
    const { data } = await sb
      .from('embeddings')
      .select('content_id, embedding')
      .eq('content_type', ct)
      .eq('model_version', ACTIVE_EMBEDDING_MODEL)
      .in('content_id', ids);

    if (!data) continue;

    const lookup = new Map<string, number[]>();
    for (const row of data) {
      lookup.set(row.content_id, parseVector(row.embedding));
    }

    for (const { idx, contentId } of entries) {
      results[idx] = lookup.get(contentId) ?? null;
    }
  }

  return results;
}

// ── findSimilar() ─────────────────────────────────────────────

/**
 * Find similar embeddings by cosine similarity via pgvector RPC.
 * Filtered by content_type and active model version.
 */
export async function findSimilar(
  embedding: number[],
  contentType: ContentType,
  options: FindSimilarOptions = {},
): Promise<SimilarityMatch[]> {
  const threshold = options.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const limit = options.limit ?? 20;
  const sb = getSupabaseAdmin();

  const { data, error } = await sb.rpc('find_similar_embeddings', {
    query_embedding: JSON.stringify(embedding),
    match_content_type: contentType,
    match_model_version: ACTIVE_EMBEDDING_MODEL,
    match_threshold: threshold,
    match_limit: limit,
    exclude_content_id: options.excludeContentId ?? null,
    exclude_content_hash: options.excludeContentHash ?? null,
  });

  if (error) {
    console.error('[embeddings] Similarity query failure:', error);
    return [];
  }

  return (data ?? []) as SimilarityMatch[];
}

// ── similarityBatch() ─────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 * OpenAI text-embedding-3-small returns normalized vectors,
 * so cosine similarity = dot product.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Compute similarity matrix between two sets of texts.
 * Embeds both sides (with caching), returns NxM similarity matrix.
 * textsA[i] vs textsB[j] → matrix[i][j]
 */
export async function similarityBatch(
  textsA: Array<{ text: string; contentType: ContentType; contentId: string }>,
  textsB: Array<{ text: string; contentType: ContentType; contentId: string }>,
): Promise<number[][]> {
  // Embed both sides (caching handles overlap)
  const [embeddingsA, embeddingsB] = await Promise.all([
    embedBatch(textsA),
    embedBatch(textsB),
  ]);

  // Build NxM matrix
  const matrix: number[][] = [];
  for (let i = 0; i < textsA.length; i++) {
    const row: number[] = [];
    const vecA = embeddingsA[i]?.embedding;
    for (let j = 0; j < textsB.length; j++) {
      const vecB = embeddingsB[j]?.embedding;
      if (vecA && vecB) {
        row.push(cosineSimilarity(vecA, vecB));
      } else {
        row.push(0); // null embedding → 0 similarity
      }
    }
    matrix.push(row);
  }

  return matrix;
}
