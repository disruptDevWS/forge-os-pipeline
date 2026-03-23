-- Migration 003: Total Addressable Revenue (TAR) columns + hidden cluster support
--
-- TAR calculates "what is this market worth at target visibility?" across ALL keywords,
-- not just near-miss. Near-miss revenue stays as a secondary "90-day achievable" signal.
--
-- Hidden status allows irrelevant clusters to be removed from active views while
-- preserving data for pipeline learning.

-- TAR columns on audit_clusters
ALTER TABLE audit_clusters
  ADD COLUMN IF NOT EXISTS tar_revenue_low numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tar_revenue_mid numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tar_revenue_high numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS keyword_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hidden_reason text;

-- TAR columns on audit_rollups
ALTER TABLE audit_rollups
  ADD COLUMN IF NOT EXISTS tar_revenue_low numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tar_revenue_mid numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tar_revenue_high numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_keyword_count integer DEFAULT 0;

-- Target visibility position on audit_assumptions
ALTER TABLE audit_assumptions
  ADD COLUMN IF NOT EXISTS tar_position integer DEFAULT 5;
