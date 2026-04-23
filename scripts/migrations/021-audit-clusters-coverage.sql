-- Migration 021: Coverage score columns on audit_clusters (denormalized for dashboard)
-- Mirrors authority_score pattern for quick dashboard access

ALTER TABLE public.audit_clusters
  ADD COLUMN IF NOT EXISTS coverage_score FLOAT,
  ADD COLUMN IF NOT EXISTS coverage_competitor_count INTEGER,
  ADD COLUMN IF NOT EXISTS coverage_score_updated_at TIMESTAMPTZ;
