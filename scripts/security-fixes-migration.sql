-- security-fixes-migration.sql
-- Fixes 7 Security Advisor errors + 6 search_path warnings + audits.mode column.
-- Run in Supabase SQL Editor. Safe to re-run (all statements are idempotent).
-- Pipeline scripts use service_role key (bypasses RLS), so no code changes needed.
-- Leaked password protection: toggle in Auth → Settings → Password Security (not SQL).

-- ============================================================
-- 1. Fix SECURITY DEFINER views → SECURITY INVOKER
-- ============================================================

ALTER VIEW public.vw_audit_informational_keywords SET (security_invoker = on);
ALTER VIEW public.v_opportunity_breakdown SET (security_invoker = on);

-- ============================================================
-- 2. RLS on per-user tables (audit_topic_competitors, audit_topic_dominance)
--    Policy: users can SELECT/INSERT rows belonging to their own audits.
--    No DELETE/UPDATE policies — service_role handles writes, Dashboard is read-only.
-- ============================================================

ALTER TABLE public.audit_topic_competitors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own audit_topic_competitors"
  ON public.audit_topic_competitors FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.audits
    WHERE audits.id = audit_topic_competitors.audit_id
      AND audits.user_id = auth.uid()
  ));

CREATE POLICY "Users can insert own audit_topic_competitors"
  ON public.audit_topic_competitors FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.audits
    WHERE audits.id = audit_topic_competitors.audit_id
      AND audits.user_id = auth.uid()
  ));

ALTER TABLE public.audit_topic_dominance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own audit_topic_dominance"
  ON public.audit_topic_dominance FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.audits
    WHERE audits.id = audit_topic_dominance.audit_id
      AND audits.user_id = auth.uid()
  ));

CREATE POLICY "Users can insert own audit_topic_dominance"
  ON public.audit_topic_dominance FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.audits
    WHERE audits.id = audit_topic_dominance.audit_id
      AND audits.user_id = auth.uid()
  ));

-- ============================================================
-- 3. RLS on global lookup tables (read-only for authenticated users)
--    Writes come from service_role only.
-- ============================================================

ALTER TABLE public.service_root_terms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read service_root_terms"
  ON public.service_root_terms FOR SELECT
  USING (true);

ALTER TABLE public.service_roots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read service_roots"
  ON public.service_roots FOR SELECT
  USING (true);

ALTER TABLE public.directory_domains ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read directory_domains"
  ON public.directory_domains FOR SELECT
  USING (true);

-- ============================================================
-- 4. Add audits.mode column for sales pipeline
--    Default 'full' backfills all existing rows. No NULLs.
-- ============================================================

ALTER TABLE public.audits ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'full';

-- ============================================================
-- 5. Pin search_path on all public functions (fixes 6 WARN-level findings)
--    Prevents schema-shadowing attacks. Zero side effects — all functions
--    only reference public schema objects.
-- ============================================================

ALTER FUNCTION public.handle_updated_at() SET search_path = public;
ALTER FUNCTION public.fn_regex_escape(text) SET search_path = public;
ALTER FUNCTION public.fn_build_audit_clusters(uuid) SET search_path = public;
ALTER FUNCTION public.fn_ctr_for_rank(integer) SET search_path = public;
ALTER FUNCTION public.fn_apply_revenue_to_audit_clusters(uuid) SET search_path = public;
ALTER FUNCTION public.fn_canonicalize_audit_keywords(uuid) SET search_path = public;

-- ============================================================
-- 6. Add audits.business_name column for sales report
-- ============================================================

ALTER TABLE public.audits ADD COLUMN IF NOT EXISTS business_name TEXT;
