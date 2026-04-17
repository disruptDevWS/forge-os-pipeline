-- Migration 016: Add exclude_content_hash parameter to find_similar_embeddings RPC
--
-- Allows excluding all rows matching a content_hash from similarity results.
-- Used by Canonicalize hybrid mode to exclude the query variant's own hash
-- (multiple content_ids may share the same content_hash for identical text).
-- Existing exclude_content_id parameter retained for backward compatibility.

CREATE OR REPLACE FUNCTION public.find_similar_embeddings(
  query_embedding vector(1536),
  match_content_type text,
  match_model_version text,
  match_threshold float,
  match_limit int,
  exclude_content_id text DEFAULT NULL,
  exclude_content_hash text DEFAULT NULL
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
    AND (exclude_content_hash IS NULL OR e.content_hash <> exclude_content_hash)
    AND 1 - (e.embedding <=> query_embedding) >= match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_limit;
$$;
