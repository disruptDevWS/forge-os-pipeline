-- Migration 022: Add search_intent to cluster_strategy
-- WS-C: Explicit intent label from Opus cluster strategy
-- Consumed by Pam for content-type guidance

ALTER TABLE public.cluster_strategy
  ADD COLUMN IF NOT EXISTS search_intent TEXT
  CHECK (search_intent IN ('commercial', 'informational', 'transactional', 'navigational', 'mixed'));
