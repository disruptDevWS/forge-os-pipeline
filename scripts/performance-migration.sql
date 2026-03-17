-- Performance Layer Migration
-- Creates ranking_snapshots, cluster_performance_snapshots, page_performance tables,
-- ranking_deltas view, and adds published_at to execution_pages.

-- 1. ranking_snapshots — per-keyword per-date position data
CREATE TABLE IF NOT EXISTS public.ranking_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  keyword TEXT NOT NULL,
  rank_position INTEGER,  -- null = tracked but not in DataForSEO top 1000
  ranking_url TEXT,
  search_volume INTEGER,
  canonical_key TEXT,
  cluster TEXT,
  is_brand BOOLEAN DEFAULT false,
  intent_type TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(audit_id, snapshot_date, keyword)
);

CREATE INDEX IF NOT EXISTS idx_ranking_snapshots_audit_date
  ON public.ranking_snapshots(audit_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_ranking_snapshots_canonical
  ON public.ranking_snapshots(audit_id, canonical_key);

-- 2. cluster_performance_snapshots — pre-aggregated cluster metrics
CREATE TABLE IF NOT EXISTS public.cluster_performance_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  canonical_key TEXT NOT NULL,
  canonical_topic TEXT,
  keyword_count INTEGER,
  avg_position NUMERIC(6,2),
  keywords_p1_3 INTEGER DEFAULT 0,
  keywords_p4_10 INTEGER DEFAULT 0,
  keywords_p11_30 INTEGER DEFAULT 0,
  keywords_p31_100 INTEGER DEFAULT 0,
  total_volume INTEGER DEFAULT 0,
  estimated_traffic NUMERIC(10,2),
  revenue_low NUMERIC(12,2),
  revenue_mid NUMERIC(12,2),
  revenue_high NUMERIC(12,2),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(audit_id, snapshot_date, canonical_key)
);

-- 3. page_performance — post-publication page tracking
CREATE TABLE IF NOT EXISTS public.page_performance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES public.audits(id) ON DELETE CASCADE,
  execution_page_id UUID REFERENCES public.execution_pages(id),
  url_slug TEXT NOT NULL,
  silo TEXT,
  snapshot_date DATE NOT NULL,
  published_at TIMESTAMPTZ,
  pre_publish_avg_position NUMERIC(6,2),
  current_avg_position NUMERIC(6,2),
  keywords_gained_p1_10 INTEGER DEFAULT 0,
  keywords_total INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(audit_id, url_slug, snapshot_date)
);

-- 4. Add published_at column to execution_pages
ALTER TABLE public.execution_pages
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

-- 5. Enable RLS on new tables
ALTER TABLE public.ranking_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cluster_performance_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.page_performance ENABLE ROW LEVEL SECURITY;

-- 6. RLS Policies — ranking_snapshots
CREATE POLICY "Users can view own ranking_snapshots"
  ON public.ranking_snapshots FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.audits
    WHERE audits.id = ranking_snapshots.audit_id
    AND (audits.user_id = auth.uid() OR public.has_role(auth.uid(), 'super_admin'))
  ));

CREATE POLICY "Service role can manage ranking_snapshots"
  ON public.ranking_snapshots FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 7. RLS Policies — cluster_performance_snapshots
CREATE POLICY "Users can view own cluster_performance_snapshots"
  ON public.cluster_performance_snapshots FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.audits
    WHERE audits.id = cluster_performance_snapshots.audit_id
    AND (audits.user_id = auth.uid() OR public.has_role(auth.uid(), 'super_admin'))
  ));

CREATE POLICY "Service role can manage cluster_performance_snapshots"
  ON public.cluster_performance_snapshots FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 8. RLS Policies — page_performance
CREATE POLICY "Users can view own page_performance"
  ON public.page_performance FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.audits
    WHERE audits.id = page_performance.audit_id
    AND (audits.user_id = auth.uid() OR public.has_role(auth.uid(), 'super_admin'))
  ));

CREATE POLICY "Service role can manage page_performance"
  ON public.page_performance FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 9. ranking_deltas view — SQL-side delta computation
-- Dashboard hooks query this view, not the raw ranking_snapshots table.
-- Positive position_delta = improvement, negative = regression.
CREATE OR REPLACE VIEW public.ranking_deltas AS
SELECT
  r_latest.audit_id,
  r_latest.keyword,
  r_latest.canonical_key,
  r_latest.cluster,
  r_latest.snapshot_date AS latest_date,
  r_latest.rank_position AS current_position,
  r_first.rank_position AS baseline_position,
  r_first.snapshot_date AS baseline_date,
  (r_first.rank_position - r_latest.rank_position) AS position_delta,
  r_latest.search_volume
FROM public.ranking_snapshots r_latest
JOIN (
  SELECT DISTINCT ON (audit_id, keyword)
    audit_id, keyword, rank_position, snapshot_date
  FROM public.ranking_snapshots
  WHERE rank_position IS NOT NULL
  ORDER BY audit_id, keyword, snapshot_date ASC
) r_first ON r_first.audit_id = r_latest.audit_id
         AND r_first.keyword = r_latest.keyword
WHERE r_latest.snapshot_date = (
  SELECT MAX(snapshot_date)
  FROM public.ranking_snapshots rs2
  WHERE rs2.audit_id = r_latest.audit_id
);
