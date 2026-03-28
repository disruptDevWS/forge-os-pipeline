-- Forge OS Restructuring Migration
-- Run against Supabase SQL Editor
-- ============================================================

-- 0. Ensure updated_at trigger function exists
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 1.1 Add staleness timestamps to audits
ALTER TABLE public.audits ADD COLUMN IF NOT EXISTS research_snapshot_at TIMESTAMPTZ;
ALTER TABLE public.audits ADD COLUMN IF NOT EXISTS audit_snapshot_at TIMESTAMPTZ;
ALTER TABLE public.audits ADD COLUMN IF NOT EXISTS strategy_snapshot_at TIMESTAMPTZ;
ALTER TABLE public.audits ADD COLUMN IF NOT EXISTS execution_snapshot_at TIMESTAMPTZ;

-- 1.2 Enhance agent_runs
ALTER TABLE public.agent_runs ADD COLUMN IF NOT EXISTS triggered_by TEXT;
ALTER TABLE public.agent_runs ADD COLUMN IF NOT EXISTS cost_usd NUMERIC;
ALTER TABLE public.agent_runs ADD COLUMN IF NOT EXISTS snapshot_version INT DEFAULT 1;

-- 1.2 Enhance agent_technical_pages
ALTER TABLE public.agent_technical_pages ADD COLUMN IF NOT EXISTS snapshot_version INT DEFAULT 1;
ALTER TABLE public.agent_technical_pages ADD COLUMN IF NOT EXISTS prioritized_fixes JSONB;
ALTER TABLE public.agent_technical_pages ADD COLUMN IF NOT EXISTS agentic_readiness JSONB;

-- 1.2 Enhance agent_architecture_pages
ALTER TABLE public.agent_architecture_pages ADD COLUMN IF NOT EXISTS snapshot_version INT DEFAULT 1;
ALTER TABLE public.agent_architecture_pages ADD COLUMN IF NOT EXISTS cannibalization_pairs JSONB;
ALTER TABLE public.agent_architecture_pages ADD COLUMN IF NOT EXISTS internal_links JSONB;

-- 1.2 Enhance agent_architecture_blueprint
ALTER TABLE public.agent_architecture_blueprint ADD COLUMN IF NOT EXISTS snapshot_version INT DEFAULT 1;
ALTER TABLE public.agent_architecture_blueprint ADD COLUMN IF NOT EXISTS decision_log JSONB;

-- 1.3 Create execution_pages table
CREATE TABLE IF NOT EXISTS public.execution_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
  agent_run_id UUID REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  url_slug TEXT NOT NULL,
  silo TEXT,
  priority INT,
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'brief_ready', 'in_progress', 'review', 'published')),
  -- Page brief from Michael (always populated)
  page_brief JSONB,
  -- Pam fields (nullable until Pam runs)
  meta_title TEXT,
  meta_description TEXT,
  h1_recommendation TEXT,
  intent_classification TEXT,
  metadata_markdown TEXT,
  schema_json JSONB,
  content_outline_markdown TEXT,
  target_word_count INT,
  deliverable_checklist JSONB DEFAULT '[]',
  snapshot_version INT DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Updated_at trigger for execution_pages
CREATE TRIGGER set_execution_pages_updated_at
  BEFORE UPDATE ON public.execution_pages
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

-- 1.4 Create baseline_snapshots table
CREATE TABLE IF NOT EXISTS public.baseline_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  baseline_rank INT NOT NULL,
  baseline_volume INT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audit_id, keyword)
);

-- 1.5 Create audit_snapshots table
CREATE TABLE IF NOT EXISTS public.audit_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  snapshot_version INT NOT NULL,
  agent_run_id UUID REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  row_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audit_id, agent_name, snapshot_version)
);

-- 1.6 Enable RLS on new tables
ALTER TABLE public.execution_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baseline_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_snapshots ENABLE ROW LEVEL SECURITY;

-- RLS Policies for execution_pages
CREATE POLICY "Users can view own execution_pages"
  ON public.execution_pages FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.audits
    WHERE audits.id = execution_pages.audit_id
    AND audits.user_id = auth.uid()
  ));

CREATE POLICY "Users can create own execution_pages"
  ON public.execution_pages FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.audits
    WHERE audits.id = execution_pages.audit_id
    AND audits.user_id = auth.uid()
  ));

CREATE POLICY "Users can update own execution_pages"
  ON public.execution_pages FOR UPDATE
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.audits
    WHERE audits.id = execution_pages.audit_id
    AND audits.user_id = auth.uid()
  ));

-- RLS Policies for baseline_snapshots
CREATE POLICY "Users can view own baseline_snapshots"
  ON public.baseline_snapshots FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.audits
    WHERE audits.id = baseline_snapshots.audit_id
    AND audits.user_id = auth.uid()
  ));

CREATE POLICY "Users can create own baseline_snapshots"
  ON public.baseline_snapshots FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.audits
    WHERE audits.id = baseline_snapshots.audit_id
    AND audits.user_id = auth.uid()
  ));

-- RLS Policies for audit_snapshots
CREATE POLICY "Users can view own audit_snapshots"
  ON public.audit_snapshots FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.audits
    WHERE audits.id = audit_snapshots.audit_id
    AND audits.user_id = auth.uid()
  ));

CREATE POLICY "Users can create own audit_snapshots"
  ON public.audit_snapshots FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.audits
    WHERE audits.id = audit_snapshots.audit_id
    AND audits.user_id = auth.uid()
  ));

-- Indexes for new tables
CREATE INDEX IF NOT EXISTS idx_execution_pages_audit_id ON public.execution_pages(audit_id);
CREATE INDEX IF NOT EXISTS idx_execution_pages_status ON public.execution_pages(status);
CREATE INDEX IF NOT EXISTS idx_baseline_snapshots_audit_id ON public.baseline_snapshots(audit_id);
CREATE INDEX IF NOT EXISTS idx_audit_snapshots_audit_id ON public.audit_snapshots(audit_id);
CREATE INDEX IF NOT EXISTS idx_audit_snapshots_agent ON public.audit_snapshots(audit_id, agent_name);

-- 1.7 Data migration: copy agent_implementation_pages → execution_pages
INSERT INTO public.execution_pages (
  audit_id, agent_run_id, url_slug, status,
  meta_title, meta_description, h1_recommendation,
  intent_classification, metadata_markdown, schema_json,
  content_outline_markdown, target_word_count
)
SELECT
  ip.audit_id, ip.agent_run_id, ip.url_slug, 'brief_ready',
  ip.meta_title, ip.meta_description, ip.h1_recommendation,
  ip.intent_classification, ip.metadata_markdown, ip.schema_json,
  ip.content_outline_markdown, ip.target_word_count
FROM public.agent_implementation_pages ip
ON CONFLICT DO NOTHING;

-- Backfill page_brief from architecture pages
UPDATE public.execution_pages ep
SET page_brief = jsonb_build_object(
  'silo_name', ap.silo_name,
  'role', ap.role,
  'primary_keyword', ap.primary_keyword,
  'primary_keyword_volume', ap.primary_keyword_volume,
  'action_required', ap.action_required,
  'page_status', ap.page_status
),
silo = ap.silo_name,
priority = CASE
  WHEN ap.action_required = 'create' THEN 1
  WHEN ap.action_required = 'optimize' THEN 2
  WHEN ap.action_required = 'differentiate' THEN 3
  ELSE 4
END
FROM public.agent_architecture_pages ap
WHERE ap.audit_id = ep.audit_id
  AND ap.url_slug = ep.url_slug
  AND ep.page_brief IS NULL;
