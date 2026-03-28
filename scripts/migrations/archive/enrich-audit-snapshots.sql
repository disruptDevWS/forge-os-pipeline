-- Enrich audit_snapshots with Dwight's site-level findings
-- Run against Supabase SQL Editor

ALTER TABLE audit_snapshots
  ADD COLUMN IF NOT EXISTS executive_summary text,
  ADD COLUMN IF NOT EXISTS prioritized_fixes jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS agentic_readiness jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS structured_data_issues jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS heading_issues jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS security_issues jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS platform_notes text,
  ADD COLUMN IF NOT EXISTS site_metadata jsonb DEFAULT '{}'::jsonb;
