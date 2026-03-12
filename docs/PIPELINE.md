# Audit Pipeline — Complete Reference

> **This is a contract.** Every phase declares what it reads, what it writes, and what must exist before it runs. When a phase's responsibility changes, update this file in the same commit. See also: `docs/DECISIONS.md` for the "why" behind non-obvious choices.

Orchestrator: `./scripts/run-pipeline.sh <domain> <email> [seed_matrix.json] [competitor_urls] [--mode sales|full|prospect] [--prospect-config <path>]`

Trigger: Dashboard `useCreateAudit` → `run-audit` Edge Function (thin trigger) → HTTP POST to NanoClaw pipeline server → `run-pipeline.sh`

Core scripts:
- `scripts/pipeline-generate.ts` — agent generation logic
- `scripts/sync-to-dashboard.ts` — Supabase sync logic
- `scripts/foundational_scout.sh` — DataForSEO CLI wrapper

## Prerequisites (must exist before pipeline starts)

| Table | Created By | Required Fields |
|-------|-----------|----------------|
| `audits` | Dashboard `useCreateAudit` | domain, service_key, market_city, market_state, geo_mode, market_geos, user_id |
| `audit_assumptions` | Dashboard `useCreateAudit` (primary), `sync-to-dashboard.ts ensureAssumptions()` (fallback) | benchmark_id, ctr_model_id, cr_used_min/max/mid, acv_used_min/max/mid, target_ctr, near_miss_min/max_pos, min_volume |
| `benchmarks` | Seeded (one row per service vertical + 'other' fallback) | cr_min, cr_max, acv_min, acv_max |
| `ctr_models` | Seeded (one row with is_default=true) | buckets JSON |

The `run-audit` Edge Function writes **nothing** to keyword/cluster/rollup tables. It only marks the audit as `running` and fires the pipeline. All DataForSEO, keyword seeding, clustering, and revenue modeling happens inside the pipeline phases below.

---

## Data Flow Overview

```
Phase 0 (Scout) ← prospect mode only, exits after completion
  READS:     prospect-config.json (local file)
  PRODUCES:  scout-{domain}-{date}.md, scope.json
             Supabase → prospects (upsert)
      │
      ▼ (exits — full pipeline runs separately after conversion)

Phase 1 (Dwight)
  PRODUCES:  internal_all.csv, AUDIT_REPORT.md, 20+ CSVs
             Copies internal_all.csv + semantically_similar_report.csv → architecture/
      │
      ▼
Phase 2 (KeywordResearch)
  READS:     AUDIT_REPORT.md (Dwight), Supabase ← audits metadata
  PRODUCES:  keyword_research_summary.md, keyword_research_raw.json
             Supabase → audit_keywords (source='keyword_research', is_near_me)
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
Phase 3c (Canonicalize)
  READS:     Supabase ← audit_keywords
  PRODUCES:  Supabase → audit_keywords (canonical_key, canonical_topic, cluster,
             intent_type, is_brand, is_near_me)
  POST-STEP: Clears is_near_miss for branded/navigational keywords
      │
      ▼
Phase 3d (Rebuild Clusters)
  READS:     Supabase ← audit_keywords (with canonical_key from 3c)
  PRODUCES:  Supabase → audit_clusters (DELETE+INSERT), audit_rollups (DELETE+INSERT)
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
             semantically_similar_report.csv (Dwight), AUDIT_REPORT.md (Dwight, platform section),
             Supabase ← audit_clusters
  PRODUCES:  architecture_blueprint.md
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
  READS:     internal_all.csv, AUDIT_REPORT.md, semantically_similar_report.csv
  PRODUCES:  Supabase → agent_technical_pages, audit_snapshots
```

---

## Phase Details

### Phase 0: Scout — Prospect Discovery (prospect mode only)

**Function:** `runScout()` | **Models:** Claude Haiku (topic extraction) + Claude Sonnet (report generation)

**Invocation:** `npx tsx scripts/pipeline-generate.ts scout --domain <domain> --prospect-config <path>` or via `run-pipeline.sh --mode prospect --prospect-config <path>`

**Prerequisites:** `prospect-config.json` file with `name`, `domain`, `target_geos`, `topic_patterns`, `state`. No audit record required — uses `prospects` table instead.

**Steps:**
1. **Topic extraction** — Haiku extracts 5–15 canonical topics from ranked keywords + topic patterns. No crawl — Dwight handles comprehensive crawling in Phase 1 if the prospect converts.
2. **Current rankings** — DataForSEO `ranked_keywords/live` for the domain. Falls back to `buildSyntheticRankedKeywords()` if <50 results.
3. **Opportunity map** — DataForSEO bulk volume for `topic × geo` candidates.
4. **Gap matrix** — Cross-references rankings vs opportunity: defending (1–10), weak (11–30), gap (not ranking).
5. **Report + scope.json** — Sonnet generates scout report (7 sections); scope.json is Jim-compatible seed data.

**External APIs:**

| API | Endpoint | Purpose |
|-----|----------|---------|
| DataForSEO Ranked Keywords | `/v3/dataforseo_labs/google/ranked_keywords/live` | Current organic rankings |
| DataForSEO Bulk Volume | `/v3/keywords_data/google_ads/search_volume/live` | Opportunity map volume |
| Claude CLI (haiku) | `callClaude()` sync | Topic extraction |
| Claude CLI (sonnet) | `callClaudeAsync()` async | Scout report generation |

**Budget:** `SCOUT_SESSION_BUDGET` env var (default $2.00). Each API call checks remaining budget before proceeding.

**Output files** (relative to `audits/{domain}/`):
- `scout/{date}/scout-{domain}-{date}.md` — Full scout report (7 sections)
- `scout/{date}/scope.json` — Jim-compatible seed matrix

**Supabase writes:** `prospects` (INSERT or UPDATE status/scout_run_at/scout_output_path)

**Important:** Scout exits after completion. The full pipeline (Phases 1–6c) runs separately after the prospect converts to a client.

---

### Phase 1: Dwight — Technical Crawl + Audit Report

**Function:** `runDwight()` | **Model:** Claude Sonnet (async)

**External APIs:**

| Tool | Details |
|------|---------|
| Screaming Frog CLI | `--crawl`, `--headless`, 15 export tabs, 9 bulk exports, 2 reports. Optional `--config` for Gemini embeddings. 600s timeout. |
| Claude CLI (sonnet) | Generates AUDIT_REPORT.md from crawl CSVs. `internal_all.csv` filtered to 32 key columns before prompting. |

**Output files** (relative to `audits/{domain}/`):
- `auditor/{date}/internal_all.csv` + 20+ supplementary CSVs
- `auditor/{date}/AUDIT_REPORT.md` (11-12 sections + prioritized fix list)
- **Copies to `architecture/{date}/`:** `internal_all.csv`, `semantically_similar_report.csv`

**Key detail:** `internal_all.csv` is filtered from ~75 columns to 32 SEO-relevant columns (`INTERNAL_ALL_KEEP_COLUMNS`) before being included in the prompt. This reduces the file from ~1.3MB to ~20KB and prevents "Prompt too long" errors.

**Prompt framing:** Uses "YOUR ENTIRE RESPONSE IS THE REPORT" top/bottom framing to prevent narration. `validateArtifact()` enforces ≥5000 byte minimum and checks for conversational patterns.

**Supabase writes:** `agent_runs`, `audit_snapshots` (agent='dwight')

---

### Phase 2: KeywordResearch — Service × City × Intent Matrix

**Function:** `runKeywordResearch()` | **Model:** Claude Haiku (extraction, async) + Claude Sonnet (synthesis, async)

**Steps:**
1. **Extract** — Haiku reads Dwight's AUDIT_REPORT.md, extracts services, locations, and platform
2. **Matrix build** — Generates `service × city × intent` keyword candidates, capped at `MAX_KEYWORD_MATRIX_SIZE = 200`
3. **Volume validation** — DataForSEO bulk volume API filters zero-volume/zero-CPC keywords
4. **Synthesis** — Sonnet produces `keyword_research_summary.md` from validated matrix
5. **Seed Supabase** — Inserts validated keywords into `audit_keywords` with `source: 'keyword_research'` and `is_near_me` flags

**External APIs:**

| API | Endpoint | Purpose |
|-----|----------|---------|
| DataForSEO Bulk Volume | `/v3/keywords_data/google_ads/search_volume/live` | Volume/CPC for keyword matrix |
| Claude CLI (haiku) | `claude --print --model haiku` | Extract services + locations from AUDIT_REPORT.md |
| Claude CLI (sonnet) | `claude --print --model sonnet` | Synthesize keyword_research_summary.md |

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
| Claude CLI (sonnet) | `claude --print --model sonnet` | Generate research_summary.md narrative |

**Modes:**
- **Mode A (default):** Calls ranked-keywords + competitors for the domain. If <50 keywords returned, auto-supplements from `SERVICE_KEYWORD_SEEDS[service_key] × market_city locales` via bulk volume API.
- **Mode B (seed matrix):** Generates keyword candidates from `services[] × locales[]` cross-product, fetches bulk volume, builds synthetic ranked_keywords.json with rank_group=100.

**Output files** (relative to `audits/{domain}/`):
- `research/{date}/ranked_keywords.json`
- `research/{date}/competitors.json`
- `research/{date}/research_summary.md` (10 sections: executive summary, keyword overview, position distribution, branded analysis, intent breakdown, top URLs, competitor deep dive, striking distance, content gaps, key takeaways)

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
| `audits` | UPDATE | status='completed', completed_at |

Each `audit_keywords` row includes revenue estimates: `delta_revenue_low/mid/high` computed from `delta_traffic × CR × ACV` at three tiers. Near-miss filter: `is_brand=false AND intent≠navigational AND pos in [min,max] AND vol≥min_volume`.

**Important:** Clusters built here use raw `extractTopic()` (5-word truncation) because `canonical_key` doesn't exist yet. Phase 3d rebuilds clusters after canonicalize provides clean keys.

---

### Phase 3c: Canonicalize — Semantic Topic Grouping

**Function:** `runCanonicalize()` | **Model:** Claude Haiku (sync, small batches)

Batches all `audit_keywords` (up to 250 per call) through Haiku for semantic grouping. Returns `canonical_key` (slug), `canonical_topic` (display name), `is_brand`, `intent_type` per keyword.

**Near-me flagging:** After grouping, flags keywords containing "near me" with `is_near_me: true`. This supplements the flags already set by KeywordResearch on seeded keywords.

**Post-canonicalize cleanup:** Clears `is_near_miss` (and zeroes revenue fields) for any keywords where canonicalize set `is_brand=true` or `intent_type=navigational`, since these shouldn't appear in striking distance opportunities.

**Supabase writes:** `audit_keywords` UPDATE (canonical_key, canonical_topic, cluster, is_brand, intent_type, is_near_me)

**Why before Competitors:** Clean canonical keys eliminate duplicate SERP calls (e.g., "plumber boise" and "plumber boise id" map to the same canonical_key).

**Does NOT rebuild clusters.** Phase 3d handles that.

---

### Phase 3d: Rebuild Clusters — Post-Canonicalize Re-aggregation

**Function:** `rebuildClustersAndRollups()` in sync-to-dashboard.ts | **No external APIs**

**Invocation:** `npx tsx scripts/sync-to-dashboard.ts --domain <d> --user-email <e> --rebuild-clusters`

**Why this exists:** Phase 3b builds clusters before canonical_key is set, producing one cluster per keyword variation (e.g., "air conditioner repair boise idaho" and "air conditioner repair boise" as separate clusters). After canonicalize assigns canonical_key, this phase re-aggregates using the clean keys so all AC repair variants merge into one "AC Repair" cluster.

**Clustering key priority:** `canonical_key > cluster > topic > 'general'`

**Supabase writes:**
- `audit_clusters` — DELETE + INSERT (using canonical groupings)
- `audit_rollups` — DELETE + INSERT (recalculated totals)

**Filters:** Excludes `is_brand=true`, `intent_type=informational`, `intent_type=navigational` from clusters.

---

### Phase 4: Competitors — SERP Analysis

**Function:** `runCompetitors()` | **Model:** Claude Haiku (sync, small batches — domain classification)

**External APIs:**

| API | Endpoint | Purpose |
|-----|----------|---------|
| DataForSEO SERP Organic | `/v3/serp/google/organic/live/regular` | Top 10 organic results per keyword |
| Claude CLI (haiku) | Domain classification: industry_competitor, aggregator, brand_confusion, unrelated |

**Logic:** Selects top ~20 canonical topics by volume, fetches SERP for top 5 keywords per topic (up to 100 SERP calls). Aggregates which competitor domains appear most frequently per topic.

**Supabase writes:**
- `audit_topic_competitors` — per-topic competitor records with appearance_count and share
- `audit_topic_dominance` — per-topic leader/client comparison

---

### Phase 5: Gap — Content Gap Analysis

**Function:** `runGap()` | **Model:** Claude Sonnet (async)

Synthesizes all competitive intelligence + keyword data into a structured gap analysis.

**Supabase reads:** `audit_topic_competitors`, `audit_topic_dominance`, `audit_keywords`, `audit_clusters`, `agent_architecture_pages`

**Output JSON keys:** `authority_gaps` (with `data_source` provenance), `format_gaps`, `unaddressed_gaps`, `priority_recommendations`, `summary`

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
- Dwight: `internal_all.csv` (filtered, 100 rows), `semantically_similar_report.csv` (50 rows), Platform Observations from `AUDIT_REPORT.md`
- Supabase: `audit_clusters` (revenue estimates)

All cross-phase reads use `resolveArtifactPath()` with date fallback for operational resilience.

**Output:** `architecture/{date}/architecture_blueprint.md` — Executive Summary + Platform Constraints + 3-7 Silos (each with page table: URL slug, status, role, primary keyword, volume, action) + Cannibalization Warnings + Internal Linking Strategy

**Structural validation:** Blueprint must contain `## Executive Summary` and at least one `### Silo N:` heading. If missing, Michael auto-retries once.

**Key rules:**
- Platform Constraints section required when Dwight detects CMS-specific limitations
- Near-me keywords prohibited as `primary_keyword` for any page
- Every authority gap from Gap analysis must map to at least one architecture page

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

**Supabase writes:**

| Table | Purpose |
|-------|---------|
| `agent_architecture_pages` | Parsed page records (slug, silo, role, keyword, volume, action) |
| `agent_architecture_blueprint` | Full markdown + executive summary |
| `execution_pages` | UPSERT — seeds Content Factory with page briefs (priority: 1=create, 2=optimize) |
| `audit_keywords` | UPDATE cluster field from silo assignments |

---

### Phase 6c: sync dwight — Technical Audit to Supabase

**Function:** `syncDwight()` | Parses `internal_all.csv` + `AUDIT_REPORT.md`

**Supabase writes:**

| Table | Purpose |
|-------|---------|
| `agent_technical_pages` | Per-page technical data (status_code, word_count, title, h1, meta_desc, depth, indexability, inlinks, semantic flags) |
| `audit_snapshots` | Parsed AUDIT_REPORT.md sections (executive_summary, prioritized_fixes, agentic_readiness, structured_data_issues, heading_issues, security_issues) |

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
  READS:  execution_pages (metadata, outline, schema),
          content/{slug}/ (disk fallback), client_profiles,
          audit_topic_competitors, configs/oscar/
  WRITES: content/{date}/{slug}/page.html
          execution_pages → status='review', content_html
```

### Pam — Content Brief Generation

**Script:** `scripts/generate-brief.ts` | **Model:** Claude Sonnet (async)

**Trigger:** `pam_requests` table (status='pending'). Polled by running `npx tsx scripts/generate-brief.ts [--domain <d>]`.

**What it does:** For each `execution_pages` row created by sync-michael, generates a complete content brief: metadata (meta title, description, H1, intent), JSON-LD schema, and a detailed content outline with per-section word counts, keyword targets, and internal linking maps.

**Context gathered per page:**
1. `execution_pages` — page_brief, silo, url_slug (from sync-michael)
2. `audit_keywords` — keywords in the same cluster/silo
3. `architecture_blueprint.md` — silo excerpt from disk
4. `research_summary.md` — striking distance + key takeaways from Jim
5. `audit_snapshots` (agent='gap') — authority gaps and format gaps
6. `client_profiles` — brand voice, USPs, differentiators (optional)
7. DataForSEO SERP Advanced — PAA questions, People Also Search, top organic competitors (optional, per primary keyword)

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
1. `execution_pages` — metadata_markdown, content_outline_markdown, schema_json (Supabase first, disk fallback)
2. `client_profiles` — brand voice, business details
3. `audit_topic_competitors` + `audit_topic_dominance` — competitive context fallback if Pam's outline lacks it
4. `configs/oscar/system-prompt.md` + `configs/oscar/seo-playbook.md` — Oscar's persona and SEO rules

**Output:**
- `content/{date}/{slug}/page.html` — production-ready semantic HTML
- `content/_debug/{slug}-oscar-raw.html` — raw Claude output (debug)

**Supabase writes:** `execution_pages` UPDATE (content_html, status → 'review')

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

## External API Reference

| API | Endpoint | Called By | Auth |
|-----|----------|-----------|------|
| DataForSEO Ranked Keywords | `https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live` | Jim | Basic auth |
| DataForSEO Competitors | `https://api.dataforseo.com/v3/dataforseo_labs/google/competitors_domain/live` | Jim | Basic auth |
| DataForSEO Bulk Volume | `https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live` | Jim, KeywordResearch | Basic auth |
| DataForSEO SERP Organic | `https://api.dataforseo.com/v3/serp/google/organic/live/regular` | Competitors | Basic auth |
| DataForSEO SERP Advanced | `https://api.dataforseo.com/v3/serp/google/organic/live/advanced` | Pam | Basic auth |
| DataForSEO Credits | `https://api.dataforseo.com/v3/appendix/user_data` | foundational_scout.sh | Basic auth |
| Claude CLI | `claude --print --model {model} --tools ''` | All generation phases | OAuth token |
| Screaming Frog | `screamingfrogseospider --crawl --headless` | Dwight (Phase 1 only) | License key |

## Claude Model Usage

| Phase | Agent | Model | Method | Purpose |
|-------|-------|-------|--------|---------|
| 0 | Scout | **haiku** + **sonnet** | `callClaude()` + `callClaudeAsync()` | Topic extraction (haiku) + scout report (sonnet) |
| 1 | Dwight | **sonnet** | `callClaudeAsync()` | AUDIT_REPORT.md |
| 2 | KeywordResearch | **haiku** + **sonnet** | `callClaudeAsync()` | Service extraction (haiku) + synthesis (sonnet) |
| 3 | Jim | **sonnet** | `callClaudeAsync()` | research_summary.md |
| 3c | Canonicalize | **haiku** | `callClaude()` sync | Topic grouping JSON (small batches) |
| 4 | Competitors | **haiku** | `callClaude()` sync | Domain classification (small batches) |
| 5 | Gap | **sonnet** | `callClaudeAsync()` | Gap analysis JSON |
| 6 | Michael | **sonnet** | `callClaudeAsync()` | architecture_blueprint.md |
| 6.5 | Validator | **haiku** | `callClaudeAsync()` | Coverage validation JSON |
| — | Pam | **sonnet** | `callClaudeAsync()` | Content brief (metadata + schema + outline) |
| — | Oscar | **sonnet** | `callClaudeAsync()` | Production HTML from brief |

**Sync vs Async:** `callClaude()` uses `spawnSync` — suitable for small Haiku batches. `callClaudeAsync()` uses async `spawn` — required for large prompts (>50K chars) to avoid ETIMEDOUT errors.

## Supabase Tables

| Table | Read By | Written By |
|-------|---------|------------|
| `audits` | All agents, all syncs | Jim, sync-jim, sync-michael, sync-dwight |
| `audit_keywords` | Canonicalize, Competitors, Gap, sync-jim, sync-michael | KeywordResearch (INSERT, source='keyword_research'), sync-jim (DELETE+INSERT, source='ranked'), Canonicalize (UPDATE), sync-michael (UPDATE cluster) |
| `audit_clusters` | Gap, Michael | sync-jim (preliminary), rebuild-clusters Phase 3d (canonical, authoritative) |
| `audit_rollups` | — | sync-jim (preliminary), rebuild-clusters Phase 3d (canonical, authoritative) |
| `audit_assumptions` | sync-jim, rebuild-clusters | Dashboard `useCreateAudit` (primary), `ensureAssumptions()` in sync (fallback from benchmarks) |
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

## Disk Artifact Reference

All paths relative to `audits/{domain}/`. Cross-phase reads use `resolveArtifactPath()` for date fallback.

| Path | Producer | Consumers |
|------|----------|-----------|
| `auditor/{date}/internal_all.csv` | Dwight | Jim (service pages), sync-dwight |
| `auditor/{date}/AUDIT_REPORT.md` | Dwight | KeywordResearch, Michael (platform section), sync-dwight |
| `auditor/{date}/*.csv` (20+ files) | Dwight | Dwight (prompt context) |
| `architecture/{date}/internal_all.csv` | Dwight (copy) | Michael |
| `architecture/{date}/semantically_similar_report.csv` | Dwight (copy) | Michael |
| `research/{date}/keyword_research_raw.json` | KeywordResearch | — (debug) |
| `research/{date}/keyword_research_summary.md` | KeywordResearch | Jim |
| `research/{date}/ranked_keywords.json` | Jim | sync-jim, Michael |
| `research/{date}/competitors.json` | Jim | sync-jim |
| `research/{date}/research_summary.md` | Jim | sync-jim, Michael |
| `research/{date}/content_gap_analysis.md` | Gap | Michael, Validator |
| `research/{date}/coverage_validation.md` | Validator | — (review) |
| `architecture/{date}/architecture_blueprint.md` | Michael | sync-michael, Validator |
| `scout/{date}/scout-{domain}-{date}.md` | Scout | — (review) |
| `scout/{date}/scope.json` | Scout | — (Jim seed input) |
| `content/{date}/{slug}/metadata.md` | Pam | Oscar, sync-pam |
| `content/{date}/{slug}/schema.json` | Pam | Oscar, sync-pam |
| `content/{date}/{slug}/content_outline.md` | Pam | Oscar, sync-pam |
| `content/{date}/{slug}/page.html` | Oscar | — (review/publish) |
| `content/_debug/{slug}-oscar-raw.html` | Oscar | — (debug) |
| `configs/oscar/system-prompt.md` | Manual | Oscar |
| `configs/oscar/seo-playbook.md` | Manual | Oscar |
