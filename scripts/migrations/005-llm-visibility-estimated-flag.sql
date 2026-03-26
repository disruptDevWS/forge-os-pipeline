-- 005-llm-visibility-estimated-flag.sql
-- Add is_estimated flag to distinguish measured vs. aggregated-derived mention counts

ALTER TABLE public.llm_visibility_snapshots
ADD COLUMN IF NOT EXISTS is_estimated BOOLEAN DEFAULT false;

COMMENT ON COLUMN public.llm_visibility_snapshots.is_estimated IS
  'True when mention_count is derived from aggregate distribution across keywords, not a direct per-keyword measurement. Applies to competitor domain rows from the aggregated_metrics endpoint.';
