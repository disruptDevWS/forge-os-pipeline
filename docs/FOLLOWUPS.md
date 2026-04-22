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
