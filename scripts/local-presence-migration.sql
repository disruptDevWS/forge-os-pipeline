-- local-presence-migration.sql
-- Phase 6d: Local Presence Diagnostic (GBP + Citations)
-- Creates gbp_snapshots, citation_snapshots tables and adds canonical NAP to client_profiles.

-- ── gbp_snapshots ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gbp_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  listing_found BOOLEAN NOT NULL DEFAULT false,
  match_confidence TEXT,
  matched_name TEXT,
  category TEXT,
  additional_categories TEXT[],
  rating NUMERIC(2,1),
  review_count INT,
  photo_count INT,
  is_claimed BOOLEAN,
  website_url TEXT,
  work_hours JSONB,
  attributes JSONB,
  canonical_name TEXT,
  canonical_address TEXT,
  canonical_phone TEXT,
  cid TEXT,
  place_id TEXT,
  gbp_missing BOOLEAN DEFAULT false,
  raw_response JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(audit_id, snapshot_date)
);

-- ── citation_snapshots ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS citation_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  directory_name TEXT NOT NULL,
  directory_domain TEXT,
  listing_found BOOLEAN NOT NULL DEFAULT false,
  listing_url TEXT,
  found_name TEXT,
  found_address TEXT,
  found_phone TEXT,
  nap_match_name BOOLEAN,
  nap_match_address BOOLEAN,
  nap_match_phone BOOLEAN,
  nap_consistent BOOLEAN,
  data_source TEXT DEFAULT 'serp',
  raw_snippet TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(audit_id, snapshot_date, directory_name)
);

-- ── client_profiles — add canonical NAP columns ────────────────
ALTER TABLE client_profiles ADD COLUMN IF NOT EXISTS canonical_name TEXT;
ALTER TABLE client_profiles ADD COLUMN IF NOT EXISTS canonical_address TEXT;
ALTER TABLE client_profiles ADD COLUMN IF NOT EXISTS canonical_phone TEXT;

-- ── Indexes ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_gbp_snapshots_audit_id ON gbp_snapshots(audit_id);
CREATE INDEX IF NOT EXISTS idx_citation_snapshots_audit_id ON citation_snapshots(audit_id);
CREATE INDEX IF NOT EXISTS idx_citation_snapshots_audit_date ON citation_snapshots(audit_id, snapshot_date);

-- ── RLS ────────────────────────────────────────────────────────
ALTER TABLE gbp_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE citation_snapshots ENABLE ROW LEVEL SECURITY;

-- Users can view their own via audits FK join
CREATE POLICY "Users can view own gbp_snapshots"
  ON gbp_snapshots FOR SELECT
  USING (audit_id IN (SELECT id FROM audits WHERE user_id = auth.uid()));

CREATE POLICY "Users can view own citation_snapshots"
  ON citation_snapshots FOR SELECT
  USING (audit_id IN (SELECT id FROM audits WHERE user_id = auth.uid()));

-- Service role has full access (for pipeline inserts)
CREATE POLICY "Service role full access gbp_snapshots"
  ON gbp_snapshots FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access citation_snapshots"
  ON citation_snapshots FOR ALL
  USING (auth.role() = 'service_role');
