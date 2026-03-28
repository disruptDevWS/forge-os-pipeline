-- Cluster Focus Migration
-- Run in Supabase SQL editor before deploying cluster focus code

-- Ensure canonical_key + canonical_topic on audit_clusters
ALTER TABLE public.audit_clusters
  ADD COLUMN IF NOT EXISTS canonical_key TEXT,
  ADD COLUMN IF NOT EXISTS canonical_topic TEXT;

-- Bridge: canonical_key on execution_pages
ALTER TABLE public.execution_pages
  ADD COLUMN IF NOT EXISTS canonical_key TEXT;

CREATE INDEX IF NOT EXISTS idx_execution_pages_canonical_key
  ON public.execution_pages(audit_id, canonical_key);

-- Cluster Focus: status columns on audit_clusters
ALTER TABLE public.audit_clusters
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'inactive'
    CHECK (status IN ('inactive', 'active', 'complete')),
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activated_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS target_publish_date DATE,
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- Cluster Focus: cluster_active flag on execution_pages
ALTER TABLE public.execution_pages
  ADD COLUMN IF NOT EXISTS cluster_active BOOLEAN DEFAULT false;

-- Cluster strategy table
CREATE TABLE IF NOT EXISTS public.cluster_strategy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  canonical_key TEXT NOT NULL,
  canonical_topic TEXT,
  strategy_markdown TEXT,
  recommended_pages JSONB,
  buyer_stages JSONB,
  format_gaps JSONB,
  ai_optimization_notes TEXT,
  generated_at TIMESTAMPTZ DEFAULT now(),
  model_used TEXT,
  UNIQUE(audit_id, canonical_key)
);

-- RLS (same pattern as other audit tables)
ALTER TABLE public.cluster_strategy ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'cluster_strategy' AND policyname = 'Users can read own cluster strategies'
  ) THEN
    CREATE POLICY "Users can read own cluster strategies" ON public.cluster_strategy
      FOR SELECT USING (audit_id IN (SELECT id FROM audits WHERE user_id = auth.uid()));
  END IF;
END $$;
