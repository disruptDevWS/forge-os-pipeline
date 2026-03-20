-- Add estimated_volume and revenue_signal columns to audit_coverage_validation
-- These fields are populated by the Validator (Phase 6.5) for revenue-prioritized coverage analysis.

ALTER TABLE public.audit_coverage_validation
  ADD COLUMN IF NOT EXISTS estimated_volume integer,
  ADD COLUMN IF NOT EXISTS revenue_signal text;

COMMENT ON COLUMN public.audit_coverage_validation.estimated_volume IS 'Monthly search volume carried through from gap analysis';
COMMENT ON COLUMN public.audit_coverage_validation.revenue_signal IS 'high|medium|low|unknown — based on CPC × volume threshold';
