-- Enrich audit_snapshots with Jim's research findings + keyword segment flags
-- Run against Supabase SQL Editor

-- Jim's site-level findings columns on audit_snapshots
ALTER TABLE audit_snapshots
  ADD COLUMN IF NOT EXISTS research_summary_markdown text,
  ADD COLUMN IF NOT EXISTS keyword_overview jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS position_distribution jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS branded_split jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS intent_breakdown jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS top_ranking_urls jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS competitor_analysis jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS competitor_summary jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS striking_distance jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS content_gap_observations jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS key_takeaways jsonb DEFAULT '[]'::jsonb;

-- Keyword segment flags (insert ALL keywords, not just near-miss)
ALTER TABLE audit_keywords
  ADD COLUMN IF NOT EXISTS is_near_miss boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_top_10 boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_striking_distance boolean DEFAULT false;
