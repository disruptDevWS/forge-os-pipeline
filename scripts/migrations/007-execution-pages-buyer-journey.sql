-- 007-execution-pages-buyer-journey.sql
-- Add cluster strategy origin tracking to execution_pages

ALTER TABLE public.execution_pages
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'michael',
  ADD COLUMN IF NOT EXISTS buyer_stage TEXT,
  ADD COLUMN IF NOT EXISTS strategy_rationale TEXT;

COMMENT ON COLUMN public.execution_pages.source IS
  'Origin of this page recommendation: michael = architecture blueprint, cluster_strategy = buyer journey addition from cluster activation';
COMMENT ON COLUMN public.execution_pages.buyer_stage IS
  'Buyer journey stage this page targets: awareness | consideration | decision | retention. Null for standard architecture pages.';
COMMENT ON COLUMN public.execution_pages.strategy_rationale IS
  'Rationale from cluster strategy for why this page was recommended. Null for standard architecture pages.';
