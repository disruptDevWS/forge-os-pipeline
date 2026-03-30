-- Migration 011: GSC + GA4 analytics integration
-- Creates analytics_connections, gsc_page_snapshots, ga4_page_snapshots tables
-- Extends page_performance and audit_assumptions with GA4 behavioral columns

-- ============================================================
-- Table: analytics_connections
-- Stores GSC/GA4 property IDs per audit. Service account handles auth centrally.
-- ============================================================

CREATE TABLE IF NOT EXISTS analytics_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  gsc_property_url TEXT,
  ga4_property_id TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  connected_by UUID REFERENCES auth.users(id),
  last_gsc_sync_at TIMESTAMPTZ,
  last_ga4_sync_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'error')),
  error_message TEXT,
  CONSTRAINT analytics_connections_audit_id_key UNIQUE (audit_id)
);

ALTER TABLE analytics_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_analytics_connections"
  ON analytics_connections FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "super_admin_select_analytics_connections"
  ON analytics_connections FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.user_id = auth.uid()
        AND user_roles.role = 'super_admin'
    )
  );

-- ============================================================
-- Table: gsc_page_snapshots
-- Google Search Console page-level performance data
-- ============================================================

CREATE TABLE IF NOT EXISTS gsc_page_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  page_url TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr NUMERIC(8,6) NOT NULL DEFAULT 0,
  avg_position NUMERIC(6,2),
  top_queries JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gsc_page_snapshots_unique UNIQUE (audit_id, snapshot_date, page_url)
);

ALTER TABLE gsc_page_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_gsc_page_snapshots"
  ON gsc_page_snapshots FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "audit_owner_select_gsc_page_snapshots"
  ON gsc_page_snapshots FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM audits
      WHERE audits.id = gsc_page_snapshots.audit_id
        AND audits.user_id = auth.uid()
    )
  );

-- ============================================================
-- Table: ga4_page_snapshots
-- Google Analytics 4 page-level behavioral data
-- ============================================================

CREATE TABLE IF NOT EXISTS ga4_page_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  page_url TEXT NOT NULL,
  total_sessions INTEGER DEFAULT 0,
  total_conversions INTEGER DEFAULT 0,
  total_revenue NUMERIC(12,2) DEFAULT 0,
  organic_sessions INTEGER DEFAULT 0,
  organic_engaged_sessions INTEGER DEFAULT 0,
  organic_engagement_rate NUMERIC(6,4) DEFAULT 0,
  organic_conversions INTEGER DEFAULT 0,
  organic_avg_session_dur NUMERIC(8,2) DEFAULT 0,
  organic_cr NUMERIC(8,6) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ga4_page_snapshots_unique UNIQUE (audit_id, snapshot_date, page_url)
);

ALTER TABLE ga4_page_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_ga4_page_snapshots"
  ON ga4_page_snapshots FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "audit_owner_select_ga4_page_snapshots"
  ON ga4_page_snapshots FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM audits
      WHERE audits.id = ga4_page_snapshots.audit_id
        AND audits.user_id = auth.uid()
    )
  );

-- ============================================================
-- Extend: page_performance (5 new GA4 behavioral columns)
-- ============================================================

ALTER TABLE page_performance
  ADD COLUMN IF NOT EXISTS organic_sessions INTEGER,
  ADD COLUMN IF NOT EXISTS organic_engagement_rate NUMERIC(6,4),
  ADD COLUMN IF NOT EXISTS organic_cr NUMERIC(8,6),
  ADD COLUMN IF NOT EXISTS organic_conversions INTEGER,
  ADD COLUMN IF NOT EXISTS ga4_snapshot_date DATE;

-- ============================================================
-- Extend: audit_assumptions (4 new observed CR columns)
-- ============================================================

ALTER TABLE audit_assumptions
  ADD COLUMN IF NOT EXISTS observed_cr NUMERIC(8,6),
  ADD COLUMN IF NOT EXISTS observed_cr_source TEXT,
  ADD COLUMN IF NOT EXISTS observed_cr_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS use_observed_cr BOOLEAN DEFAULT FALSE;
