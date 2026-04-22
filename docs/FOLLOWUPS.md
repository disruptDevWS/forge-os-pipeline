# FOLLOWUPS.md — Deferred Items

Items captured during implementation sessions that are out of scope but shouldn't be forgotten.
Each entry is self-contained: picking it up 3 months later should not require rediscovery.

---

### [Dashboard] Clusters page `cluster_strategy` status filter

- **Issue:** The Lovable repo's Clusters page may display deprecated `cluster_strategy` rows alongside active ones. After re-canonicalization orphans a strategy (sets `status='deprecated'`, `deprecated_at` timestamp), the dashboard should stop showing it.
- **Why it matters:** Users see stale strategies for clusters that have been re-canonicalized. Confusing when active and deprecated strategies coexist for similar topics.
- **Prerequisites:** Verify current Clusters page query in `lovable-repo/src/hooks/useClusterFocus.ts` (or equivalent). Check if it already filters on `status`. The `status` and `deprecated_at` columns were added in migration 014.
- **Scope estimate:** S — likely one `.eq('status', 'active')` filter on the dashboard query. May need UI treatment for "no active strategy" state.
- **Captured:** Session A, 2026-04-20

---

### [Pipeline] `ranking_snapshots.cluster` column rename

- **Issue:** After the `audit_keywords.cluster` column split (Session B), `track-rankings.ts` caches the `cluster` value from `audit_keywords` and writes it to `ranking_snapshots.cluster`. Post-split, `audit_keywords.cluster` holds `canonical_topic`, so `ranking_snapshots.cluster` also holds `canonical_topic` — but the column name suggests silo.
- **Why it matters:** Misleading column name could confuse future development. The column stores canonical_topic but is named `cluster`.
- **Prerequisites:** Session B cluster split complete and verified.
- **Scope estimate:** S — rename column in migration + update `track-rankings.ts` writer + verify no dashboard readers depend on the column name.
- **Captured:** Session B Check 3, 2026-04-21

---

### [Pipeline] Deprecate `intent` column on `audit_keywords`

- **Issue:** `intent` is a backward-compatible copy of `intent_type`. Both columns exist on `audit_keywords`. Session B writes both (`intent = intent_type`) to maintain backward compatibility.
- **Why it matters:** Column duplication creates maintenance risk. Dashboard or edge functions may read `intent` in some places, `intent_type` in others. Pam's `generate-brief.ts` reads the `intent` column in its keyword SELECT.
- **Prerequisites:** Audit all `intent` column readers across pipeline repo and lovable-repo. Update them to use `intent_type`. Then drop `intent` column.
- **Scope estimate:** M — cross-repo reader audit + migration + dashboard updates.
- **Captured:** Session B addendum correction #4, 2026-04-21

---

### ~~[Pipeline] Inject `core_services` into Haiku classification prompt for vocational verticals~~ RESOLVED

- **Resolved:** Session 2026-04-22. `coreServices?: string[]` added to `ClassifyOptions` in `classify-keywords.ts`. Haiku prompt conditionally injects service-preference guidance + business service list when `core_services` is populated. `pipeline-generate.ts` extracts from `audits.client_context` JSONB (comma-separated string → array). No prompt change when `core_services` is absent.
- **Captured:** Classification validation investigation, 2026-04-21

---

### ~~[Pipeline] IMA classification NULL backfill (self-healing)~~ RESOLVED

- **Resolved:** Session B re-canonicalize run (2026-04-21) populated all 1,100 IMA keywords. is_brand NULLs 198→0, intent_type NULLs 198→0, entity_type NULLs 410→0.
- **Captured:** Session B Check 1, 2026-04-21

---

### [Pipeline] IMA/SMA state page production gap — pending operator-directed content surface

- **Issue:** IMA (`geo_mode: state`, single state Idaho) has 17 state-level and 6 city-level geo pages in architecture. SMA (`geo_mode: state`, 6 states) has 28 state-level and 1 city-level. Both are `not_started`/`deprecated`. The new `STATE_GEO_BLOCK` provides principled guidance (delivery-intent → city, regulatory → state, follow the data), but existing architectures pre-date these principles.
- **Why it matters:** Re-running Michael on IMA/SMA with the new prompt will produce more principled geographic page structures. But this is an operator decision — the existing architectures have committed pages and cluster activations.
- **Prerequisites:** Operator decides whether to re-run Michael on IMA/SMA. If yes, review committed page preservation behavior on strategic re-run.
- **Scope estimate:** S per client — one Michael re-run + review deprecation candidates.
- **Captured:** Michael prompt revision session, 2026-04-22

---

### [Pipeline] Strategy brief prompt quality review — directive precision now load-bearing

- **Issue:** The Michael prompt now treats Strategy Brief binding constraints as hard constraints that suppress page creation. This means imprecise or overly broad Strategy Brief language can silently prevent legitimate pages from being built. The Strategy Brief prompt (`scripts/strategy-brief.ts`) was written when brief content was advisory, not binding.
- **Why it matters:** An overly broad prohibition like "avoid competitor terms" could suppress pages targeting legitimate keywords. Strategy Brief quality is now on the critical path for architecture accuracy.
- **Prerequisites:** Review `strategy-brief.ts` prompt for directive precision. Ensure the four sections (Visibility Posture, Keyword Research Directive, Architecture Directive, Risk Flags) use specific, falsifiable language rather than vague guidance.
- **Scope estimate:** M — prompt review + potential revision of strategy brief generation prompt.
- **Captured:** Michael prompt revision session, 2026-04-22

---

### [Schema] `geo_mode` semantic cleanup — city/metro conflate geographic unit with market count

- **Issue:** `geo_mode` values `city` and `metro` conflate the geographic unit (city) with the market type (single vs multi-market). A single-city client and a 5-city client both use `city` mode but may need different geographic architecture guidance. Similarly, `state` covers single-state (IMA) and multi-state (SMA) with different patterns.
- **Why it matters:** The `getGeographicArchitectureBlock()` function returns the same block for both single-city and multi-city clients. The geographic architecture principles are the same, but the scale implications differ.
- **Prerequisites:** Evaluate whether the current city/metro/state/national taxonomy is sufficient or whether market-count should be a separate dimension.
- **Scope estimate:** L — schema change across pipeline + dashboard + edge functions.
- **Captured:** Michael prompt revision session, 2026-04-22

---

### [Pipeline] Pam brief handling for dual-parent service+location pages

- **Issue:** The geographic architecture blocks describe a dual-parent relationship for service+location pages (service pillar = topical parent, geographic hub = geographic parent). Pam's content brief generation (`scripts/generate-brief.ts`) currently treats each page as belonging to a single silo. Dual-parent pages need both parents referenced in the brief.
- **Why it matters:** Content briefs for geographic service pages should reference both the service pillar's positioning and the geographic hub's market context. Without this, briefs may miss geographic specificity or service depth.
- **Prerequisites:** Review Pam's brief generation prompt for silo/parent context injection. Determine how dual-parent relationship should surface in the brief.
- **Scope estimate:** M — Pam prompt update + brief schema addition for secondary parent.
- **Captured:** Michael prompt revision session, 2026-04-22

---

### [Pipeline] Coverage assessment rows cause false positive slug corruption in Michael validation

- **Issue:** `runMichael()` pre-flight slug corruption check counts Buyer Journey Coverage Assessment table rows (e.g., "Awareness (problem recognition, research queries)") as rejected slugs. This produces false positive corruption ratios of ~30%, triggering unnecessary retries.
- **Why it matters:** Each retry costs one additional Sonnet call (~$0.10-0.15). The parser (`parseBlueprintMarkdown`) correctly filters these rows — the corruption check is less sophisticated.
- **Prerequisites:** The `checkBlueprint()` function in `runMichael()` uses `parseBlueprintMarkdown()` which has its own silo table regex. The regex should be tightened to only match actual silo page tables, not coverage assessment tables.
- **Scope estimate:** S — tighten the silo table regex in `parseBlueprintMarkdown()` to exclude `### Silo N Coverage Assessment` sections.
- **Captured:** Michael prompt revision validation, 2026-04-22
