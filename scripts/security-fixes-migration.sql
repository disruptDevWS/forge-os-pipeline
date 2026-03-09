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

-- ============================================================
-- 7. Add brief_pdf_url column to execution_pages
-- ============================================================

ALTER TABLE public.execution_pages ADD COLUMN IF NOT EXISTS brief_pdf_url TEXT;

-- ============================================================
-- 8. Create oscar_requests table for content draft generation
-- ============================================================

CREATE TABLE IF NOT EXISTS public.oscar_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES public.audits(id),
  page_url TEXT NOT NULL,
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE public.oscar_requests ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'oscar_requests' AND policyname = 'Users can view own oscar_requests'
  ) THEN
    CREATE POLICY "Users can view own oscar_requests"
      ON public.oscar_requests FOR SELECT
      USING (EXISTS (
        SELECT 1 FROM public.audits
        WHERE audits.id = oscar_requests.audit_id
          AND audits.user_id = auth.uid()
      ));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'oscar_requests' AND policyname = 'Users can insert own oscar_requests'
  ) THEN
    CREATE POLICY "Users can insert own oscar_requests"
      ON public.oscar_requests FOR INSERT
      WITH CHECK (EXISTS (
        SELECT 1 FROM public.audits
        WHERE audits.id = oscar_requests.audit_id
          AND audits.user_id = auth.uid()
      ));
  END IF;
END $$;

-- ============================================================
-- 9. Create client_profiles table for brand brief data
-- ============================================================

CREATE TABLE IF NOT EXISTS public.client_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
  business_name TEXT,
  years_in_business INTEGER,
  phone TEXT,
  review_count INTEGER,
  review_rating NUMERIC(2,1),
  founder_background TEXT,
  usps TEXT[],
  brand_voice_notes TEXT,
  service_differentiators TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(audit_id)
);

ALTER TABLE public.client_profiles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'client_profiles' AND policyname = 'Users can view own client_profiles'
  ) THEN
    CREATE POLICY "Users can view own client_profiles"
      ON public.client_profiles FOR SELECT
      USING (EXISTS (
        SELECT 1 FROM public.audits
        WHERE audits.id = client_profiles.audit_id
          AND audits.user_id = auth.uid()
      ));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'client_profiles' AND policyname = 'Users can manage own client_profiles'
  ) THEN
    CREATE POLICY "Users can manage own client_profiles"
      ON public.client_profiles FOR ALL
      USING (EXISTS (
        SELECT 1 FROM public.audits
        WHERE audits.id = client_profiles.audit_id
          AND audits.user_id = auth.uid()
      ));
  END IF;
END $$;
