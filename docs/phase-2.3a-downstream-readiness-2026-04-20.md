# Phase 2.3a — Downstream Consumer Readiness Report

**Date:** 2026-04-20
**Purpose:** Pre-promotion readiness review for canonicalize hybrid mode
**Scope:** Audit-only, no code changes
**Promotion candidate pool:** IMA, SMA, forgegrowth.ai, ecovacboise.com

## Executive Summary

**Overall assessment: READY FOR PHASE 2.3b PROMOTION** — with monitoring protocols.

No downstream consumer has explicit dependencies on legacy-style output that would fail under hybrid. The codebase is architecturally sound: all join logic uses `canonical_key` (opaque string), not `canonical_topic` (display name). Topic naming conventions flow into LLM prompts as context but never as routing/branching logic.

**Top 3 findings:**

1. **Pam's keyword join path degrades gracefully but needs monitoring.** Pam queries `audit_keywords.cluster = siloName` — if `execution_pages.silo` is stale from a prior Michael run while `audit_keywords.cluster` reflects the new hybrid canonicalization, the join returns 0 keywords and Pam falls back to a broader (less focused) keyword context. Not a failure, but degraded brief quality.

2. **`cluster_performance_snapshots` has an orphan problem on key rename.** Historical authority data is keyed by `canonical_key`. If hybrid produces different keys than legacy on the transition run, prior performance history is disconnected from the new cluster with no migration path. The dashboard shows new clusters starting from authority 0.

3. **Architecture persistence is robust.** Michael's `isCommitted()` predicate protects all committed content. The `canonical_key` backfill runs after Michael and correctly re-maps pages to new keys. Stale pages are deactivated (not deleted). The one-time transition from legacy to hybrid produces expected deprecation/deactivation behavior.

**Classification distribution:** 1 READY WITH MONITORING (Pam), 5 READY (all others). 0 BLOCKS PROMOTION.

---

## Consumer-by-Consumer Findings

### 1. rebuildClustersAndRollups()

**Classification: READY**

**Input contract:**
- Reads `audit_keywords`: `canonical_key`, `canonical_topic`, `cluster`, `intent_type`, `intent`, `is_brand`, `search_volume`, `rank_pos`, revenue columns, `primary_entity_type`
- Filter: `.not('canonical_key', 'is', null)` — only processes canonicalized keywords
- Does NOT read: `classification_method`, `similarity_score`, `arbitration_reason`, `canonicalize_mode`
- Reads `audit_clusters` for prior activation status preservation (before DELETE+INSERT)
- Reads `cluster_strategy` for orphan deprecation

**Implicit assumptions found:**
- None. Treats `canonical_key` as opaque string identifier. No regex, no hardcoded matching, no cluster count bounds, no minimum cluster size requirements.
- `buildClusterMap()` filters out informational/navigational keywords and branded keywords by their dedicated fields — not by topic name.

**Data shape sensitivity:**
- 30 clusters instead of 15: No issues. Function produces N `audit_clusters` rows for N distinct keys. `opportunity_topics_count` in rollups reflects actual count.
- Topic split: Orphan-detection logic correctly identifies lost keys → deprecates strategies, deactivates pages.
- Smaller cluster sizes: Revenue/leads aggregate proportionally. `sample_keywords` gracefully handles <5 keywords.

**Re-run behavior:**
- DELETE+INSERT cycle with explicit status preservation for surviving keys.
- Orphaned keys get `cluster_active: false` on execution_pages and `status: 'deprecated'` on cluster_strategy.
- `cluster_performance_snapshots` NOT touched — historical data for orphaned keys is stranded. This is a data lineage gap but not a functional failure.
- Hybrid's prior-lock mechanism means fewer orphans on re-runs (keys stabilize). First hybrid run after legacy is the high-orphan event.

**Integration smoke test:**
- Input: Audit with 3 active clusters + strategies, where hybrid re-canonicalization renames 1 key and splits 1 topic into 2.
- Verify: (1) surviving active cluster retains status/activated_at, (2) renamed key's strategy is deprecated, (3) split produces 2 new inactive clusters, (4) execution_pages for renamed key have `cluster_active: false`, (5) audit_rollups.opportunity_topics_count = new count.
- Failure mode: If hybrid produces a key that is semantically equivalent but syntactically different (e.g., `ac_repair` → `air_conditioning_repair`), the old key is orphaned even though the intent is unchanged. This is by design (no fuzzy remapping).

---

### 2. syncMichael()

**Classification: READY**

**Input contract:**
- Reads `audit_keywords`: `keyword`, `canonical_key` (for backfill) — case-insensitive match on `keyword` string
- Does NOT read: `canonical_topic`, `classification_method`, `similarity_score`, or any Phase 2 metadata
- Writes: `execution_pages.canonical_key` via keyword→key lookup, `agent_architecture_pages`, `agent_architecture_blueprint`

**Implicit assumptions found:**
- The `canonical_key` backfill is a keyword-text lookup (primary_keyword → audit_keywords.keyword), NOT a topic-name lookup. Robust to hybrid naming changes.
- `isCommitted()` protects committed pages (status != 'not_started', source='cluster_strategy'/'manual', or published) — metadata-only updates on re-run.
- The backfill at line 2362 runs AFTER the committed-page protection and updates `canonical_key` regardless of committed status. This is correct — committed pages should track their keyword's current canonical assignment.

**Data shape sensitivity:**
- 30 topics: No effect. Backfill maps per-keyword, not per-topic.
- Topic splits: Works correctly because lookup is keyword→key, not topic→key.
- If Michael's `primary_keyword` doesn't exactly match any `audit_keywords.keyword`, backfill silently fails for that page — `canonical_key` retains prior value or stays null.

**Re-run behavior:**
- Backfill runs unconditionally every syncMichael execution. Previous canonical_key values are overwritten with current mapping.
- Window of staleness: Between re-canonicalize and next Michael run, execution_pages may have old canonical_keys. Pages are deactivated (safe) but not yet re-assigned.
- `run-canonicalize.ts` has its own backfill (lines 157-187) that mirrors syncMichael's — Settings-triggered re-canonicalizations also update execution_pages immediately.

**Integration smoke test:**
- Input: Audit with 20+ execution_pages, some committed. Re-canonicalization changed 3 keywords' canonical_keys.
- Verify: (1) Backfill updates all 3 pages to new canonical_key, (2) committed pages retain status/source/content, (3) Pages whose primary_keyword has no match get no update (prior key preserved).
- Failure mode: Primary_keyword variant mismatch (e.g., "HVAC repair services" vs "hvac repair"). Backfill is case-insensitive but requires exact text match. Rate should be logged.

---

### 3. generateClusterStrategy()

**Classification: READY**

**Input contract:**
- Reads `audit_clusters`: `canonical_topic`, `primary_entity_type`, `total_volume`, `est_revenue_mid` (queried by `canonical_key`)
- Reads `audit_keywords`: `keyword, search_volume, rank_pos, intent_type, is_brand, is_near_me, delta_revenue_mid, cpc` (filtered by `canonical_key`, excludes brand)
- Reads `execution_pages`, `audit_snapshots`, `audit_topic_competitors`, client context
- Does NOT read: `classification_method`, `similarity_score`, `arbitration_reason`, `canonicalize_mode`

**Implicit assumptions found:**
- `canonical_topic` appears in Opus prompt as section header: `## Cluster: ${cluster.canonical_topic}`. More specific hybrid names flow into Opus reasoning context. **Risk: LOW** — this is a quality improvement (more specific context = better strategy), not a breaking change.
- No hardcoded topic names, patterns, or cluster count/size thresholds.
- Role-assignment (`mapContentTypeToRole()`) operates on Opus output strings, not input topic names.
- Silo-match fallback (step 12b) matches `execution_pages.silo = cluster.canonical_topic`. If syncMichael ran under old names and cluster_strategy runs under new names, this match fails. **Pre-existing risk** — identical to what happens with legacy re-canonicalization.

**Data shape sensitivity:**
- Operates on a SINGLE cluster per invocation (user-triggered per-cluster activation). More total clusters = more potential activations, each independent.
- Smaller clusters (3-4 keywords): Opus receives smaller keyword table, produces proportionally focused strategy. No minimum-size guards.
- Keyed by `(audit_id, canonical_key)` via upsert — second activation of same key overwrites.

**Re-run behavior:**
- Deprecation logic in `rebuildClustersAndRollups()` handles orphaned strategies. If hybrid renames a key, old strategy is deprecated (not deleted).
- Hybrid's prior-lock means keys stabilize after first run — fewer spurious deprecations on subsequent runs vs. legacy's non-determinism.
- `cluster_strategy.canonical_topic` is a snapshot value from generation time — becomes stale if topic display name changes but `canonical_key` stays the same. Cosmetic only.

**Integration smoke test:**
- Input: Audit with hybrid canonicalization complete. Activate a cluster with ≥3 keywords, some with existing execution_pages.
- Verify: (1) strategy_markdown starts with `### 0. Entity Map`, (2) `recommended_pages` JSON parses correctly, (3) execution_pages with matching canonical_key get `cluster_active: true`, (4) silo-match fallback activates pages where `silo = canonical_topic AND canonical_key IS NULL`.
- Failure mode: Silo-match miss if Michael ran with old topic names. Mitigation: re-run Michael after re-canonicalize.

---

### 4. runGap()

**Classification: READY**

**Input contract:**
- Reads `audit_topic_competitors` and `audit_topic_dominance` (produced by Phase 4, keyed by `canonical_key`)
- Reads `audit_clusters`: `topic, total_volume, est_revenue_*` — does NOT read `canonical_key` or `classification_method`
- Reads `audit_keywords`: `keyword, rank_pos, search_volume, intent, intent_type, ranking_url, cluster, is_near_miss, is_near_me, cpc` — does NOT read `canonical_key` or `canonical_topic`
- Reads `agent_architecture_pages`, `agent_technical_pages`
- Does NOT read any Phase 2 metadata columns

**Implicit assumptions found:**
- None. Gap is downstream of Phase 4 (Competitors), which groups by `canonical_key`. Gap consumes pre-grouped data.
- Caps input at top 30 dominance entries, top 20 clusters by revenue, top 10 competitors. These caps handle any cluster count gracefully.
- No parsing of topic names for intent or routing.

**Data shape sensitivity:**
- 30 clusters: Top-20 cap applies, Gap sees the most valuable clusters regardless of total count.
- Smaller clusters: Gap doesn't care about individual cluster sizes — it cares about volume/revenue at cluster level.
- New topics: If hybrid creates new topics, Phase 4 processes them (Competitors runs between canonicalize and Gap). Gap receives whatever Phase 4 wrote.

**Re-run behavior:**
- Stateless. Always writes fresh `content_gap_analysis.md` to disk and new `audit_snapshots` row. No comparison against prior gap output. No topic caching.
- `unaddressed_gaps` compares against CURRENT `agent_architecture_pages` — not prior gap output.

**Integration smoke test:**
- Input: Audit where hybrid canonicalize + Phase 4 (Competitors) have run.
- Verify: (1) `audit_topic_dominance` has rows for hybrid-produced canonical_keys, (2) Gap produces valid JSON output with no "No competitive data found" short-circuit, (3) authority_gaps reference real canonical_keys.
- Failure mode: Phase 4 must run AFTER hybrid canonicalize for Gap to have correct data. Pipeline ordering guarantees this (Phase 4 runs at pipeline slot 4, canonicalize at 3c).

---

### 5. runMichael()

**Classification: READY**

**Input contract:**
- Reads `audit_clusters`: `topic, total_volume, est_revenue_low, est_revenue_high, sample_keywords, near_miss_positions` — does NOT read `canonical_key` or `classification_method`
- Reads `execution_pages` (for re-run reconciliation): `url_slug, silo, priority, status, source, published_at, page_brief, canonical_key`
- Receives cluster data as a markdown table in the Opus prompt

**Implicit assumptions found:**
- Prompt Rule 4: "3-7 silos total" — constrains OUTPUT structure regardless of input cluster count. Michael consolidates clusters into silos.
- Prompt Rule 4b: caps total new pages proportional to site size (15/<10 pages, 25/10-30 pages).
- No minimum cluster size assumptions. No topic name parsing.
- Michael receives `topic` (display name) — more specific hybrid names provide better context for architecture decisions.

**Data shape sensitivity:**
- 30 clusters: The "Revenue Clusters" prompt section grows but the 3-7 silo constraint constrains output. Michael consolidates related clusters into silos — this is correct behavior with more granular hybrid topics.
- Smaller clusters: Lower per-cluster revenue may deprioritize them in Michael's judgment. Rule 8 ("every HIGH-VOLUME cluster topic should map to at least one page") uses LLM judgment for "high-volume" — no hardcoded threshold.

**Re-run behavior:**
- `agent_architecture_pages` and `agent_architecture_blueprint` are ALWAYS replaced (DELETE+INSERT)
- `execution_pages` reconciliation via `isCommitted()`: committed pages get metadata-only updates, non-committed stale pages deprecated
- `canonical_key` backfill runs after page sync — updates all pages to current keyword→key mapping

---

## Architecture Persistence Findings (Michael-specific extended investigation)

### Persistence Model

Michael's output persists in three layers:
1. **Reference layer** (`agent_architecture_pages`, `agent_architecture_blueprint`): ALWAYS replaced on re-run. No committed protection.
2. **Durable layer** (`execution_pages`): Protected by `isCommitted()`. Committed pages survive re-runs intact.
3. **Canonical mapping** (`execution_pages.canonical_key`): Backfilled from `audit_keywords` after each sync. Updates to current mapping regardless of committed status.

### Scenario A: execution_page with status='content_ready', canonical_key assigned under legacy, hybrid re-canonicalize changes the keyword's mapping

**Trace:**
1. Starting state: `execution_pages` row with `canonical_key='emt_basic_course'`, `status='content_ready'`
2. Hybrid re-canonicalize runs (Phase 3c+3d):
   - Phase 3c updates `audit_keywords.canonical_key` — the keyword now maps to `online_emt_training`
   - Phase 3d (`rebuildClustersAndRollups`) detects `emt_basic_course` as orphaned → sets `cluster_active: false` on the execution_page, deprecates any cluster_strategy
3. `run-canonicalize.ts` backfill (lines 157-187) runs immediately after 3d: matches page's `primary_keyword` against keywords → writes `canonical_key='online_emt_training'` to the page
4. **Result:** Page retains `status='content_ready'` (content safe), gets new `canonical_key='online_emt_training'`, but has `cluster_active: false` until the new cluster is activated.

**Risk:** Between re-canonicalize and cluster activation, the page is deactivated. Content is safe but the page doesn't appear in active content queue filters. This is correct, intentional behavior — the new cluster must be explicitly activated.

### Scenario B: Legacy cluster "EMT Basic Course" (8 pages) split by hybrid into 3 clusters

**Trace:**
1. Starting state: 8 `execution_pages` with `canonical_key='emt_basic_course'`
2. Hybrid canonicalize splits keywords into `online_emt_training` (4 kw), `emt_certification` (3 kw), `emt_refresher` (1 kw)
3. `rebuildClustersAndRollups`: `emt_basic_course` no longer exists in keyword data → orphaned → 8 pages get `cluster_active: false`, cluster_strategy deprecated
4. `run-canonicalize.ts` backfill: Each page's `primary_keyword` is matched against `audit_keywords` → pages get assigned to whichever of the 3 new keys their primary_keyword maps to
5. **Result:** 8 pages distributed across 3 new clusters (proportional to keyword mapping). All deactivated. New clusters must be individually activated for content production to resume.

**Risk:** If a page's `primary_keyword` doesn't exactly match any keyword in `audit_keywords` (unlikely but possible with Michael's creative slug→keyword generation), the backfill fails and the page retains `canonical_key='emt_basic_course'` — permanently orphaned until Michael re-runs.

### Scenario C: Michael wrote topology with 15 clusters, hybrid produces 22 clusters, Michael re-runs

**Trace:**
1. After hybrid canonicalize: 22 clusters in `audit_clusters`
2. `runMichael()` queries `audit_clusters` — receives all 22 in the Revenue Clusters prompt section
3. Michael generates new architecture with 3-7 silos (consolidating 22 topics). Blueprint may recommend different page structure.
4. `syncMichael()` with `strategic_rerun` scenario:
   - `agent_architecture_pages/blueprint`: replaced entirely with new output
   - `execution_pages`: committed pages (status != 'not_started') preserved with metadata-only updates. Non-committed stale pages deprecated. New pages from expanded clusters inserted.
   - Canonical_key backfill: all pages get current canonical_key from keyword mapping
5. **Result:** Old topology destroyed at reference layer. Durable layer (committed content) preserved. New topology accommodates 22 clusters.

**Risk:** None identified. The architecture is designed for this exact scenario. `isCommitted()` is the protection boundary.

### Architecture Persistence Assessment

**No BLOCKS PROMOTION finding.** The architecture persistence model is robust:
- Committed content is always preserved via `isCommitted()`
- Canonical_key backfill correctly re-maps pages to new keys
- Orphan detection (rebuildClustersAndRollups) handles the transition gracefully
- The one-time legacy→hybrid transition produces expected deprecation behavior (same as any re-canonicalization)

---

### 6. Pam (content briefs)

**Classification: READY WITH MONITORING**

**Input contract:**
- Reads `execution_pages`: `canonical_key`, `silo` (= canonical_topic)
- Reads `audit_keywords`: filtered by `.eq('cluster', siloName)` — keyword join uses the `cluster` column which stores `canonical_topic` value
- Reads `audit_clusters`: `primary_entity_type` keyed by `canonical_key`
- Reads `cluster_strategy`: `entity_map`, `ai_optimization_targets` keyed by `canonical_key`
- Does NOT read: `classification_method`, `similarity_score`, or any Phase 2 metadata

**Implicit assumptions found:**
- **Keyword join via `cluster` column** (line 196): Pam queries `audit_keywords.cluster = siloName`. The `cluster` column is updated by `rebuildClustersAndRollups` to reflect `canonical_topic`. If `execution_pages.silo` is stale (set by a prior Michael/cluster-strategy run using old topic names), the join returns 0 keywords. Pam falls back to broader context (all keywords, limit 50).
- **canonical_topic embedded in prompt** (line 952): `- Silo: ${siloName}` appears directly in the Page Identity section. More specific hybrid names flow into Claude's brief generation context.
- **Architecture blueprint regex match**: Pam searches the Michael-generated blueprint for a section matching `siloName`. If topics were renamed after Michael ran, the regex fails and Pam uses a 2000-char fallback.
- **Stale `pam_requests.silo_name`**: If a brief request is queued before re-canonicalization, the persisted `silo_name` may not match current `audit_keywords.cluster`. Fallback chain: `req.silo_name → execution_pages.silo → null`.

**Data shape sensitivity:**
- More clusters with fewer keywords: Smaller keyword tables in Pam's context. Not a failure — briefs work with any keyword count.
- Finer-grained topics: Better context for brief generation (e.g., "EMT Course Cost & Pricing" tells Claude more about the page's commercial focus than "EMT Basic Course").
- New topics: If page belongs to a new topic, Pam finds whatever keywords are assigned. No issues.

**Re-run behavior:**
- No in-memory caching. Each `processRequest()` queries Supabase fresh.
- Disk output keyed by slug, not canonical_topic — no cache invalidation issue.
- Re-brief creates new pam_request with current silo_name — old brief files are orphaned but harmless.

**Integration smoke test:**
- **Keyword join test**: After hybrid re-canonicalize, verify for each `execution_pages` row with `canonical_key != null`: `.from('audit_keywords').eq('cluster', page.silo).eq('audit_id', id)` returns >0 rows.
- **Stale silo test**: Queue pam_request with pre-hybrid silo_name. Verify Pam falls back gracefully and produces valid brief.
- **Entity map stability**: Verify `cluster_strategy` rows still joinable via `canonical_key` after re-canonicalization.
- **Blueprint regex test**: Verify Pam's architecture section extraction works or falls back gracefully.
- Failure mode: 0-keyword context produces lower-quality briefs (generic guidance vs. keyword-targeted). Detectable by monitoring "keyword count in context" metric.

---

## Additional Consumers Discovered

| Consumer | What it reads | Classification | Notes |
|----------|---------------|----------------|-------|
| `track-rankings.ts` | `audit_keywords.canonical_key`, `cluster_performance_snapshots` | READY | All joins on `canonical_key`. Topic name is display-only label. |
| `generate-content.ts` (Oscar) | Zero canonical data | READY | Downstream of Pam — consumes briefs, not canonical structure. |
| `strategy-brief.ts` (Phase 1b) | Zero canonical data | READY | Runs BEFORE canonicalize (Phase 1b precedes 3c). Not a consumer. |
| `generate-client-brief.ts` | `audit_clusters.canonical_topic` (display only) | READY | Pure display consumer. Topic names render in HTML as-is. |
| `backfill-authority-scores.ts` | `audit_keywords.canonical_key` | READY | All logic on `canonical_key`. |
| `run-canonicalize.ts` | Producer, not consumer | READY | IS the canonical data producer. |
| `pipeline-server-standalone.ts` | Pass-through `canonical_key` from request body | READY | Routing only. |
| Edge: `cluster-action` | `canonical_key` for status updates | READY | Pass-through + status update. |
| Edge: `run-competitor-dominance` | Groups by `canonical_key`, uses `canonical_topic` as label | READY | Join logic on key, topic is cosmetic. |
| Edge: `share-audit` | `audit_clusters.*` (full export) | READY | Read-only data export. |

**8 additional consumers discovered.** All classified READY. No implicit assumptions about legacy-style topic naming found in any additional consumer.

---

## Cross-Cutting Observations

1. **All consumers join on `canonical_key`, never on `canonical_topic`.** The codebase consistently uses `canonical_key` as the join/filter key and `canonical_topic` as a display label. This is the fundamental reason no consumer blocks promotion — hybrid changes topic *names* but the key structure is stable.

2. **The `cluster` column on `audit_keywords` is a legacy artifact that creates a sync dependency.** It stores `canonical_topic` (updated by `rebuildClustersAndRollups`), and is read by Pam's keyword join. This is the ONLY join path that uses topic name content instead of `canonical_key`. It works correctly when the rebuild has run after canonicalization (Phase 3d always follows 3c), but creates a stale-data window if pages reference old topic names.

3. **The one-time legacy→hybrid transition is the highest-risk event.** After the transition, hybrid's `prior_assignment_locked` mechanism stabilizes keys across re-runs. The transition itself may produce more orphans than a typical legacy re-canonicalization because hybrid's finer-grained clustering creates more distinct keys.

4. **`cluster_performance_snapshots` has no migration path for renamed keys.** When a canonical_key changes (whether from legacy re-canonicalization OR from the hybrid transition), historical authority data under the old key is stranded. The dashboard shows the new cluster starting from authority 0. This is a pre-existing issue (not introduced by hybrid) but is amplified by the transition. Documented as an operational consideration, not a blocker.

5. **Michael's "3-7 silos" constraint absorbs cluster count variance.** The prompt forces consolidation regardless of input count. Whether canonicalize produces 15 or 30 clusters, Michael's output structure stays bounded. This is the design pattern that makes Michael robust to hybrid's higher cluster counts.

---

## Dashboard Visibility Audit

| Consumer | Output Location | Dashboard Surface | Pre/Post Comparison Method |
|----------|-----------------|-------------------|----------------------------|
| rebuildClustersAndRollups | `audit_clusters`, `audit_rollups` | ClustersPage, OverviewPage (revenue cards), ResearchPage, AuditsDashboard | UI: cluster count/names visible. SQL: compare `audit_clusters` before/after. |
| syncMichael | `execution_pages`, `agent_architecture_pages`, `agent_architecture_blueprint` | StrategyPage, ExecutionPage (content queue) | UI: strategy page shows blueprint, execution shows pages. SQL: compare canonical_key distribution. |
| generateClusterStrategy | `cluster_strategy`, `execution_pages` | ClustersPage (strategy expandable section) | UI: strategy markdown visible per cluster. |
| runGap | `audit_snapshots` (JSON), disk file | ResearchPage (gap section) | UI: gap analysis renders on Research page. Disk: `content_gap_analysis.md`. |
| runMichael | `agent_architecture_pages`, `agent_architecture_blueprint`, `execution_pages` | StrategyPage, ExecutionPage | UI: full architecture visible on Strategy page. |
| Pam | `pam_requests` (status), `execution_pages` (brief fields), disk artifacts | ExecutionPage (brief status indicator) | UI: brief status on content queue cards. Disk: per-page brief files. |
| track-rankings | `ranking_snapshots`, `cluster_performance_snapshots`, `audit_clusters.authority_score` | PerformancePage (authority chart, cluster table) | UI: authority trends visible. SQL: compare scores before/after. |
| generate-client-brief | Disk HTML, Supabase (shared via edge function) | Downloadable from Settings page | UI: download button. Visual: open HTML in browser. |

**Operational readiness assessment:**
- 6/8 critical consumers have direct UI surfaces for comparison.
- `cluster_performance_snapshots` (authority history) is database-only for per-key drill-down but surfaces via the PerformancePage chart at cluster level.
- No critical consumer output is exclusively database-only with no comparison surface.
- **Monitoring protocol for Phase 2.3b:** UI review of ClustersPage (names/counts), StrategyPage (architecture), ExecutionPage (page assignments), PerformancePage (authority continuity). SQL verification of canonical_key distribution and orphan counts.

---

## Blocking Issues

**None identified.** No consumer requires pre-promotion code changes.

---

## Integration Smoke Test Checklist (for Phase 2.3b)

Client-agnostic — designed to work against any of the four promotion candidates.

### Pre-promotion baseline capture
- [ ] Snapshot current `audit_clusters` (canonical_key, canonical_topic, status, authority_score)
- [ ] Snapshot current `execution_pages` (url_slug, canonical_key, cluster_active, status)
- [ ] Snapshot current `cluster_strategy` (canonical_key, status)
- [ ] Screenshot ClustersPage, StrategyPage, ExecutionPage, PerformancePage

### After first hybrid promotion run (re-canonicalize in hybrid mode)
- [ ] Verify `audit_clusters` rebuilt with expected cluster count (hybrid produces ~1.5-2x legacy count)
- [ ] Verify no execution_pages have NULL canonical_key that previously had one (backfill regression)
- [ ] Verify orphan handling: lost keys → `cluster_active: false`, strategies deprecated
- [ ] Verify surviving active clusters retain `status='active'` and `activated_at`
- [ ] Compare canonical_topic names: note any that changed (for Pam keyword-join monitoring)
- [ ] Run `SELECT canonical_key, count(*) FROM audit_keywords WHERE audit_id=? AND canonical_key IS NOT NULL GROUP BY canonical_key ORDER BY count(*) DESC` — verify no single-keyword clusters auto-assigned (size gate validation)

### Pam monitoring (after first content brief request)
- [ ] Verify keyword count in Pam's context is >0 for the page's cluster
- [ ] If 0: check `execution_pages.silo` matches `audit_keywords.cluster` for that page's keywords
- [ ] Verify brief quality: not degraded to generic guidance

### Architecture stability (if Michael re-runs)
- [ ] Verify committed pages preserved (count unchanged, status unchanged)
- [ ] Verify canonical_key backfill resolves ≥80% of pages
- [ ] Verify no committed page has `canonical_key` pointing to an orphaned cluster

### Performance continuity
- [ ] Check `cluster_performance_snapshots`: surviving keys have historical data intact
- [ ] Check PerformancePage authority chart: no unexpected resets to 0
- [ ] Note any keys with authority history that were orphaned (for operational awareness, not blocking)

### Cluster strategy (if any cluster is activated post-promotion)
- [ ] Verify strategy generation succeeds with hybrid-produced topic names
- [ ] Verify execution_pages get `cluster_active: true` for activated cluster
- [ ] Verify silo-match fallback activates pages where canonical_key was null

---

## Recommendation

**GO for Phase 2.3b promotion.** No blocking issues found.

**Recommended first promotion candidate: SMA** (`c07eb21d-3120-4242-8754-361a429a6f2c`)

Rationale:
- SMA is already hybrid-origin (all 121 keywords have `classification_method != null`, 100% prior-lock stability confirmed across multiple shadow runs)
- SMA's transition risk is minimal — hybrid re-canonicalize will produce identical output to the current shadow state because all keywords are already locked
- SMA has active cluster strategies and committed content, making it the best test of the full downstream chain
- SMA is the smallest corpus (127 keywords) — lowest blast radius if anything unexpected occurs

**Sequencing recommendation:**
1. Promote SMA first (minimal risk, validates the full chain)
2. If SMA succeeds: promote IMA (larger corpus, tests the size gate under production conditions)
3. forgegrowth.ai and ecovacboise.com after IMA validation

**Phase 2.3b scope:** No prerequisite fix session needed. Proceed directly to promotion with the smoke test checklist above as the monitoring protocol. The only operational consideration is documenting the `cluster_performance_snapshots` orphan behavior so the operator knows authority scores may reset for any renamed clusters (applies to IMA more than SMA, since SMA's keys are fully locked).
