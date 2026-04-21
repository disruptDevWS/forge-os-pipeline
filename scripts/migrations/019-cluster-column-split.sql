-- Migration 019: Cluster column split — add dedicated silo column
-- Session B (2026-04-21)
--
-- The audit_keywords.cluster column is overloaded: it stores canonical_topic
-- (written by canonicalize) OR silo_name (overwritten by syncMichael's silo backfill).
-- This migration adds a dedicated silo column and separates the two values.

-- Step 1: Add silo column
ALTER TABLE public.audit_keywords ADD COLUMN IF NOT EXISTS silo text;

-- Step 2: Backfill silo from cluster where cluster differs from canonical_topic
-- These are the rows where syncMichael's silo backfill overwrote canonical_topic
UPDATE public.audit_keywords
SET silo = cluster
WHERE canonical_topic IS NOT NULL
  AND cluster IS NOT NULL
  AND cluster != canonical_topic;

-- Step 3: Restore cluster to canonical_topic where it was overwritten by silo
UPDATE public.audit_keywords
SET cluster = canonical_topic
WHERE canonical_topic IS NOT NULL
  AND cluster IS NOT NULL
  AND cluster != canonical_topic;

-- Step 4: Index for Pam's keyword join (will use canonical_key after Session B)
CREATE INDEX IF NOT EXISTS idx_audit_keywords_canonical_key
ON public.audit_keywords (audit_id, canonical_key);
