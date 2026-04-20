# Canonicalize Hybrid Mode — Rollout Checklist

## Overview

Hybrid canonicalize replaces Sonnet-only semantic grouping with vector pre-clustering (embeddings) plus Sonnet arbitration for edge cases. This document tracks the rollout sequence from shadow validation through full migration.

## Architecture

- **Legacy mode** (`--canonicalize-mode legacy`): Current Sonnet-only behavior. Default.
- **Hybrid mode** (`--canonicalize-mode hybrid`): Vector pre-clustering + Sonnet arbitration. Authoritative output.
- **Shadow mode** (`--canonicalize-mode shadow`): Runs both legacy (authoritative) and hybrid (comparison). Legacy output written first, hybrid second with `canonicalize_mode='shadow_hybrid'`.

Hybrid handles ONLY `canonical_key` and `canonical_topic` clustering. Other fields (`is_brand`, `is_near_me`, `intent_type`, `primary_entity_type`) remain Sonnet-based in all modes.

## Thresholds

| Threshold | Value | Meaning |
|-----------|-------|---------|
| Auto-assign | >= 0.82 | Single centroid match above this → auto-assign |
| Ambiguity band | 0.75 – 0.82 | Multiple matches or borderline → Sonnet arbitration |
| Below floor | < 0.75 | No match → new topic candidate → Sonnet arbitration |

**History:** Auto-assign threshold lowered from 0.85 → 0.82 on 2026-04-20 (Phase 2.1). IMA shadow data showed 82/83 cases in the 0.80–0.85 band were assign_existing Sonnet arbitrations (98.8% agreement with vector layer). Comparison report: `scratch/shadow-reports/phase-2.1-threshold-tuning-2026-04-20.md`.

## Rollout Sequence

### Phase 1: Embedding Infrastructure (complete)
- [x] Deploy pgvector 0.8.0 with HNSW cosine index on Supabase
- [x] OpenAI text-embedding-3-small (1536 dimensions) integration
- [x] Migrations 016 + 017 applied
- [x] `--canonicalize-mode legacy` remains default

### Phase 2: Hybrid Implementation & Shadow Validation (complete)
- [x] Hybrid module implemented (pre-cluster + arbitrator + persist)
- [x] Shadow mode validated on SMA (87.4% agreement with legacy, 127 keywords)
- [x] Shadow mode validated on IMA (54.0% agreement with legacy, 1000 keywords)
- [x] Re-run stability confirmed (100% prior-lock rate on SMA second run)
- [x] Snapshot protocol bug fixed (prior hybrid assignments preserved across legacy overwrites)
- [x] Arbitration batching implemented (40 cases per Sonnet call)
- [x] Migration 018 applied (shadow columns)
- [x] 3 bugs caught and fixed during validation

### Phase 2.1: Threshold Tuning (complete — this session)
- [x] Auto-assign threshold lowered from 0.85 → 0.82
- [x] IMA auto-assign rate: 5.6% → 10.7% (nearly doubled)
- [x] Pre-vs-post comparison: 76% same-cluster in 0.82–0.85 band (conservative lower bound due to taxonomy drift)
- [x] All disagreements categorically benign (more specific routing, not coarser merges)
- [x] SMA stability regression: 100% prior-lock, zero behavioral change
- [x] Promotion criteria documented (see below)
- [x] Report: `scratch/shadow-reports/phase-2.1-threshold-tuning-2026-04-20.md`

### Phase 2.2: Single-Member Cluster Size Gate (complete — this session)
- [x] MIN_CLUSTER_SIZE_FOR_AUTO_ASSIGN = 3 constant with rationale comment
- [x] Size gate: auto-assign requires cluster to have 3+ members; otherwise route to Sonnet arbitration
- [x] Lock precedence preserved (lock evaluates before size gate)
- [x] New classification method: `sonnet_arbitration_size_gated` for audit trail
- [x] SMA stability regression: 100% prior-lock, 0 size-gated — PASSES
- [x] IMA behavioral validation: 50 size-gated, 62.7% redirected to different cluster by Sonnet
- [x] N=3 calibration confirmed (9/57 IMA clusters gated, 5% of corpus, ~1 extra Sonnet batch)
- [x] 3 new tests + existing tests updated (55/55 passing)
- [x] Report: `scratch/shadow-reports/phase-2.2-size-gate-2026-04-20.md`
- [x] No client promoted to hybrid default (per specification)

### Phase 2.3a: Downstream Consumer Readiness Review (complete — 2026-04-20)
- [x] 6 known consumers reviewed: rebuildClustersAndRollups, generateClusterStrategy, syncMichael, generate-brief (Pam), ClustersPage, PerformancePage
- [x] 8 additional consumers discovered: StrategyPage, ExecutionPage, AuditSettings, AuditSidebar, ResearchPage, OverviewPage, track-rankings, pipeline-generate
- [x] Classification: 1 READY WITH MONITORING (Pam keyword-join), 5 READY, 0 BLOCKS PROMOTION
- [x] Architecture persistence verified via 3 scenario traces
- [x] Report: `docs/phase-2.3a-downstream-readiness-2026-04-20.md`

### Phase 2.3b: First Production Hybrid Promotion — SMA (complete — 2026-04-20)
- [x] SMA promoted from `canonicalize_mode='legacy'` to `canonicalize_mode='hybrid'`
- [x] `canonicalize_mode` column added to `audits` table (was CLI flag only)
- [x] Full pipeline run completed (Phases 3c→6d + client brief)
- [x] env propagation fix applied to `pipeline-generate.ts` (blocking issue)
- [x] Smoke test checklist executed — all items pass except 1 observation
- [x] **OBSERVATION: 21 of 127 keywords (16.5%) have different canonical_key post-promotion despite prior-lock**
- [x] Zero operational impact on SMA (0 active clusters, no committed content affected)
- [x] Performance data intact, no data loss
- [x] Outcome: **SUCCESS WITH OBSERVATIONS**
- [x] Report: `docs/phase-2.3b-sma-promotion-2026-04-20.md`

### Phase 2.3c: Fix canonical_key drift (next session)
- [ ] Debug why hybrid pre-cluster's `existingTopics` shows 14 topics when prior snapshot has 12 distinct keys
- [ ] Fix topicMap construction to be purely snapshot-derived when all keywords are hybrid-origin
- [ ] Re-run SMA in hybrid mode to validate fix (expect 0 drift on locked audit)
- [ ] Then proceed to IMA promotion

### Phase 2.4: IMA Promotion (blocked on 2.3c)
- [ ] IMA has active clusters and committed content — requires deterministic prior-lock
- [ ] Must validate canonical_key drift fix first

### Phase 3: Scout Deduplication (future)
- [ ] Reuse embedding infrastructure for Scout keyword deduplication

### Phase 4: Gap Section-Level Semantic Coverage (future)
- [ ] Semantic matching for content gap analysis

## Promotion Criteria

A client may be promoted from `canonicalize_mode='legacy'` (default) to
`canonicalize_mode='hybrid'` (default) only when ALL of the following are met:

### Re-run stability
- Second hybrid run on the same audit produces 100% prior-lock rate
- Output is byte-identical across two consecutive hybrid runs with no input changes
- No variants move between canonical topics between runs

### Quality direction
- Agreement rate with legacy >50%
- Disagreements are categorically either:
  - Hybrid splitting legacy's coarse buckets into more granular topics reflecting
    distinct search intents, OR
  - Hybrid creating legitimate new clusters for intents legacy missed
- No disagreements where hybrid merges legacy's distinct clusters into coarser groupings
- No systematic bias toward any single cluster (verified by reviewing top-5 largest
  clusters for centroid-proximity artifacts)

### Efficiency indicators
- Auto-assign rate >20% on second hybrid run (confirms vector layer doing meaningful
  work, not just acting as arbitration trigger)
- Sonnet arbitration rate trending toward <50% of first-run value on re-runs

### Single-member cluster behavior
- Size-gated keywords (routed to Sonnet due to cluster <3 members) should show >50%
  redirect rate (Sonnet choosing a different cluster than vector proximity suggested)
- If redirect rate drops below 30%, N=3 threshold should be re-evaluated
- Lock precedence must hold: prior-locked keywords are never size-gated

### Consistency across audits
- Pattern confirmed across at least two shadow runs on different audits
  (domain variety preferred — different verticals, different keyword corpus sizes)

### Operational
- No open bugs in hybrid module affecting the specific client's domain
- Claude Code Anthropic API key usage for arbitration within expected budget
- Downstream consumers (Cluster Strategy, Gap, Michael, Pam) not modified since last
  validation run

### Promotion process
1. Client opted in explicitly (not blanket rollout)
2. First production hybrid run compared against prior legacy run for same audit
3. Cluster Strategy, Michael, Pam outputs compared against prior runs
4. If downstream consumers produce coherent output with no schema violations or
   missing canonical_key references, client remains on hybrid for next cycle
5. If downstream regressions appear, immediate rollback to legacy mode, bug filed

---

## Cost Impact

- **Shadow mode**: ~2x cost per canonicalize run (runs both paths). Acceptable for validation, not long-term.
- **Hybrid mode**: Lower Sonnet cost (only arbitration cases) + OpenAI embedding cost (~$0.0001 per keyword). Net cheaper than legacy for audits with > 50 keywords.
- **Embedding cost**: text-embedding-3-small at $0.02/1M tokens. 300 keywords ≈ 3000 tokens ≈ $0.00006. Negligible.

## Re-run Stability

Hybrid mode locks prior assignments on re-run when ALL three conditions are met:
1. Prior `canonical_key` exists on the keyword
2. That canonical topic still exists in the current run
3. Prior assignment was hybrid-originated (`classification_method IS NOT NULL`)

Hybrid's first run after legacy runs does NOT inherit legacy clustering — this is by design. The first hybrid run re-evaluates everything, then subsequent hybrid re-runs are stable.

## Monitoring Queries

```sql
-- Classification method distribution for an audit
SELECT classification_method, count(*)
FROM audit_keywords
WHERE audit_id = '<uuid>'
  AND classification_method IS NOT NULL
GROUP BY classification_method;

-- Shadow comparison: agreement rate
SELECT
  count(*) FILTER (WHERE canonicalize_mode IS NULL OR canonicalize_mode = 'legacy') AS legacy_rows,
  count(*) FILTER (WHERE canonicalize_mode = 'shadow_hybrid') AS hybrid_rows
FROM audit_keywords
WHERE audit_id = '<uuid>';

-- Average similarity scores by method
SELECT classification_method, avg(similarity_score), min(similarity_score), max(similarity_score)
FROM audit_keywords
WHERE audit_id = '<uuid>'
  AND similarity_score IS NOT NULL
GROUP BY classification_method;
```
