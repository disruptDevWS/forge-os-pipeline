-- Migration 020: Competitor section extraction + coverage scoring tables
-- Phase 4b: competitor page heading extraction and semantic coverage computation

-- representative_url on audit_topic_competitors (Phase 4 persists SERP URLs)
ALTER TABLE public.audit_topic_competitors
  ADD COLUMN IF NOT EXISTS representative_url TEXT;

-- Extracted heading sections from competitor and client pages
CREATE TABLE IF NOT EXISTS public.competitor_sections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  audit_id UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  url TEXT NOT NULL,
  heading_level TEXT NOT NULL CHECK (heading_level IN ('h2', 'h3')),
  heading_text TEXT NOT NULL,
  heading_position INTEGER NOT NULL DEFAULT 0,
  is_client BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_competitor_sections_audit
  ON public.competitor_sections(audit_id);
CREATE INDEX IF NOT EXISTS idx_competitor_sections_audit_topic
  ON public.competitor_sections(audit_id, canonical_key);

-- Computed coverage scores per cluster (historical, snapshot by date)
CREATE TABLE IF NOT EXISTS public.cluster_section_coverage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  audit_id UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
  canonical_key TEXT NOT NULL,
  canonical_topic TEXT,
  coverage_score FLOAT NOT NULL DEFAULT 0,
  coverage_status TEXT NOT NULL DEFAULT 'scored'
    CHECK (coverage_status IN ('scored', 'no_client_pages', 'insufficient_competitors')),
  competitor_count INTEGER NOT NULL DEFAULT 0,
  total_subtopics_weighted FLOAT NOT NULL DEFAULT 0,
  covered_subtopics_weighted FLOAT NOT NULL DEFAULT 0,
  core_gaps JSONB DEFAULT '[]'::jsonb,
  borderline_matches JSONB DEFAULT '[]'::jsonb,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(audit_id, canonical_key, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_cluster_section_coverage_audit
  ON public.cluster_section_coverage(audit_id);

-- RLS: service_role full access (pipeline writes, dashboard reads via service key)
ALTER TABLE public.competitor_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cluster_section_coverage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access_competitor_sections"
  ON public.competitor_sections
  FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "service_role_full_access_cluster_section_coverage"
  ON public.cluster_section_coverage
  FOR ALL
  USING (true)
  WITH CHECK (true);
