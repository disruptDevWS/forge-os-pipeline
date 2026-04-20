# SMA Pre-Promotion Baseline Metrics

**Date:** 2026-04-20
**Audit ID:** c07eb21d-3120-4242-8754-361a429a6f2c
**Domain:** summitmedicalacademy.com
**Current canonicalize_mode:** legacy (on audits table)

## Keyword State

| Metric | Value |
|--------|-------|
| Total audit_keywords | 127 |
| Keywords with canonical_key | 127 |
| Distinct canonical_keys | 12 |
| Distinct canonical_topics | 12 |
| classification_method = prior_assignment_locked | 127 (100%) |
| Shadow columns populated | 127/127 (100%) |

## Cluster State

| Metric | Value |
|--------|-------|
| audit_clusters rows | 9 |
| Active clusters | 0 |
| cluster_strategy rows | 1 (deprecated) |
| cluster_performance_snapshots | 13 |

## Execution Pages

| Status | Count |
|--------|-------|
| deprecated | 39 |
| not_started | 33 |
| in_progress | 1 |
| **Total** | **73** |

## Architecture

| Metric | Value |
|--------|-------|
| agent_architecture_pages | 52 |
| agent_architecture_blueprint | 1 |

## Notes

- All 127 keywords are prior_assignment_locked — hybrid run expected to produce identical output
- 0 active clusters — no cluster_strategy will be disrupted
- 39 deprecated pages from prior re-runs — these stay deprecated
- 1 cluster_strategy is already deprecated (emt_basic_course from 2026-04-09 re-canonicalization)
