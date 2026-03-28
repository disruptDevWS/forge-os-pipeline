-- Enrich audit_snapshots with additional Dwight findings (v2)
-- Run against Supabase SQL Editor

ALTER TABLE audit_snapshots
  ADD COLUMN IF NOT EXISTS url_identity_issues jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS metadata_issues jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS image_issues jsonb DEFAULT '{}'::jsonb;
