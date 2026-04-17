-- Migration 018: Add shadow columns for shadow-mode canonicalize comparison
--
-- Shadow mode runs both legacy (authoritative) and hybrid (comparison).
-- Legacy output writes to canonical_key/canonical_topic as normal.
-- Hybrid output in shadow mode writes to these shadow columns instead,
-- preserving legacy output for comparison analysis.
--
-- shadow_canonical_key / shadow_canonical_topic: hybrid's clustering decision
-- shadow_classification_method / shadow_similarity_score / shadow_arbitration_reason:
--   hybrid's classification metadata
--
-- These columns are NULL for non-shadow runs. Only populated by shadow mode.
-- Comparison script reads both column pairs to produce a diff report.

ALTER TABLE public.audit_keywords
  ADD COLUMN IF NOT EXISTS shadow_canonical_key TEXT,
  ADD COLUMN IF NOT EXISTS shadow_canonical_topic TEXT,
  ADD COLUMN IF NOT EXISTS shadow_classification_method TEXT,
  ADD COLUMN IF NOT EXISTS shadow_similarity_score FLOAT,
  ADD COLUMN IF NOT EXISTS shadow_arbitration_reason TEXT;
