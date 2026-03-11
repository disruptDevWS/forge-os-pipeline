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
