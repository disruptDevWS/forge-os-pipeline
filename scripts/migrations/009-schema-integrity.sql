-- Migration 009: Schema Integrity (v3.0 Session 3)
-- Adds missing constraints identified in REVIEW_v3.md:
--   DATA-3: unique constraint on execution_pages(audit_id, url_slug)
--   DATA-8: CHECK constraint on audit_clusters.status
--   DATA-7: revenue column precision (numeric(12,2))
--
-- Run with: supabase db query --linked -f scripts/migrations/009-schema-integrity.sql

-- ============================================================
-- Part 1: Constraints (no view dependencies)
-- ============================================================

-- DATA-3: execution_pages unique constraint on (audit_id, url_slug)
-- First, deduplicate if any exist (keep the most recently created row)
DELETE FROM execution_pages
WHERE id IN (
  SELECT id FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY audit_id, url_slug
        ORDER BY created_at DESC NULLS LAST, id DESC
      ) AS rn
    FROM execution_pages
  ) dupes
  WHERE rn > 1
);

ALTER TABLE execution_pages
  DROP CONSTRAINT IF EXISTS uq_execution_pages_audit_slug;
ALTER TABLE execution_pages
  ADD CONSTRAINT uq_execution_pages_audit_slug UNIQUE (audit_id, url_slug);

-- DATA-8: audit_clusters.status CHECK constraint
UPDATE audit_clusters
  SET status = 'inactive'
  WHERE status IS NOT NULL
    AND status NOT IN ('inactive', 'active', 'complete', 'hidden');

ALTER TABLE audit_clusters
  DROP CONSTRAINT IF EXISTS chk_cluster_status;
ALTER TABLE audit_clusters
  ADD CONSTRAINT chk_cluster_status
  CHECK (status IN ('inactive', 'active', 'complete', 'hidden'));

-- ============================================================
-- Part 2: Revenue column precision
-- Must drop and recreate v_opportunity_breakdown view first
-- ============================================================

-- Save the view definition (recreated below after ALTER)
DROP VIEW IF EXISTS v_opportunity_breakdown;

-- audit_clusters revenue columns
ALTER TABLE audit_clusters
  ALTER COLUMN est_revenue_low TYPE numeric(12,2),
  ALTER COLUMN est_revenue_mid TYPE numeric(12,2),
  ALTER COLUMN est_revenue_high TYPE numeric(12,2),
  ALTER COLUMN tar_revenue_low TYPE numeric(12,2),
  ALTER COLUMN tar_revenue_mid TYPE numeric(12,2),
  ALTER COLUMN tar_revenue_high TYPE numeric(12,2);

-- audit_rollups revenue columns
ALTER TABLE audit_rollups
  ALTER COLUMN monthly_revenue_low TYPE numeric(12,2),
  ALTER COLUMN monthly_revenue_mid TYPE numeric(12,2),
  ALTER COLUMN monthly_revenue_high TYPE numeric(12,2),
  ALTER COLUMN monthly_revenue_conservative TYPE numeric(12,2);

-- Recreate the view (from pg_views dump)
CREATE OR REPLACE VIEW v_opportunity_breakdown AS
WITH a AS (
  SELECT aa.audit_id,
    aa.ctr_model_id,
    aa.target_ctr,
    aa.near_miss_min_pos,
    aa.near_miss_max_pos,
    aa.min_volume,
    aa.floor_ctr_over30
  FROM audit_assumptions aa
), cm AS (
  SELECT ctr_models.id AS ctr_model_id,
    ctr_models.buckets
  FROM ctr_models
)
SELECT ac.audit_id,
  ac.canonical_key,
  COALESCE(ac.canonical_topic, ac.topic) AS canonical_topic,
  ac.service_root_id,
  ac.eligibility_status,
  ac.exclusion_reason,
  ac.match_version,
  a.near_miss_min_pos AS audit_near_miss_min_pos,
  a.near_miss_max_pos AS audit_near_miss_max_pos,
  a.min_volume AS audit_min_volume,
  a.target_ctr AS audit_target_ctr,
  ac.total_volume,
  ac.best_rank,
  ac.keyword_count_total,
  ac.keyword_count_eligible,
  ac.keyword_count_near_miss,
  ac.topic_cpc,
  ac.volume_rollup_method,
  ac.sample_keywords,
  ac.est_new_leads_low,
  ac.est_new_leads_high,
  ac.est_revenue_low,
  ac.est_revenue_high,
  fn_ctr_for_rank(cm.buckets, ac.best_rank, a.floor_ctr_over30) AS current_ctr_estimated,
  GREATEST((a.target_ctr - fn_ctr_for_rank(cm.buckets, ac.best_rank, a.floor_ctr_over30)), 0::numeric) AS ctr_gain_used,
  ac.created_at,
  ac.updated_at
FROM audit_clusters ac
  JOIN a ON a.audit_id = ac.audit_id
  JOIN cm ON cm.ctr_model_id = a.ctr_model_id
WHERE ac.canonical_key IS NOT NULL
  AND ac.eligibility_status = 'eligible'
  AND ac.total_volume >= a.min_volume;
