-- Migration 017: Add classification metadata columns to audit_keywords
--
-- These columns are populated ONLY by hybrid and shadow canonicalize modes.
-- Legacy mode rows remain NULL in all four columns.
--
-- Downstream consumers (rebuildClustersAndRollups, syncMichael, generateClusterStrategy,
-- runGap, runMichael, Pam) do NOT read these columns. They exist purely for:
-- 1. Hybrid mode re-run stability (classification_method used as lock predicate)
-- 2. Shadow mode comparison analysis (canonicalize-shadow-compare.ts)
-- 3. Audit trail / debugging
--
-- classification_method values:
--   'vector_auto_assign'           — above 0.85 similarity, single match
--   'sonnet_arbitration_assigned'  — Sonnet assigned to existing topic
--   'sonnet_arbitration_new_topic' — Sonnet created a new topic
--   'sonnet_arbitration_merged'    — Sonnet merged candidates
--   'prior_assignment_locked'      — re-run stability lock (prior hybrid assignment kept)
--
-- canonicalize_mode values:
--   'legacy'         — standard Sonnet-only path
--   'hybrid'         — vector-first + Sonnet arbitration
--   'shadow_hybrid'  — hybrid output from shadow mode (legacy output is authoritative)

ALTER TABLE public.audit_keywords
  ADD COLUMN IF NOT EXISTS classification_method TEXT,
  ADD COLUMN IF NOT EXISTS similarity_score FLOAT,
  ADD COLUMN IF NOT EXISTS arbitration_reason TEXT,
  ADD COLUMN IF NOT EXISTS canonicalize_mode TEXT;

-- Index for re-run lock predicate: hybrid mode checks classification_method IS NOT NULL
-- to determine if prior assignment was hybrid-originated
CREATE INDEX IF NOT EXISTS idx_audit_keywords_classification_method
  ON public.audit_keywords (audit_id, classification_method)
  WHERE classification_method IS NOT NULL;
