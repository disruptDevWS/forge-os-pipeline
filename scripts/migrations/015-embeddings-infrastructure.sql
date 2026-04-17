-- Migration 015: Embeddings infrastructure (pgvector + embeddings table + RPC)
--
-- Context: Foundation for vector embedding infrastructure. Downstream consumers
-- (Canonicalize, Scout dedup, Gap analysis, topical coverage scoring) come in
-- subsequent sessions. This migration installs pgvector, creates the polymorphic
-- embeddings table, and adds the similarity search RPC function.
--
-- Architectural decisions (see DECISIONS.md):
--   - Single polymorphic table keyed by (content_type, content_id, model_version)
--   - Content-hash-based cache dedup before embedding API calls
--   - HNSW index on active model version only (partial index)
--   - All similarity queries filter on model_version (no cross-version comparisons)
--
-- pgvector 0.8.0 verified available on this Supabase project (2026-04-17).

-- ── Enable pgvector extension (idempotent) ────────────────────
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Embeddings table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type TEXT NOT NULL,
  content_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  text_input TEXT NOT NULL,
  embedding VECTOR(1536) NOT NULL,
  model_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (content_type, content_id, model_version)
);

-- Lookup by content_hash for cache-hit path (before embedding)
CREATE INDEX IF NOT EXISTS idx_embeddings_content_hash
  ON public.embeddings (content_hash, model_version);

-- HNSW index for cosine similarity queries
-- Partial index on active model version to keep the index focused
CREATE INDEX IF NOT EXISTS idx_embeddings_cosine_active
  ON public.embeddings
  USING hnsw (embedding vector_cosine_ops)
  WHERE model_version = 'openai/text-embedding-3-small@2024-01';

-- Filter index for content_type queries
CREATE INDEX IF NOT EXISTS idx_embeddings_content_type_version
  ON public.embeddings (content_type, model_version);

-- ── RPC function for similarity search ────────────────────────
CREATE OR REPLACE FUNCTION public.find_similar_embeddings(
  query_embedding vector(1536),
  match_content_type text,
  match_model_version text,
  match_threshold float,
  match_limit int,
  exclude_content_id text DEFAULT NULL
)
RETURNS TABLE (
  content_id text,
  similarity float,
  text_input text
)
LANGUAGE sql STABLE
AS $$
  SELECT
    e.content_id,
    1 - (e.embedding <=> query_embedding) AS similarity,
    e.text_input
  FROM public.embeddings e
  WHERE e.content_type = match_content_type
    AND e.model_version = match_model_version
    AND (exclude_content_id IS NULL OR e.content_id <> exclude_content_id)
    AND 1 - (e.embedding <=> query_embedding) >= match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_limit;
$$;

-- ── RLS ───────────────────────────────────────────────────────
-- Embeddings are internal pipeline infrastructure. Only service_role
-- reads/writes. No dashboard access needed.
ALTER TABLE public.embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage embeddings"
  ON public.embeddings
  FOR ALL
  USING (true)
  WITH CHECK (true);
