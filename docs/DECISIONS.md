# Architecture Decision Log

Non-obvious choices that would look wrong without context. Check here before "fixing" something.

---

**2026-03-10: Moved all DataForSEO/keyword/revenue logic out of run-audit Edge Function into the pipeline**

The `run-audit` Supabase Edge Function used to run DataForSEO keyword fetch + clustering + revenue modeling (Stage 1) before the pipeline existed. When the pipeline trigger was added, this became redundant — the pipeline's Phase 2 (KeywordResearch) and Phase 3 (Jim) handle all keyword seeding and research. The edge function was slimmed to a thin trigger: validate audit, mark as running, POST to pipeline server. It writes **nothing** to audit_keywords, audit_clusters, or audit_rollups.

**2026-03-10: audit_assumptions auto-creation fallback in sync-to-dashboard.ts**

`audit_assumptions` is primarily created by the Dashboard UI's `useCreateAudit` hook, which looks up benchmarks and CTR models at audit creation time. But if the pipeline runs for a domain where assumptions don't exist (e.g., audit auto-created by sync, or assumptions insert failed), `syncJim()` would silently skip all keyword sync — zero keywords, zero revenue, zero rollups. Added `ensureAssumptions()` that runs before any agent sync and auto-creates assumptions from the `benchmarks` table (matching service_key, falling back to 'other') and the default CTR model.

**2026-03-10: Phase 3d (rebuild clusters) added after canonicalize**

Phase 3b (sync jim) inserts keywords and builds clusters in one pass — but at that point `canonical_key` doesn't exist yet. The `cluster` field is populated by `extractTopic()` (naive 5-word truncation), so "air conditioner repair boise idaho" and "air conditioner repair boise" become separate clusters. Phase 3c (canonicalize) then assigns `canonical_key` to group them, but never rebuilt the clusters. Added Phase 3d which deletes existing clusters/rollups and re-aggregates using `canonical_key` as the grouping key. Clustering key priority: `canonical_key > cluster > topic > 'general'`.

**2026-03-10: Navigational intent exclusion from near-miss (three-layer defense)**

Problem: Canonicalize (Phase 3c) runs AFTER sync jim (Phase 3b) sets `is_near_miss`. Keywords like "ross boise" were being classified as navigational by canonicalize, but `is_near_miss` was already set to true by sync. Three fixes:
1. sync-to-dashboard.ts `isNearMiss` filter now checks `intent !== 'navigational'` at insert time
2. Canonicalize's post-step clears `is_near_miss` (and zeroes revenue) for any keyword where it sets `is_brand=true` or `intent_type=navigational`
3. Canonicalize prompt strengthened: "ONLY use navigational when the keyword contains a recognizable brand name. Generic service keywords like 'hvac contractors boise' are NEVER navigational."

**2026-03-10: Pipeline trigger server runs independently of WhatsApp**

NanoClaw's main process connects to WhatsApp via baileys, which blocks startup if auth fails (405 reconnect loop in WSL2). The pipeline trigger HTTP server (`src/pipeline-server.ts`) was moved to start BEFORE WhatsApp connection. Added `--pipeline-only` flag to skip WhatsApp entirely — used by the `nanoclaw-pipeline.service` systemd unit for production. The pipeline server listens on port 3847 with Bearer token auth and a duplicate-domain guard (in-flight Set).

**2026-03-10: 409 from pipeline server treated as success in run-audit Edge Function**

When the same domain is triggered twice (user clicks retry, or race condition), the pipeline server returns 409 (already running). The edge function initially treated this as a fatal error, marking the audit as failed. Changed to treat 409 as success with `status: "pipeline_already_running"`.

**2026-03-11: Scout (Phase 0) uses JSON config, not YAML**

Scout takes a `prospect-config.json` file as input rather than CLI flags or YAML. JSON was chosen because: (1) the pipeline already uses JSON everywhere (seed_matrix.json, ranked_keywords.json, scope.json), (2) no YAML dependency exists in the project, (3) config files are version-controlled per-prospect in `audits/{domain}/prospect-config.json` alongside other artifacts.

**2026-03-11: Scout skips resolveAudit — uses prospects table instead**

Scout runs before a client is onboarded, so no `audits` row exists. Instead of creating a throwaway audit record, Scout uses a separate `prospects` table with its own lifecycle (discovery → scouted → converted). The `converted_to_audit_id` FK links a prospect to its eventual audit after conversion. This keeps the `audits` table clean for actual paying clients.

**2026-03-12: Scout skips crawl entirely (DataForSEO-only)**

Scout originally included a lightweight SF crawl (Internal:All only) for topic extraction. Removed because: (1) Dwight does a comprehensive crawl in Phase 1 if the prospect converts, making Scout's crawl redundant; (2) topic extraction from DataForSEO ranked keywords works just as well — the Idaho Medical Academy test proved this with 13 clean canonical topics and no crawl data; (3) removing the crawl saves 30–60s per scout run.

**2026-03-11: Prospect mode exits after Scout — no full pipeline**

When `run-pipeline.sh` is called with `--mode prospect`, only Phase 0 (Scout) runs, then the script exits cleanly. The full pipeline (Phases 1–6c) runs separately after the prospect converts to a client. This prevents wasting compute/API budget on prospects that may never convert.

**2026-03-11: Geo-flexibility via geo_mode + market_geos on audits table**

The pipeline originally hardcoded one geographic model: `market_state` (single state) + `market_city` (comma-separated cities). This breaks for course providers, regional businesses, and multi-state expansion plays where the unit of geography is a state or metro. Added `geo_mode` (`city`|`metro`|`state`|`national`) and `market_geos` (JSONB) columns. A `resolveGeoScope(audit)` helper replaces all direct `market_city`/`market_state` reads — returns `{ mode, locales[], state, label }` ready for query construction. Existing `market_city`/`market_state` columns are NOT removed (backward compat with Dashboard code).

**2026-03-11: resolveGeoScope throws on null geo_mode — no silent defaults**

If an audit row has `geo_mode=NULL` (should not happen after migration backfill, but could occur from manual inserts), `resolveGeoScope()` throws a loud error instead of silently defaulting to city mode. This prevents accidental misclassification of geographic scope. The backfill `UPDATE` in the migration sets all existing rows to `geo_mode='city'`.

**2026-03-11: Mode-aware MATRIX_CAPS for KeywordResearch**

`MAX_KEYWORD_MATRIX_SIZE` was a flat cap of 200 for all audits. For state mode (e.g., 4 states × 15 services × 4 intent variants), the matrix can grow significantly. Replaced with per-mode caps: city=200, metro=300, state=500, national=200 (no geo multiplier). Truncation logs a warning but does not throw.

**2026-03-11: generateKeywordCandidates handles state/national modes**

For state mode, `locales` are state names (e.g., "Idaho", "Washington") — the `{service} {locale} {state}` variant is skipped to avoid "phlebotomy training Idaho Idaho". For national mode, `locales` is empty — candidates are `{service}` without any geo modifier.
