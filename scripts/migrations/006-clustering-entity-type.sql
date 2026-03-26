-- 006-clustering-entity-type.sql
-- Add entity type classification to keywords/clusters and entity map to cluster strategy

-- Add entity type to audit_keywords (set by Phase 3c canonicalize)
ALTER TABLE public.audit_keywords
  ADD COLUMN IF NOT EXISTS primary_entity_type TEXT;

-- Add entity type to audit_clusters (aggregated from keywords in Phase 3d rebuild)
ALTER TABLE public.audit_clusters
  ADD COLUMN IF NOT EXISTS primary_entity_type TEXT DEFAULT 'Service';

-- Add entity map storage to cluster_strategy (from Section 0 Opus output)
ALTER TABLE public.cluster_strategy
  ADD COLUMN IF NOT EXISTS entity_map JSONB;

COMMENT ON COLUMN public.audit_keywords.primary_entity_type IS
  'Schema.org entity type assigned by Phase 3c canonicalize';
COMMENT ON COLUMN public.audit_clusters.primary_entity_type IS
  'Schema.org entity type for cluster pillar page (Service, Course, Product, LocalBusiness, FAQPage, Article)';
COMMENT ON COLUMN public.cluster_strategy.entity_map IS
  'Entity map from Cluster Strategy Section 0 — canonical entity definition, key attributes, related entities';
