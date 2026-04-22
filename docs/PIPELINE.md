# Audit Pipeline — Complete Reference

> **This is a contract.** Every phase declares what it reads, what it writes, and what must exist before it runs. When a phase's responsibility changes, update this file in the same commit. See also: `docs/DECISIONS.md` for the "why" behind non-obvious choices.

Orchestrator: `./scripts/run-pipeline.sh <domain> <email> [seed_matrix.json] [competitor_urls] [--mode sales|full|prospect] [--prospect-config <path>] [--canonicalize-mode legacy|hybrid|shadow]`

Trigger paths:
- **New audit:** Dashboard `useCreateAudit` → `run-audit` Edge Function → HTTP POST to Forge OS pipeline server → `run-pipeline.sh`
- **Prospect conversion:** Dashboard `useConvertProspect` → creates audit + assumptions → `run-audit` Edge Function → same pipeline path
- **Scout:** Dashboard Scout UI → `scout-config` Edge Function → Forge OS pipeline server (`/scout-config` + `/trigger-pipeline` with `--mode prospect`)
- **Re-canonicalize:** Settings page → `pipeline-controls` Edge Function → `/recanonicalize` → `run-canonicalize.ts` (Phase 3c+3d only)
- **Refresh rankings:** Settings page → `pipeline-controls` Edge Function → `/track-rankings` → `track-rankings.ts`
- **Refresh GSC data:** Settings page → `pipeline-controls` Edge Function → `/track-gsc` → `track-gsc.ts`
- **Track AI visibility:** Settings page → `pipeline-controls` Edge Function → `/track-llm-mentions` → `track-llm-mentions.ts`
- **AI visibility analysis:** Settings page → `pipeline-controls` Edge Function → `/ai-visibility-analysis` → `ai-visibility-analysis.ts`
- **Keyword lookup:** Keyword Lookup page → `pipeline-controls` Edge Function → `/lookup-keywords` → `lookupKeywordVolumes()` → `keyword_lookups` table
- **Re-run pipeline:** Settings page → `run-audit` Edge Function → `/trigger-pipeline` → `run-pipeline.sh`
- **Cluster activation:** Clusters page → `cluster-action` Edge Function → `/activate-cluster` → `generate-cluster-strategy.ts`
- **Export audit:** Settings page → `export-audit` Edge Function → `/export-audit` → ZIP stream of all `audits/{domain}/` artifacts
- **Prospect brief:** Auto after Scout (prospect mode) or on-demand → `pipeline-controls` Edge Function → `/generate-prospect-brief` → `generate-prospect-brief.ts`
- **Client brief:** Auto after Phase 6d (full/sales pipeline) or on-demand → `pipeline-controls` Edge Function → `/generate-client-brief` → `generate-client-brief.ts`

Edge Functions (deployed from [Lovable repo](https://github.com/disruptDevWS/market-position-audit-lovable)):
- `run-audit` — validates audit, marks `running`, POSTs to `/trigger-pipeline`
- `scout-config` — writes prospect config to disk, triggers scout, reads reports via `/scout-report` (auth: `validateSuperAdmin` + `has_role`)
- `cluster-action` — proxies `/activate-cluster` and `/deactivate-cluster` (auth: `resolveAuthContext` + ownership check)
- `pipeline-controls` — proxies `/recanonicalize`, `/track-rankings`, `/track-gsc`, `/track-llm-mentions`, `/ai-visibility-analysis`, `/lookup-keywords`, `/generate-prospect-brief`, and `/generate-client-brief` (auth: `validateSuperAdmin` + `has_role`)
- `export-audit` — streams ZIP of all pipeline artifacts for a domain (auth: `validateSuperAdmin` + `has_role`)

Core scripts:
- `scripts/pipeline-generate.ts` — agent generation logic
- `scripts/sync-to-dashboard.ts` — Supabase sync logic
- `scripts/foundational_scout.sh` — DataForSEO CLI wrapper

## Phase 2 Embedding Infrastructure Status (2026-04-20)

Phase 2 added hybrid canonicalize mode (vector pre-clustering + Sonnet arbitration) as an alternative to legacy Sonnet-only grouping. Both production clients (SMA, IMA) are promoted to hybrid. The embedding service, hybrid module, size gate, snapshot protocol, and contamination fix are all in production.

**Key components:**
- Embedding service: `src/embeddings/` — OpenAI `text-embedding-3-small` (1536 dims) with Supabase caching via pgvector
- Hybrid module: `src/agents/canonicalize/hybrid/` — pre-cluster + arbitrate + persist
- Lock determinism fix: `src/agents/canonicalize/build-legacy-payload.ts` — prevents canonical field contamination
- Migrations 016-018: pgvector RPC enhancement, classification metadata, shadow columns

**Production clients:**

| Client | Mode | Promoted | Keywords | Canonical Keys |
|--------|------|----------|----------|----------------|
| summitmedicalacademy.com | hybrid | 2026-04-20 (Phase 2.3b) | 127 | 27 |
| idahomedicalacademy.com | hybrid | 2026-04-20 (Phase 2.4) | 1,100 | 76 |
| forgegrowth.ai | hybrid | 2026-04-22 | 25 | 7 |
| All others | legacy | — | — | — |

**Known limitation:** `audits.canonicalize_mode` DB column is not read by any trigger path. See Phase 3c Known Limitation and `docs/architectural-review-post-phase-2-2026-04-21.md`.

**Phase 2 documentation:**
- `docs/canonicalize-hybrid-rollout.md` — complete rollout checklist (Phases 2.1-2.4)
- `docs/phase-2.3b-sma-promotion-2026-04-20.md` — SMA promotion report
- `docs/phase-2.3c-lock-determinism-fix-2026-04-20.md` — contamination bug fix
- `docs/phase-2.4-ima-promotion-2026-04-20.md` — IMA promotion report
- `docs/architectural-review-post-phase-2-2026-04-21.md` — system-wide architectural audit

## Prerequisites (must exist before pipeline starts)

| Table | Created By | Required Fields |
|-------|-----------|----------------|
| `audits` | Dashboard `useCreateAudit` or `useConvertProspect` | domain, service_key, market_city, market_state, geo_mode, market_geos, user_id |
| `audit_assumptions` | Dashboard `useCreateAudit` or `useConvertProspect` (primary), `sync-to-dashboard.ts ensureAssumptions()` (fallback) | benchmark_id, ctr_model_id, cr_used_min/max/mid, acv_used_min/max/mid, target_ctr, near_miss_min/max_pos, min_volume |
| `benchmarks` | Seeded (one row per service vertical + 'other' fallback) | cr_min, cr_max, acv_min, acv_max |
| `ctr_models` | Seeded (one row with is_default=true) | buckets JSON |

The `run-audit` Edge Function writes **nothing** to keyword/cluster/rollup tables. It only marks the audit as `running` and fires the pipeline. All DataForSEO, keyword seeding, clustering, and revenue modeling happens inside the pipeline phases below.

---

## Data Flow Overview

```
Phase 0 (Scout) ← prospect mode only, exits after completion
  READS:     prospect-config.json (local file)
  PRODUCES:  scout-{domain}-{date}.md, scope.json, prospect-narrative.md
             Supabase → prospects (upsert)
      │
      ▼
Prospect Brief (auto after Scout, non-fatal)
  READS:     scope.json, prospect-narrative.md, ranked_keywords.json
  PRODUCES:  reports/prospect_brief.html (Sonnet narrative + data tables)
  SERVED:    /artifact endpoint (file=reports/prospect_brief.html)
      │
      ▼ (exits — full pipeline runs separately after conversion)

--- Prospect Conversion (Dashboard) ---
  useConvertProspect: prospect → audit INSERT (with geo_mode, market_geos)
                      + audit_assumptions INSERT + prospect status='converted'
                      → run-audit Edge Function → /trigger-pipeline
  scope.json persists on disk for Phase 2 (KeywordResearch reads it as optional priors)

Phase 1 (Dwight)
  PRODUCES:  internal_all.csv, AUDIT_REPORT.md, ~20 CSVs
             Copies internal_all.csv → architecture/
      │
      ▼
Phase 1a (Verify Dwight)
  READS:     AUDIT_REPORT.md, internal_all.csv (for 3xx redirect list)
  CHECKS:    Sitemap existence (HEAD), Schema presence (GET+parse), Redirect chain integrity (follow 3xx)
  PRODUCES:  verification_results.json (structured corrections map)
             Annotates AUDIT_REPORT.md with verification section
      │
      ▼
Phase 1c (GSC Data Fetch)
  READS:     Supabase ← analytics_connections (gsc_property_id)
  EXTERNAL:  Google Search Console Search Analytics API (ADC + SA impersonation)
  PRODUCES:  Supabase → gsc_page_snapshots (per-URL clicks, impressions, CTR, position)
             Disk → research/{date}/gsc_summary.json (top pages + aggregate stats)
      │
      ▼
Phase 1b (Strategy Brief)
  READS:     AUDIT_REPORT.md (Dwight), scope.json + scout-report.md (Scout, optional),
             prospect-config.json → client_context (optional),
             Supabase ← client_profiles (optional), audits metadata
  PRODUCES:  strategy_brief.md (disk — research/{date}/)
             Supabase → agent_runs (agent_name='strategy_brief')
      │
      ▼ (review gate: if audits.review_gate_enabled=true AND mode=full,
         pipeline pauses with status='awaiting_review'. Resume via
         pipeline-controls edge function → start_from='2')
      │
      ▼
Phase 2 (KeywordResearch)
  READS:     AUDIT_REPORT.md (Dwight), internal_all.csv (Dwight, for service expansion),
             strategy_brief.md (Phase 1b, optional — keyword directive injected into synthesis),
             Supabase ← audits metadata,
             scope.json (Scout, optional — pre-seeds matrix with gap keywords),
             prospect-config.json → client_context.services (full mode, optional)
  PRODUCES:  keyword_research_summary.md, keyword_research_raw.json
             Supabase → audit_keywords (source='keyword_research', is_near_me)
             Supabase → audits.service_key (updated if auto-detected from 'other')
      │
      ▼
Phase 3 (Jim)
  READS:     internal_all.csv (Dwight), keyword_research_summary.md (KeywordResearch)
  PRODUCES:  ranked_keywords.json, competitors.json, research_summary.md
      │
      ▼
Phase 3b (sync jim)
  READS:     ranked_keywords.json, research_summary.md
  REQUIRES:  audit_assumptions (auto-created from benchmarks if missing)
  PRODUCES:  Supabase → audit_keywords (source='ranked', revenue fields populated)
             Supabase → audit_clusters, audit_rollups (preliminary — rebuilt in 3d)
      │
      ▼
Phase 3c (Canonicalize) — supports legacy and hybrid modes
  READS:     Supabase ← audit_keywords, audits (canonicalize_mode)
  MODES:     legacy (Sonnet-only), hybrid (vector pre-clustering + Sonnet arbitration),
             shadow (both paths, legacy authoritative)
  PRODUCES:  Supabase → audit_keywords (canonical_key, canonical_topic, cluster,
             intent_type, is_brand, is_near_me, classification_method,
             similarity_score, canonicalize_mode)
  EXTERNAL:  OpenAI text-embedding-3-small (hybrid/shadow only)
  POST-STEP: Clears is_near_miss for branded/navigational keywords
      │
      ▼
Phase 3d (Rebuild Clusters)
  READS:     Supabase ← audit_keywords (with canonical_key from 3c),
             audit_clusters (activation status preservation),
             cluster_strategy (deprecation of orphaned strategies)
  PRODUCES:  Supabase → audit_clusters (DELETE+INSERT with status preservation),
             audit_rollups (DELETE+INSERT),
             cluster_strategy (deprecated orphaned rows),
             execution_pages (cluster_active preserved/deactivated)
  WHY:       3b builds clusters before canonical_key exists; 3d rebuilds using
             canonical groupings so "ac repair boise" + "ac repair boise id" merge
      │
      ▼
Phase 4 (Competitors)                    ← skipped in sales mode
  READS:     Supabase ← audit_keywords (canonical_key, intent_type, is_brand)
  PRODUCES:  Supabase → audit_topic_competitors, audit_topic_dominance
      │
      ▼
Phase 5 (Gap)                            ← skipped in sales mode
  READS:     Supabase ← audit_topic_competitors, audit_topic_dominance,
             audit_keywords, audit_clusters, agent_architecture_pages
  PRODUCES:  content_gap_analysis.md + Supabase → audit_snapshots
      │
      ▼
Phase 6 (Michael)
  READS:     research_summary.md (Jim), ranked_keywords.json (Jim),
             content_gap_analysis.md (Gap), internal_all.csv (Dwight),
             AUDIT_REPORT.md (Dwight, platform section),
             Supabase ← audit_clusters, audit_assumptions, audit_rollups,
             prospect-config.json → client_context (full mode, optional)
  PRODUCES:  architecture_blueprint.md (+ ## Revenue Opportunity in sales mode)
      │
      ▼
Phase 6.5 (Validator)                    ← skipped in sales mode
  READS:     content_gap_analysis.md (Gap), architecture_blueprint.md (Michael)
  PRODUCES:  coverage_validation.md + Supabase → audit_coverage_validation
      │
      ▼
Phase 6b (sync michael)
  READS:     architecture_blueprint.md
  PRODUCES:  Supabase → agent_architecture_pages, agent_architecture_blueprint,
             execution_pages, audit_keywords (cluster backfill)
      │
      ▼
Phase 6c (sync dwight)
  READS:     internal_all.csv, AUDIT_REPORT.md
  PRODUCES:  Supabase → agent_technical_pages, audit_snapshots
      │
      ▼
Phase 6d (Local Presence)
  READS:     Supabase ← audits (business_name, market_city, market_state),
             client_profiles (canonical NAP fallback)
  PRODUCES:  Supabase → gbp_snapshots, citation_snapshots (11 directories)
  EXTERNAL:  DataForSEO Business Data (GBP lookup), DataForSEO SERP (citation scan)
      │
      ▼
Client Brief (auto after Phase 6d, non-fatal)
  READS:     AUDIT_REPORT.md, research_summary.md, architecture_blueprint.md,
             strategy_brief.md (disk) + Supabase ← audit_rollups, audit_clusters,
             gbp_snapshots, citation_snapshots
  PRODUCES:  reports/client_brief.html (Sonnet narrative + data tables)
  SERVED:    /artifact endpoint (file=reports/client_brief.html)
```

---

## Phase Details

### Phase 0: Scout — Prospect Discovery (prospect mode only)

**Function:** `runScout()` | **Models:** Claude Haiku (topic extraction) + Claude Sonnet (report generation)

**Invocation:** `npx tsx scripts/pipeline-generate.ts scout --domain <domain> --prospect-config <path>` or via `run-pipeline.sh --mode prospect --prospect-config <path>`

**Prerequisites:** `prospect-config.json` file with `name`, `domain`, `target_geos`, `topic_patterns`, `state`. No audit record required — uses `prospects` table instead.

**Steps:**
1. **Topic extraction** — Haiku extracts 5–15 canonical topics from ranked keywords + topic patterns. No crawl — Dwight handles comprehensive crawling in Phase 1 if the prospect converts.
2. **Current rankings** — DataForSEO `ranked_keywords/live` for the domain. Falls back to `buildSyntheticRankedKeywords()` if <50 results. For multi-state prospects, ranked keyword volumes are geo-qualified via per-state `search_volume/live` calls (volumes summed across target states). Low-presence domains (<50 rankings) get expanded synthetic candidates with intent modifiers (`best`, `cost`, `services`, `near me`) and raised cap (500 vs 200).
3. **Opportunity map** — DataForSEO bulk volume for `topic × geo` candidates. Uses geo-qualified location codes when target_geos contains state data. Low-presence domains get expanded cross-product with intent modifiers and `topic_patterns × metros` injection.
4. **Deduplication** — Near-variant keywords collapsed via `buildCanonicalKey()` (suffix-only state stripping, alphabetical sort). Applied to ranked keywords and opportunity map before gap matrix assembly.
5. **Gap matrix** — Cross-references rankings vs opportunity: defending (1–10), weak (11–30), gap (not ranking). CPC backfill: $0 CPC entries filled from same-topic max, marked `cpc_inferred: true`. Inferred values shown with tilde prefix (`~$X`) in report tables.
6. **Report + scope.json** — Sonnet generates scout report (7 sections); scope.json is Jim-compatible seed data with `cpc_inferred` on opportunities and `max_topic_cpc` at root.
7. **Prospect narrative** — Sonnet generates 3-section outreach document. Prompt includes `topicMaxCpc` revenue context, CPC revenue translation instruction, and competitive framing instruction.

**External APIs:**

| API | Endpoint | Purpose |
|-----|----------|---------|
| DataForSEO Ranked Keywords | `/v3/dataforseo_labs/google/ranked_keywords/live` | Current organic rankings |
| DataForSEO Bulk Volume | `/v3/keywords_data/google_ads/search_volume/live` | Opportunity map volume |
| Anthropic API (haiku) | `callClaude()` | Topic extraction |
| Anthropic API (sonnet) | `callClaude()` | Scout report generation |

**Budget:** `SCOUT_SESSION_BUDGET` env var (default $2.00). Each API call checks remaining budget before proceeding.

**Output files** (relative to `audits/{domain}/`):
- `scout/{date}/scout-{domain}-{date}.md` — Full scout report (7 sections)
- `scout/{date}/scope.json` — Jim-compatible seed matrix
- `scout/{date}/prospect-narrative.md` — Plain-language outreach document (3 sections: Where You're Winning, Where Demand Is Escaping You, What a Full Analysis Would Reveal). Generated via Sonnet after the scout report. Non-fatal — Scout succeeds even if narrative generation fails.

**Supabase writes:** `prospects` (INSERT or UPDATE status/scout_run_at/scout_output_path)

**Important:** Scout exits after completion. The full pipeline (Phases 1–6c) runs separately after the prospect converts to a client.

### Prospect Intelligence Brief (auto after Scout)

**Script:** `scripts/generate-prospect-brief.ts` | **Model:** Claude Sonnet (narrative sections)

**Invocation:** Runs automatically after Scout completes in prospect mode (non-fatal). Also available on-demand via `/generate-prospect-brief` endpoint or `pipeline-controls` edge function action `generate_prospect_brief`.

**Reads:**
- `scout/{date}/scope.json` — gap summary, topics, locales, opportunity volume
- `scout/{date}/prospect-narrative.md` — existing narrative (optional, for tone reference)
- `research/{date}/ranked_keywords.json` — current rankings (optional)

**Produces:**
- `reports/prospect_brief.html` — Self-contained HTML intelligence brief matching Forge Growth design system

**Approach:** Structured sections (score cards, keyword tables, gap grids, topic coverage) are data-injected directly from scope.json. Three narrative sections (executive summary, opportunity analysis, next steps) generated via a single Sonnet call (~$0.06). Template uses the same CSS design system as the SMA/IMA static briefs (Oswald/Inter/JetBrains Mono, --bone/--charcoal/--orange vars).

**Serving:** Via existing `/artifact` endpoint: `POST /artifact { domain, file: "reports/prospect_brief.html" }`. Accessible through the dashboard's existing artifact serving mechanism.

### Client Intelligence Brief (auto after Phase 6d)

**Script:** `scripts/generate-client-brief.ts` | **Model:** Claude Sonnet (narrative sections)

**Invocation:** Runs automatically after Phase 6d completes in full/sales pipeline mode (non-fatal). Also available on-demand via `/generate-client-brief` endpoint or `pipeline-controls` edge function action `generate_client_brief`.

**Reads (disk):**
- `auditor/{date}/AUDIT_REPORT.md` — technical crawl findings
- `research/{date}/research_summary.md` — keyword research narrative
- `architecture/{date}/architecture_blueprint.md` — site architecture plan
- `research/{date}/strategy_brief.md` — strategic framing

**Reads (Supabase):**
- `audit_rollups` — revenue model (total volume, weighted revenue, keyword count)
- `audit_clusters` — top 15 clusters by weighted revenue (canonical_key, keyword_count, total_volume, weighted_revenue)
- `gbp_snapshots` — GBP listing data (claimed status, rating, reviews, canonical NAP)
- `citation_snapshots` — per-directory presence and NAP match status

**Produces:**
- `reports/client_brief.html` — Self-contained HTML intelligence brief (7 sections)

**Approach:** Seven HTML sections: Executive Summary (score cards + Sonnet prose), Technical Health (Sonnet prose), Revenue Opportunity (3-tier revenue cards + cluster table + Sonnet prose), Topic Cluster Breakdown (data-injected table), Architecture Recommendations (Sonnet prose), Local Presence (GBP cards + citation grid + Sonnet prose), Next Steps (Sonnet prose). Single Sonnet call (~$0.06-0.10) for 6 narrative sections using sentinel-delimited output. Same CSS design system as prospect brief.

**Serving:** Via existing `/artifact` endpoint: `POST /artifact { domain, file: "reports/client_brief.html" }`.

---

### Phase 1: Dwight — Technical Crawl + Audit Report

**Function:** `runDwight()` | **Model:** Anthropic API Sonnet

**External APIs:**

| Tool | Details |
|------|---------|
| DataForSEO OnPage API | `scripts/dataforseo-onpage.ts`: createOnPageTask → pollTaskReady → getPages/getSummary/getMicrodata/getResources. JS rendering enabled. |
| Anthropic API (sonnet) | Generates AUDIT_REPORT.md from crawl CSVs. `internal_all.csv` filtered to 32 key columns before prompting. |

**QA Gate:** After Dwight completes, `runQA(phase='dwight')` evaluates AUDIT_REPORT.md. On ENHANCE, re-runs Dwight. On persistent FAIL, pipeline halts.

**Output files** (relative to `audits/{domain}/`):
- `auditor/{date}/internal_all.csv` + supplementary CSVs (from `onpage-to-csv.ts`)
- `auditor/{date}/AUDIT_REPORT.md` (11 sections + prioritized fix list)
- **Copies to `architecture/{date}/`:** `internal_all.csv`

**Key detail:** `internal_all.csv` is filtered from ~75 columns to 32 SEO-relevant columns (`INTERNAL_ALL_KEEP_COLUMNS`) before being included in the prompt. This reduces the file from ~1.3MB to ~20KB and prevents "Prompt too long" errors.

**Prompt framing:** Uses "YOUR ENTIRE RESPONSE IS THE REPORT" top/bottom framing to prevent narration. `validateArtifact()` enforces ≥5000 byte minimum and checks for conversational patterns.

**Supabase writes:** `agent_runs`, `audit_snapshots` (agent='dwight')

---

### Phase 1a: Verify Dwight — HTTP Checks

**Script:** `scripts/verify-dwight.ts` | **Model:** None (pure HTTP)

**Purpose:** DataForSEO's OnPage API has documented gaps that cause Dwight to report false negatives on sitemap detection, schema/structured data detection, and redirect chain resolution. This phase independently verifies those findings with direct HTTP checks before downstream phases consume AUDIT_REPORT.md.

**Checks:**
- **Check A — Sitemap existence:** HEAD requests to `/sitemap.xml` and `/sitemap_index.xml` (both `www` and non-`www`). If sitemap found but Dwight flagged as missing → correction.
- **Check B — Schema presence:** GET homepage, parse for `<script type="application/ld+json">` and Yoast schema graph. Extracts `@type` values from JSON-LD blocks. If schema found but Dwight flagged as absent → correction.
- **Check C — Redirect chain integrity:** Reads `internal_all.csv` for 3xx entries with empty `Redirect URL` column. Follows each redirect chain (manual redirect mode, max 10 hops, max 50 URLs) and records terminal URL, status, and chain health.

**Outputs:**
- `verification_results.json` — structured corrections map (keyed by issue pattern match). Consumed by `syncDwight()` at Phase 6c for merging into `prioritized_fixes[]` objects.
- Appends a `## Post-Dwight Verification (Phase 1a)` section to `AUDIT_REPORT.md` (cosmetic annotation for disk artifact accuracy — not machine-parsed).

**Correction flow:** Corrections are NOT applied by modifying `parseAuditReport()`. Instead, `syncDwight()` loads `verification_results.json` after parsing and merges corrections into fix objects before writing to `audit_snapshots`. Each fix object gets `status` ('flagged' | 'false_positive'), `original_severity` (baseline for re-verification), `verified_at`, `verification_source`, and `verification_note`.

**Idempotency:** Skips if `AUDIT_REPORT.md` already contains the verification section header.

**Cost:** $0 (HTTP only, no LLM calls). Runtime: ~2-5 seconds.

---

### Phase 1c: GSC Data Fetch

**Script:** `scripts/fetch-gsc-data.ts` | **Model:** None (pure HTTP)

**Purpose:** Fetches Google Search Console Search Analytics data for the audit domain. Provides real click/impression/CTR/position data per URL to enrich Strategy Brief (Phase 1b), Jim (Phase 3), and Pam (OPTIMIZE briefs).

**Prerequisites:** `analytics_connections` row with `gsc_property_id` for the audit. If no connection exists, phase skips silently (non-fatal).

**Steps:**
1. Look up `analytics_connections` for the audit's `gsc_property_id`
2. Authenticate via ADC + impersonation of `fg-analytics@` service account (custom OAuth client → IAM generateAccessToken)
3. Fetch Search Analytics data (last 90 days, per-URL aggregation)
4. Write `gsc_page_snapshots` to Supabase (per-URL clicks, impressions, CTR, avg position)
5. Write `gsc_summary.json` to disk for downstream phases

**Downstream consumption:**
- **Phase 1b (Strategy Brief):** GSC summary injected as real performance data
- **Phase 3 (Jim):** GSC context block enriches research narrative
- **Pam (OPTIMIZE):** Per-URL GSC data injected into brief for pages being optimized

**Cost:** $0 (Google API, no per-call charges). Runtime: ~2-5 seconds.

**Graceful degradation:** No `analytics_connections` row or no `gsc_property_id` → skip. API error → log warning, continue pipeline.

---

### Phase 1b: Strategy Brief

**Script:** `scripts/strategy-brief.ts` | **Model:** Claude Sonnet

**Steps:**
1. **Gather** — Loads AUDIT_REPORT.md (cross-date fallback), scope.json + scout markdown (optional), client_context from prospect-config.json (optional), client_profiles from Supabase (optional), audit metadata (geo_mode, market_geos, service_key)
2. **Synthesize** — Single Sonnet call produces `strategy_brief.md` with four sections: Visibility Posture, Keyword Research Directive, Architecture Directive, Risk Flags
3. **Write** — Brief saved to `audits/{domain}/research/{date}/strategy_brief.md`

**Downstream consumption:**
- **Phase 2 (KeywordResearch):** Keyword Research Directive section injected into the Sonnet synthesis prompt (not the Haiku extraction prompt)
- **Phase 6 (Michael):** Architecture Directive + Risk Flags + Keyword Research Directive sections injected (Visibility Posture dropped — framing, not actionable for architecture)
- **Pam (content briefs):** Visibility Posture + Architecture Directive sections injected alongside market context

**Cost:** ~$0.06 (Sonnet, ~14K tokens)

**Graceful degradation:** Runs with whatever inputs exist. No AUDIT_REPORT.md + no scope.json = skip. Missing Scout = posture based on Dwight crawl only. Missing client_context = technical-only framing.

**Supabase writes:** `agent_runs` (agent_name='strategy_brief')

#### Review Gate (opt-in)

**Trigger condition:** `audits.review_gate_enabled = true` AND `mode = full`. Checked by `run-pipeline.sh` after Phase 1b via `update-pipeline-status.ts check-review-gate`.

**What happens when it fires:**
1. Pipeline sets `audits.status = 'awaiting_review'` and **exits** (`exit 0` in `run-pipeline.sh:240`). The shell process terminates — this is not a pause/sleep, it is a full stop. Phases 2–6d do not run.
2. The pipeline server's in-flight tracker clears the domain (the child process exited cleanly).
3. The audit sits in `awaiting_review` status indefinitely until manually resumed.

**How to resume:**
- **Dashboard UI:** The Settings page shows a "Review & Resume" panel when `status = 'awaiting_review'`. User can read `strategy_brief.md`, add annotations, and click Resume.
- **Edge function:** `pipeline-controls` with `action: 'resume_pipeline'`, `domain`, `email`, and optional `annotations`. The edge function appends annotations to `client_context.out_of_scope`, then POSTs to `/trigger-pipeline` with `start_from: '2'`.
- **Direct API:** POST `/trigger-pipeline` with `{"domain": "...", "email": "...", "start_from": "2"}`. Must use `start_from: '2'` (not `'1b'`) — resuming from `'1b'` causes an infinite loop because Phase 1b re-runs, hits the gate again, and exits.

**Operational implications for programmatic re-runs:**
- A full pipeline trigger (`/trigger-pipeline` without `start_from`) on a review-gate-enabled audit will **always pause** after Phase 1b. Phases 2–6d will not execute until a separate resume call is made.
- `/recanonicalize` is unaffected (runs only Phase 3c+3d, never touches Phase 1b).
- A re-run with `start_from: '2'` bypasses the gate entirely (Phase 1b is skipped).
- The gate only fires in `full` mode. Sales mode (`--mode sales`) skips the gate check.

**Currently enabled audits (2026-04-22):**

| Domain | Audit ID | Intentional? |
|--------|----------|-------------|
| forgegrowth.ai | `d1a9b155-...` | Yes — operator's own site, wants strategy review before full run |
| ecohvacboise.com | `b905e208-...` | Yes — demo client, manual review preferred |

**To disable:** `UPDATE audits SET review_gate_enabled = false WHERE id = '<audit_id>'` or toggle via Settings page.

---

### Phase 2: KeywordResearch — Service × City × Intent Matrix

**Function:** `runKeywordResearch()` | **Model:** Claude Haiku (extraction, async) + Claude Sonnet (synthesis, async)

**Steps:**
1. **Extract** — Haiku reads Dwight's AUDIT_REPORT.md, extracts services, locations, and platform. Prompt asks for sub-services from navigation, titles, URL paths (not just top-level categories). If Scout's `scope.json` exists, scout priors are injected into the extraction prompt for validation against crawl data.
2. **Service expansion** — If `service_key` is 'other' (auto-created sales audits), `detectServiceKey()` auto-detects the vertical (Tier 1: seed matching, Tier 2: Haiku fallback) and updates the audit row. Then `expandServicesFromCrawl()` cross-references `SERVICE_KEYWORD_SEEDS[serviceKey]` against report content and CSV URLs to add sub-services with evidence in the crawl data.
3. **Client context** — If `prospect-config.json` has `client_context.services`, those are merged into the services list (full mode only).
4. **Matrix build** — Generates `service × city × intent` keyword candidates, capped at `MAX_KEYWORD_MATRIX_SIZE = 200`. If `scope.json` has gap keywords, they are pre-seeded at priority 0 (survive truncation).
5. **Volume validation** — DataForSEO bulk volume API filters zero-volume/zero-CPC keywords
6. **Synthesis** — Sonnet produces `keyword_research_summary.md` from validated matrix
7. **Seed Supabase** — Inserts validated keywords into `audit_keywords` with `source: 'keyword_research'` and `is_near_me` flags

**External APIs:**

| API | Endpoint | Purpose |
|-----|----------|---------|
| DataForSEO Bulk Volume | `/v3/keywords_data/google_ads/search_volume/live` | Volume/CPC for keyword matrix |
| Anthropic API (haiku) | `callClaude()` | Extract services + locations from AUDIT_REPORT.md |
| Anthropic API (sonnet) | `callClaude()` | Synthesize keyword_research_summary.md |

**Output files:**
- `research/{date}/keyword_research_raw.json`
- `research/{date}/keyword_research_summary.md`

**Supabase writes:** `audit_keywords` (INSERT, source='keyword_research'), `agent_runs`

**Near-me detection:** Deterministic `keyword.toLowerCase().includes(' near me')` — not LLM-based.

---

### Phase 3: Jim — DataForSEO Research + Narrative

**Function:** `runJim()` | **Model:** Claude Sonnet (async)

**Upstream context from Dwight + KeywordResearch:**
- Reads `internal_all.csv` from Dwight's crawl — extracts service pages (URLs matching `/service|residential|commercial|what-we-do/`), location signals, and platform info
- Reads `keyword_research_summary.md` from KeywordResearch — injects as `## Keyword Opportunities` section
- Uses `resolveArtifactPath()` for cross-date resilience (if Dwight ran yesterday, Jim still finds the files)

**External APIs:**

| API | Endpoint | Purpose |
|-----|----------|---------|
| DataForSEO Ranked Keywords | `/v3/dataforseo_labs/google/ranked_keywords/live` | Current organic rankings for domain |
| DataForSEO Competitors | `/v3/dataforseo_labs/google/competitors_domain/live` | Competitor domain landscape |
| DataForSEO Bulk Volume | `/v3/keywords_data/google_ads/search_volume/live` | Volume for seed/supplementary keywords |
| DataForSEO LLM Mentions | `/v3/ai_optimization/llm_mentions/search/live` | Domain mentions in AI platforms (ChatGPT, Google AI) |
| DataForSEO LLM Mentions | `/v3/ai_optimization/llm_mentions/aggregated_metrics/live` | Competitor AI mention counts |
| Anthropic API (sonnet) | `callClaude()` | Generate research_summary.md narrative |

**LLM Mentions (conditional):** After ranked keywords and competitors are collected, `fetchAllLlmMentions()` queries DataForSEO for AI platform mentions. Top 5 keywords (by volume, rank ≤ 30, excluding brand/near-me) and top 3 non-aggregator competitors are selected. Results written to `research/{date}/llm_mentions.json`. An `## AI Visibility Data` block is injected into the narrative prompt with: per-keyword breakdown table (Google/ChatGPT mentions, AI search volume, top citation source per keyword), re-aggregated competitor totals (domain-level, not synthetic per-keyword), and data quality notes section (precision caveats, budget skip detection). Budget guard via `LLM_DOMAIN_BUDGET` / `LLM_COMPETITOR_BUDGET` env vars (legacy fallback: `LLM_MENTIONS_BUDGET`, default $1.00/$0.50) — non-fatal if exceeded. A conditional Section 11 (AI Visibility, 5 subsections: Mention Summary, Citation Source Analysis, Competitor Comparison, Structural Gap Analysis, Recommendations) is added to the research narrative output when data exists. Section 11.4 includes explicit cross-reference pointers directing Sonnet to compare citation sources against Site Inventory and ranked URLs for evidence-based structural gap reasoning.

**Aggregator filtering:** Before building the prompt, competitors are pre-filtered using `isAggregatorDomain()` (Yelp, HomeAdvisor, Angi, BBB, Thumbtack, social media, Wikipedia, Reddit, etc.). This prevents aggregator domains with massive ETV from dominating the competitor table and misleading analysis.

**Client context:** If `prospect-config.json` has `client_context`, a `## Client Business Context` block is injected into the prompt (full mode only). Includes business model, target audience, core services, and out-of-scope reasoning constraints.

**Modes:**
- **Mode A (default):** Calls ranked-keywords + competitors for the domain. If <50 keywords returned, auto-supplements from `SERVICE_KEYWORD_SEEDS[service_key] × market_city locales` via bulk volume API. For geo-qualified audits (`geo_mode != 'national'`), after all ranked keywords are collected, a separate geo-qualified `search_volume/live` call replaces national volumes with state-level sums. Original national data is backed up to `ranked_keywords.national.json`.
- **Mode B (seed matrix):** Generates keyword candidates from `services[] × locales[]` cross-product, fetches bulk volume (geo-qualified if applicable), builds synthetic ranked_keywords.json with rank_group=100.

**Geo-qualified volume:** When `geo_mode` is `state`, `city`, or `metro`, `bulkKeywordVolume()` calls `search_volume/live` per service-area state and sums volumes. Rankings remain national (`ranked_keywords/live` uses `location_code: 2840`). City/metro modes use the parent state code (city-level codes return suppressed data). Unmatched keywords keep their national volume. Cost: +$0.075/state/task.

**Output files** (relative to `audits/{domain}/`):
- `research/{date}/ranked_keywords.json` (geo-qualified volumes when applicable)
- `research/{date}/ranked_keywords.national.json` (backup, Mode A only, geo-qualified audits only)
- `research/{date}/competitors.json`
- `research/{date}/llm_mentions.json` (AI platform mention data: domain_mentions, competitor_mentions, queried_keywords, total_cost)
- `research/{date}/research_summary.md` (10-11 sections: executive summary, keyword overview, position distribution, branded analysis, intent breakdown, top URLs, competitor deep dive, striking distance, content gaps, key takeaways, + conditional Section 11: AI Visibility)

**Prompt framing:** Uses "YOUR ENTIRE RESPONSE IS THE REPORT" top/bottom framing. `validateArtifact()` enforces ≥3000 byte minimum.

**Supabase writes:** `agent_runs`, `audit_snapshots` (agent='jim'), `audits` (research_snapshot_at)

---

### Phase 3b: sync jim — Keywords to Supabase

**Function:** `syncJim()` in sync-to-dashboard.ts | **No external APIs**

**Reads:** `ranked_keywords.json`, `research_summary.md` (parsed for structured sections)

**Supabase reads:** `audit_assumptions` (CR/ACV rates), `ctr_models` (CTR by position)

**Precondition:** `audit_assumptions` must exist. `ensureAssumptions()` runs at the start of every sync and auto-creates from `benchmarks` defaults if missing.

**Supabase writes:**

| Table | Operation | Notes |
|-------|-----------|-------|
| `audit_keywords` | DELETE (where source ≠ 'keyword_research') + INSERT | Preserves KeywordResearch-seeded rows. New rows tagged `source: 'ranked'` |
| `audit_clusters` | DELETE + INSERT | Preliminary clusters from `extractTopic()` — rebuilt in Phase 3d |
| `audit_rollups` | DELETE + INSERT | Preliminary — rebuilt in Phase 3d |
| `audit_snapshots` | INSERT | 1 (parsed research sections) |
| `baseline_snapshots` | UPSERT | 1 (first sync only) |
| `llm_visibility_snapshots` | DELETE + INSERT | Client + competitor AI mention data (from `llm_mentions.json`, optional) |
| `llm_mention_details` | DELETE + INSERT | Qualitative mention texts and citation URLs (from `llm_mentions.json`, optional) |
| `audits` | UPDATE | status='completed', completed_at |

Each `audit_keywords` row includes revenue estimates: `delta_revenue_low/mid/high` computed from `delta_traffic × CR × ACV` at three tiers. Near-miss filter: `is_brand=false AND intent≠navigational AND pos in [min,max] AND vol≥min_volume`.

**Important:** Clusters built here use raw `extractTopic()` (5-word truncation) because `canonical_key` doesn't exist yet. Phase 3d rebuilds clusters after canonicalize provides clean keys.

---

### Phase 3c: Canonicalize — Semantic Topic Grouping

**Function:** `runCanonicalize()` in `pipeline-generate.ts` | **Hybrid module:** `src/agents/canonicalize/hybrid/`

**Modes:** Controlled by `--canonicalize-mode` CLI flag (default: `legacy`). The `audits.canonicalize_mode` DB column stores the intended mode per client but is **not yet wired** to trigger paths — see Known Limitation below.

- **Legacy** (`--canonicalize-mode legacy`): Sonnet-only batching (up to 250 keywords/call). Returns `canonical_key`, `canonical_topic`, `is_brand`, `intent_type`, `primary_entity_type` per keyword.
- **Hybrid** (`--canonicalize-mode hybrid`): Three-stage pipeline: Stage 1 (classification extraction via Haiku + deterministic rules) + Stage 2 (vector pre-clustering via OpenAI embeddings) + Stage 3 (Sonnet arbitration for edge cases). Authoritative output. Classification fields (`is_brand`, `intent_type`, `primary_entity_type`, `is_near_me`) handled by the classification extraction step; canonical grouping (`canonical_key`, `canonical_topic`, `cluster`) written exclusively by hybrid persist. **Legacy Sonnet grouping is completely skipped in hybrid mode** (early return after hybrid persist).
- **Shadow** (`--canonicalize-mode shadow`): Runs both paths. Legacy output written first (authoritative), hybrid output written to `shadow_*` columns for comparison. Used during Phase 2 validation; not used in production post-promotion.

**Production status (2026-04-21):** SMA and IMA are promoted to hybrid mode. All other audits remain on legacy. `canonicalize_mode` DB column is now wired to both `/trigger-pipeline` and `/recanonicalize` endpoints (commit `ce56f23`).

#### Hybrid canonicalize pipeline (`src/agents/canonicalize/hybrid/`)

**Stage 1 — Vector Pre-Clustering** (`hybrid/pre-cluster.ts`):
1. Collapse keyword variants by content hash (SHA-256 of normalized text)
2. Embed unique hashes via OpenAI `text-embedding-3-small` (1536 dimensions, cached in Supabase `embeddings` table)
3. Compute in-memory centroids for existing canonical topics
4. Classify each hash against centroids:

| Classification | Condition | Action |
|---------------|-----------|--------|
| `prior_assignment_locked` | Prior hybrid assignment exists + topic still active | Keep prior assignment (re-run stability) |
| `vector_auto_assign` | Single centroid match ≥ 0.82 AND cluster has ≥ 3 members | Auto-assign to cluster |
| `sonnet_arbitration_size_gated` | Single match ≥ 0.82 BUT cluster < 3 members | Route to Sonnet (62.7% redirect rate observed) |
| Ambiguous | Multiple matches ≥ 0.82 OR matches in 0.75–0.82 band | Route to Sonnet |
| `new_topic_candidate` | No matches ≥ 0.75 | Route to Sonnet for new topic creation |

**Constants:** `AUTO_ASSIGN_THRESHOLD = 0.82` (lowered from 0.85 on 2026-04-20, Phase 2.1). `AMBIGUITY_LOWER_BOUND = 0.75`. `MIN_CLUSTER_SIZE_FOR_AUTO_ASSIGN = 3` (Phase 2.2 size gate).

**Stage 2 — Sonnet Arbitration** (`hybrid/arbitrator.ts`):
- Batches of up to 40 unresolved cases per Sonnet call
- Prompt includes existing topic list + unresolved cases with vector match scores
- Decisions: `assign_existing`, `create_new`, `merge_candidate`
- New topics from earlier batches become context for later batches

**Persist** (`hybrid/persist.ts`):
- Hybrid mode: writes `canonical_key`, `canonical_topic`, `cluster`, `classification_method`, `similarity_score`, `canonicalize_mode` to primary columns
- Shadow mode: writes to `shadow_canonical_key`, `shadow_canonical_topic`, etc.
- Batches of 50

#### Classification extraction (Session B — hybrid mode only)

**Module:** `src/agents/canonicalize/classify-keywords.ts`

In hybrid mode, classification fields are extracted by a dedicated lightweight path **before** the hybrid pre-cluster/arbitrate pipeline runs. Legacy Sonnet is not invoked at all.

**Three-step extraction:**
1. **Deterministic `is_near_me`:** `keyword.toLowerCase().includes(' near me')`
2. **Deterministic `is_brand` (partial):** String match against domain name, `clientBusinessName`, and `competitorNames` from client context
3. **Haiku batch:** All keywords sent to Haiku in batches of 100 for `intent_type`, `primary_entity_type`, and unresolved `is_brand`

**`core_services` prompt enrichment (2026-04-22):** When `audits.client_context.core_services` is populated (comma-separated string), the Haiku prompt receives two additional lines: (1) guidance to prefer Service/Course over Article for keywords matching listed services, (2) the actual service list. No prompt change when `core_services` is absent. Fixes entity_type misclassification for vocational verticals (e.g., "NREMT Test Prep" → Course instead of Article).

**Writes per keyword:** `is_brand`, `intent_type`, `intent` (=intent_type for backward compat), `is_near_me`, `primary_entity_type`, `canonicalize_mode`

**Cost:** ~$0.02-0.03 per 1,000 keywords (vs ~$0.30-0.50 for legacy Sonnet grouping).

**Injection:** `_setClassifyCallClaude(callClaude)` — same dependency injection pattern as `hybrid/arbitrator.ts`.

#### Lock determinism fix (Phase 2.3c)

In hybrid mode (pre-Session B), legacy Sonnet ran for classification fields but **must not write** `canonical_key`, `canonical_topic`, or `cluster`. `buildLegacyUpdatePayload()` (`src/agents/canonicalize/build-legacy-payload.ts:33-37`) enforces this exclusion when `canonicalizeMode === 'hybrid'`. **Post-Session B, this guard is no longer exercised in hybrid mode** (legacy Sonnet is skipped entirely), but remains as defense-in-depth for shadow mode.

**Why:** If hybrid fails after legacy writes, the DB is left with legacy's stochastic output. Any retry's `priorHybridSnapshot` then captures this contaminated state. This caused 16.5% canonical_key drift on SMA's Phase 2.3b promotion. See `docs/phase-2.3c-lock-determinism-fix-2026-04-20.md`.

#### Classification fields

- **Hybrid mode:** All classification fields extracted by `classify-keywords.ts` (Haiku + deterministic rules). See "Classification extraction" section above.
- **Legacy mode:** All classification fields extracted by legacy Sonnet grouping prompt (group-level, per batch of up to 250 keywords).

| Field | Hybrid | Legacy |
|-------|--------|--------|
| `is_brand` | Deterministic (string match) + Haiku fallback | Sonnet |
| `intent_type` | Haiku | Sonnet |
| `primary_entity_type` | Haiku | Sonnet |
| `is_near_me` | Deterministic (`' near me'` check) | Deterministic |

**Near-me flagging:** Supplements flags already set by KeywordResearch on seeded keywords.

**Post-canonicalize cleanup:** Clears `is_near_miss` (and zeroes revenue fields) for any keywords where canonicalize set `is_brand=true` or `intent_type=navigational`.

**Entity type classification:** Each keyword group receives a `primary_entity_type` (Service, Course, Product, LocalBusiness, FAQPage, Article). Flows downstream to Phase 3d (`audit_clusters`), Cluster Strategy (Entity Map), and Pam (Page Identity).

#### External APIs

| API | Endpoint | Purpose | Used In |
|-----|----------|---------|---------|
| OpenAI Embeddings | `text-embedding-3-small` via `openai` SDK | Vector embeddings for pre-clustering | Hybrid/shadow only |
| Anthropic API (sonnet) | `callClaude()` | Keyword grouping (legacy) + arbitration (hybrid) | All modes |
| Anthropic API (haiku) | `callClaude()` | Classification extraction (intent_type, primary_entity_type, is_brand) | Hybrid only |

**Embedding cost:** $0.02/1M tokens. 1,100 keywords ≈ 11K tokens ≈ $0.0002. Negligible.

#### Supabase writes

`audit_keywords` UPDATE:
- All modes: `is_brand`, `intent_type`, `intent`, `is_near_me`, `primary_entity_type`, `canonicalize_mode`
- Legacy only: `canonical_key`, `canonical_topic`, `cluster` (via Sonnet grouping)
- Hybrid only (via classify-keywords.ts): classification fields written before hybrid pre-cluster runs
- Hybrid only (via persist): `canonical_key`, `canonical_topic`, `cluster`, `classification_method`, `similarity_score`
- Shadow only (via persist): `shadow_canonical_key`, `shadow_canonical_topic`, `shadow_classification_method`, `shadow_similarity_score`, `shadow_arbitration_reason`

**PostgREST pagination:** Supabase PostgREST enforces `max-rows=1000` server-side. All keyword fetches in Phase 3c (and 3d, sync-michael, hybrid/index.ts) use `.range(offset, offset + PAGE_SIZE - 1)` pagination in a while loop. This was a pre-existing bug that silently capped IMA (1,100 keywords) at 1,000 — fixed in commit `36eb9c0`.

**Why before Competitors:** Clean canonical keys eliminate duplicate SERP calls.

**Does NOT rebuild clusters.** Phase 3d handles that.

#### `canonicalize_mode` wiring (fixed)

The `audits.canonicalize_mode` DB column stores each client's intended mode. Both `/trigger-pipeline` and `/recanonicalize` endpoints resolve this column before spawning the pipeline (commit `ce56f23`). NULL defaults to `'legacy'`. The resolved mode is passed as `--canonicalize-mode` to the shell orchestrator.

---

### Phase 3d: Rebuild Clusters — Post-Canonicalize Re-aggregation

**Function:** `rebuildClustersAndRollups()` in sync-to-dashboard.ts | **No external APIs**

**Invocation:** `npx tsx scripts/sync-to-dashboard.ts --domain <d> --user-email <e> --rebuild-clusters`

**Why this exists:** Phase 3b builds clusters before canonical_key is set, producing one cluster per keyword variation (e.g., "air conditioner repair boise idaho" and "air conditioner repair boise" as separate clusters). After canonicalize assigns canonical_key, this phase re-aggregates using the clean keys so all AC repair variants merge into one "AC Repair" cluster.

**Clustering key priority:** `canonical_key > cluster > topic > 'general'`

**Supabase writes:**
- `audit_clusters` — DELETE + INSERT (using canonical groupings), with activation status preservation
- `audit_rollups` — DELETE + INSERT (recalculated totals)
- `cluster_strategy` — UPDATE `status='deprecated'`, `deprecated_at` for orphaned strategies (canonical_key no longer exists in rebuilt clusters)
- `execution_pages` — UPDATE `cluster_active` (preserved for surviving active clusters, set false for lost clusters)
- `agent_runs` — INSERT warning metadata for orphaned activations and deprecated strategies

**Cluster status preservation** (`sync-to-dashboard.ts:725-878`): Before DELETE, saves activation state (`status`, `activated_at`, `activated_by`, `target_publish_date`, `notes`, `hidden_reason`) for all non-inactive clusters. After INSERT, restores state for clusters that survived the rebuild. Logs orphaned active clusters (canonical_key removed by re-canonicalization) to `agent_runs` with `warning: 'orphaned_cluster_activations'`. See DECISIONS.md entry "cluster_strategy orphaning by canonicalization is deprecation, not remap" (2026-04-09).

**Strategy deprecation** (`sync-to-dashboard.ts:880-922`): Any `cluster_strategy` row whose `canonical_key` is no longer present in the rebuilt `audit_clusters` set is marked `status='deprecated'` with `deprecated_at` timestamp. Strategy documents are preserved — deprecation is a soft flag, not a delete.

**Entity type aggregation:** Each cluster's `primary_entity_type` is set from its constituent keywords, preferring non-Service types (e.g., if any keyword in the cluster is `Course`, the cluster gets `Course`).

**Filters:** Excludes `is_brand=true`, `intent_type=informational`, `intent_type=navigational` from clusters.

**Known concern:** The DELETE+INSERT pattern creates a brief window (~200-500ms) where `audit_clusters` has zero rows for the audit. A concurrent dashboard read during this window would see an empty Clusters page. No production incidents reported. See `docs/architectural-review-post-phase-2-2026-04-21.md` Area 2.3.

---

### Phase 4: Competitors — SERP Analysis

**Function:** `runCompetitors()` | **Model:** Claude Haiku (sync, small batches — domain classification)

**External APIs:**

| API | Endpoint | Purpose |
|-----|----------|---------|
| DataForSEO SERP Organic | `/v3/serp/google/organic/live/regular` | Top 10 organic results per keyword |
| Anthropic API (haiku) | Domain classification: industry_competitor, aggregator, brand_confusion, unrelated |

**Logic:** Selects top ~20 canonical topics by volume, fetches SERP for top 5 keywords per topic (up to 100 SERP calls). Aggregates which competitor domains appear most frequently per topic.

**Supabase writes:**
- `audit_topic_competitors` — per-topic competitor records with appearance_count and share
- `audit_topic_dominance` — per-topic leader/client comparison

---

### Phase 5: Gap — Content Gap Analysis

**Function:** `runGap()` | **Model:** Claude Sonnet (async)

Synthesizes all competitive intelligence + keyword data into a structured gap analysis.

**Supabase reads:** `audit_topic_competitors`, `audit_topic_dominance`, `audit_keywords`, `audit_clusters`, `agent_architecture_pages`

**Output JSON keys:** `authority_gaps` (with `data_source` provenance), `format_gaps`, `unaddressed_gaps`, `priority_recommendations`, `summary`, `ai_citation_gaps` (conditional, from `llm_mentions.json` — topic, client/competitor mention counts, gap_severity, recommended_action)

**Client context:** If `prospect-config.json` has `client_context`, out-of-scope items are injected as reasoning constraints ("do not surface gaps related to these topics or delivery models").

**Quality rules:**
- Near-me keywords excluded from `revenue_opportunity` estimates
- Authority gaps include `data_source` ("SERP dominance" | "keyword overlap") for provenance
- Topics must be complete service phrases, not truncated fragments

**Prompt framing:** JSON-only output with "YOUR ENTIRE RESPONSE IS RAW JSON" top/bottom framing.

**Output:** `research/{date}/content_gap_analysis.md` + `audit_snapshots`

---

### Phase 6: Michael — Architecture Blueprint

**Function:** `runMichael()` | **Model:** Claude Sonnet (async)

Reads ALL prior artifacts to produce a silo-based site architecture.

**Input summary:**
- Jim: `research_summary.md` + top 200 keywords from `ranked_keywords.json`
- Gap: `content_gap_analysis.md`
- Dwight: `internal_all.csv` (filtered, 100 rows), Platform Observations from `AUDIT_REPORT.md`
- Supabase: `audit_clusters` (revenue estimates), `audit_assumptions` + `audit_rollups` (sales mode revenue)
- Client context: `prospect-config.json` → `client_context` (full mode only)

All cross-phase reads use `resolveArtifactPath()` with date fallback for operational resilience.

**Revenue headline (sales mode):** `buildRevenueTable()` pre-computes a deterministic `## Revenue Opportunity` section from `audit_assumptions` (CR/ACV) and `audit_rollups` (total volume). Passed verbatim to Michael's prompt — no LLM interpretation of revenue numbers.

**Client context (full mode):** `## Client Business Context` block injected with business model, target audience, pricing, services, and out-of-scope reasoning constraints.

**Output:** `architecture/{date}/architecture_blueprint.md` — Executive Summary + Platform Constraints + 3-7 Silos (each with page table: URL slug, status, role, primary keyword, volume, action) + Cannibalization Warnings + Internal Linking Strategy. In sales mode, additionally includes `## Revenue Opportunity` section.

**Structural validation:** Blueprint must contain `## Executive Summary` and at least one `### Silo N:` heading. If missing, Michael auto-retries once.

**Key rules:**
- Platform Constraints section required when Dwight detects CMS-specific limitations
- Near-me keywords prohibited as `primary_keyword` for any page
- Every authority gap from Gap analysis must map to at least one architecture page
- **Buyer Journey Coverage (Rule 15):** Every silo must have Consideration + Decision stage coverage
- **Geo Pages as Silo Roles (Rule 16):** Geo pages are roles within a silo (e.g., `/services/plumbing/boise/`), not separate silos
- Buyer Journey Coverage Assessment table required: per-silo matrix of Awareness/Consideration/Decision/Retention coverage

**Prompt framing:** Uses "YOUR ENTIRE RESPONSE IS THE BLUEPRINT" top/bottom framing.

---

### Phase 6.5: Validator — Coverage Cross-Check

**Function:** `runValidator()` | **Model:** Claude Haiku (async)

Cross-checks Gap's identified gaps against Michael's blueprint to verify coverage.

**Input:** `content_gap_analysis.md` (Gap) + `architecture_blueprint.md` (Michael) — both resolved via `resolveArtifactPath()`

**Output JSON:** `{ coverage: [{ gap_topic, gap_type, blueprint_page, status, notes }], summary }`

**Statuses:** `addressed`, `partially_addressed`, `unaddressed`

**Output:** `research/{date}/coverage_validation.md` + Supabase → `audit_coverage_validation`

---

### Phase 6b: sync michael — Architecture to Supabase

**Function:** `syncMichael()` | Parses `architecture_blueprint.md` silo tables

**Re-run awareness:** Detects scenario via `detectRerunScenario()` using `agent_runs`. Accepts `--start-from` from shell orchestrator.

| Scenario | Behavior |
|----------|----------|
| `first_run` | Standard INSERT/upsert, writes `source: 'michael'` |
| `strategic_rerun` | Committed pages get metadata-only update (page_brief, silo, priority). Stale uncommitted pages set to `deprecated`. Parses `## Deprecation Candidates` JSON from blueprint for explicit deprecation. |
| `failure_resume` | Full replace (re-syncing same artifacts, no protection needed) |

**Supabase writes:**

| Table | Purpose |
|-------|---------|
| `agent_architecture_pages` | Parsed page records (slug, silo, role, keyword, volume, action) — always DELETE+INSERT |
| `agent_architecture_blueprint` | Full markdown + executive summary — always DELETE+INSERT |
| `execution_pages` | Conditional UPSERT — committed pages preserved on strategic re-run. Writes `source: 'michael'` on INSERT. |
| `audit_keywords` | UPDATE `cluster` field from silo assignments (3-tier matching: exact primary_keyword → substring match → URL slug match). Achieves ~50-60% backfill rate. Known limitation: editorial/informational slugs often don't match keyword text. |

**Silo backfill detail** (`sync-to-dashboard.ts:2371-2425`): Maps keywords to Michael's silos via:
1. Exact `primary_keyword` match
2. Bidirectional substring match on `primary_keyword`
3. `ranking_url` slug match against page slugs

**Session B fix (migration 019):** syncMichael now writes to the dedicated `silo` column instead of overwriting `cluster`. The `cluster` column is preserved as `canonical_topic`-exclusive. The `silo` column stores Michael's architecture taxonomy assignment for the keyword. Both columns coexist independently — `canonical_key`/`canonical_topic` for keyword grouping, `silo` for architecture taxonomy.

---

### Phase 6c: sync dwight — Technical Audit to Supabase

**Function:** `syncDwight()` | Parses `internal_all.csv` + `AUDIT_REPORT.md`

**Supabase writes:**

| Table | Purpose |
|-------|---------|
| `agent_technical_pages` | Per-page technical data (status_code, word_count, title, h1, meta_desc, depth, indexability, inlinks) |
| `audit_snapshots` | Parsed AUDIT_REPORT.md sections (executive_summary, prioritized_fixes, agentic_readiness, structured_data_issues, heading_issues, security_issues) |

---

### Phase 6d: Local Presence Diagnostic (GBP + Citations)

**Script:** `scripts/local-presence.ts` | **No LLM** — pure DataForSEO API calls

**Invocation:** `npx tsx scripts/local-presence.ts --domain <domain> --user-email <email> [--force]`

**Runs in:** Both sales and full mode (always with `--force` when inline pipeline).

**Steps:**
1. **Resolve business identity** — Fallback chain: `audit.business_name` → `client_profiles.canonical_name` → domain-derived name
2. **GBP lookup** — DataForSEO `/v3/business_data/google/my_business_info/live` → match confidence, category, rating, reviews, claimed status, canonical NAP
3. **Upsert `gbp_snapshots`** — Always, even if `listing_found: false` (unclaimed/missing GBP is a high-value sales signal)
4. **Synthesize Google citation** — Derive `citation_snapshots` row from GBP data (`data_source: 'gbp'`)
5. **SERP citation scan** — For each of 10 directories: DataForSEO SERP API with `site:` filter → presence detection + NAP extraction from snippets
6. **NAP comparison** — Fuzzy name match, digits-only phone match, contains-based address match
7. **Batch upsert `citation_snapshots`** — 11 rows (Google + 10 directories)

**External APIs:**

| API | Endpoint | Purpose | Cost |
|-----|----------|---------|------|
| DataForSEO Business Data | `/v3/business_data/google/my_business_info/live` | GBP listing lookup | ~$0.005 |
| DataForSEO SERP | `/v3/serp/google/organic/live` | Citation scan per directory (×10) | ~$0.002 each |

**Total cost:** ~$0.026/audit

**Citation directories** (11 total): Google (from GBP), Apple Maps, Bing Places, Facebook, Yelp, BBB, Angi, Thumbtack, Foursquare, Yellow Pages, Manta

**Supabase writes:**

| Table | Purpose |
|-------|---------|
| `gbp_snapshots` | GBP listing data, canonical NAP, claimed status, rating/reviews |
| `citation_snapshots` | Per-directory presence, listing URL, NAP match booleans |
| `agent_runs` | agent_name='local_presence' |

**Recency:** 6-day check (same as track-rankings). `--force` overrides.

---

## Post-Pipeline: On-Demand Content Agents

These agents run **outside** `run-pipeline.sh` — they are triggered per-page via Supabase request tables, not as pipeline phases. They operate on pages created by sync-michael in `execution_pages`.

```
sync-michael → execution_pages (page_brief, status='not_started')
       │
       ▼
Pam (generate-brief.ts) — polls pam_requests
  READS:  execution_pages, audit_keywords, audit_snapshots (gap),
          architecture_blueprint.md, research_summary.md,
          client_profiles, DataForSEO SERP Advanced
  WRITES: content/{date}/{slug}/metadata.md, schema.json, content_outline.md
          execution_pages → status='brief_ready'
       │
       ▼
Oscar (generate-content.ts) — polls oscar_requests
  READS:  execution_pages (metadata, outline, schema — DB only),
          client_profiles, audit_topic_competitors, configs/oscar/
  WRITES: content/{date}/{slug}/page.html
          execution_pages → status='review', content_html
```

### Pam — Content Brief Generation

**Script:** `scripts/generate-brief.ts` | **Model:** Claude Sonnet (async)

**Trigger:** `pam_requests` table (status='pending'). Polled by running `npx tsx scripts/generate-brief.ts [--domain <d>]`.

**What it does:** For each `execution_pages` row created by sync-michael, generates a complete content brief: metadata (meta title, description, H1, intent), JSON-LD schema, and a detailed content outline with per-section word counts, keyword targets, and internal linking maps.

**Context gathered per page:**
1. `execution_pages` — page_brief, silo, url_slug, buyer_stage, strategy_rationale (from sync-michael or cluster strategy)
2. `audit_keywords` — keywords sharing the page's `canonical_key` (Session B: join via `canonical_key`, with volume-based fallback if empty). Includes `primary_entity_type`.
3. `audit_clusters` → `cluster_strategy` (filtered `status='active'`) — entity_map (JSONB) for entity-aware content framing
4. `architecture_blueprint.md` — silo excerpt from disk
5. `research_summary.md` — striking distance + key takeaways from Jim
6. `audit_snapshots` (agent='gap') — authority gaps and format gaps
7. `client_profiles` — brand voice, USPs, differentiators (optional)
8. DataForSEO SERP Advanced — PAA questions, People Also Search, top organic competitors (optional, per primary keyword)

**Entity + buyer journey context:** If the page has a `primary_entity_type` (from audit_clusters), it's injected into the Page Identity block. If `entity_map` exists on the cluster's strategy, the full entity definition is injected. If `buyer_stage` is set (cluster strategy pages), a Buyer Journey Context block is added.

**Output (3 files per page):**
- `content/{date}/{slug}/metadata.md` — meta title, description, H1, intent, keyword-element mapping
- `content/{date}/{slug}/schema.json` — JSON-LD @graph (Organization, WebSite, WebPage, Service, FAQPage)
- `content/{date}/{slug}/content_outline.md` — section-by-section outline, word counts, keyword placement, internal linking map

**Supabase writes:** `execution_pages` UPDATE (metadata_markdown, schema_json, content_outline_markdown, meta_title, meta_description, h1_recommendation, intent_classification, target_word_count, status → 'brief_ready')

**Prompt structure:** Uses sentinel markers (`---METADATA_START---`/`---METADATA_END---`, `---SCHEMA_START---`/`---SCHEMA_END---`, `---OUTLINE_START---`/`---OUTLINE_END---`) to parse three output sections from a single Claude call.

---

### Oscar — Content Production (HTML Generation)

**Script:** `scripts/generate-content.ts` | **Model:** Claude Sonnet (async)

**Trigger:** `oscar_requests` table (status='pending') or direct CLI: `npx tsx scripts/generate-content.ts --domain <d> --slug <s>`.

**What it does:** Takes Pam's completed brief (metadata + outline + schema) and produces production-ready semantic HTML (`<article>` structure).

**Context gathered per page:**
1. `execution_pages` — metadata_markdown, content_outline_markdown, schema_json (Supabase only, warns on null fields)
2. `client_profiles` — brand voice, business details
3. `audit_topic_competitors` + `audit_topic_dominance` — competitive context fallback if Pam's outline lacks it
4. `configs/oscar/system-prompt.md` + `configs/oscar/seo-playbook.md` — Oscar's persona and SEO rules

**Output:**
- `content/{date}/{slug}/page.html` — production-ready semantic HTML
- `content/_debug/{slug}-oscar-raw.html` — raw Claude output (debug)

**Supabase writes:** `execution_pages` UPDATE (content_html, status → 'in_progress'). Dashboard maps `in_progress` → "Draft Ready".

**Token budget:** Uses `PHASE_MAX_TOKENS.content` = 65536 tokens. Must be called with `callClaudeAsync(prompt, { model: 'sonnet', phase: 'content' })` — passing `'sonnet'` as a string only sets the model and falls through to default 8192 tokens. Streaming is automatically enabled for requests >16K tokens (Anthropic API requirement for long-running operations).

**HTML extraction:** `extractHtmlContent()` strips Claude preamble/postamble — looks for first `<!--` through last `-->`, falls back to code fence stripping.

---

### sync-pam — Batch Re-sync (Disk → Supabase)

**Function:** `syncPam()` in `scripts/sync-to-dashboard.ts` | **No external APIs**

**Purpose:** Batch re-sync of Pam's disk output back to Supabase. This is a recovery/re-sync mechanism — `generate-brief.ts` already writes to `execution_pages` directly. Use this to re-populate Supabase from disk if data is lost or to sync briefs generated outside the normal flow.

**Invocation:** `npx tsx scripts/sync-to-dashboard.ts --domain <d> --user-email <e> --agents pam`

**Reads:** `content/{date}/{slug}/metadata.md`, `schema.json`, `content_outline.md` from disk

**Supabase writes:**
- `agent_implementation_pages` — legacy table (backward compat, DELETE+INSERT)
- `execution_pages` — UPSERT (matches by slug, preserves page_brief/status from Michael, promotes `not_started` → `brief_ready`)
- `agent_runs`, `audit_snapshots` (agent='pam')

---

### Page Status Lifecycle

```
not_started  → sync-michael creates execution_pages row with page_brief
brief_ready  → Pam generates metadata + schema + outline
review       → Oscar generates page.html
published    → (manual, via dashboard)
```

---

## Performance Tracking (Post-Pipeline, Scheduled)

Ranking performance tracking runs independently of the audit pipeline — weekly via cron, or on-demand via the `/track-rankings` endpoint.

### track-rankings.ts — Per-Domain Tracker

**Script:** `scripts/track-rankings.ts` | **No LLM calls**

**Invocation:** `npx tsx scripts/track-rankings.ts --domain <d> --user-email <e> [--force]`

**Steps:**
1. Resolve audit from Supabase (domain + email)
2. Recency check: skip if latest `ranking_snapshots` < 6 days old (bypass with `--force`)
3. Load `audit_keywords` from Supabase (keyword → metadata map: canonical_key, cluster, intent_type, volume)
4. Fetch DataForSEO `ranked_keywords/live` (max 1000 keywords, ~$0.05/call)
5. Build + upsert `ranking_snapshots` (500-record batches). Keywords not in DataForSEO results get `rank_position=null`
6. Aggregate `cluster_performance_snapshots` — groups by `canonical_key`, computes `avg_position` (mean of ranked keywords only; unranked `rank_position=null` excluded), position bucket counts (`keywords_p1_3/p4_10/p11_30/p31_100` — ranked only), `keyword_count` (all keywords including unranked), `authority_score` (position-weighted 0-100, see DECISIONS.md), `authority_score_delta` (vs previous snapshot)
7. Update `audit_clusters.authority_score` with the latest score from step 6
8. Track published pages in `page_performance` — matches ranking URLs against published `execution_pages`, computes `current_avg_position` (ranked keywords only, same exclusion as clusters)
9. Log to `agent_runs` (agent_name='performance_tracker')

**External APIs:**

| API | Endpoint | Purpose |
|-----|----------|---------|
| DataForSEO Ranked Keywords | `/v3/dataforseo_labs/google/ranked_keywords/live` | Current organic rankings |

### cron-track-all.ts — Batch Runner

**Script:** `scripts/cron-track-all.ts`

**Invocation:** `npx tsx scripts/cron-track-all.ts [--force]`

**Logic:** Queries all audits where `status='completed'`, resolves user emails, runs `track-rankings.ts` sequentially with 30-second delays between domains (DataForSEO rate limits). The 6-day recency check in `track-rankings.ts` prevents double-runs.

**Scheduling:** Railway cron job or external scheduler, weekly.

### Pipeline Server Endpoint

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/track-rankings` | On-demand ranking tracking for a single domain |

**Body:** `{ domain, email, force? }` — same auth as other endpoints.

### Supabase Tables

| Table | Purpose |
|-------|---------|
| `ranking_snapshots` | Per-keyword per-date position data (UNIQUE: audit_id, snapshot_date, keyword) |
| `cluster_performance_snapshots` | Pre-aggregated cluster metrics per snapshot date |
| `page_performance` | Post-publication page tracking (avg position, keyword gains) |
| `ranking_deltas` (VIEW) | SQL-computed baseline vs latest position deltas per keyword |

**Migration:** `scripts/performance-migration.sql` + `scripts/authority-score-migration.sql`

**Backfill:** `npx tsx scripts/backfill-authority-scores.ts [--domain <d>]` — computes authority scores for existing `cluster_performance_snapshots` and updates `audit_clusters`. Uses `audit_keywords` as denominator (not snapshot data) since older snapshots may be incomplete. Processes snapshot dates chronologically so deltas are correct.

**RLS:** All tables: SELECT for audit owners (`audits.user_id = auth.uid()`). INSERT/UPDATE/DELETE restricted to service_role.

---

## LLM Visibility Tracking (Post-Pipeline, Scheduled)

AI platform mention tracking runs independently of the audit pipeline — monthly via cron, or on-demand via the `/track-llm-mentions` endpoint.

### track-llm-mentions.ts — Per-Domain Tracker

**Script:** `scripts/track-llm-mentions.ts` | **No LLM calls**

**Invocation:** `npx tsx scripts/track-llm-mentions.ts --domain <d> --user-email <e> [--force]`

**Steps:**
1. Resolve audit from Supabase (domain + email)
2. Recency check: skip if latest `llm_visibility_snapshots` < 25 days old (bypass with `--force`)
3. Load top 5 keywords from `audit_keywords` (by volume, rank ≤ 30, excluding brand/near-me)
4. Fetch DataForSEO LLM Mentions `/search/live` for domain mentions across platforms (~$0.10-0.30)
5. DELETE + INSERT to `llm_visibility_snapshots` (one row per keyword × platform)
6. DELETE + INSERT to `llm_mention_details` (one row per mention text)

**External APIs:**

| API | Endpoint | Purpose |
|-----|----------|---------|
| DataForSEO LLM Mentions | `/v3/ai_optimization/llm_mentions/search/live` | AI platform mention data |

### cron-llm-mentions-all.ts — Batch Runner

**Script:** `scripts/cron-llm-mentions-all.ts`

**Invocation:** `npx tsx scripts/cron-llm-mentions-all.ts [--force]`

**Logic:** Queries all audits where `status='completed'`, resolves user emails, runs `track-llm-mentions.ts` sequentially with 30-second delays between domains. The 25-day recency check prevents double-runs.

**Scheduling:** Railway cron job or external scheduler, monthly.

### Pipeline Server Endpoint

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/track-llm-mentions` | On-demand LLM visibility tracking for a single domain |

**Body:** `{ domain, email, force? }` — same auth as other endpoints.

### Supabase Tables

| Table | Purpose |
|-------|---------|
| `llm_visibility_snapshots` | Per-keyword per-platform per-domain mention counts (UNIQUE: audit_id, snapshot_date, keyword, platform, domain) |
| `llm_mention_details` | Qualitative mention texts with citation URLs |

**Migration:** `scripts/migrations/004-llm-visibility.sql`

**RLS:** Both tables: SELECT for audit owners (`audits.user_id = auth.uid()`). INSERT/UPDATE/DELETE restricted to service_role.

### AI Visibility Analysis / Jim Section 11 Overlap

Jim (Phase 3) writes `llm_visibility_snapshots` during the pipeline run via `syncJim()`. The standalone AI Visibility Analysis (`/ai-visibility-analysis` → `ai-visibility-analysis.ts`) also writes to the same table.

**Dedup behavior:** When AI Visibility Analysis runs, it checks `llm_visibility_snapshots` for entries matching this audit + today's date. If Jim data already exists (same-day pipeline run), it reuses that data instead of making redundant DataForSEO calls. The Sonnet synthesis (structural gaps + recommendations) still runs since that's the standalone-specific output Jim does not produce. The `agent_runs` metadata includes `jim_data_reused: true` when dedup applies.

**Cost implication:** Running AI Visibility Analysis after a full pipeline costs only the Sonnet synthesis (~$0.03) instead of the full DataForSEO + synthesis cost (~$0.30-0.50).

---

## Re-Canonicalize (On-Demand)

Re-canonicalize runs Phase 3c + 3d without the full pipeline. Used from the Settings page when operators want to refresh keyword groupings or cluster structure.

### run-canonicalize.ts

**Script:** `scripts/run-canonicalize.ts` | **Model:** Claude Sonnet (legacy grouping + hybrid arbitration)

**Invocation:** `npx tsx scripts/run-canonicalize.ts --domain <d> --user-email <e> [--canonicalize-mode legacy|hybrid|shadow]`

**Steps:**
1. Resolve audit from Supabase (domain + email)
2. Parse `--canonicalize-mode` flag (default: `legacy`)
3. Run Phase 3c (`runCanonicalize()`) — semantic topic grouping in specified mode
4. Run Phase 3d (`rebuildClustersAndRollups()`) — delete + insert clusters with status preservation + strategy deprecation
5. Re-backfill `execution_pages.canonical_key` from updated `audit_keywords`
6. Log `agent_runs` entry

**Status preservation:** `rebuildClustersAndRollups()` saves cluster activation status (status, activated_at, activated_by, target_publish_date, notes) before DELETE and restores it after INSERT for clusters that survive the rebuild. Also preserves `execution_pages.cluster_active` for surviving active clusters and deactivates pages for lost clusters. See Phase 3d section for details.

**Known wiring gap:** The `/recanonicalize` endpoint (`pipeline-server-standalone.ts:390`) does not pass `--canonicalize-mode` to this script — it always runs in legacy mode regardless of the client's `audits.canonicalize_mode` column. See Phase 3c Known Limitation.

### Pipeline Server Endpoint

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/recanonicalize` | Start re-canonicalize (async, 202) |

**Body:** `{ domain, email }` — same auth as other endpoints. Does not accept `canonicalize_mode` parameter (wiring gap).

---

## Keyword Lookup (On-Demand)

Ad-hoc keyword volume lookup via DataForSEO Keyword Data API. Super-admin only. Results are persisted to the `keyword_lookups` table so paid-for research is retained across sessions.

### Pipeline Server Handler

**Handler:** `handleLookupKeywords()` in `src/pipeline-server-standalone.ts`

**Body:** `{ keywords[], location_codes?, audit_id?, user_id? }`

**Steps:**
1. Validate keywords (required, max 500)
2. Call `lookupKeywordVolumes()` from `src/dataforseo-keywords.ts`
3. If `audit_id` provided, best-effort insert results into `keyword_lookups` via `getSb()`:
   - Generate `crypto.randomUUID()` for `batch_id`
   - Upsert with `onConflict: 'audit_id,batch_id,keyword'` (prevents duplicates)
   - Log errors but don't fail the HTTP response
4. Return `{ results[], total, found, estimated_cost }` (cost formatted as `$X.XXX`)

### Pipeline Server Endpoint

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/lookup-keywords` | Synchronous keyword volume lookup + persist |

### Supabase Tables

| Table | Purpose |
|-------|---------|
| `keyword_lookups` | One row per keyword result, `batch_id` groups a single lookup session |

**Unique:** `(audit_id, batch_id, keyword)`
**Index:** `(audit_id, looked_up_at DESC)` for history listing
**RLS:** super_admin only (`has_role` check)
**Migration:** `scripts/migrations/008-keyword-lookups.sql`

### Dashboard

- **Hook:** `useKeywordLookup(auditId)` — mutation passes `audit_id` to edge function, invalidates history on success
- **Hook:** `useKeywordLookupHistory(auditId)` — reads `keyword_lookups` for last 90 days
- **Page:** `KeywordLookupPage.tsx` — "Previous Lookups" card with collapsible batches

---

## Cluster Activation (On-Demand)

Cluster activation is an on-demand step that generates a strategy document for a specific topic cluster, marks it active, and flags its execution_pages. It runs outside the main pipeline, triggered via HTTP endpoint or CLI.

### generate-cluster-strategy.ts — Cluster Strategy Generator

**Script:** `scripts/generate-cluster-strategy.ts` | **Model:** Claude Opus (single call)

**Invocation:** `npx tsx scripts/generate-cluster-strategy.ts --domain <d> --canonical-key <key> --user-email <e>`

**Prerequisites:** Phases 3c+3d must have run (canonical_key populated on audit_keywords and audit_clusters).

**Steps:**
1. Resolve audit from Supabase (domain + email)
2. Load cluster (with `primary_entity_type`), keywords, execution_pages, gap analysis, competitors, client context
3. Build prompt → `callClaude()` with Opus (strategic judgment tier). Prompt includes entity type context and Section 0 (Entity Map) requirement.
4. Parse via `extractJsonBySection()` (header-based, not positional): entity_map (Section 0), buyer_stages (Section 1), recommended_pages (Section 3), format_gaps (Section 4), AI optimization notes (Section 5)
5. Upsert `cluster_strategy` table (includes `entity_map` JSONB)
6. SET `audit_clusters.status = 'active'`, `activated_at = now()`
7. SET `execution_pages.cluster_active = true` WHERE `canonical_key = key`
8. **Insert recommended_pages into `execution_pages`** with `source: 'cluster_strategy'`, `buyer_stage`, `strategy_rationale` (slug dedup check prevents duplicates on re-activation)
9. Log `agent_runs` entry

**Strategy sections:** 0. Entity Map (JSON), 1. Buyer Journey Map (JSON), 2. Content Strategy (markdown), 3. Recommended New Pages (JSON), 4. Format Gaps (JSON), 5. AI Optimization Priorities

**Cost:** ~$0.15-0.50 per cluster (single Opus call).

### Pipeline Server Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/activate-cluster` | Spawn cluster strategy generation (202 async) |
| POST | `/deactivate-cluster` | Instant deactivation (200 sync, 2 DB updates) |

**Body (both):** `{ domain, canonical_key, email }` — same auth as other endpoints.

**Deactivation** is handled directly in the server process (no script spawn) for near-instant response. It sets `audit_clusters.status = 'inactive'` and `execution_pages.cluster_active = false`.

### Supabase Tables

| Table | Purpose |
|-------|---------|
| `cluster_strategy` | Per-cluster strategy document (UNIQUE: audit_id, canonical_key). Columns include `status` (TEXT: 'active', 'deprecated'), `deprecated_at` (TIMESTAMPTZ), `entity_map` (JSONB). Migration 014. |
| `audit_clusters.status` | `inactive` → `active` → `complete` lifecycle |
| `audit_clusters.canonical_key` | Join key to `execution_pages.canonical_key` |
| `execution_pages.cluster_active` | Boolean flag for content queue filtering |

**Migration:** `scripts/cluster-focus-migration.sql`

---

## Operational Resilience

**Date fallback:** Pipeline phases may span midnight. `resolveArtifactPath()` tries today's date first, then falls back to the most recent dated directory containing the requested file. This means a failed Phase 5 re-run at 12:01 AM still finds Phase 3's artifacts from 11:58 PM.

**Narration detection:** `validateArtifact()` strips leading backticks/whitespace, then checks against conversational patterns (`/^I'll /i`, `/^Let me /i`, `/^Here's /i`, etc.). Rejects outputs that narrate about the file instead of producing it.

**Prompt framing:** All agent calls use a consistent pattern:
- **Top of prompt:** "YOUR ENTIRE RESPONSE IS THE [REPORT/BLUEPRINT/RAW JSON]..."
- **Bottom of prompt:** "REMINDER: Your response IS the [content] — start with [expected heading]. No preamble, no narration."
- **JSON agents** add: "No markdown code fences. Just the bare JSON object starting with {"

**Retry:** Michael includes structural validation (Executive Summary + Silo headings present) with one automatic retry if the output is incomplete.

**Source preservation:** sync jim's DELETE preserves `source='keyword_research'` rows so KeywordResearch-seeded keywords survive re-syncs.

---

## Pipeline Server Infrastructure

The pipeline server (`src/pipeline-server-standalone.ts`) is an HTTP server that Supabase Edge Functions call to trigger pipeline runs, write scout configs, and read scout reports.

**Endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check (uptime, in-flight domains, env var presence) |
| POST | `/trigger-pipeline` | Start a full/sales/prospect pipeline run |
| POST | `/scout-config` | Write prospect-config.json to disk |
| POST | `/scout-report` | Read scout markdown + scope.json |
| POST | `/artifact` | Download pipeline output files |
| POST | `/track-rankings` | On-demand ranking tracking for a single domain |
| POST | `/recanonicalize` | Re-run Phase 3c+3d with status preservation (async, 202) |
| POST | `/activate-cluster` | Start cluster strategy generation (async, 202) |
| POST | `/deactivate-cluster` | Deactivate a cluster (sync, 200) |
| POST | `/lookup-keywords` | Ad-hoc DataForSEO keyword volume lookup, persists to `keyword_lookups` |
| POST | `/export-audit` | Stream ZIP of all artifacts for a domain |

**Auth:** All endpoints (except `/health`) require `Authorization: Bearer <PIPELINE_TRIGGER_SECRET>`.

**Startup:** `npm run dev` (local) or `npm start` (production on Railway).

### Supabase Secrets

| Secret | Value | Purpose |
|--------|-------|---------|
| `PIPELINE_BASE_URL` | `https://nanoclaw-production-e8b7.up.railway.app` | Pipeline server base URL (edge functions append endpoint paths) |
| `PIPELINE_TRIGGER_SECRET` | Bearer token | Shared secret between edge functions and pipeline server |
| `DEFAULT_PIPELINE_EMAIL` | `matt@forgegrowth.ai` | Fallback email for pipeline trigger when no user JWT |

Edge functions read `PIPELINE_BASE_URL` with fallback to `PIPELINE_TRIGGER_URL` (deprecated).

### Network Access (SEC-2 — Resolved)

> **Status (2026-03-30):** SEC-2 is resolved. The pipeline server runs on Railway (cloud-hosted), which provides HTTPS natively via `https://nanoclaw-production-e8b7.up.railway.app`. There is no local port exposure. Auth is handled by `PIPELINE_TRIGGER_SECRET` bearer token.

The pipeline server runs on Railway's managed infrastructure. Supabase Edge Functions reach it via Railway's public HTTPS URL. No local ports are exposed, no residential ISP connection is involved, and no tunneling is required.

**History:** The server originally ran on a local machine with port 3847 forwarded through an EERO router. A Cloudflare Tunnel (`pipeline.forgegrowth.ai`) was implemented as an intermediate fix (SEC-2 remediation). Now that the server runs on Railway, the tunnel is unnecessary and has been retired. Railway provides HTTPS + stable hostname natively.

---

## External API Reference

| API | Endpoint | Called By | Auth |
|-----|----------|-----------|------|
| DataForSEO Ranked Keywords | `https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live` | Jim | Basic auth |
| DataForSEO Competitors | `https://api.dataforseo.com/v3/dataforseo_labs/google/competitors_domain/live` | Jim | Basic auth |
| DataForSEO Bulk Volume | `https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live` | Jim, KeywordResearch | Basic auth |
| DataForSEO SERP Organic | `https://api.dataforseo.com/v3/serp/google/organic/live/regular` | Competitors | Basic auth |
| DataForSEO SERP Advanced | `https://api.dataforseo.com/v3/serp/google/organic/live/advanced` | Pam | Basic auth |
| DataForSEO Credits | `https://api.dataforseo.com/v3/appendix/user_data` | foundational_scout.sh | Basic auth |
| Anthropic API | `@anthropic-ai/sdk` via `scripts/anthropic-client.ts` | All generation phases | ANTHROPIC_API_KEY |
| OpenAI Embeddings | `openai` SDK via `src/embeddings/service.ts` | Phase 3c hybrid/shadow canonicalize | OPENAI_API_KEY |
| DataForSEO OnPage | `scripts/dataforseo-onpage.ts` | Dwight (Phase 1 only) | DATAFORSEO_LOGIN/PASSWORD |

## Claude Model Usage

| Phase | Agent | Model | Method | Purpose |
|-------|-------|-------|--------|---------|
| 0 | Scout | **haiku** + **sonnet** | `callClaude()` | Topic extraction (haiku) + scout report (sonnet) |
| 1 | Dwight | **sonnet** | `callClaude()` | AUDIT_REPORT.md [QA gated] |
| 2 | KeywordResearch | **haiku** + **sonnet** | `callClaude()` | Service extraction (haiku) + synthesis (sonnet) |
| 3 | Jim | **sonnet** | `callClaude()` | research_summary.md [QA gated] |
| 3c | Canonicalize (legacy) | **sonnet** | `callClaude()` | Topic grouping JSON (batches of 250) + classification fields |
| 3c | Canonicalize (hybrid) | **sonnet** + OpenAI embeddings | `callClaude()` + `openai` SDK | Legacy Sonnet for classification fields; hybrid: vector pre-clustering + Sonnet arbitration (batches of 40) |
| 4 | Competitors | **haiku** | `callClaude()` | Domain classification (small batches) |
| 5 | Gap | **sonnet** | `callClaude()` | Gap analysis JSON [QA gated] |
| 6 | Michael | **sonnet** | `callClaude()` | architecture_blueprint.md [QA gated] |
| 6.5 | Validator | **haiku** | `callClaude()` | Coverage validation JSON |
| QA | QA Agent | **haiku** | `callClaude()` | Phase evaluation against rubrics |
| — | Pam | **sonnet** | `callClaude()` | Content brief (metadata + schema + outline) |
| — | Oscar | **sonnet** | `callClaude()` | Production HTML from brief (65K tokens, streaming) |
| — | Cluster Strategy | **opus** | `callClaude()` | Strategic cluster analysis (on-demand, per-cluster) |

**SDK migration:** All phases use `@anthropic-ai/sdk` via `scripts/anthropic-client.ts`. Per-phase `max_tokens` configured in `PHASE_MAX_TOKENS` (e.g., sonnet phases: 16384, haiku phases: 4096, content: 65536). Requests with `max_tokens > 16384` automatically use streaming (`client.messages.stream().finalMessage()`). No more Claude CLI binary, env var stripping, or `stripClaudePreamble()`.

## Supabase Tables

| Table | Read By | Written By |
|-------|---------|------------|
| `audits` | All agents, all syncs | Jim, sync-jim, sync-michael, sync-dwight |
| `audits.client_context` (JSONB) | Settings page (dashboard reads/writes) | Settings page `useUpdateClientContext`. Pipeline reads from disk (`prospect-config.json`), not this column |
| `audits.canonicalize_mode` | pipeline-server (reads at trigger), run-canonicalize.ts | SET during hybrid promotion (Phase 2.3b/2.4). Values: 'legacy', 'hybrid'. Read by `/trigger-pipeline` and `/recanonicalize` (commit `ce56f23`). |
| `audit_keywords` | Canonicalize, Competitors, Gap, sync-jim, sync-michael | KeywordResearch (INSERT, source='keyword_research'), sync-jim (DELETE+INSERT, source='ranked'), Canonicalize legacy (UPDATE classification + canonical fields), Canonicalize hybrid classify-keywords.ts (UPDATE classification fields), Canonicalize hybrid persist (UPDATE canonical fields + metadata), sync-michael (UPDATE silo) |
| `audit_clusters` | Gap, Michael, Clusters page (status + authority_score), Performance page (authority_score) | sync-jim (preliminary), rebuild-clusters Phase 3d (canonical, authoritative, preserves status/activation), generate-cluster-strategy.ts (status UPDATE → 'active'), deactivate-cluster (status UPDATE → 'inactive'), track-rankings.ts (authority_score UPDATE) |
| `audit_rollups` | — | sync-jim (preliminary), rebuild-clusters Phase 3d (canonical, authoritative) |
| `audit_assumptions` | sync-jim, rebuild-clusters, Settings page | Dashboard `useCreateAudit` (primary), `ensureAssumptions()` in sync (fallback from benchmarks), Settings page `useUpdateAssumptions` |
| `ctr_models` | sync-jim, rebuild-clusters | — (seeded) |
| `benchmarks` | `ensureAssumptions()`, Dashboard `useCreateAudit` | — (seeded) |
| `audit_snapshots` | Jim, Gap, sync-jim, sync-dwight, sync-michael | Jim, Dwight, Gap, sync-jim, sync-dwight, sync-michael |
| `agent_runs` | — | All generation agents |
| `audit_topic_competitors` | Competitors, Gap | Competitors (DELETE+INSERT) |
| `audit_topic_dominance` | Gap | Competitors (DELETE+INSERT) |
| `directory_domains` | Competitors | — |
| `agent_technical_pages` | — | sync-dwight (DELETE+INSERT) |
| `agent_architecture_pages` | Gap | sync-michael (DELETE+INSERT) |
| `agent_architecture_blueprint` | — | sync-michael (DELETE+INSERT) |
| `execution_pages` | sync-michael, Pam, Oscar | sync-michael (UPSERT), Pam (UPDATE → brief_ready), Oscar (UPDATE → review), sync-pam (UPSERT) |
| `baseline_snapshots` | sync-jim | sync-jim (UPSERT, first run only) |
| `audit_coverage_validation` | — | Validator (DELETE+INSERT) |
| `prospects` | Scout | Scout (INSERT/UPDATE) |
| `pam_requests` | Pam | Dashboard (INSERT, status='pending') |
| `oscar_requests` | Oscar | Dashboard (INSERT, status='pending') |
| `client_profiles` | Pam, Oscar | Dashboard (manual) |
| `agent_implementation_pages` | — | sync-pam (DELETE+INSERT, legacy compat) |
| `cluster_strategy` | Cluster activation dashboard, Pam (entity_map) | generate-cluster-strategy.ts (UPSERT), rebuildClustersAndRollups (UPDATE status='deprecated', deprecated_at) |
| `embeddings` | Hybrid canonicalize (embedding cache) | `src/embeddings/service.ts` (UPSERT on content_type + content_id) |
| `ranking_snapshots` | Performance tab, ranking_deltas view | track-rankings.ts (UPSERT) |
| `cluster_performance_snapshots` | Performance page (authority trend chart), Clusters page (authority delta) | track-rankings.ts (UPSERT) |
| `page_performance` | Performance tab | track-rankings.ts (UPSERT) |

## Disk Artifact Reference

All paths relative to `audits/{domain}/`. Cross-phase reads use `resolveArtifactPath()` for date fallback.

| Path | Producer | Consumers |
|------|----------|-----------|
| `auditor/{date}/internal_all.csv` | Dwight | Jim (service pages), sync-dwight |
| `auditor/{date}/AUDIT_REPORT.md` | Dwight | KeywordResearch, Michael (platform section), sync-dwight |
| `auditor/{date}/*.csv` (~20 files) | Dwight | Dwight (prompt context) |
| `architecture/{date}/internal_all.csv` | Dwight (copy) | Michael |
| `research/{date}/keyword_research_raw.json` | KeywordResearch | — (debug) |
| `research/{date}/keyword_research_summary.md` | KeywordResearch | Jim |
| `research/{date}/ranked_keywords.json` | Jim | sync-jim, Michael |
| `research/{date}/competitors.json` | Jim | sync-jim |
| `research/{date}/research_summary.md` | Jim | sync-jim, Michael |
| `research/{date}/content_gap_analysis.md` | Gap | Michael, Validator |
| `research/{date}/coverage_validation.md` | Validator | — (review) |
| `architecture/{date}/architecture_blueprint.md` | Michael | sync-michael, Validator |
| `scout/{date}/scout-{domain}-{date}.md` | Scout | — (review) |
| `scout/{date}/scope.json` | Scout | KeywordResearch (optional priors) |
| `content/{date}/{slug}/metadata.md` | Pam | Oscar, sync-pam |
| `content/{date}/{slug}/schema.json` | Pam | Oscar, sync-pam |
| `content/{date}/{slug}/content_outline.md` | Pam | Oscar, sync-pam |
| `content/{date}/{slug}/page.html` | Oscar | — (review/publish) |
| `content/_debug/{slug}-oscar-raw.html` | Oscar | — (debug) |
| `configs/oscar/system-prompt.md` | Manual | Oscar |
| `configs/oscar/seo-playbook.md` | Manual | Oscar |

**Key source files (Phase 2 embedding infrastructure):**

| Path | Purpose |
|------|---------|
| `src/agents/canonicalize/hybrid/index.ts` | Hybrid canonicalize orchestrator (Stage 1 + Stage 2) |
| `src/agents/canonicalize/hybrid/pre-cluster.ts` | Stage 1: vector pre-clustering (thresholds, size gate, lock) |
| `src/agents/canonicalize/hybrid/arbitrator.ts` | Stage 2: Sonnet arbitration for ambiguous/new-topic/size-gated cases |
| `src/agents/canonicalize/hybrid/persist.ts` | Write hybrid results to audit_keywords (hybrid or shadow columns) |
| `src/agents/canonicalize/hybrid/types.ts` | TypeScript types: ClassificationMethod, VariantInput, PreClusterDecision, etc. |
| `src/agents/canonicalize/build-legacy-payload.ts` | Phase 2.3c fix: excludes canonical fields in hybrid mode |
| `src/embeddings/service.ts` | Embedding service: OpenAI embed + Supabase cache + pgvector similarity |
| `src/embeddings/config.ts` | Embedding constants: model, dimensions, thresholds |
| `src/embeddings/hash.ts` | Content hash (SHA-256) for embedding deduplication |

**Migrations (Phase 2):**

| Migration | Purpose |
|-----------|---------|
| `scripts/migrations/016-findsimilar-hash-exclusion.sql` | Add `exclude_content_hash` param to `find_similar_embeddings()` RPC |
| `scripts/migrations/017-canonicalize-classification-metadata.sql` | Add `classification_method`, `similarity_score`, `arbitration_reason`, `canonicalize_mode` to `audit_keywords` |
| `scripts/migrations/018-shadow-canonicalize-columns.sql` | Add `shadow_canonical_key`, `shadow_canonical_topic`, `shadow_classification_method`, `shadow_similarity_score`, `shadow_arbitration_reason` to `audit_keywords` |
