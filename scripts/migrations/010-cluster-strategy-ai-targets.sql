-- Migration 010: Add structured AI optimization targets to cluster_strategy
-- Additive only — existing rows will have NULL for this column.

ALTER TABLE cluster_strategy
ADD COLUMN IF NOT EXISTS ai_optimization_targets JSONB;

COMMENT ON COLUMN cluster_strategy.ai_optimization_targets IS
'Structured AI/search optimization targets from Cluster Strategy Section 5. Array of {query, target_type, structural_pattern, applies_to_page, condition, rationale}.';
