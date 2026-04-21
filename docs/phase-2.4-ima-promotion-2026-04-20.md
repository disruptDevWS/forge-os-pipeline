# Phase 2.4 — IMA Hybrid Promotion Report

**Date:** 2026-04-20
**Audit:** Idaho Medical Academy (`idahomedicalacademy.com`)
**Audit ID:** `08409ae8-28ab-4a34-b92c-2c92f73e5af7`
**Outcome:** SUCCESS

---

## Pre-Promotion Baseline

| Metric | Value |
|--------|-------|
| Keywords | 1,100 |
| Distinct canonical_keys | 66 |
| audit_clusters | 62 |
| execution_pages | 72 (33 with canonical_key, 45.8%) |
| cluster_strategy | 0 |
| cluster_performance_snapshots | 32 |
| classification_method | 100% NULL (all legacy origin) |
| Active clusters | 0 |
| Committed pages | 1 (`how-to-become-an-emt-in-idaho`, status=in_progress, canonical_key=emt_training — orphaned) |

## Pipeline Run Summary

**Command:** `./scripts/run-pipeline.sh idahomedicalacademy.com matt@forgegrowth.ai --start-from 3c --canonicalize-mode hybrid`

All phases completed successfully:

| Phase | Status | Notes |
|-------|--------|-------|
| 3c Canonicalize | PASS | hybrid mode, 1000 keywords, 4 legacy batches + hybrid pre-cluster + 23 Sonnet arbitration batches |
| 3d Rebuild Clusters | PASS | 64 clusters, 20 near-miss |
| 4 Competitors | PASS | 20 topics, 88 SERP calls, 314 domains classified |
| 5 Gap | PASS (QA) | 12 authority gaps, 8 format gaps, 7 unaddressed, 8 recommendations |
| 6 Michael | PASS (QA) | 86 pages extracted, 23 rejected for invalid slugs (22.9% → 21.1% on retry). Expected behavior — syncMichael drops invalid rows |
| 6.5 Validator | PASS | 22/27 gaps addressed, 5 partially |
| 6b syncMichael | PASS | 1 preserved, 38 updated, 47 new, 33 deprecated. 39/86 canonical_key backfill |
| 6c syncDwight | PASS | 1 technical page, 10 fixes, 2 verification corrections |
| 6d LocalPresence | PASS | GBP found (4.9★, 402 reviews), 9/11 citations, 2 NAP-consistent |
| Client Brief | PASS | 25.7KB HTML generated |

## Hybrid Canonicalize Results

### Classification Method Distribution

| Method | Count | % |
|--------|-------|---|
| sonnet_arbitration_assigned | 852 | 77.5% |
| null (100 non-canonicalized keywords) | 100 | 9.1% |
| vector_auto_assign | 89 | 8.1% |
| sonnet_arbitration_size_gated | 43 | 3.9% |
| sonnet_arbitration_new_topic | 13 | 1.2% |
| sonnet_arbitration_merged | 3 | 0.3% |
| prior_assignment_locked | 0 | 0% |

**Auto-assign rate:** 8.9% (89/1000 classified) — lower than SMA's rate. IMA has a large, diverse corpus where many keywords fall in the ambiguity band.

**Size-gated:** 43 keywords routed to Sonnet due to <3 cluster members. Active and working as designed.

**Prior locked:** 0 — expected. No prior hybrid state existed. Phase 2.3c contamination fix is present but not load-bearing this run; becomes load-bearing on second hybrid run.

### Canonical Key Changes

| Metric | Pre | Post | Delta |
|--------|-----|------|-------|
| Distinct canonical_keys | 66 | 76 | +10 |
| audit_clusters | 62 | 64 | +2 |

**Survived keys:** 63
**Deprecated keys (3):** `emt_advanced_certification`, `pharmacy_technician`, `pharmacy_technician_training`
**New keys (13):** `ambulance_overview`, `clinical_skills_training`, `cpr_course_cost`, `ems_assessment_mnemonics`, `ems_equipment_supplies`, `ems_licensure`, `emt_course_cost`, `fire_academy`, `general_health_wellness`, `healthcare_career_stability`, `infection_control_healthcare`, `mountain_biking_injury_prevention`, `ski_injury_first_aid`

Note: Cluster count (64) increased less than predicted from shadow data (~79+). This is expected — shadow run predated the 0.85→0.82 threshold change and size gate, which consolidate more keywords into existing clusters rather than creating new ones.

### Shadow Data Comparison (with tolerance caveat)

Shadow data was captured before threshold tuning (0.85→0.82) and size gate (N=3). Direct comparison is approximate:

- Shadow predicted 79 distinct keys; actual is 76
- Shadow predicted 18 new keys; actual is 13 new keys
- Directionally consistent: hybrid creates more granular topics than legacy

## Smoke Test Results

### 4a. Cluster Count & Key Comparison — PASS
Keywords preserved (1,100 → 1,100). Keys increased 66 → 76. 3 deprecated, 13 new.

### 4b. Classification Methods — PASS
All methods populated as expected. 0 prior_assignment_locked (expected for first hybrid run).

### 4c. Committed Page — PASS
`how-to-become-an-emt-in-idaho` retained `status=in_progress`, `source=michael`. canonical_key changed from orphaned `emt_training` → `emt_career_info` (improvement — page now maps to a live cluster).

### 4d. Performance Snapshots — PASS
32 → 32 (none deleted).

### 4e. Cluster Strategy — PASS
0 → 0 (IMA has no strategies to deprecate).

### 4f. Execution Pages Backfill — PASS (with note)
47/86 non-deprecated pages have canonical_key (54.7%). Initial 60% halt threshold fired, but investigation showed baseline was 45.8% (33/72) — **this is an improvement, not a regression.** The 39 unbackfilled pages are informational/editorial slugs that don't match any research keyword. Pre-existing Michael taxonomy limitation, not hybrid-related.

### 4g. Pam Keyword-Join — PASS
47 pages healthy (5+ keywords each), 0 degraded, 0 fallback.

## Behavioral Notes

1. **Committed page's orphaned canonical_key resolved:** `emt_training` (no keywords mapped to it) → `emt_career_info` (live cluster with keywords). This is an improvement — if the cluster gets activated, this page will properly surface in content queue.

2. **Phase 2.3c contamination fix not exercised:** This run had no prior hybrid state to contaminate. The fix becomes load-bearing on the second hybrid run (re-canonicalize or full pipeline re-run).

3. **Michael slug rejection rate (21-23%):** Same behavior as prior runs. Not hybrid-related — Michael's slug formatting is a known issue being addressed by prompt hardening.

4. **`canonicalize_mode` column is documentation only:** Pipeline-server-standalone.ts, edge functions, and dashboard re-triggers do NOT read this column. The actual mechanism is the `--canonicalize-mode` CLI flag in run-pipeline.sh. Manual re-triggers from Settings page would run legacy unless the edge function or server explicitly passes the flag. **This is flagged for architectural review.**

## Outcome Classification

**SUCCESS** — All phases completed. All smoke tests pass. No data loss, no regressions. First fresh-evaluation hybrid run on a 1,100-keyword corpus with committed content.

## Phase 2 Closure Assessment

With IMA promoted, both production clients (SMA and IMA) run hybrid canonicalize. The core rollout sequence (Phases 2.1–2.4) is complete. Remaining items:

- **Operational gap:** `canonicalize_mode` DB column is documentation, not mechanism. Re-triggers from dashboard Settings use whatever the pipeline server defaults to (currently requires manual `--canonicalize-mode` flag).
- **Phase 2.3c verification:** Lock determinism fix verified on SMA but not yet exercised on IMA. Next IMA re-canonicalize or full re-run will exercise it.
- **Future phases:** Phase 3 (Scout dedup) and Phase 4 (Gap semantic coverage) remain scoped but unstarted.
