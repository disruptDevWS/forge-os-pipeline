-- near-me-migration.sql
-- Adds is_near_me flag + source column to audit_keywords + audit_coverage_validation table.
-- Run in Supabase SQL Editor. Safe to re-run (all statements are idempotent).

-- ============================================================
-- 1. Flag near-me keywords so downstream agents exclude them
--    from volume-based prioritization (national volume, not local)
-- ============================================================

ALTER TABLE public.audit_keywords ADD COLUMN IF NOT EXISTS is_near_me BOOLEAN DEFAULT FALSE;

-- ============================================================
-- 1b. Source column — distinguishes KeywordResearch-seeded keywords
--     ('keyword_research') from Jim's ranked keywords ('ranked')
-- ============================================================

ALTER TABLE public.audit_keywords ADD COLUMN IF NOT EXISTS source TEXT;

-- ============================================================
-- 2. Coverage validation table — tracks whether gaps from the
--    Gap agent are addressed in Michael's architecture blueprint
-- ============================================================

CREATE TABLE IF NOT EXISTS public.audit_coverage_validation (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  audit_id       uuid NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
  gap_topic      text NOT NULL,
  gap_type       text NOT NULL,
  blueprint_page text,
  status         text NOT NULL,
  notes          text,
  created_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_acv_audit_id ON public.audit_coverage_validation(audit_id);
