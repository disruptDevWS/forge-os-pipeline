ALTER TABLE public.audits ADD COLUMN IF NOT EXISTS agent_pipeline_status TEXT;
ALTER TABLE public.audits ADD COLUMN IF NOT EXISTS agent_pipeline_domain TEXT;
CREATE TABLE IF NOT EXISTS public.agent_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_id UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
    agent_name TEXT NOT NULL,
    run_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'syncing',
    source_path TEXT,
    synced_at TIMESTAMPTZ DEFAULT now(),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
CREATE TABLE IF NOT EXISTS public.agent_technical_pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_id UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
    agent_run_id UUID REFERENCES public.agent_runs(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    status_code INTEGER,
    word_count INTEGER,
    title TEXT,
    h1 TEXT,
    meta_description TEXT,
    depth INTEGER,
    indexability TEXT,
    inlinks_count INTEGER,
    outlinks_count INTEGER,
    semantic_closest_url TEXT,
    semantic_similarity_score NUMERIC,
    semantic_flag TEXT,
    crawl_data JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
CREATE TABLE IF NOT EXISTS public.agent_architecture_pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_id UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
    agent_run_id UUID REFERENCES public.agent_runs(id) ON DELETE CASCADE,
    url_slug TEXT NOT NULL,
    page_status TEXT,
    silo_name TEXT,
    role TEXT,
    primary_keyword TEXT,
    primary_keyword_volume INTEGER,
    action_required TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
CREATE TABLE IF NOT EXISTS public.agent_architecture_blueprint (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_id UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
    agent_run_id UUID REFERENCES public.agent_runs(id) ON DELETE CASCADE,
    blueprint_markdown TEXT NOT NULL,
    executive_summary TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
CREATE TABLE IF NOT EXISTS public.agent_implementation_pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_id UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
    agent_run_id UUID REFERENCES public.agent_runs(id) ON DELETE CASCADE,
    url_slug TEXT NOT NULL,
    meta_title TEXT,
    meta_description TEXT,
    h1_recommendation TEXT,
    intent_classification TEXT,
    metadata_markdown TEXT,
    schema_json JSONB,
    content_outline_markdown TEXT,
    target_word_count INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_technical_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_architecture_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_architecture_blueprint ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_implementation_pages ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_agent_runs_audit_id ON public.agent_runs(audit_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_name ON public.agent_runs(agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_technical_pages_audit_id ON public.agent_technical_pages(audit_id);
CREATE INDEX IF NOT EXISTS idx_agent_architecture_pages_audit_id ON public.agent_architecture_pages(audit_id);
CREATE INDEX IF NOT EXISTS idx_agent_architecture_blueprint_audit_id ON public.agent_architecture_blueprint(audit_id);
CREATE INDEX IF NOT EXISTS idx_agent_implementation_pages_audit_id ON public.agent_implementation_pages(audit_id);

DROP POLICY IF EXISTS "Users can view own agent_runs" ON public.agent_runs;
CREATE POLICY "Users can view own agent_runs" ON public.agent_runs FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.audits WHERE audits.id = agent_runs.audit_id AND audits.user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can create own agent_runs" ON public.agent_runs;
CREATE POLICY "Users can create own agent_runs" ON public.agent_runs FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.audits WHERE audits.id = agent_runs.audit_id AND audits.user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can view own agent_technical_pages" ON public.agent_technical_pages;
CREATE POLICY "Users can view own agent_technical_pages" ON public.agent_technical_pages FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.audits WHERE audits.id = agent_technical_pages.audit_id AND audits.user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can create own agent_technical_pages" ON public.agent_technical_pages;
CREATE POLICY "Users can create own agent_technical_pages" ON public.agent_technical_pages FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.audits WHERE audits.id = agent_technical_pages.audit_id AND audits.user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can view own agent_architecture_pages" ON public.agent_architecture_pages;
CREATE POLICY "Users can view own agent_architecture_pages" ON public.agent_architecture_pages FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.audits WHERE audits.id = agent_architecture_pages.audit_id AND audits.user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can create own agent_architecture_pages" ON public.agent_architecture_pages;
CREATE POLICY "Users can create own agent_architecture_pages" ON public.agent_architecture_pages FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.audits WHERE audits.id = agent_architecture_pages.audit_id AND audits.user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can view own agent_architecture_blueprint" ON public.agent_architecture_blueprint;
CREATE POLICY "Users can view own agent_architecture_blueprint" ON public.agent_architecture_blueprint FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.audits WHERE audits.id = agent_architecture_blueprint.audit_id AND audits.user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can create own agent_architecture_blueprint" ON public.agent_architecture_blueprint;
CREATE POLICY "Users can create own agent_architecture_blueprint" ON public.agent_architecture_blueprint FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.audits WHERE audits.id = agent_architecture_blueprint.audit_id AND audits.user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can view own agent_implementation_pages" ON public.agent_implementation_pages;
CREATE POLICY "Users can view own agent_implementation_pages" ON public.agent_implementation_pages FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.audits WHERE audits.id = agent_implementation_pages.audit_id AND audits.user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can create own agent_implementation_pages" ON public.agent_implementation_pages;
CREATE POLICY "Users can create own agent_implementation_pages" ON public.agent_implementation_pages FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.audits WHERE audits.id = agent_implementation_pages.audit_id AND audits.user_id = auth.uid()));

