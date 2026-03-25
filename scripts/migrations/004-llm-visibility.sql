-- 004-llm-visibility.sql
-- LLM Mentions / AI Visibility tracking tables
-- Stores time-series mention data from DataForSEO LLM Mentions API
-- Both client and competitor mentions coexist in llm_visibility_snapshots (distinguished by domain column)

-- ============================================================
-- Table 1: llm_visibility_snapshots (time-series tracking)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.llm_visibility_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  snapshot_date DATE NOT NULL,
  keyword TEXT NOT NULL,
  platform TEXT NOT NULL,
  mention_count INTEGER NOT NULL DEFAULT 0,
  ai_search_volume INTEGER,
  top_citation_domains JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audit_id, snapshot_date, keyword, platform, domain)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_llm_vis_audit ON public.llm_visibility_snapshots(audit_id);
CREATE INDEX IF NOT EXISTS idx_llm_vis_audit_date ON public.llm_visibility_snapshots(audit_id, snapshot_date);

-- RLS
ALTER TABLE public.llm_visibility_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage llm_visibility_snapshots"
  ON public.llm_visibility_snapshots FOR ALL
  TO service_role
  USING (true);

CREATE POLICY "Users can view own llm_visibility_snapshots"
  ON public.llm_visibility_snapshots FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.audits
      WHERE public.audits.id = llm_visibility_snapshots.audit_id
        AND (public.audits.user_id = auth.uid() OR has_role(auth.uid(), 'super_admin'::app_role))
    )
  );

-- ============================================================
-- Table 2: llm_mention_details (qualitative mention records)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.llm_mention_details (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  platform TEXT NOT NULL,
  mention_text TEXT,
  citation_urls JSONB DEFAULT '[]',
  source_domains JSONB DEFAULT '[]',
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index
CREATE INDEX IF NOT EXISTS idx_llm_details_audit ON public.llm_mention_details(audit_id);

-- RLS
ALTER TABLE public.llm_mention_details ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage llm_mention_details"
  ON public.llm_mention_details FOR ALL
  TO service_role
  USING (true);

CREATE POLICY "Users can view own llm_mention_details"
  ON public.llm_mention_details FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.audits
      WHERE public.audits.id = llm_mention_details.audit_id
        AND (public.audits.user_id = auth.uid() OR has_role(auth.uid(), 'super_admin'::app_role))
    )
  );
