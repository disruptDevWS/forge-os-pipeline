-- authority-score-migration.sql
-- Adds position-weighted topical authority score columns.

-- Historical trend data (one score per cluster per snapshot date)
ALTER TABLE public.cluster_performance_snapshots
  ADD COLUMN IF NOT EXISTS authority_score NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS authority_score_delta NUMERIC(5,1);

COMMENT ON COLUMN public.cluster_performance_snapshots.authority_score IS
  'Position-weighted authority score (0-100). Measures what % of cluster keywords the domain ranks for, weighted by position.';
COMMENT ON COLUMN public.cluster_performance_snapshots.authority_score_delta IS
  'Change vs previous snapshot. Positive = improving.';

-- Current/latest score on audit_clusters (for Cluster Focus page display)
ALTER TABLE public.audit_clusters
  ADD COLUMN IF NOT EXISTS authority_score NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS authority_score_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN public.audit_clusters.authority_score IS
  'Latest position-weighted authority score from most recent ranking snapshot.';
