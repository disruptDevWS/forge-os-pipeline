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

**2026-03-12: KeywordResearch consumes scope.json as optional priors (soft dependency)**

When a prospect converts to a client, Scout's `scope.json` contains topics and gap keywords already discovered. KeywordResearch now loads this file using `findLatestDatedDir()` + inline `fs.existsSync()` rather than extending `resolveArtifactPath()`. Rationale: scope.json is read in exactly one place (KeywordResearch), and extending the `'research' | 'architecture'` union type on `resolveArtifactPath()` would touch 6 call sites for no benefit. Scout priors are injected into the Haiku extraction prompt for validation against crawl data (not blindly trusted), and gap keywords are pre-seeded at priority 0 so they survive matrix truncation. The `marketCity`/`marketState` bug in the synthesis prompt was fixed in the same change — those variables were undeclared in `runKeywordResearch` scope; `kwGeo.label` is the correct source.

**2026-03-12: Oscar disk fallback removed (DB-only source of truth)**

Oscar's `gatherBrief()` had a dual-source pattern: query `execution_pages` from Supabase first, then fall back to disk files (`metadata.md`, `content_outline.md`, `schema.json`) if DB columns were null. This masked real failures — if Pam's upsert to `execution_pages` failed silently, Oscar would happily read stale disk data and produce content from outdated briefs. Removed the disk fallback entirely; Oscar now warns on null `metadata_markdown` and `schema_json` fields. The existing hard check (`if (!brief.contentOutlineMarkdown) throw`) enforces the critical requirement.

**2026-03-12: Pam logs warnings for missing enrichment files**

`generate-brief.ts` had empty catch blocks around `architecture_blueprint.md` and `research_summary.md` reads — when these files were absent, the brief was generated silently without silo structure or striking distance context. Added WARNING logs after each try-catch so operators can see which enrichments are missing. No behavior change — files remain optional.

**2026-03-12: PIPELINE_BASE_URL replaces PIPELINE_TRIGGER_URL**

Edge functions (`run-audit`, `scout-config`) were inconsistent: `run-audit` used `PIPELINE_TRIGGER_URL` as a full endpoint URL, while `scout-config` treated it as a base URL and appended paths. Standardized to `PIPELINE_BASE_URL` — edge functions append `/trigger-pipeline`, `/scout-config`, `/scout-report` in code. Both functions fall back to `PIPELINE_TRIGGER_URL` for backward compatibility. This means one Supabase secret serves all three pipeline server endpoints.

**2026-03-12: Pipeline server exposed via public IP (Cloudflare Tunnel recommended)**

Supabase Edge Functions need to reach the NanoClaw pipeline server running on a residential ISP connection. Currently exposed via public IP + port 3847 forwarded through EERO router. This works but the IP may change on DHCP lease renewal. If pipelines stop triggering, check `curl -s ifconfig.me` against the `PIPELINE_BASE_URL` secret. Recommended permanent fix: Cloudflare Tunnel with a stable hostname (e.g., `pipeline.forgegrowth.ai`), which survives IP changes and adds TLS.

**2026-03-12: Convert-to-client wired end-to-end (Scout → Pipeline)**

Prospect conversion flow: Dashboard `useConvertProspect` creates an `audits` row (with `geo_mode` and `market_geos` from the prospect — required by `resolveGeoScope()`), creates `audit_assumptions`, updates prospect `status='converted'`, then invokes `run-audit` edge function. The edge function sets audit `status='running'` and POSTs to `/trigger-pipeline`. KeywordResearch (Phase 2) automatically finds Scout's `scope.json` on disk and pre-seeds the keyword matrix with gap keywords. No manual data migration needed between prospect and audit phases.

**2026-03-12: Gemini embeddings removed from SF crawl (Dwight Phase 1)**

SF's `--config semantic_config.seospiderconfig` enabled Gemini API embeddings for content similarity detection. Removed because: (1) the embedding API times out on sites >500 pages — exactly the sites where cannibalization matters; (2) Jim's canonicalization (Phase 3c) and Michael's topic overlap analysis (Phase 6) already cover the same cannibalization signal from keyword and architecture angles; (3) the semantic similarity report (`Content:Semantically Similar`, `Content:Near Duplicates`) was a nice-to-have but not critical-path for the audit. The `semanticReport` variable in the prompt and Michael's `resolveArtifactPath('semantically_similar_report.csv')` both gracefully handle the file not existing. If content-level similarity analysis is needed for a specific client, it can be a standalone tool.

**2026-03-12: SF crawl uses async spawn instead of spawnSync**

The SF CLI was invoked via `child_process.spawnSync('bash', [tmpScript], { timeout: 600_000 })`. For large sites, the 600s timeout caused `ETIMEDOUT` even when the crawl had completed — SF was still processing (API calls, report generation). Switched to async `child_process.spawn()` wrapped in a Promise, which has no timeout cap. SF's Java process manages its own timeouts internally.

**2026-03-12: Jim research_summary.md truncation guard**

Claude Sonnet can hit output token limits on large prompts. When this happens, `callClaudeAsync()` captures only the continuation fragment (e.g., "Continuing Section 10 from the cut-off point:") instead of the full report. This caused `keyword_overview` to be all zeros (no Section 2 to parse). Fix: (1) reduced prompt size — keyword table from 200→100 rows, competitor table from 50→20; (2) added structural validation checking for `# Research Summary` header and `## 8.` section; (3) auto-retries once if validation fails. The retry is cheap (same prompt, no new API calls) and catches truncation before it propagates to sync.

**2026-03-12: Dwight filters internal_all.csv to HTML pages before analysis**

Dwight's prompt was receiving all resources from `internal_all.csv` — CSS, JS, images, fonts — inflating the page count and diluting the analysis. Added a `Content Type` column filter that keeps only `text/html` rows. The filter uses simple comma-split (not a full CSV parser) which works because MIME type values never contain commas. Non-HTML resources are counted but excluded from the prompt: `Filtered internal_all.csv: {n} HTML pages ({dropped} non-HTML resources excluded)`.

**2026-03-12: Agentic readiness scorecard regex allows explanatory text**

The sync-dwight parser extracts PASS/FAIL signals from Section 10.4 of AUDIT_REPORT.md. The original regex `(PASS|FAIL)\s*\|` failed on rows like `FAIL — zero structured data site-wide |` because text appeared between the status and the pipe delimiter. Fixed to `(PASS|FAIL)[^|]*\|` which matches any text after PASS/FAIL up to the next pipe. The scorecard template was also updated to instruct "PASS or FAIL — explanation" format.

**2026-03-12: top_10_non_branded uses domain-name heuristic (not is_brand flag)**

`keyword_overview.top_10_non_branded` is needed at Jim sync time, but `is_brand` is null until Canonicalize runs (Phase 3c). Rather than defer the computation, sync-jim uses a domain-name heuristic: strip TLD from domain, remove hyphens, compare spaceless versions against each keyword. E.g., `idahomedicalacademy` matches `idaho medical academy`. This catches the most common branded keywords without waiting for Canonicalize. The count is re-synced with canonical `is_brand` data if sync-jim runs again after Phase 3c.

**2026-03-12: keyword_overview exposes DataForSEO cap metadata**

DataForSEO's `ranked_keywords/live` endpoint returns max 1000 results but the response's `total_count` field reports the true total (e.g., 3735 for idahomedicalacademy.com). Added `keywords_capped: true` and `dataforseo_total: 3735` to `keyword_overview` in the Jim snapshot so the dashboard can render "1,000+" / "400+" instead of presenting capped numbers as absolutes.

**2026-03-13: Screaming Frog replaced with DataForSEO OnPage API (Dwight Phase 1)**

SF CLI was a Java desktop app that couldn't run on cloud, had site-unreachable failures, and cost $209/yr. Replaced with DataForSEO's OnPage API (`scripts/dataforseo-onpage.ts`) which: (1) runs anywhere (pure HTTP), (2) handles JS rendering, (3) costs ~$0.025/crawl for 200-page sites. The new `scripts/onpage-to-csv.ts` transformer produces CSV files with identical headers to SF output (`INTERNAL_ALL_KEEP_COLUMNS`) so all downstream consumers (Dwight prompt, Michael prompt, sync-dwight) work unchanged. `Spelling Errors` and `Grammar Errors` columns are empty (never consumed meaningfully). `Link Score` maps to `onpage_score` (0-100 vs SF's proprietary metric). Polling uses 15s intervals with 30-min timeout for large sites.

**2026-03-13: Claude CLI replaced with Anthropic SDK (@anthropic-ai/sdk)**

The pipeline spawned the `claude` CLI binary (`/home/forgegrowth/.local/bin/claude`) via `child_process.spawn`/`spawnSync`. This had multiple problems: (1) binary dependency that can't deploy to Railway, (2) `spawnSync` has a 120s timeout cap regardless of the `timeout` parameter, (3) required stripping all `CLAUDE*` env vars to prevent conversation transcript leaking into output, (4) `stripClaudePreamble()` was needed to clean XML artifacts. New `scripts/anthropic-client.ts` uses `@anthropic-ai/sdk` directly with per-phase `max_tokens` config. Model mapping: `sonnet` → `claude-sonnet-4-5-20250514`, `haiku` → `claude-haiku-3-5-20241022`. All 15 call sites in `pipeline-generate.ts` plus `generate-brief.ts` and `generate-content.ts` migrated.

**2026-03-13: loadEnv() falls through to process.env for cloud deployment**

Local dev reads from `.env` file. When no `.env` exists (Railway, Docker), `loadEnv()` now falls through to `process.env`. This lets the same code run on both home server and Railway without code changes. Applied to all four files: `pipeline-generate.ts`, `sync-to-dashboard.ts`, `generate-brief.ts`, `generate-content.ts`.

**2026-03-13: QA Agent evaluates generation phases via Haiku**

New `runQA()` function in `pipeline-generate.ts` evaluates LLM output after each generation phase (Dwight, Jim, Gap, Michael) using phase-specific rubrics. Each rubric has critical/high/medium weighted checks. Verdict logic: PASS (all critical pass, ≤1 high fail), ENHANCE (critical fail or 2+ high fails, but meaningful content), FAIL (broken/empty). On ENHANCE, the phase re-runs and QA evaluates again. On persistent FAIL, pipeline halts. Results logged to `audit_qa_results` Supabase table. Cost: ~$0.005 per QA eval (Haiku).

**2026-03-13: Pipeline server health endpoint for Railway**

Added `GET /health` to `pipeline-server.ts` returning `{ status: 'ok', uptime, inFlight }`. Railway uses this for health checks and zero-downtime deploys. Also created `pipeline-server-standalone.ts` as a standalone entry point that runs without WhatsApp/container dependencies.

**2026-03-13: Dockerfile.railway for cloud deployment**

`Dockerfile.railway` uses `node:22-slim` + curl + jq (for `foundational_scout.sh`). Railway volume mounts at `/app/audits` for inter-phase artifact persistence. No Claude binary, no Screaming Frog, no Java — pure Node.js + HTTP APIs.

**2026-03-16: Pre-filter aggregator domains from Jim's competitor table**

Jim's DataForSEO competitor data included Yelp ($1.3B ETV), HomeAdvisor, BBB, etc. as top competitors — useless for sales or strategy analysis. Added `AGGREGATOR_DOMAINS` constant and `isAggregatorDomain()` filter that removes these before building the prompt. Phase 4 (Competitors) already had its own Haiku-based classification, but Jim's output feeds the dashboard and Michael directly, so pre-filtering is needed at the data level. The filter runs on `competitors.json` extraction, not the raw file — `competitors.json` on disk stays unmodified for debugging.

**2026-03-16: Evidence-based service expansion in KeywordResearch (Phase 2)**

The KeywordResearch extraction prompt's "do NOT guess" rule was too conservative — boiseserviceplumbers.com extracted only "Residential Plumbing" and "Commercial Plumbing" despite offering emergency plumbing, drain cleaning, water heater repair, etc. Two fixes: (1) relaxed the extraction prompt to include sub-services from navigation, titles, and URL paths; (2) added `expandServicesFromCrawl()` which cross-references `SERVICE_KEYWORD_SEEDS[serviceKey]` against AUDIT_REPORT.md text and internal_all.csv URLs. Only seeds with evidence in the crawl are added — this prevents hallucinating services the business doesn't offer. Also added `detectServiceKey()` for auto-created sales audits where `service_key='other'`: Tier 1 counts seed term matches (min 2), Tier 2 asks Haiku (~$0.001). The detected key is written to the audit row so downstream phases inherit it.

**2026-03-16: Client context as prompt reasoning constraints (not keyword filters)**

Full-mode audits for clients (e.g., Summit Medical Academy) produced irrelevant content recommendations because the pipeline had no business context. Added `client_context` to `prospect-config.json` with `business_model`, `services`, `out_of_scope`, `target_audience`, etc. Injected into Phases 2/3/5/6 as prompt context. The key design choice: `out_of_scope` is injected as **reasoning constraints**, not keyword matrix filters. A keyword filter catches exact matches ("phlebotomy") but misses semantic exclusions ("online-only means no geo city pages"). The LLM needs the reasoning context to make these judgment calls. Sales mode is unaffected (no `client_context` in prospect-config).

**2026-03-16: Deterministic revenue headline for sales mode (not LLM)**

Sales prospects need a dollar figure. Revenue model already existed (benchmarks → audit_assumptions → CR/ACV) but only ran during sync. Added `buildRevenueTable()` which reads `audit_assumptions` and `audit_rollups` to produce a `## Revenue Opportunity` markdown table (Conservative / Expected / Optimistic). This is deterministic — no LLM call — because revenue figures end up in sales reports. A hallucinated number from Michael could misrepresent opportunity to a prospect. The table is passed verbatim to Michael's prompt so the blueprint includes it in one pass (no post-hoc file rewrite).

**2026-03-17: Performance tracking baseline uses first ranking_snapshot, not baseline_snapshots**

The spec assumed `baseline_snapshots` contains all keyword positions for delta computation. It doesn't — it only stores near-miss keywords (positions 11-30, filtered by volume), written once by sync-jim. Resolution: the first `ranking_snapshots` entry per keyword becomes the effective baseline. A `ranking_deltas` SQL view computes deltas at query time by joining earliest vs latest snapshots per keyword. This keeps computation in the database (not TypeScript) — as snapshot volume grows across clients, pulling all rows to compute deltas client-side would degrade. `baseline_snapshots` remains useful only for the "Opportunity Keywords" section on the Performance tab, showing the initial near-miss positions at audit time.

**2026-03-17: avg_position excludes unranked keywords**

`cluster_performance_snapshots.avg_position` and `page_performance.current_avg_position` are computed from only the keywords that have a non-null `rank_position` (i.e., appear in the top 1000 in DataForSEO). Keywords where DataForSEO returned no ranking are stored with `rank_position=null` in `ranking_snapshots` but excluded from the average. Including them would require inventing a placeholder position (e.g., 1001) which would skew the metric — a cluster with 5 keywords at position 8 and 15 unranked would show avg ~750 instead of 8. The `keyword_count` on `cluster_performance_snapshots` includes all keywords (ranked + unranked) for the cluster, while the position bucket counts (`keywords_p1_3`, `keywords_p4_10`, etc.) only count ranked keywords.

**2026-03-17: Performance tracking as weekly cron, not per-pipeline**

Ranking tracking runs independently of the audit pipeline via `scripts/cron-track-all.ts` (weekly scheduler) and `scripts/track-rankings.ts` (per-domain). Rationale: rankings change slowly (weekly is sufficient), DataForSEO costs $0.05/call, and the pipeline runs once per domain while tracking is ongoing. A 6-day recency check in `track-rankings.ts` prevents double-runs from scheduling drift. The `/track-rankings` endpoint on the pipeline server enables on-demand runs from the dashboard.

**2026-03-17: canonical_key is the contractual bridge between cluster layer and execution layer**

`canonical_key` (set by Phase 3c) is the primary join key between `audit_clusters` and `execution_pages`. Any future phase connecting these tables must use `canonical_key` — not topic string matching, not silo name matching. Silos come from Michael's blueprint headings (e.g., "Core Plumbing Services (Boise)"), canonical_topics from Phase 3c semantic grouping (e.g., "Water Heater Repair") — completely different string spaces. `syncMichael()` backfills `canonical_key` on `execution_pages` by mapping each page's `primary_keyword` through `audit_keywords.canonical_key`.

**2026-03-17: Geo-agnostic canonical keys**

Canonical keys and topics must be geography-agnostic. "Boise water heater repair" and "water heater repair" resolve to `water_heater_repair`. Geographic context lives in keyword-level data and schema markup, not cluster identity. One cluster strategy document serves the topic regardless of geo variants. Phase 3d merges geo variants into combined clusters with correct aggregate volume/revenue. The Phase 3c prompt was strengthened to explicitly show geo-stripping examples and forbid geo prefixes in `canonical_key`.

**2026-03-17: Three-tier model allocation policy (Haiku / Sonnet / Opus)**

Explicit policy for which Claude model to use per phase:
- **Haiku** — high-volume classification, batching, validation (Canonicalize, Competitors, QA, Validator, service detection). Runs dozens of times per pipeline. Cost must stay low.
- **Sonnet** — synthesis and generation phases with large context and structured output (Dwight, Jim, KeywordResearch, Gap, Michael, Pam, Oscar, Scout). Primary workhorse. Good balance of quality and cost.
- **Opus** — strategic judgment phases where a wrong decision has high downstream cost, reasoning requires cross-domain depth, and call frequency is low (Cluster Strategy). A misdirected cluster strategy cascades into weeks of wasted content production — exactly the agency failure mode this system replaces. Cost delta is ~$0.45/cluster vs Sonnet, trivial against the execution cost it governs.

Scout stays on Sonnet despite producing strategic output, because it runs at $2 budget per prospect (many never convert) and Opus would consume ~30% of that on one call. Cluster strategy only fires for converted, paying clients — the right economic boundary for Opus.

**2026-03-17: Cluster strategy prompt includes Jim's research narrative**

`generate-cluster-strategy.ts` loads `research_summary.md` via `resolveArtifactPath()` and extracts Section 8 (Striking Distance) and Section 10 (Key Takeaways). This gives Opus the strategic observations about the domain's competitive position alongside structured cluster data — why the cluster matters competitively, not just what keywords are in it. Falls back gracefully if the file doesn't exist on disk (Railway-only deployments).

**2026-03-17: Cluster activation gates content production**

Cluster activation (`/activate-cluster` endpoint) generates a strategy document via `generate-cluster-strategy.ts` (single Sonnet call, ~$0.05-0.15) and marks the cluster as `active`. Only pages in active clusters have `cluster_active=true` on `execution_pages`, enabling the dashboard to filter the Content Queue by active clusters. Deactivation (`/deactivate-cluster`) is near-instant (2 Supabase UPDATEs, no LLM call). This creates the upsell mechanic: activating a cluster is the explicit commitment to produce content for that topic.

**2026-03-16: Stripped dead WhatsApp/container code (~5,500 lines)**

NanoClaw was originally built as a WhatsApp bot with Docker-isolated Claude Agent SDK containers. WhatsApp was never used in production (WSL2 baileys conflicts), and the pipeline "agents" are single-shot prompt templates calling `callClaude()` — not Agent SDK multi-turn sessions. The actual product is a pipeline toolkit: Dashboard → Supabase Edge Functions → Railway HTTP server → shell orchestrator → TypeScript phase generators → Supabase sync. Deleted: `src/index.ts` (WhatsApp orchestrator), `src/channels/whatsapp.ts` (baileys client), `src/container-runner.ts`, `src/group-queue.ts`, `src/ipc.ts`, `src/task-scheduler.ts`, `src/router.ts`, `src/mount-security.ts`, `src/db.ts` (SQLite), `src/config.ts`, `src/env.ts`, `src/types.ts`, `src/pipeline-server.ts` (replaced by standalone), `src/logger.ts`, all 7 test files, `container/` directory, `groups/` directory, and 6 WhatsApp-focused docs. Removed 12 npm dependencies (baileys, better-sqlite3, pino, qrcode-terminal, cron-parser, zod, pg, qrcode, and their @types). `src/` now contains only `pipeline-server-standalone.ts`. Risk was very low: pipeline scripts have zero imports from any deleted file.
