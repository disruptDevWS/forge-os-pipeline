-- Migration 023: GA4 event-level conversion snapshots
-- Stores event-level conversion data (site-wide, not per-page) from GA4 Data API.
-- Complements ga4_page_snapshots (page behavioral) with conversion breakdown by event + channel.

CREATE TABLE IF NOT EXISTS public.ga4_event_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id        UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
  snapshot_date   DATE NOT NULL,
  event_name      TEXT NOT NULL,
  channel_group   TEXT NOT NULL,
  event_count     INTEGER NOT NULL DEFAULT 0,
  event_revenue   NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ga4_event_snapshots_unique UNIQUE (audit_id, snapshot_date, event_name, channel_group)
);

-- GRANTs (required for Data API access per DECISIONS.md 2026-05-13)
GRANT SELECT ON public.ga4_event_snapshots TO anon;
GRANT SELECT ON public.ga4_event_snapshots TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ga4_event_snapshots TO service_role;

-- RLS
ALTER TABLE public.ga4_event_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_ga4_event_snapshots"
  ON public.ga4_event_snapshots FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "audit_owner_select_ga4_event_snapshots"
  ON public.ga4_event_snapshots FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.audits
      WHERE audits.id = ga4_event_snapshots.audit_id
        AND audits.user_id = auth.uid()
    )
  );

-- Index for dashboard queries
CREATE INDEX idx_ga4_event_snapshots_audit_date
  ON public.ga4_event_snapshots (audit_id, snapshot_date);
