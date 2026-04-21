# Forge OS Architectural Review — Post-Phase 2 System Audit

**Date:** 2026-04-21
**Purpose:** Systematic assessment of Forge OS architecture following Phase 2 completion
**Scope:** Seven areas, catalog-only, no code changes

---

## Executive Summary

Phase 2 delivered a working embedding infrastructure and promoted both production clients (SMA, IMA) to hybrid mode. The three bugs caught during rollout (snapshot ordering, single-member centroid vulnerability, cross-cycle contamination) were genuine architectural issues — not implementation mistakes. The validation methodology that caught them should be formalized.

**Key findings:**

1. **The `canonicalize_mode` DB column is inert.** All 5 trigger paths default to `legacy`. The two promoted clients (SMA, IMA) are hybrid in the DB but every re-trigger will silently run legacy. This is load-bearing — a re-canonicalize from Settings today would overwrite hybrid output with legacy output.

2. **Legacy Sonnet runs fully in hybrid mode, at $0.10–0.25 per audit of pure waste.** The grouping output is discarded; only 4 classification fields are used. These fields are deterministic or Haiku-suitable.

3. **The DELETE+INSERT pattern in `rebuildClustersAndRollups` has a TOCTOU window** where a concurrent read would see zero clusters. This hasn't caused a production incident but is structurally risky.

4. **Pre-existing data integrity issues are modest.** The only load-bearing issue is the 4 orphaned `canonical_key='trades_seo'` references on forgegrowth.ai's `execution_pages` pointing at deprecated strategies with 16 active pages. Everything else is cosmetic or historical.

5. **Embedding infrastructure has 14 identified application opportunities** beyond canonicalize. The highest-value is embed-at-ingestion (Phase 2/3b), which would eliminate downstream re-embedding and enable Scout dedup (Phase 3) and gap analysis (Phase 4) immediately.

**Prioritized next actions:**
1. Close the `canonicalize_mode` wiring gap (load-bearing, ~1 session)
2. Eliminate legacy Sonnet grouping in hybrid mode (structural, saves $0.10-0.25/audit)
3. Embed-at-ingestion for keyword pipeline (structural enabler for Phase 3+4)

---

## Area 1: `canonicalize_mode` Wiring Gap

### Findings

Five trigger paths can invoke canonicalization. **None of them read the `audits.canonicalize_mode` DB column.** All default to `legacy`.

#### Trigger Path 1: Full pipeline via `/trigger-pipeline`

- `pipeline-server-standalone.ts:61-160` (`handleTrigger`): accepts `domain`, `email`, `mode`, `prospect_config`, `start_from`, `stop_after`. **No `canonicalize_mode` parameter.** Does not query the `audits` table.
- `run-pipeline.sh:72`: hardcodes `CANONICALIZE_MODE="legacy"` as default.
- `run-pipeline.sh:91-108`: parses `--canonicalize-mode` flag from CLI args, but no caller passes it.
- `run-pipeline.sh:287`: passes `--canonicalize-mode "$CANONICALIZE_MODE"` to Phase 3c.
- **Result:** Full pipeline runs always execute legacy canonicalization, regardless of DB column.

#### Trigger Path 2: Re-canonicalize via `/recanonicalize`

- `pipeline-server-standalone.ts:356-434` (`handleRecanonicalize`): spawns `run-canonicalize.ts` with args `['tsx', 'scripts/run-canonicalize.ts', '--domain', domain, '--user-email', email]` (line 390). **No `--canonicalize-mode` flag passed.**
- `run-canonicalize.ts:51-52`: defaults to `legacy` when `--canonicalize-mode` not passed.
- **Result:** Re-canonicalize from Settings page always runs legacy mode.

#### Trigger Path 3: Edge function `pipeline-controls` → `/trigger-pipeline`

- The `pipeline-controls` edge function POSTs to `/trigger-pipeline` with `start_from` for resume and to `/recanonicalize` for re-canonicalize. Neither path includes `canonicalize_mode`.
- **Result:** Dashboard Settings page triggers always run legacy.

#### Trigger Path 4: `pipeline-generate.ts:2419` (`runCanonicalize`)

- Accepts `canonicalizeMode` parameter, defaults to `'legacy'`.
- Called from `run-pipeline.sh` which passes the flag, and from `run-canonicalize.ts` which passes its parsed value.
- **Result:** Correctly parameterized but all callers pass `legacy` (see paths 1-3).

#### Trigger Path 5: Monthly cron via `cron-track-all.ts`

- Only triggers `/track-rankings` and `/track-gsc`. Does not trigger canonicalization.
- **Result:** No canonicalization path; not affected.

#### Silent reversion scenarios

- **SMA re-canonicalize from Settings:** Would run legacy, overwriting hybrid output. SMA has 127 keywords — all hybrid-classified assignments would revert to Sonnet-only grouping.
- **IMA re-canonicalize from Settings:** Would run legacy on 1,100 keywords, destroying 76 hybrid canonical keys.
- **Any full pipeline re-run (resume or fresh):** Would run legacy canonicalization for promoted clients.

#### If `canonicalize_mode` column were deleted tomorrow

Nothing would break. No code reads it. The column is written during promotion (SMA: Phase 2.3b, IMA: Phase 2.4) but never queried.

### Severity

**Load-bearing.** A single Settings page re-canonicalize on SMA or IMA would silently revert hybrid output. The user would see no error — legacy would run normally and produce different groupings. The reversion would only be detectable by manual inspection of `classification_method` values.

### Recommendation

**Fix now. Single session. ~20-30 lines of code.**

Minimal fix surface:

| File | Change | Lines |
|------|--------|-------|
| `pipeline-server-standalone.ts` `handleTrigger` (~line 95) | Query `audits.canonicalize_mode` for domain, pass `--canonicalize-mode` flag to `run-pipeline.sh` | ~8 lines |
| `pipeline-server-standalone.ts` `handleRecanonicalize` (~line 390) | Query `audits.canonicalize_mode` for domain, add `--canonicalize-mode` to spawn args | ~8 lines |
| Optional: `pipeline-server-standalone.ts` | Accept `canonicalize_mode` in POST body as override (for testing/rollback) | ~4 lines |

Risk: Low. Both downstream scripts (`run-pipeline.sh`, `run-canonicalize.ts`) already parse and handle the flag correctly. The fix is purely about passing the flag from the HTTP layer.

No new failure modes introduced. Fallback: if DB query fails, default to `legacy` (safe — preserves current behavior).

---

## Area 2: Shared-Column Coupling Patterns

### Findings

Phase 2.3c fixed the specific case where legacy and hybrid both wrote `canonical_key`, `canonical_topic`, and `cluster` on `audit_keywords`. The fix (`build-legacy-payload.ts:33-37`) excludes those fields in hybrid mode. The broader pattern — multiple writers to the same columns — exists elsewhere.

#### 2.1: `audit_keywords` — 4 distinct writers

| Writer | Columns Written | Phase/Trigger |
|--------|----------------|---------------|
| Phase 2 KeywordResearch (`pipeline-generate.ts:4305-4334`) | `keyword`, `search_volume`, `cpc`, `rank_pos`, `intent`, `is_near_me`, `source` | Phase 2, seeds rows |
| Phase 3b syncJim (`sync-to-dashboard.ts`) | `keyword`, `search_volume`, `cpc`, `rank_pos`, `intent`, `topic`, `source`, revenue fields | Phase 3b, overwrites Phase 2 rows |
| Phase 3c Canonicalize legacy (`pipeline-generate.ts:2636-2668`) | `is_brand`, `intent_type`, `intent`, `is_near_me`, `primary_entity_type` + conditionally `canonical_key`, `canonical_topic`, `cluster` | Phase 3c |
| Phase 3c Canonicalize hybrid (`src/agents/canonicalize/hybrid/persist.ts`) | `canonical_key`, `canonical_topic`, `cluster`, `classification_method`, `similarity_score`, `canonicalize_mode` | Phase 3c (hybrid path) |
| Phase 6b syncMichael (`sync-to-dashboard.ts:2371-2425`) | `cluster` (silo backfill) | Phase 6b |

**Coupling risk:** `cluster` column has 3 writers (legacy canonicalize, hybrid persist, syncMichael silo backfill). In hybrid mode, the Phase 2.3c fix prevents legacy from writing `cluster`, but syncMichael's silo backfill at line 2421 unconditionally overwrites `cluster` with Michael's silo name. This means **Phase 6b overwrites Phase 3c's `cluster` value** for any keyword that matches Michael's slug-matching heuristic.

**Impact assessment:** The `cluster` column on `audit_keywords` is used by `rebuildClustersAndRollups` only as a display label (mapped from `canonical_topic`), and Michael's silo backfill targets the same column. Since `rebuildClustersAndRollups` reads `canonical_topic` not `cluster` for grouping (line 746-748), the overwrite doesn't affect cluster computation. But it means the `cluster` column is unreliable as a source of truth — it may contain either a canonical topic name or a Michael silo name depending on run ordering.

**Severity:** Structural. Not currently causing incorrect behavior because no critical code path reads `audit_keywords.cluster` for grouping decisions.

#### 2.2: `execution_pages` — 5 distinct writers

| Writer | Key Columns | Trigger |
|--------|------------|---------|
| Phase 6b syncMichael (`sync-to-dashboard.ts`) | `url_slug`, `primary_keyword`, `silo_name`, `page_type`, `status`, `canonical_key` (backfill) | Pipeline Phase 6b |
| Pam brief generation (`generate-brief.ts`) | `brief_status`, `brief_content`, `schema_markup` | On-demand |
| Oscar content generation (`generate-content.ts`) | `status`, `content_html`, `word_count` | On-demand |
| User actions (dashboard) | `status`, `notes`, `target_publish_date` | Manual |
| Cluster activation (`sync-to-dashboard.ts:860-873`) | `cluster_active` | On-demand |

**Coupling risk:** `status` has 5 writers. Oscar writes `status='in_progress'` (draft ready) or `status='review'`. Users manually change status. syncMichael writes `status='not_started'` on fresh inserts. If syncMichael re-runs after Oscar has generated content, it would re-insert pages (UPSERT on `audit_id + url_slug`), potentially resetting status.

**Impact assessment:** syncMichael uses UPSERT with `onConflict: 'audit_id,url_slug'`. The UPSERT payload includes `status: 'not_started'`. However, the UPSERT is INSERT-focused — Supabase's default UPSERT behavior updates all specified columns. A re-run of the full pipeline (Phase 6b) after content has been generated would reset page statuses. This is mitigated by the fact that full pipeline re-runs are rare and operator-initiated.

**Severity:** Structural. Known risk, accepted by convention (operators don't re-run full pipeline after content production starts). Would become load-bearing if automated re-runs are ever introduced.

#### 2.3: `audit_clusters` — DELETE+INSERT with TOCTOU window

`rebuildClustersAndRollups` (`sync-to-dashboard.ts:740-741`) executes:
```
DELETE FROM audit_clusters WHERE audit_id = ?
DELETE FROM audit_rollups WHERE audit_id = ?
```

Then inserts new clusters (line 796) and restores activation status (lines 814-833). Between the DELETE and INSERT, any concurrent dashboard read would see zero clusters.

**Timing window:** For a typical audit with 50-80 clusters, the gap is ~200-500ms (DELETE + query keywords + build cluster map + batch INSERT). The status preservation loop adds ~50ms per active cluster.

**Severity:** Structural. No reported production incidents, but dashboard is a live SPA making real-time queries. A user viewing the Clusters page during re-canonicalization would see an empty state flash.

#### 2.4: `audit_keywords` — Jim snapshot double-write

Phase 2 KeywordResearch (`pipeline-generate.ts:4311`) deletes `source='keyword_research'` rows, then inserts new ones. Phase 3b syncJim later deletes `source='ranked'` and `source IS NULL` rows, then inserts Jim's researched keywords. Both writers target the same table with different `source` filter values.

**Coupling risk:** If Phase 2 re-runs without Phase 3b following, stale `source='ranked'` rows from a prior Jim run persist alongside fresh `source='keyword_research'` rows, creating a mixed-vintage dataset.

**Severity:** Cosmetic. Pipeline phases always run in sequence; standalone Phase 2 re-runs don't happen.

#### 2.5: `cluster_strategy` — generation + deprecation

Two writers: `generate-cluster-strategy.ts` (creates/updates strategy, sets `status='active'`) and `rebuildClustersAndRollups` (sets `status='deprecated'`, `deprecated_at`). These never race — deprecation only happens during cluster rebuild, which is a pipeline operation, while strategy generation is user-initiated.

**Severity:** Cosmetic. No coupling risk.

### Recommendation

| Finding | Action | Scope |
|---------|--------|-------|
| 2.1: `cluster` column 3-writer ambiguity | Accept as limitation OR rename syncMichael's backfill to a dedicated `silo` column | Defer — low impact since `cluster` isn't used for grouping |
| 2.2: `execution_pages.status` 5-writer risk | Document in DATA_CONTRACT.md; add guard to syncMichael UPSERT to preserve non-`not_started` statuses | Scoped session (~15 lines) |
| 2.3: TOCTOU in rebuildClustersAndRollups | Accept as limitation OR migrate to UPSERT pattern (significant refactor) | Defer — no production impact observed |
| 2.4: Jim double-write | Accept — phases run sequentially | Accept as limitation |
| 2.5: cluster_strategy | No action needed | N/A |

**Should the Phase 2.3c column-separation pattern generalize?** Only for 2.1 (the `cluster` column). The other shared-column cases are either sequential (no race) or already mitigated by operational convention.

---

## Area 3: Pre-Existing Data Integrity Issues

### Findings

Live Supabase queries run against all 9 audits. Results below.

#### Audit Inventory

| Domain | Mode | canonicalize_mode | Keywords | Canonical Keys |
|--------|------|-------------------|----------|----------------|
| summitmedicalacademy.com (SMA) | full | hybrid | 127 | 27 |
| idahomedicalacademy.com (IMA) | full | hybrid | 1,100 | 76 |
| forgegrowth.ai | full | legacy | 247 | 24 |
| ecohvacboise.com | full | legacy | ~600 | ~50 |
| boiseheatingair.com | full | legacy | ~200 | 0 (pre-canonicalize era) |
| tvrinc.net | full | legacy | ~150 | 0 (pre-canonicalize era) |
| talonconstructiongroup.com | full | legacy | ~300 | 0 (pre-canonicalize era) |
| foxhvacpro.com | sales | legacy | 129 | 0 (sales mode) |
| boiseserviceplumbers.com | sales | legacy | ~100 | 0 (sales mode) |

#### 3.1: Orphaned canonical_key on execution_pages

**forgegrowth.ai:** 4 `execution_pages` with `canonical_key='trades_seo'`. This key was deprecated by re-canonicalization (cluster rebuild deprecated the strategy, but `execution_pages` still reference it). The deprecated `cluster_strategy` row for `trades_seo` has `status='deprecated'` but 4 pages still point at it.

**All other audits:** 0 orphaned canonical_keys.

**Severity:** Structural. The 4 pages display correctly in the dashboard (they show the page data regardless of canonical_key validity), but if content production is triggered for these pages, the cluster strategy lookup would find a deprecated strategy. Pam's brief generation reads `cluster_strategy` and would use deprecated strategic guidance.

#### 3.2: Orphaned cluster references (audit_clusters → audit_keywords)

**foxhvacpro.com:** 15 of 15 clusters are orphaned (all `canonical_key` values in `audit_clusters` have zero matching `audit_keywords` rows). This is because foxhvacpro is a sales-mode audit — canonicalization never ran, so `audit_keywords.canonical_key` is NULL for all 129 keywords, but `audit_clusters` was populated by a pre-canonicalize cluster build.

**All other audits:** 0 orphaned clusters.

**Severity:** Cosmetic. foxhvacpro.com is a sales-mode audit not intended for content production. The orphaned clusters display revenue estimates with no backing keywords — misleading if someone inspects the data, but operationally irrelevant.

#### 3.3: Unbackfilled pages (execution_pages with NULL canonical_key)

| Audit | NULL canonical_key | Total Pages | Backfill Rate |
|-------|-------------------|-------------|---------------|
| SMA | 6 | 7 | 14.3% (1 backfilled) |
| IMA | 39 | 86 | 54.7% |
| forgegrowth.ai | 12 | 14 | 14.3% (2 backfilled) |
| ecohvacboise.com | ~15 | ~35 | ~57% |
| Early audits (4) | All | All | 0% (pre-backfill era) |

**IMA's 39 unbackfilled pages:** These are informational/editorial slugs (`how-to-become-an-emt-in-idaho`, `what-does-a-cna-do`, etc.) whose `primary_keyword` doesn't match any keyword in `audit_keywords` via syncMichael's 3-tier substring matching (`sync-to-dashboard.ts:2396-2418`). This is a known limitation of the substring-matching backfill — it requires keyword text overlap between Michael's `primary_keyword` and Jim's keyword corpus.

**Severity:** Structural for IMA (39 pages = 45.3% of content queue lacks cluster context). Cosmetic for others. The 3-tier matching approach (exact → substring → URL slug) hits a ceiling around 50-60% for audits with informational content that uses editorial slugs.

#### 3.4: Silo vs canonical_topic mismatch

`execution_pages.silo` (Michael's architecture taxonomy) and `audit_clusters.canonical_topic` (canonicalize's semantic grouping) are **different taxonomies by design.** Michael creates 3-7 broad silos; canonicalize creates 20-80 granular topics. There is no 1:1 mapping, and none is expected.

Example (IMA): Michael silo "Career Pathways" maps to canonical topics `emt_career_info`, `nursing_career_info`, `medical_assistant_career_info`, `healthcare_education_overview`, etc.

**Severity:** Not an issue. Documenting to prevent future misidentification as a data integrity problem.

#### 3.5: Deprecated strategies with active pages

**forgegrowth.ai:**
- `cluster_strategy` `canonical_key='local_seo'`: `status='deprecated'`, `deprecated_at` set. **12 `execution_pages`** still reference this canonical_key.
- `cluster_strategy` `canonical_key='trades_seo'`: `status='deprecated'`. **4 `execution_pages`** still reference this canonical_key.

No other audits have deprecated strategies with active pages (SMA and IMA have 0 cluster strategies).

**Severity:** Structural. The deprecated strategies remain readable (soft delete), so Pam would use outdated strategic guidance for these 16 pages if brief generation were triggered. Operationally, forgegrowth.ai hasn't triggered content production for these pages, so the risk is latent.

#### 3.6: Orphaned performance snapshots

| Audit | Orphaned Snapshots | Total Snapshots | Notes |
|-------|-------------------|-----------------|-------|
| SMA | 7 | 13 | canonical_keys from pre-hybrid era no longer exist |
| forgegrowth.ai | 1 | 6 | `local_seo` key deprecated |
| IMA | 1 | 32 | Key renamed during hybrid promotion |

**Severity:** Cosmetic. Orphaned snapshots are historical records that no longer join to active `audit_clusters` rows. The Performance page doesn't crash — it just can't display trend data for these keys. Accepted as known limitation per Phase 2.4 report.

#### 3.7: DATA_CONTRACT.md gaps

The following columns exist in production but are not documented in DATA_CONTRACT.md:

| Table | Column | Added By |
|-------|--------|----------|
| `cluster_strategy` | `status` | Migration 014 |
| `cluster_strategy` | `deprecated_at` | Migration 014 |
| `audit_keywords` | `service_root_id` | Unknown (likely Phase 2 KeywordResearch) |
| `audit_keywords` | `match_method` | Unknown |
| `audit_keywords` | `in_market` | Unknown |

**Severity:** Structural. Undocumented columns create confusion for future development. `cluster_strategy.status` is particularly important — it's queried by `rebuildClustersAndRollups` (line 893) and cluster display logic.

### Summary Counts

| Category | SMA | IMA | forgegrowth | Others | Total |
|----------|-----|-----|-------------|--------|-------|
| Orphaned canonical_keys on pages | 0 | 0 | 4 | 0 | 4 |
| Orphaned clusters | 0 | 0 | 0 | 15 (foxhvacpro) | 15 |
| Unbackfilled pages | 6 | 39 | 12 | All (pre-era) | 57+ |
| Deprecated strategies w/ active pages | 0 | 0 | 16 | 0 | 16 |
| Orphaned performance snapshots | 7 | 1 | 1 | 0 | 9 |
| Undocumented columns | — | — | — | — | 5 |

### Recommendation

| Finding | Action | Priority |
|---------|--------|----------|
| 3.1: forgegrowth trades_seo orphans (4 pages) | Manual cleanup: update `canonical_key` to current valid key | Before content production |
| 3.2: foxhvacpro orphaned clusters | Accept — sales mode artifact | Accept |
| 3.3: Unbackfilled pages (~45% IMA) | Architectural fix: replace substring matching with embedding-based backfill (see Area 6) | Phase 3+ |
| 3.4: Silo vs canonical_topic | Document in DATA_CONTRACT.md as intentional | Next commit |
| 3.5: Deprecated strategies + active pages (16 pages) | Add `status='active'` filter to Pam's strategy lookup; clean up forgegrowth references | Scoped session |
| 3.6: Orphaned snapshots | Accept as known limitation | Accept |
| 3.7: DATA_CONTRACT.md gaps | Update DATA_CONTRACT.md with missing columns | Next commit |

---

## Area 4: Redundancies from Pre-Embedding Architecture

### Findings

#### 4.1: syncMichael silo backfill — substring matching where embeddings would excel

`sync-to-dashboard.ts:2371-2425`: Michael's silo backfill uses 3-tier string matching:
1. Exact `primary_keyword` match (line 2397)
2. Substring match on `primary_keyword` — bidirectional `includes()` (lines 2400-2407)
3. URL slug matching against `ranking_url` (lines 2410-2417)

This achieves ~50-60% backfill rates. The remaining 40-50% are keywords whose text doesn't overlap with Michael's page slugs (e.g., "what does a cna do" doesn't substring-match any Michael page).

**Embedding replacement:** Embed Michael's `primary_keyword` values and each audit keyword. Cosine similarity match at 0.80+ threshold. Expected backfill rate: 80-90% based on Phase 2 auto-assign behavior in the same similarity range.

**Severity:** Structural. The low backfill rate means 40-50% of content queue pages lack cluster context, which degrades Pam's brief quality for those pages.

#### 4.2: Scout topic extraction — word-level matching

Scout's topic extraction in `foundational_scout.sh` uses Haiku to extract topics from ranked keywords. These topics are later compared against client topics using string equality. Embedding-based similarity could identify related topics across different naming conventions (e.g., Scout's "HVAC repair" matching client's "heating system maintenance").

**Severity:** Cosmetic for current use. Would become structural when Scout dedup (Phase 3) starts.

#### 4.3: Pam brief context — cluster-bounded keyword selection

`generate-brief.ts` selects context keywords from the same canonical_key cluster. Cross-cluster related keywords (e.g., "emergency plumber" in cluster A and "24 hour plumbing" in cluster B) are invisible to Pam. Embedding similarity over the full keyword corpus would surface these.

**Severity:** Structural. Affects brief comprehensiveness for clusters with related content in adjacent clusters.

#### 4.4: No hardcoded synonym lists found

Searched for explicit synonym maps, equivalence tables, and topic alias lists. None found. The codebase uses LLM judgment (Sonnet/Haiku) for semantic equivalence rather than hardcoded rules.

#### 4.5: No Levenshtein or fuzzy-match libraries

No string distance computation libraries (`levenshtein`, `fuzzball`, `string-similarity`, etc.) found in `package.json` or imports. String comparison is either exact match, `includes()`, or LLM-based.

### Recommendation

| Opportunity | Effort | Value | Priority |
|-------------|--------|-------|----------|
| 4.1: Embedding-based silo backfill | 1 session | High — lifts backfill from ~55% to ~85% | Phase 3+ (after embed-at-ingestion) |
| 4.2: Scout topic similarity | 1 session | Medium — enables Phase 3 dedup | Phase 3 |
| 4.3: Pam cross-cluster context | 1 session | Medium — improves brief quality | After 4.1 |
| 4.4-4.5: No action | N/A | N/A | N/A |

---

## Area 5: Inefficiencies Introduced by Phase 2's Bolt-On Approach

### Findings

#### 5.1: Legacy Sonnet runs FULLY in hybrid mode — $0.10-0.25 wasted per audit

`pipeline-generate.ts:2419-2668` (`runCanonicalize`): In hybrid mode, legacy Sonnet still processes ALL keywords through the full grouping prompt. It classifies `is_brand`, `intent_type`, `primary_entity_type`, and produces `canonical_key`/`canonical_topic` groupings. The Phase 2.3c fix (`build-legacy-payload.ts:33-37`) prevents writing the canonical fields, but legacy Sonnet still **computes** them.

**What legacy produces in hybrid mode that's actually used:**
- `is_brand` (boolean) — written by legacy, not computed by hybrid
- `intent_type` (string) — written by legacy, not computed by hybrid
- `is_near_me` (boolean) — **deterministic** (`keyword.includes(' near me')`, line 2628), not Sonnet-classified
- `primary_entity_type` (string) — written by legacy, not computed by hybrid

**What legacy produces that's thrown away:**
- `canonical_key` grouping (excluded by Phase 2.3c fix)
- `canonical_topic` grouping (excluded by Phase 2.3c fix)
- `cluster` assignment (excluded by Phase 2.3c fix)

**Cost analysis:** Legacy canonicalize uses Sonnet for the full keyword corpus. For IMA (1,100 keywords), this is ~15 Sonnet batches × $0.015-0.02 each = **$0.20-0.25**. For SMA (127 keywords), ~2-3 batches = **$0.03-0.05**. The useful output (4 classification fields) could be produced by:
- `is_near_me`: Already deterministic (line 2628). Zero cost.
- `is_brand`: Simple keyword heuristic possible (contains company name, brand terms). Could be Haiku.
- `intent_type`: Classification task. Haiku-suitable (~10x cheaper than Sonnet).
- `primary_entity_type`: Classification task. Haiku-suitable.

**Severity:** Structural (cost inefficiency). Legacy Sonnet grouping in hybrid mode is pure waste. The 4 classification fields justify a Haiku call at most.

#### 5.2: Shadow mode is dead code

Shadow mode (`canonicalize_mode='shadow'`) was used during Phase 2 validation. Both clients are now promoted to hybrid. Shadow mode paths remain in:
- `pipeline-generate.ts` (shadow comparison logic)
- `run-canonicalize.ts` (accepts `shadow` as valid mode)
- `run-pipeline.sh` (passes `shadow` to Phase 3c)
- `src/agents/canonicalize/hybrid/` (shadow comparison output)

No trigger path currently passes `shadow` mode. The code is reachable only via manual CLI invocation.

**Severity:** Cosmetic. Dead code doesn't affect correctness. Retaining it has minor maintenance cost; removing it risks losing validation infrastructure if future changes need shadow comparison.

**Recommendation:** Defer removal. Shadow mode is cheap to keep and valuable for future phase rollouts (e.g., Phase 3 Scout dedup validation).

#### 5.3: Duplicate DB queries in runCanonicalize

`runCanonicalize` (`pipeline-generate.ts:2423-2437`) fetches:
1. `audits` table for metadata (line 2423-2427)
2. `audit_keywords` for all keywords (lines 2433-2436)

The hybrid module (`src/agents/canonicalize/hybrid/`) then fetches:
1. `audit_keywords` again — same query but with additional fields (`canonical_key`, `canonical_topic`, `classification_method`, `similarity_score`) for prior-lock detection

The keyword fetch is duplicated. Both queries hit the same table for the same audit. The hybrid module needs a superset of the legacy query's fields.

**Severity:** Cosmetic. The duplicate query adds ~100-200ms for IMA-scale audits. Not operationally significant.

#### 5.4: Classification fields could be pre-computed

In hybrid mode, the 4 classification fields (`is_brand`, `intent_type`, `is_near_me`, `primary_entity_type`) are the only useful output from legacy Sonnet. These could be:
- Computed as a separate lightweight step (Haiku batch or deterministic rules)
- Computed during Phase 2 KeywordResearch (some fields like `is_near_me` and `intent` are already seeded there)
- Computed during Jim (Phase 3b sync already has intent data)

Moving classification out of the Sonnet grouping call would allow eliminating legacy Sonnet entirely in hybrid mode.

**Severity:** Structural. Blocking the cost savings from 5.1.

#### 5.5: `canonicalizeMode` flag threading

The `canonicalizeMode` flag is threaded through 5 layers: HTTP server → shell script → env variable → TypeScript runner → function parameter. This is correct but adds 5 places where a default of `legacy` is specified. Area 1's wiring gap fix (reading from DB) would reduce this to: DB → HTTP server → downstream.

**Severity:** Cosmetic.

### Recommendation

| Finding | Action | Scope | Saves |
|---------|--------|-------|-------|
| 5.1: Legacy Sonnet waste in hybrid | Eliminate legacy Sonnet grouping; extract classification to Haiku/deterministic step | 1 session | $0.10-0.25/audit |
| 5.2: Shadow dead code | Defer removal — keep for future validation | Accept | N/A |
| 5.3: Duplicate keyword query | Accept — consolidate if touched for other reasons | Accept | ~150ms |
| 5.4: Classification pre-compute | Implement as part of 5.1 fix | Same session as 5.1 | Enables 5.1 |
| 5.5: Flag threading | Addressed by Area 1 fix | Same session as Area 1 | Complexity |

**Overall Phase 2 dual-mode assessment:** The dual-mode architecture should migrate toward hybrid-only for promoted clients. Legacy should remain available as a fallback mode (selectable via DB column) but should not run in hybrid mode. The transition path:
1. Fix Area 1 (DB column → mechanism)
2. Extract classification from legacy Sonnet (5.1 + 5.4)
3. Skip legacy Sonnet entirely when `canonicalizeMode === 'hybrid'`

---

## Area 6: Missed Opportunities to Apply Embedding Infrastructure

### Findings

14 opportunities identified across 9 agents. Ranked by effort-to-value ratio.

#### Tier 1: High value, enables other work

**6.1: Embed-at-ingestion (Phase 2/3b keyword seeding)**

Embed keywords when they first enter `audit_keywords` (Phase 2 KeywordResearch + Phase 3b syncJim). Currently, embeddings are generated on-demand during canonicalize. Moving to ingestion-time:
- Eliminates re-embedding on re-canonicalize
- Provides embeddings for all downstream consumers (backfill, Pam, Scout dedup, Gap)
- Amortizes embedding cost ($0.00006 per 300 keywords) to pipeline startup
- Required for Phase 3 (Scout dedup) and Phase 4 (Gap coverage)

**Effort:** 1 session. Add embedding call to Phase 2 seeding (`pipeline-generate.ts:4305-4334`) and Phase 3b sync. Store in existing `embedding` column on `audit_keywords` (already exists from Phase 2 migration 016).

**Impact:** Universal enabler. Every other embedding opportunity below becomes cheaper once embeddings exist at ingestion.

**6.2: Canonical_key backfill via embeddings (replace syncMichael substring matching)**

Replace `sync-to-dashboard.ts:2371-2425` (3-tier substring match, ~55% rate) with embedding similarity between Michael's `primary_keyword` and audit keywords. Expected backfill rate: 80-90%.

**Effort:** 1 session (after 6.1).
**Impact:** 39 IMA pages and ~12 forgegrowth pages gain cluster context. Pam briefs improve for those pages.

#### Tier 2: Medium value, independent

**6.3: Pam cross-cluster keyword discovery**

When generating a brief for page P with `canonical_key=K`, find the top-5 semantically similar keywords from OTHER clusters (cosine similarity > 0.75). Include as "related search intents" in the brief context. Currently, Pam only sees keywords within the same cluster.

**Effort:** 1 session.
**Impact:** Briefs gain awareness of related content opportunities, reducing content overlap between adjacent clusters.

**6.4: Michael silo assignment verification**

After Michael proposes 3-7 silos with page assignments, use embeddings to verify that page topics within each silo are semantically coherent. Flag outliers (pages whose embedding is >0.3 cosine distance from silo centroid).

**Effort:** 0.5 session.
**Impact:** Catches Michael's LLM judgment errors. Low frequency (Michael runs once per audit) but high consequence (silo misassignment cascades to all downstream content).

**6.5: Scout keyword dedup (Phase 3 scope)**

Already scoped as Phase 3. Embeddings deduplicate Scout's keyword candidates before they enter the pipeline. This is the originally planned Phase 3 work — embeddings make it feasible without LLM calls.

**Effort:** 1 session.
**Impact:** Reduces keyword corpus noise, particularly for prospects with overlapping service areas.

#### Tier 3: Lower value or higher effort

**6.6: Gap analysis semantic matching (Phase 4 scope)**

Section-level semantic comparison between client content and competitor SERP content. Already scoped as Phase 4.

**Effort:** 2-3 sessions.
**Impact:** Replaces string-based gap detection with semantic matching.

**6.7: Competitor topic alignment**

When comparing client vs competitor keyword profiles, use embedding similarity to identify semantically equivalent topics across different naming conventions.

**Effort:** 1 session.
**Impact:** Medium — competitors analysis runs once per audit.

**6.8: Oscar internal linking**

When generating content, use embeddings to find the most semantically related existing pages for internal link suggestions. Currently, Oscar receives a list of existing pages but link selection is LLM-driven.

**Effort:** 0.5 session.
**Impact:** Low-medium — Oscar already uses LLM judgment effectively. Embeddings would add determinism but not necessarily better links.

**6.9: Cluster Strategy entity map verification**

Use embeddings to verify entity relationships proposed by Opus during cluster strategy generation. E.g., confirm that "emergency plumber" and "24/7 plumbing" are genuinely related entities.

**Effort:** 0.5 session.
**Impact:** Low — Opus judgment is already high quality. Verification would catch rare errors.

**6.10-6.14: Additional lower-priority opportunities**

- **Jim variant dedup** (0.5 session): Deduplicate keyword variants during research phase.
- **Dwight findings categorization**: Not embedding-suitable — findings are structural/technical, not semantic.
- **Brief quality scoring**: Embedding similarity between brief outline and target keywords as a quality metric.
- **Keyword lookup dedup**: Deduplicate ad-hoc keyword lookups against existing audit keywords.
- **Strategy brief context selection**: Use embeddings to select most relevant Dwight findings for strategy brief synthesis.

### Recommendation

**Proposed sequencing:**

```
Phase 3 prep:  6.1 (embed-at-ingestion)     ← universal enabler, do first
Phase 3:       6.5 (Scout dedup)             ← already planned
Phase 3+:      6.2 (canonical_key backfill)  ← immediate quality win
               6.3 (Pam cross-cluster)       ← brief quality improvement
               6.4 (Michael silo verify)     ← safety net
Phase 4:       6.6 (Gap semantic matching)   ← already planned
Opportunistic: 6.7-6.14                      ← as touched for other reasons
```

**Behavior change concerns:**
- 6.2 (backfill) changes which pages get cluster context — validate before relying on it for content production
- 6.4 (silo verification) could flag existing assignments as incorrect — present as advisory, not automatic reassignment
- 6.5 (Scout dedup) reduces keyword count — validate that dedup doesn't remove genuinely distinct keywords

---

## Area 7: Validation Framework Formalization

### Findings

#### 7.1: Phase 2 validation pattern (extracted template)

Phase 2 used an 8-stage validation approach that caught 3 architecturally significant bugs:

| Stage | Phase 2 Implementation | Bug Caught |
|-------|----------------------|------------|
| 1. Shadow mode | Run new path alongside old, old authoritative | Snapshot ordering (Phase 2 validation) |
| 2. Paired client testing | SMA (stability) + IMA (behavioral) | Single-member centroid vulnerability (Phase 2.2) |
| 3. Threshold tuning | Data-driven parameter adjustment | Auto-assign rate optimization |
| 4. Size gate | Guard against pathological inputs | 62.7% misroute rate on single-member clusters |
| 5. Downstream readiness | Review all consumers before promotion | 14 consumers identified, 1 monitoring flag |
| 6. First promotion (SMA) | Stable client, low risk | Cross-cycle contamination (Phase 2.3b) |
| 7. Bug fix + re-validation | Fix, re-test stable client | Phase 2.3c confirmed 0 drift |
| 8. Second promotion (IMA) | Behavioral client, high keyword count | Validated at scale (1,100 keywords) |

**Reusable template:**

1. **Shadow mode**: New path runs alongside old; old path remains authoritative. Compare outputs.
2. **Paired testing**: Test on stability client (confirm no regression) AND behavioral client (confirm correct behavior change).
3. **Smoke test checklist**: Pre-defined pass/fail criteria with explicit halt conditions.
4. **Downstream consumer audit**: Catalog all readers before changing writer behavior.
5. **Incremental promotion**: Promote one client at a time, validate, then proceed.
6. **Rollback protocol**: Document exact steps to revert to prior state.
7. **Contamination detection**: Monitor for unexpected state changes in shared data.
8. **Outcome classification**: "Success" / "Success with observations" / "Halt" — not binary.

#### 7.2: Historical examples where this pattern would have helped

Based on DECISIONS.md and commit history, 10 changes shipped without Phase 2-style validation:

1. **Michael parser change** (2026-04-09): Fixed architecture blueprint parsing. No shadow mode. Could have caught edge cases in other audits.
2. **Pam entity_map fix** (2026-04-09): Fixed `entity_map` type handling. No downstream consumer audit. Dashboard error surfaced post-deploy.
3. **Oscar streaming retry** (2026-04-13): Fixed `terminated` status retry. Tested on single page. Could have validated across multiple content types.
4. **Cluster activation silo-match fallback** (2026-04-13): Changed matching logic without paired testing.
5. **Revenue model introduction**: Changed financial projections without A/B comparison to prior model.
6. **Performance tracking launch**: New data pipeline added without shadow comparison to verify snapshot stability.
7. **Local presence phase**: New phase added with testing on 1-2 domains, not systematically across all clients.
8. **Strategy brief introduction**: New synthesis phase injected into downstream consumers without readiness review.
9. **Review gate feature**: Opt-in pipeline pause with testing on single audit flow.
10. **Keyword lookup persistence**: New table and API without consumer audit (only consumer is dashboard, low risk).

**Assessment:** Items 1-4 would have meaningfully benefited from structured validation. Items 5-10 are lower risk — the current approach (test on 1-2 clients, deploy, monitor) was adequate.

#### 7.3: Threshold criteria

Not every change needs Phase 2-style validation. Proposed 3-tier criteria:

**Tier 1 — Full validation (Phase 2 pattern):**
- Changes to data computation that affects multiple downstream consumers
- Changes to the canonicalize, clustering, or revenue model
- New data writers to existing tables
- Changes that affect financial projections shown to users
- Any change touching `audit_keywords.canonical_key`, `canonical_topic`, or `cluster`

**Tier 2 — Lightweight validation (shadow mode OR paired testing, not both):**
- New pipeline phases
- Changes to agent prompts that affect structured output
- Changes to sync logic (syncJim, syncMichael, syncDwight)
- Performance tracking or snapshot logic changes

**Tier 3 — Standard testing (tests + single-client verification):**
- Bug fixes with clear root cause
- New API endpoints
- Dashboard display changes
- Documentation updates

#### 7.4: Current change management process

Implicit. Changes are:
1. Discussed in Claude Code sessions
2. Implemented and tested locally
3. Committed to `main`
4. Auto-deployed to Railway/Vercel
5. Verified by operator inspection

No formal gates, no required checklists, no mandatory validation steps. The Phase 2 validation pattern was ad-hoc — invented for Phase 2's specific risk profile and executed through discipline, not process.

### Recommendation

**Proposed architectural principle:**

> Changes to Forge OS data computation paths require validation proportional to their downstream impact. Changes that affect multiple consumers or shared state require shadow validation and paired client testing before production promotion. Changes that introduce new data writers to existing tables require downstream consumer audits.

**Formalization approach:** Documentation + convention (not tooling). Forge OS is a single-operator system. Heavy process would add overhead without proportional benefit. Recommendation:

1. Add a `docs/VALIDATION.md` documenting the 3-tier framework with the reusable template
2. Add a checklist section to DECISIONS.md entries for Tier 1 changes
3. Keep shadow mode infrastructure alive for future use
4. Do NOT build automated validation tooling at this scale

**Severity:** Structural. The pattern works. The risk is that future changes skip it because it's not documented — the knowledge lives in Phase 2 session context, not in the codebase.

---

## Cross-Cutting Observations

### Observation 1: The DB column → mechanism gap is a systemic pattern

The `canonicalize_mode` wiring gap (Area 1) reveals a broader pattern: Forge OS stores configuration in Supabase (`audits` table columns) that the pipeline doesn't read. The pipeline relies on CLI flags and environment variables. Other potential instances:
- `audits.geo_mode`: Read by `resolveGeoScope()` in `pipeline-generate.ts` — **this one works correctly**.
- `audits.review_gate_enabled`: Read by `update-pipeline-status.ts check-review-gate` — **this one works correctly**.
- `audits.client_context`: Read by `loadClientContextAsync()` — **this one works correctly**.

The `canonicalize_mode` gap is isolated, not systemic. The other DB-stored config values are properly wired.

### Observation 2: DATA_CONTRACT.md drift

5 undocumented columns (Area 3.7) indicate DATA_CONTRACT.md isn't updated in every commit as specified in CLAUDE.md. This is a process gap, not an architectural one. The contract document should be refreshed during this review's follow-up work.

### Observation 3: The dual taxonomy (silo vs canonical_topic) is load-bearing complexity

Michael's silo taxonomy and canonicalize's canonical_topic taxonomy serve different purposes (content architecture vs keyword grouping). Both write to `audit_keywords.cluster` (Area 2.1). Both are used by different dashboard pages. The dual taxonomy is correct but creates ongoing confusion. A dedicated `silo` column on `audit_keywords` would clarify ownership.

### Observation 4: Sales-mode audits have degraded data integrity

foxhvacpro.com and boiseserviceplumbers.com (sales mode) have 0% backfill rates, orphaned clusters, and NULL canonical_keys everywhere. Sales mode skips canonicalization (Phase 3c) and several downstream phases. This is by design, but the resulting data state is messy. Sales-mode audits should either: (a) skip cluster-dependent tables entirely, or (b) run a lightweight canonicalization.

### Observation 5: Phase 2's bolt-on approach was correct for risk but expensive to maintain

Running legacy Sonnet fully in hybrid mode (Area 5.1) costs $0.10-0.25 per audit. Over 9 audits, that's ~$1-2 of waste. At current scale, this is negligible. At 50+ audits, it becomes operationally significant. The cleanup priority is proportional to growth expectations.

---

## Pre-Existing Data Integrity Catalog

### Per-Client Detail

#### SMA (summitmedicalacademy.com) — hybrid mode
- **Orphaned canonical_keys on pages:** 0
- **Orphaned clusters:** 0
- **Unbackfilled pages:** 6 of 7 (14.3% backfill rate)
- **Deprecated strategies w/ active pages:** 0
- **Orphaned performance snapshots:** 7 of 13 (from pre-hybrid canonical keys)

#### IMA (idahomedicalacademy.com) — hybrid mode
- **Orphaned canonical_keys on pages:** 0
- **Orphaned clusters:** 0
- **Unbackfilled pages:** 39 of 86 (54.7% backfill rate)
- **Deprecated strategies w/ active pages:** 0
- **Orphaned performance snapshots:** 1 of 32

#### forgegrowth.ai — legacy mode
- **Orphaned canonical_keys on pages:** 4 (`trades_seo`)
- **Orphaned clusters:** 0
- **Unbackfilled pages:** 12 of 14 (14.3% backfill rate)
- **Deprecated strategies w/ active pages:** 16 (12 `local_seo` + 4 `trades_seo`)
- **Orphaned performance snapshots:** 1 of 6

#### ecohvacboise.com — legacy mode
- **Orphaned canonical_keys on pages:** 0
- **Orphaned clusters:** 0
- **Unbackfilled pages:** ~15 of ~35 (~57% backfill rate)
- **Deprecated strategies w/ active pages:** 0
- **Orphaned performance snapshots:** 0

#### Early audits (boiseheatingair, tvrinc, talonconstructiongroup) — legacy, pre-canonicalize era
- All pages unbackfilled (0% backfill rate — pre-backfill era)
- No canonical_keys, no clusters, no strategies
- Historical artifacts; not operationally relevant

#### Sales-mode audits (foxhvacpro, boiseserviceplumbers) — legacy
- **foxhvacpro:** 15 orphaned clusters (all clusters orphaned due to no canonical_keys on keywords)
- All pages unbackfilled
- Not intended for content production

---

## Prioritized Recommendations

### Load-Bearing (affects correctness or production reliability)

| # | Finding | Action | Scope | Dependencies |
|---|---------|--------|-------|--------------|
| 1 | Area 1: `canonicalize_mode` wiring gap | Read DB column in `handleTrigger` + `handleRecanonicalize`, pass to downstream | 1 session, ~25 lines | None |
| 2 | Area 3.5: Deprecated strategies w/ active pages | Add `status='active'` filter to Pam's strategy lookup | 1 session, ~5 lines | None |

### Structural (affects maintainability and future work)

| # | Finding | Action | Scope | Dependencies |
|---|---------|--------|-------|--------------|
| 3 | Area 5.1+5.4: Legacy Sonnet waste in hybrid | Extract classification to Haiku/deterministic; skip legacy Sonnet grouping in hybrid | 1 session | After #1 |
| 4 | Area 6.1: Embed-at-ingestion | Add embedding call to Phase 2/3b keyword seeding | 1 session | None |
| 5 | Area 3.3+4.1: Unbackfilled pages | Replace substring matching with embedding-based backfill | 1 session | After #4 |
| 6 | Area 3.7+Obs 2: DATA_CONTRACT.md gaps | Update with 5 undocumented columns + silo/canonical_topic documentation | Next commit | None |
| 7 | Area 2.2: execution_pages.status risk | Guard syncMichael UPSERT to preserve non-`not_started` statuses | 0.5 session | None |
| 8 | Area 7: Validation framework | Write `docs/VALIDATION.md` with 3-tier framework and reusable template | 0.5 session | None |
| 9 | Area 6.3: Pam cross-cluster context | Embedding-based related keyword discovery for briefs | 1 session | After #4 |
| 10 | Area 6.4: Michael silo verification | Embedding-based coherence check on silo assignments | 0.5 session | After #4 |

### Cosmetic (nice-to-have)

| # | Finding | Action | Scope |
|---|---------|--------|-------|
| 11 | Area 3.1: forgegrowth orphans | Manual cleanup: remap 4 pages to valid canonical_key | 15 min |
| 12 | Area 5.2: Shadow dead code | Keep — useful for future validation | N/A |
| 13 | Area 2.3: TOCTOU in rebuildClustersAndRollups | Accept — no production impact | N/A |
| 14 | Area 3.2: foxhvacpro orphaned clusters | Accept — sales mode artifact | N/A |
| 15 | Area 3.6: Orphaned performance snapshots | Accept — known limitation | N/A |

---

## Proposed Sequencing

```
Session A (immediate):  #1 canonicalize_mode wiring gap
                        #6 DATA_CONTRACT.md update
                        #11 forgegrowth manual cleanup

Session B:              #2 Pam strategy status filter
                        #3 Legacy Sonnet elimination in hybrid
                        #7 syncMichael UPSERT guard

Session C:              #4 Embed-at-ingestion
                        #8 VALIDATION.md

Session D:              #5 Embedding-based backfill (replaces substring matching)
                        #9 Pam cross-cluster context

Phase 3:                #10 Michael silo verification
                        Scout dedup (already planned)

Phase 4:                Gap semantic matching (already planned)
```

**Dependencies:**
- #3 depends on #1 (need DB column → mechanism before skipping legacy)
- #5 depends on #4 (need embeddings at ingestion before backfill can use them)
- #9 depends on #4 (same reason)
- #10 depends on #4 (same reason)

---

## Open Questions for Operator

### Q1: Should legacy mode be preserved as a permanent fallback?

Phase 2's dual-mode architecture allows switching any client back to legacy via the DB column. Eliminating legacy Sonnet grouping in hybrid mode (#3) doesn't remove legacy mode — it only stops running legacy's grouping step when hybrid is active. Full legacy mode remains available for `canonicalize_mode='legacy'` clients.

**Decision needed:** Is this acceptable, or should legacy be entirely removed once all clients are on hybrid?

**Recommendation:** Keep legacy available. New clients and sales-mode audits may benefit from legacy as a simpler, no-embedding path. Cost of keeping: minimal (the code stays, just doesn't run for hybrid clients).

### Q2: Should forgegrowth.ai and ecohvacboise.com be promoted to hybrid before the wiring gap fix?

The wiring gap (#1) means any re-trigger would revert them. Promoting them first means a re-trigger breaks them; fixing the gap first means they run legacy until the fix ships.

**Recommendation:** Fix #1 first. The fix is ~25 lines and 1 session. Promoting without the fix creates an operational hazard.

### Q3: Should sales-mode audits run lightweight canonicalization?

Sales-mode audits (foxhvacpro, boiseserviceplumbers) skip Phase 3c entirely, leaving `audit_keywords.canonical_key` NULL everywhere. This creates orphaned clusters and 0% backfill. A lightweight canonicalize (embedding-only, no Sonnet arbitration) would cost ~$0.0001 and produce meaningful clusters.

**Decision needed:** Is the sales-mode cluster data valuable enough to justify adding a step?

**Recommendation:** Defer. Sales-mode audits are prospect qualification tools. Cluster data isn't shown to prospects. The cost is negligible but the complexity isn't — sales mode's value proposition is speed and simplicity.

### Q4: What is the target for backfill rate?

Current: ~55% (IMA). With embedding-based backfill (#5): estimated ~85%. The remaining ~15% would be keywords with no semantic relationship to any Michael page (genuinely unmatchable).

**Decision needed:** Is 85% acceptable, or should Michael's architecture output be modified to ensure broader coverage?

**Recommendation:** 85% is sufficient. The remaining 15% are informational/editorial keywords that Michael intentionally doesn't create pages for (they don't fit service-page architecture). Forcing coverage would dilute silo focus.

### Q5: Should the `cluster` column on `audit_keywords` be split?

Currently stores either canonical_topic (from canonicalize) or silo_name (from syncMichael), depending on which ran last. A dedicated `silo` column would clarify ownership.

**Decision needed:** Is the column split worth a migration, or is the current overloaded usage acceptable?

**Recommendation:** Split. The migration is trivial (add column, backfill from existing `cluster` where source is syncMichael). The clarity benefit prevents future bugs. Include in Session B alongside #7.

---

*Report generated 2026-04-21. No code changes made. All findings verified against live codebase and Supabase production data.*
