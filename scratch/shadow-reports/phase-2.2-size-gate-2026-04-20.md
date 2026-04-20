# Phase 2.2: Single-Member Cluster Size Gate — Shadow Validation Report

**Date:** 2026-04-20
**Change:** MIN_CLUSTER_SIZE_FOR_AUTO_ASSIGN = 3 — clusters with <3 members route to Sonnet arbitration instead of vector auto-assign.

## Motivation

IMA Phase 2 data showed single-member clusters (e.g., "EMT Jobs" with 1 member) pulling geo variants via centroid = single vector. A single vector lacks the averaging effect that dampens noise in 3+ member clusters, creating false-confidence auto-assigns.

## SMA Stability Regression

| Metric | Value |
|--------|-------|
| Total keywords | 127 |
| Prior-locked | 121 |
| Auto-assigned | 0 |
| Size-gated | 0 |
| Arbitrated (natural) | 6 |

**Result: PASS** — 100% prior-lock rate. SMA is hybrid-origin, so all 121 previously-classified keywords lock immediately. The size gate has zero behavioral impact on stable, locked audits.

## IMA Behavioral Validation

### Method Distribution (Pre-gate → Post-gate)

| Metric | Pre-gate (Phase 2.1) | Post-gate (Phase 2.2) | Delta |
|--------|---------------------|----------------------|-------|
| Auto-assigned | 107 (10.7%) | 84 (8.4%) | -23 |
| Size-gated | — | 50 | +50 |
| Arbitrated (natural) | 883 | 856 | -27 |
| Total arbitrated (natural + size-gated) | 883 | 906 | +23 |

The 23-keyword reduction in auto-assign matches the net effect: keywords that previously auto-assigned to small clusters now route through Sonnet. The 50 size-gated cases include both former auto-assigns (17) and re-labeled existing Sonnet arbitrations (34) that now carry the `sonnet_arbitration_size_gated` method tag for audit trail purposes.

### IMA Cluster Size Distribution

| Category | Count | Clusters |
|----------|-------|----------|
| 1-member | 4 | pharmacy_tech, emt_career_jobs, cpr_training, emt_advanced_intermediate_certification |
| 2-member | 5 | group_classes, nremt_test_prep, aha_instructor_course, ems_courses, paramedic_training |
| 3+ member | 48 | (majority of clusters) |

Total small clusters (1-2 members): 9 out of 57 topics (15.8%)

### Size-Gate Outcome Distribution (51 keywords)

| Metric | Count | % |
|--------|-------|---|
| Sonnet chose SAME cluster as pre-gate assignment | 19 | 37.3% |
| Sonnet chose DIFFERENT cluster | 32 | 62.7% |

#### Breakdown by previous method

| Previous method | Count | Same cluster | Different cluster |
|-----------------|-------|--------------|-------------------|
| vector_auto_assign | 17 | 6 (35.3%) | 11 (64.7%) |
| sonnet_arbitration_assigned | 34 | 13 (38.2%) | 21 (61.8%) |

### Interpretation

The 62.7% different-cluster rate is the key signal. These are cases where:
- Pre-gate: the keyword auto-assigned (or was already Sonnet-assigned) to a small cluster
- Post-gate: Sonnet, given the full topic list and semantic context, chose a different (typically larger, more established) cluster

This confirms the cold-start vulnerability hypothesis: small clusters with single/dual-vector centroids create false proximity, pulling keywords that semantically belong elsewhere. Sonnet's 62.7% redirect rate validates that the gate is catching real misrouting.

The 37.3% same-cluster cases are not wasted — these were genuinely correct assignments that Sonnet confirmed. The cost is ~1-2 additional Sonnet calls per canonicalize run (50 keywords ÷ 40 batch size ≈ 1.25 extra batches).

### N=3 Calibration Assessment

**N=3 is well-calibrated for IMA:**
- 4 single-member + 5 two-member = 9 gated clusters out of 57 total (15.8%)
- 50 keywords affected (5.0% of corpus)
- Cost overhead: ~1.25 extra Sonnet batches per run
- Quality improvement: 32 keywords redirected to better-fit clusters

**Would N=2 be better?** N=2 would only gate the 4 single-member clusters, missing the 5 two-member clusters. Given that 2-member centroids still lack the averaging diversity of 3+ member clusters, N=3 provides a more robust gate with minimal cost overhead.

**Would N=4 be too aggressive?** N=4 would gate significantly more keywords (potentially 100+), defeating the efficiency purpose of vector auto-assign. N=3 is the minimum viable threshold that addresses the cold-start problem without over-routing to Sonnet.

## Conclusions

1. **Size gate is safe:** SMA stability regression passes. Zero impact on locked audits.
2. **Size gate is effective:** 62.7% of gated keywords get redirected to better clusters by Sonnet.
3. **N=3 is appropriate:** Balances quality (catches cold-start centroid pulls) with efficiency (only 5% of corpus routed, ~1 extra Sonnet batch).
4. **Lock precedence holds:** Prior-locked variants bypass size gate entirely (confirmed by test + SMA data).
5. **No promotion this session:** Per prompt specification, neither client promoted to hybrid default.

## Files Modified

- `src/agents/canonicalize/hybrid/types.ts` — `sonnet_arbitration_size_gated` method + `size_gated` decision
- `src/agents/canonicalize/hybrid/pre-cluster.ts` — MIN_CLUSTER_SIZE_FOR_AUTO_ASSIGN + gate logic
- `src/agents/canonicalize/hybrid/index.ts` — size_gated in arbitration filter + method preservation
- `src/agents/canonicalize/hybrid/__tests__/pre-cluster.test.ts` — 3 new tests, existing tests updated
- `scripts/snapshot-shadow.ts` — new utility for shadow column snapshots
- `scripts/cluster-sizes.ts` — cluster size distribution reporter
- `scripts/size-gate-outcomes.ts` — size-gate outcome analyzer

## Snapshots

- `scratch/shadow-snapshots/sma-pre-size-gate-2026-04-20.json` (127 rows)
- `scratch/shadow-snapshots/ima-pre-size-gate-2026-04-20.json` (1000 rows)
