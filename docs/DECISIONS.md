# Architecture Decision Log

Non-obvious choices that would look wrong without context. Check here before "fixing" something.

---

**2026-03-24: Validator resilience — max_tokens bump + truncation detection + JSON repair**

Phase 6.5 (Coverage Validator) failed on IMA's audit (35 clusters, 30+ gaps) because `max_tokens: 4096` was too low — JSON response truncated at ~14K chars. Bumped to 16384 (matches other synthesis phases). Added `TruncationError` class and `warnOnTruncation` option to `callClaude()` — when `stop_reason === 'max_tokens'`, always logs a warning; when the flag is set, throws `TruncationError` carrying the partial output so callers can attempt repair. Generalized `repairJSON()` with an optional `arrayKey` parameter (tries specified key for truncation recovery instead of hardcoded `"groups"`). Validator now catches `TruncationError` and attempts `repairJSON(partial, 'coverage')`. Cost impact of token bump: zero (cap, not minimum). Added defensive dedup guardrail to validator prompt as safety net.

**2026-03-24: Gap agent deduplication — canonical_key pre-aggregation + structural prompt constraint**

Phase 5 (Gap agent) produced near-duplicate authority_gaps on IMA (5 EMT variants, 4 burn/first-aid variants) because dominance data had multiple rows per canonical_key (one per geo-variant keyword). Two-layer fix: (1) Pre-aggregate dominance and weakTopics by `canonical_key` before injecting into the prompt — keep the row with lowest `client_share` as representative, prefix each line with `[canonical_key]`. (2) Replace the single "deduplicate semantic equivalents" sentence in the prompt with a structural constraint: each authority_gap MUST correspond to a distinct `[canonical_key]`, max 15 is an upper bound not a target, typical audit 6-12. The `[canonical_key]` prefix provides context; the structural constraint is the enforcement mechanism. Gap QA rubric floor is "5+ specific content gaps" (line ~4607) — target range of 6-12 stays above this, no rubric update needed.

---

**2026-03-23: Phase 2 service_area → Bucket 3 cities + cap raised from 3 to 5**

Bucket 3 (city-qualified keywords in state mode) relied entirely on Haiku extracting city names from AUDIT_REPORT.md. With JS rendering disabled, crawls return thin HTML and Haiku finds 0 locations — Bucket 3 never fires. The user already enters `service_area` in Settings (e.g., "Boise, Nampa, Meridian"). This data was available via `loadClientContextAsync()` as `extras.service_area` but Phase 2 discarded `extras`. Now Phase 2 parses `service_area`, filters out state names (already in Bucket 2), deduplicates against Haiku results, and merges into `locations`. City cap raised from 3 to 5 because explicit user input is reliable (not noisy Haiku extraction). Cost impact: ~160 more candidates in a 500-cap matrix — well within budget.

**2026-03-23: Robust prose parsing for service_area city extraction**

`service_area` is free-text — users enter prose like "Primarily serving Idaho, Eastern Oregon, and Eastern Washington" not just "Boise, Nampa, Meridian". Naive comma-split produced tokens like "Primarily serving Idaho" which, when concatenated with long service names, exceeded DataForSEO's keyword character limit (all 380 candidates rejected → pipeline failed). Parser now: (1) strips leading prose prefixes ("Primarily serving..."), (2) splits on commas AND the word "and", (3) rejects tokens with prose/filler words, (4) rejects directional state patterns ("Eastern Oregon"), (5) rejects tokens >4 words. When no cities are extractable, logs diagnostic instead of injecting garbage. This means `service_area` with only regional descriptions correctly yields 0 city hints — Bucket 3 won't fire, which is correct behavior.

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

The original codebase's main process connected to WhatsApp via baileys, which blocked startup if auth fails (405 reconnect loop in WSL2). The pipeline trigger HTTP server (`src/pipeline-server.ts`) was moved to start BEFORE WhatsApp connection. Added `--pipeline-only` flag to skip WhatsApp entirely. The pipeline server listens on port 3847 with Bearer token auth and a duplicate-domain guard (in-flight Set). (Historical context — WhatsApp code has since been removed.)

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

Supabase Edge Functions need to reach the Forge OS pipeline server running on a residential ISP connection. Currently exposed via public IP + port 3847 forwarded through EERO router. This works but the IP may change on DHCP lease renewal. If pipelines stop triggering, check `curl -s ifconfig.me` against the `PIPELINE_BASE_URL` secret. Recommended permanent fix: Cloudflare Tunnel with a stable hostname (e.g., `pipeline.forgegrowth.ai`), which survives IP changes and adds TLS.

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

Cluster activation (`/activate-cluster` endpoint) generates a strategy document via `generate-cluster-strategy.ts` (single Opus call, ~$0.15-0.50) and marks the cluster as `active`. Only pages in active clusters have `cluster_active=true` on `execution_pages`, enabling the dashboard to filter the Content Queue by active clusters. Deactivation (`/deactivate-cluster`) is near-instant (2 Supabase UPDATEs, no LLM call). This creates the upsell mechanic: activating a cluster is the explicit commitment to produce content for that topic.

**2026-03-17: Cluster status preservation through rebuild**

`rebuildClustersAndRollups()` does DELETE+INSERT on `audit_clusters`. Without preservation, re-canonicalize would deactivate all active clusters. The function now saves activation metadata (status, activated_at, activated_by, target_publish_date, notes) before DELETE and restores it after INSERT for clusters whose `canonical_key` survives the rebuild. Also syncs `execution_pages.cluster_active` — surviving active clusters keep their pages flagged, lost clusters get their pages deactivated.

**2026-03-17: client_context lives on disk (prospect-config.json), mirrored to audits table**

The pipeline reads `client_context` from `audits/{domain}/prospect-config.json` via `loadClientContext()`. The dashboard Settings page reads/writes `audits.client_context` JSONB column. These are separate stores — the pipeline never reads from Supabase `client_context`, and the dashboard never reads from disk. They are synced at convert-to-client time. If the pipeline needs to pick up Settings-page edits, the edge function must write to both disk (via `/scout-config`) and Supabase.

**2026-03-17: pipeline-controls edge function for Settings page**

Settings page pipeline actions (re-canonicalize, track rankings) route through a single `pipeline-controls` edge function rather than one edge function per action. This follows the `scout-config` pattern (action switch on request body) and keeps the edge function count manageable. Both actions proxy to existing pipeline server endpoints (`/recanonicalize`, `/track-rankings`).

**2026-03-17: Position-weighted topical authority score**

Authority score = Σ(position_weight) / (keyword_count × 1.0) × 100. Weights: pos 1-3=1.0, 4-10=0.6, 11-20=0.3, 21-30=0.1, 31+=0.05, not ranking=0.0. Denominator is ALL keywords for the `canonical_key` in the ranking snapshot — including keywords the domain has never ranked for. This penalizes clusters with large coverage gaps, not just poor positions. Computed weekly during `track-rankings.ts` and stored in `cluster_performance_snapshots` (historical) and `audit_clusters` (current). Delta = current minus previous snapshot score. The live computation uses snapshot data as the denominator (already contains all audit_keywords). The backfill script uses `audit_keywords` directly since older snapshots may not have had all keywords.

**2026-03-17: Authority score surfaced in Clusters page + Performance page**

The authority score (0-100, position-weighted) is surfaced in two dashboard pages: Performance page shows authority trend chart (recharts line chart per cluster, collapsible), authority/trend columns in the cluster performance table, and a weighted-average summary card. Clusters page shows authority/trend columns in the cluster table, an "Opportunity" badge on the best inactive cluster (highest revenue + authority < 50), an avg authority summary card, and an empty-state info banner linking to Settings when no scores exist yet. Both pages share `AuthorityScoreBadge` (4 color tiers: Low/Building/Strong/Dominant) and `AuthorityDeltaBadge` components. Data comes from `audit_clusters.authority_score` (current) and `cluster_performance_snapshots` (historical trend via `useClusterAuthorityTrend` hook).

**2026-03-18: Citation scan via SERP, not BrightLocal/dedicated citation API**

DataForSEO has no multi-directory citation endpoint — their Business Listings DB is Google Maps only. Rather than adding a new vendor (BrightLocal ~$80/mo), Phase 6d uses DataForSEO's SERP API to search `"Business Name" "City, State" site:{directory}` per directory. This gives presence detection + basic NAP extraction from snippets at ~$0.002/directory. A `data_source: 'serp'` field on `citation_snapshots` allows future upgrade to a dedicated citation API without schema changes. Known limitation: Apple Maps (`maps.apple.com`) blocks Google crawling, so SERP returns `listing_found: false` for most businesses — documented, not a bug.

**2026-03-18: GBP canonical NAP as source of truth for citation matching**

Phase 6d extracts canonical NAP (name, address, phone) from the GBP listing and uses it as the reference for citation consistency checks. Rationale: GBP is the authoritative local listing — citation services like Moz Local and BrightLocal use the same approach. Fallback chain when GBP is missing: `client_profiles.canonical_name/address/phone` (manual entry from Settings page), then domain-derived name. The `gbp_snapshots` row is always upserted, even when `listing_found: false` — a missing GBP is the highest-value sales signal in the audit (unclaimed = immediate action item for the client).

**2026-03-18: Phase 6d runs in both sales and full mode**

Local presence data (GBP claimed status, citation gaps) is a strong sales signal — unclaimed GBP and inconsistent NAP are easy-to-explain audit findings that drive conversions. Keeping Phase 6d in both modes means the Sales Report and the full Architecture Blueprint both benefit from local presence data. Cost is ~$0.026/audit (negligible vs the ~$5-8 total pipeline cost).

**2026-03-18: Phase 1b Strategy Brief — strategic framing before keyword research**

The pipeline was reactive to current rankings rather than generative from client intent. For clients like SMA (online provider, multi-state service area, near-zero non-branded visibility), Phase 2 optimized around crawl-extracted signals because client profile entered mid-pipeline as a constraint layer rather than a strategic directive. Phase 1b synthesizes Dwight output + Scout data + client profile into a `strategy_brief.md` that explicitly resolves visibility posture, keyword matrix construction rules, architecture requirements, and risk flags. This brief is injected into Phase 2 (Sonnet synthesis, not Haiku extraction — the directive informs prioritization, not entity extraction), Michael (architecture + risk flags, Visibility Posture dropped as non-actionable), and Pam (posture + architecture directive). The brief is a disk artifact only (no Supabase table) — it's consumed by downstream prompts, not surfaced in the dashboard. Sonnet, not Haiku, because this is synthesis + strategic reasoning across 3 disparate documents. Cost: ~$0.06/audit. Scout gap report markdown enters the analytical pipeline for the first time here (previously only served the dashboard UI).

**2026-03-18: Two-step audit creation — draft → configure → run**

Previously, creating an audit via `/audits/new` auto-triggered the pipeline immediately with no opportunity to enter client context. Phase 1b (Strategy Brief) produced generic output without business model, services, or out_of_scope constraints. Fix: `useCreateAudit` no longer invokes `run-audit` or sets status to `running`. Audit stays as `draft`. User is redirected to Settings page where client context fields already exist. A draft banner with "Start Pipeline" (and "Skip — start without context") appears at the top of Settings for `status === 'draft'`. AuditsDashboard routes draft audits to Settings instead of Running. The convert-prospect path (`useConvertProspect`) is completely independent and unaffected — it still auto-triggers. Why Settings reuse over a new intermediate page: Settings already has client context form, revenue assumptions, and pipeline trigger button built and working. Why not inline on NewAudit form: it already has domain/service/geo/assumptions — 7 more fields makes it overwhelming.

**2026-03-18: loadClientContextAsync — dual-source client context bridge**

Client context has two entry paths: Scout's `prospect-config.json` (disk) and the Settings page's `audits.client_context` JSONB (DB). Previously all pipeline callers used `loadClientContext()` (sync, disk-only). Added `loadClientContextAsync(domain, sb, auditId)` that tries disk first, falls back to DB with field mapping: `core_services` → split to `services[]`, `differentiators` → `competitive_advantage`, `out_of_scope` → split to `string[]`. Disk file takes priority so Scout-converted prospects use their original context. Dashboard-only fields (`service_area`, `notes`) returned separately as `DashboardExtras` for Phase 1b. All 5 callers updated: strategy-brief.ts, runJim, runMichael, runGap, runKeywordResearch, generate-cluster-strategy.ts. The round-trip works: skip → fill later on Settings → re-run pipeline → `loadClientContextAsync` picks up DB context on re-run.

**2026-03-18: Scout Prospect Narrative — plain-language outreach document**

Scout's technical report (7 sections, tables, JSON scope block) is for the pipeline, not for a prospect. Added `generateProspectNarrative()` which generates `prospect-narrative.md` — a 3-section document ("Where You're Winning", "Where Demand Is Escaping You", "What a Full Analysis Would Reveal") written for a business owner with no SEO knowledge. Uses Sonnet (not Haiku) because the output requires tone calibration, business language translation, and persuasive framing — classification tasks Haiku handles well, but writing tasks benefit from Sonnet's synthesis quality. Non-fatal: wrapped in try/catch inside `runScout()` so Scout succeeds even if narrative generation fails. This prevents a $0.01 narrative call from wasting $2 of DataForSEO spend. The narrative is served via `scout-config` edge function's `read_report` action alongside the existing scout report data.

**2026-03-18: Pipeline Review Gate — opt-in pause after Strategy Brief**

The pipeline runs unattended from trigger to completion. Strategic errors in Phase 1b (wrong services, wrong geo scope, missing out_of_scope constraints) cascade silently into Phases 2-6 — wrong keyword matrix → wrong clusters → wrong architecture. Added an opt-in review gate after Phase 1b: when `audits.review_gate_enabled = true` and mode is `full`, `run-pipeline.sh` queries the flag via `update-pipeline-status.ts check-review-gate`, sets status to `awaiting_review`, and exits cleanly. The user reviews `strategy_brief.md`, optionally adds annotations (appended to `client_context.out_of_scope`), then resumes via `pipeline-controls` edge function (`action: 'resume_pipeline'`, triggers with `start_from: '1b'`). Why opt-in: most audits don't need review — the gate is for high-value or complex clients. Why full-mode only: sales mode runs fast ($2-3), review overhead isn't worth it. Why `update-pipeline-status.ts` not `sync-to-dashboard.ts`: the status script already handles audit status updates with user/audit resolution — adding a query mode is natural extension, while sync handles table-level data operations.

**2026-03-19: Data Contract document (docs/DATA_CONTRACT.md) as cross-repo schema source of truth**

Pipeline and dashboard are separate repos with no shared type system. Schema mismatches (wrong column names, missing enums, assumed-but-nonexistent tables) caused multiple deploy-fail-fix cycles. Created `docs/DATA_CONTRACT.md` — authoritative map of every Supabase table with column-level writer/reader ownership, edge function request/response contracts, disk artifact paths, SQL views, polling intervals, and known column name mismatches (e.g., pipeline writes `listing_found`, dashboard reads `gbp_missing`). Added to CLAUDE.md Session Start as required reading. Rule: if a table, column, edge function, or sync pattern changes, DATA_CONTRACT.md gets updated in the same commit.

**2026-03-19: Prospect Share Token — Supabase-only public read path for Scout reports**

Scout reports were served via `/scout-report` on the pipeline server (residential IP, may change). Sharing with cold prospects required the pipeline server to be up and reachable. Fix: store scout report data (`scout_markdown`, `scout_scope_json`, `prospect_narrative`, `brand_favicon_url`) directly in the `prospects` table at Scout completion via a single UPDATE. A `share_token` UUID on `prospects` (unique partial index) serves as the credential for public access. Two new `scout-config` edge function actions: `generate_share_token` (behind `validateSuperAdmin`) and `get_share_report` (no auth — token IS the credential, reads Supabase only). Key decisions: (1) Token on `prospects` not `audit_shares` — prospects aren't audits, different lifecycle. (2) Single UPDATE at scout completion — no second DB roundtrip. (3) Favicon URL from Google's favicon service (deterministic, no image processing). (4) No RLS changes — edge function uses service role key. (5) `read_report` action still works via pipeline server (for dashboard use), share token is the new public path.

**2026-03-19: PostToolUse hook for automatic TypeScript type checking**

Multiple sessions had type errors caught only at commit/deploy time — curly quotes in strings, nonexistent column references, invalid enum values. Added `.claude/settings.json` with a `PostToolUse` hook that runs `npx tsc --noEmit` after every `Edit` or `Write` tool call. 30s timeout. This catches errors immediately during development instead of after a chain of changes makes the root cause harder to trace.

**2026-03-19: Business Context removed from Scout form**

Scout evaluates a site's current state and market opportunity using DataForSEO ranked keywords and SERP data — it does NOT need business context. The five Business Context fields (Business Model, Core Services, Target Audience, Competitive Advantage, Out of Scope) on the Scout form (`/scout/new`) were collected into `config.client_context` but never consumed by `runScout()`. `loadClientContext()` already returns `null` when the key is absent (`client-context.ts:33` — `config.client_context ?? null`). Business context belongs in `client_profiles` (Settings page, post-conversion), where it's consumed by Oscar for brand voice and content production. Removed: state variables, `clientContext` construction, `client_context` from `CreateProspectParams` interface, `client_context` from `ProspectConfig` interface in `pipeline-generate.ts`, the entire `<Collapsible>` Business Context JSX block.

**2026-03-19: State Abbreviation field removed from Scout form**

The separate "State Abbreviation" input on the Scout form was redundant with `GeoModeSelector`, which already captures state via dropdown (city/metro modes) or text input (state mode). The form now uses `geoData.state || ''` directly. The `state` field in `scope.json` is inert metadata — written at `pipeline-generate.ts:3871` but never consumed by any downstream phase. Phase 2 (KeywordResearch) loads `scope.json` but only reads `services` and `locales` (lines 2872-2873); geo targeting comes from `resolveGeoScope(auditRow)`, not scope.json. For state/national modes where `geoData.state` is undefined, the empty string fallback is safe.

**2026-03-19: Budget/cost removed from Scout reports**

DataForSEO cost (`$0.09 / $2.00`) was exposed in the report format template, the data context section, and `scope.json`. This is internal operational data — a prospect should never see how much the scan cost. Removed `dataforseo_cost` from scope.json, removed the `**DataForSEO Budget Used:**` line from the report prompt, and removed the `**DataForSEO Cost:**` line from the data section. Console cost logs remain for operator visibility. `ScoutMarkdownViewer.tsx` (Lovable) adds a regex strip for existing stored reports that already contain the budget line.

**2026-03-19: Scout topic extraction made geo-agnostic**

Haiku's topic extraction prompt produced geo-specific topics like `{ key: "water-damage-restoration-boise", label: "Water Damage Restoration Boise" }`. The opportunity map candidate generator cross-products topics x metros, so "water damage restoration boise" x metro "Boise" became "water damage restoration boise boise" — DataForSEO returned 0 volume. Fix: updated the Haiku prompt with explicit geo-stripping instructions and examples. Topics are now SERVICE CATEGORIES (e.g., "water-damage-restoration"), and the geo dimension comes from the `config.target_geos` cross-product. This matches the geo-agnostic canonical_key convention established in Phase 3c.

**2026-03-20: Strategy brief served via dedicated `/strategy-brief` endpoint with date resolution**

The review gate pauses the pipeline after Phase 1b (Strategy Brief), but the dashboard had no way to display the brief — users were approving something they couldn't see. Added a `/strategy-brief` endpoint on the pipeline server that scans `audits/{domain}/research/` date directories (descending) for `strategy_brief.md` and returns `{ content, date }`. Not using the existing `/artifact` endpoint because it requires the caller to know the exact date path (`research/2026-03-19/strategy_brief.md`), which the edge function doesn't have. The new endpoint does date resolution server-side, same pattern as `/scout-report`. Edge function proxies as `read_strategy_brief` action on `pipeline-controls`. Dashboard renders in a `StrategyBriefReviewModal` (Dialog + ReactMarkdown) triggered from the `ReviewBanner` on the Settings page.

**2026-03-20: Resume-from-phase exposed in dashboard UI (not just CLI)**

The pipeline server and shell orchestrator already supported `--start-from` for resuming from a specific phase, but the `run-audit` edge function and dashboard UI didn't pass it through. Two UX gaps: (1) Settings page only had "Re-run Full Pipeline" which restarts from Phase 1, wasting 20+ minutes and API budget when only later phases need re-running; (2) DataForSEO transient errors (HTTP 500) in Phase 3 required a full re-run to recover. Fix: `run-audit` edge function now accepts optional `start_from` in the request body and forwards it to the pipeline server. Settings page re-run dialog has a phase dropdown with common resume points (Phase 2, 3, 3c, 6, 6d). Dialog description, confirm button text, and success toast update dynamically based on selection. Only practical resume points are exposed (not every sub-phase) to keep the UI concise.

**2026-03-20: Review gate toggle surfaced in DraftBanner and ConvertToClientDialog**

The review gate toggle was buried in Pipeline Controls (Settings page) — inaccessible before the pipeline starts. For the Draft flow, the user fills in context on Settings then clicks "Start Pipeline" in the DraftBanner, but the review gate toggle was below the fold in a different section. For Convert-to-Client, the pipeline auto-fires with no Settings page visit at all. Fix: added inline Switch toggle in DraftBanner ("Pause for Strategy Brief review before continuing") and in ConvertToClientDialog. Both update `audits.review_gate_enabled` directly. The Pipeline Controls section keeps its toggle for post-start changes. The DraftBanner toggle uses the same Supabase direct update pattern as the Pipeline Controls toggle (not a separate mutation).

**2026-03-21: Dashboard UX audit — coordinated IA reorganization (16 issues, 4 phases)**

Full Playwright-assisted UX walkthrough identified 16 issues across all dashboard pages (3 Critical, 7 Significant, 6 Minor). Rather than patching individually, issues were grouped into a 4-phase implementation sequence unified by a single design principle: reinforce the Research → Strategy → Content Execution workflow and make the user's position unmistakable. Phase 1 (C1/C2/C3/M16/S10): sidebar labels, cluster empty states, workflow indicators, Share button relocation. Phase 2 (S4/S5/S6/S7): progressive disclosure on Overview, sub-tabs on Research, section groups on Settings, data guards on audit list. Phase 3 (S9): Client Profile relocated from Content Queue to Settings. Phase 4 (M11/M14): duplicate nav cards removed from Overview, GeoModeSelector added to New Audit form. Key decisions: (1) Overview section link cards removed rather than restyled — sidebar now has clear labels + status dots, making the cards pure redundancy. (2) New Audit form reuses existing `GeoModeSelector` component from Scout form (`src/components/scout/GeoModeSelector.tsx`) rather than building a new one — single source of truth for geo input across both flows. (3) `geo_mode` + `market_geos` added to audit insert via `(supabase as any)` pattern (same as `useConvertProspect`) since generated types don't include these columns.

**2026-03-21: New Audit form sets geo_mode — prevents pipeline Phase 2 failure**

The New Audit form collected city/state via plain text inputs but never set `geo_mode` or `market_geos` on the audit row. The pipeline's `resolveGeoScope()` (`pipeline-generate.ts:221-228`) throws on null `geo_mode`. This meant audits created through the form (not from prospect conversion) would fail at Phase 2 (KeywordResearch). The convert-from-prospect path worked because `useConvertProspect.ts:74` explicitly sets `geo_mode`. Fix: replaced city/state inputs with `GeoModeSelector`, added `geo_mode` and `market_geos` to `CreateAuditParams` and the Supabase insert in `useAudits.ts`. Legacy `market_city`/`market_state` fields derived from `geoData` for backward compatibility. Geo validation runs before zod schema validation (mode-specific: city requires state+cities, metro requires state+metros, state requires states input, national needs nothing).

**2026-03-23: Total Addressable Revenue (TAR) model replaces near-miss as hero revenue**

Near-miss revenue ($X from positions 11-30 moving to page 1) is good for retention/optimization but fails for sales qualification — a prospect with 100k monthly search volume and zero visibility shows $0 revenue. TAR answers "what is this market worth at target visibility?" using `search_volume × CTR_at_position × CR × ACV` across ALL keywords. Near-miss stays as a secondary "90-day quick wins" signal. TAR position is configurable per-audit (default position 5 = realistic first-page visibility). Calculated at the cluster-rebuild level (`rebuildClustersAndRollups`), stored on both `audit_clusters` and `audit_rollups`.

**2026-03-23: total_volume stores SUM instead of MAX (bug fix)**

`total_volume` on `audit_clusters` was storing `Math.max(volMax, vol)` — the highest single keyword volume in the cluster. Every dashboard consumer (`ClustersPage`, `ResearchPage`, `useAssumptionsPreview`) treated it as the sum across all keywords. Fixed `buildClusterMap()` to accumulate `volSum += vol`. Existing clusters get corrected values after next rebuild/re-canonicalize. Added `keyword_count` as an exact count alongside volume.

**2026-03-23: Hidden clusters — soft delete with reason**

Reuses the existing `status` TEXT column (not an enum) with a new `'hidden'` value + `hidden_reason` TEXT field. Hidden clusters are excluded from default views and stat calculations but preserved for pipeline learning. Dashboard toggle reveals them with dimmed styling. `rebuildClustersAndRollups` preserves hidden status through DELETE+INSERT the same way it preserves active status. Known limitation: canonical_key drift during re-canonicalization can lose hidden (and active) status — accepted as pre-existing risk, operator should review after re-canonicalization.

**2026-03-16: Stripped dead WhatsApp/container code (~5,500 lines)**

The codebase was originally a WhatsApp bot with Docker-isolated Claude Agent SDK containers. WhatsApp was never used in production (WSL2 baileys conflicts), and the pipeline "agents" are single-shot prompt templates calling `callClaude()` — not Agent SDK multi-turn sessions. The actual product is a pipeline toolkit: Dashboard → Supabase Edge Functions → Railway HTTP server → shell orchestrator → TypeScript phase generators → Supabase sync. Deleted: `src/index.ts` (WhatsApp orchestrator), `src/channels/whatsapp.ts` (baileys client), `src/container-runner.ts`, `src/group-queue.ts`, `src/ipc.ts`, `src/task-scheduler.ts`, `src/router.ts`, `src/mount-security.ts`, `src/db.ts` (SQLite), `src/config.ts`, `src/env.ts`, `src/types.ts`, `src/pipeline-server.ts` (replaced by standalone), `src/logger.ts`, all 7 test files, `container/` directory, `groups/` directory, and 6 WhatsApp-focused docs. Removed 12 npm dependencies (baileys, better-sqlite3, pino, qrcode-terminal, cron-parser, zod, pg, qrcode, and their @types). `src/` now contains only `pipeline-server-standalone.ts`. Risk was very low: pipeline scripts have zero imports from any deleted file.

**2026-03-23: Geo-qualified search volume — state-level aggregation**

DataForSEO returns national US search volume (`location_code: 2840`) for all keywords. For regional operators (e.g., SMA in WA, OR, UT, CA, MT, AZ), national volume for "cpr training" (74k/mo) wildly overstates the addressable market. Fix: call `search_volume/live` once per service-area state and sum volumes across states. Rankings stay national (`ranked_keywords/live` keeps `location_code: 2840`) because Google ranks domains nationally — we only replace volumes afterward. City/metro modes use the parent state code because city-level DataForSEO location codes return suppressed or zero volume for most keywords (geographic scope too narrow for their data model). A Boise business is addressable by all Idaho searchers; geo-qualified keyword strings already narrow intent. National mode is unchanged. Cost impact: +$0.375/audit for 6-state operator (6 × $0.075/task vs $0.075 national). `track-rankings.ts` excluded — volume metadata in ranking snapshots is not used for revenue calculations. `sync-to-dashboard.ts` unchanged — reads `ranked_keywords.json` which already contains geo-qualified volumes, so all downstream recalculates automatically. Original national volumes preserved in `ranked_keywords.national.json` as audit trail. Unmatched keywords (DataForSEO suppresses low-volume terms) keep their national volume rather than being zeroed.

**2026-03-23: Dwight crawl — JS rendering disabled by default**

DataForSEO OnPage crawl default changed from `enable_javascript: true` to `false`. An SEO audit should crawl what search engines and LLMs actually see — the raw HTML response. If a site relies on client-side JS to render content, that's a technical SEO problem Dwight should flag (thin pages, low text-to-code ratio, missing content in raw HTML), not mask by rendering JS first. Crawling without JS is faster, cheaper, and more representative of indexability. The `enableJsRendering` option still exists for callers that explicitly want rendered-DOM analysis, but no current pipeline phase uses it.
