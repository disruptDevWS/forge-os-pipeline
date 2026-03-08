# Audit Pipeline — Complete Reference

Orchestrator: `./scripts/run-pipeline.sh <domain> <email> [seed_matrix.json] [competitor_urls] [--mode sales|full]`

Core scripts:
- `scripts/pipeline-generate.ts` — agent generation logic
- `scripts/sync-to-dashboard.ts` — Supabase sync logic
- `scripts/foundational_scout.sh` — DataForSEO CLI wrapper

---

## Data Flow Overview

```
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
  PRODUCES:  Supabase → audit_keywords (source='ranked'), audit_clusters, audit_rollups
      │
      ▼
Phase 3c (Canonicalize)
  READS:     Supabase ← audit_keywords
  PRODUCES:  Supabase → audit_keywords (canonical_key, canonical_topic, cluster, is_near_me)
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

**Supabase writes:**

| Table | Operation | Notes |
|-------|-----------|-------|
| `audit_keywords` | DELETE (where source ≠ 'keyword_research') + INSERT | Preserves KeywordResearch-seeded rows. New rows tagged `source: 'ranked'` |
| `audit_clusters` | DELETE + INSERT | ~30-80 topic clusters |
| `audit_rollups` | DELETE + INSERT | 1 summary row |
| `audit_snapshots` | INSERT | 1 (parsed research sections) |
| `baseline_snapshots` | UPSERT | 1 (first sync only) |
| `audits` | UPDATE | status='completed', completed_at |

Each `audit_keywords` row includes revenue estimates: `delta_revenue_low/mid/high` computed from `delta_traffic × CR × ACV` at three tiers.

---

### Phase 3c: Canonicalize — Semantic Topic Grouping

**Function:** `runCanonicalize()` | **Model:** Claude Haiku (sync, small batches)

Batches all `audit_keywords` (up to 250 per call) through Haiku for semantic grouping. Returns `canonical_key` (slug), `canonical_topic` (display name), `is_brand`, `intent_type` per keyword.

**Near-me flagging:** After grouping, flags keywords containing "near me" with `is_near_me: true`. This supplements the flags already set by KeywordResearch on seeded keywords.

**Supabase writes:** `audit_keywords` UPDATE (canonical_key, canonical_topic, cluster, is_brand, intent_type, is_near_me)

**Why before Competitors:** Clean canonical keys eliminate duplicate SERP calls (e.g., "plumber boise" and "plumber boise id" map to the same canonical_key).

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
| DataForSEO Credits | `https://api.dataforseo.com/v3/appendix/user_data` | foundational_scout.sh | Basic auth |
| Claude CLI | `claude --print --model {model} --tools ''` | All generation phases | OAuth token |
| Screaming Frog | `screamingfrogseospider --crawl --headless` | Dwight | License key |

## Claude Model Usage

| Phase | Agent | Model | Method | Purpose |
|-------|-------|-------|--------|---------|
| 1 | Dwight | **sonnet** | `callClaudeAsync()` | AUDIT_REPORT.md |
| 2 | KeywordResearch | **haiku** + **sonnet** | `callClaudeAsync()` | Service extraction (haiku) + synthesis (sonnet) |
| 3 | Jim | **sonnet** | `callClaudeAsync()` | research_summary.md |
| 3c | Canonicalize | **haiku** | `callClaude()` sync | Topic grouping JSON (small batches) |
| 4 | Competitors | **haiku** | `callClaude()` sync | Domain classification (small batches) |
| 5 | Gap | **sonnet** | `callClaudeAsync()` | Gap analysis JSON |
| 6 | Michael | **sonnet** | `callClaudeAsync()` | architecture_blueprint.md |
| 6.5 | Validator | **haiku** | `callClaudeAsync()` | Coverage validation JSON |

**Sync vs Async:** `callClaude()` uses `spawnSync` — suitable for small Haiku batches. `callClaudeAsync()` uses async `spawn` — required for large prompts (>50K chars) to avoid ETIMEDOUT errors.

## Supabase Tables

| Table | Read By | Written By |
|-------|---------|------------|
| `audits` | All agents, all syncs | Jim, sync-jim, sync-michael, sync-dwight |
| `audit_keywords` | Canonicalize, Competitors, Gap, sync-jim, sync-michael | KeywordResearch (INSERT, source='keyword_research'), sync-jim (DELETE+INSERT, source='ranked'), Canonicalize (UPDATE), sync-michael (UPDATE cluster) |
| `audit_clusters` | Gap, Michael | sync-jim (DELETE+INSERT) |
| `audit_rollups` | — | sync-jim (DELETE+INSERT) |
| `audit_assumptions` | sync-jim | — |
| `ctr_models` | sync-jim | — |
| `audit_snapshots` | Jim, Gap, sync-jim, sync-dwight, sync-michael | Jim, Dwight, Gap, sync-jim, sync-dwight, sync-michael |
| `agent_runs` | — | All generation agents |
| `audit_topic_competitors` | Competitors, Gap | Competitors (DELETE+INSERT) |
| `audit_topic_dominance` | Gap | Competitors (DELETE+INSERT) |
| `directory_domains` | Competitors | — |
| `agent_technical_pages` | — | sync-dwight (DELETE+INSERT) |
| `agent_architecture_pages` | Gap | sync-michael (DELETE+INSERT) |
| `agent_architecture_blueprint` | — | sync-michael (DELETE+INSERT) |
| `execution_pages` | sync-michael | sync-michael (UPSERT) |
| `baseline_snapshots` | sync-jim | sync-jim (UPSERT, first run only) |
| `audit_coverage_validation` | — | Validator (DELETE+INSERT) |

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
