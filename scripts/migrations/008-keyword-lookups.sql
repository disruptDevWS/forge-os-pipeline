-- 008-keyword-lookups.sql
-- Persist ad-hoc keyword volume lookups from DataForSEO.
-- Each row = one keyword result; batch_id groups results from a single lookup session.
-- Super-admin only (keyword lookup is a super_admin feature).

CREATE TABLE IF NOT EXISTS public.keyword_lookups (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id         UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
  batch_id         UUID NOT NULL,
  keyword          TEXT NOT NULL,
  volume           INTEGER NOT NULL DEFAULT 0,
  cpc              NUMERIC(10,2) NOT NULL DEFAULT 0,
  competition      NUMERIC(5,4),
  competition_level TEXT,
  looked_up_by     UUID REFERENCES auth.users(id),
  looked_up_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  estimated_cost   NUMERIC(10,4),
  UNIQUE (audit_id, batch_id, keyword)
);

-- Index for history listing (most recent first)
CREATE INDEX IF NOT EXISTS idx_keyword_lookups_audit_date
  ON public.keyword_lookups(audit_id, looked_up_at DESC);

-- RLS: super_admin only
ALTER TABLE public.keyword_lookups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage keyword_lookups"
  ON public.keyword_lookups FOR ALL
  TO service_role
  USING (true);

CREATE POLICY "Super admins can view keyword_lookups"
  ON public.keyword_lookups FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'super_admin'::app_role));
