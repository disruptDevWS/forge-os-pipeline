-- Migration 014: cluster_strategy deprecation columns
--
-- Context: cluster_strategy rows are generated per cluster by Opus (~$0.15-0.50
-- each) and keyed by canonical_key. Phase 3c (Canonicalize) can rename canonical
-- keys during re-runs, orphaning existing strategies.
--
-- Exact-match remap fails because canonical_topic drifts along with canonical_key
-- (verified against SMA audit c07eb21d: "Online EMT Course" → "EMT Basic Course").
-- Keyword-overlap remap risks silent wrong matches.
--
-- Decision (see DECISIONS.md 2026-04-09): mark orphaned strategies as deprecated
-- rather than attempting remap. Preserve the strategy document for audit trail
-- and future manual review.
--
-- Adds:
--   status        — 'active' (default) | 'deprecated'
--   deprecated_at — timestamp when a rebuild orphaned this strategy
--
-- Existing rows backfill to status='active' via DEFAULT, deprecated_at stays NULL.

ALTER TABLE public.cluster_strategy
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS deprecated_at TIMESTAMPTZ;

ALTER TABLE public.cluster_strategy
  DROP CONSTRAINT IF EXISTS cluster_strategy_status_check;

ALTER TABLE public.cluster_strategy
  ADD CONSTRAINT cluster_strategy_status_check
  CHECK (status IN ('active', 'deprecated'));

-- Index supports the common dashboard query pattern:
--   SELECT ... FROM cluster_strategy WHERE audit_id = ? AND status = 'active'
CREATE INDEX IF NOT EXISTS idx_cluster_strategy_audit_status
  ON public.cluster_strategy (audit_id, status);
