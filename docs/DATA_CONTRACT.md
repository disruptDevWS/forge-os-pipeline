# Data Contract: Forge OS Pipeline ↔ Forge OS Dashboard

> **Purpose**: Authoritative map of every Supabase table, who writes it (pipeline), who reads it (dashboard), and which columns matter. Use this before adding columns, changing sync logic, or building new UI components.
>
> **Last updated**: 2026-03-30

---

## Table of Contents

1. [Core Tables](#core-tables)
2. [Agent Output Tables](#agent-output-tables)
3. [Performance Tables](#performance-tables)
4. [LLM Visibility Tables](#llm-visibility-tables)
5. [Ad-Hoc Research Tables](#ad-hoc-research-tables)
6. [Content Factory Tables](#content-factory-tables)
7. [Local Presence Tables](#local-presence-tables)
8. [Reference Tables](#reference-tables)
9. [Views](#views)
10. [Edge Functions](#edge-functions)
11. [RPC Functions](#rpc-functions)
12. [Disk Artifacts](#disk-artifacts)

---

## Core Tables

### `audits`

| Column | Writer | Reader | Notes |
|--------|--------|--------|-------|
| `id` | Dashboard (INSERT) | Both | PK, UUID |
| `user_id` | Dashboard | Dashboard | Auth context |
| `domain` | Dashboard | Both | |
| `business_name` | Dashboard | Dashboard | |
| `mode` | Dashboard | Pipeline | `full` / `sales` / `prospect` |
| `service_key` | Dashboard / Pipeline | Both | Pipeline auto-detects if 'other' |
| `market_city`, `market_state` | Dashboard | Pipeline | Geo targeting |
| `country_code`, `language_code` | Dashboard | Pipeline | |
| `geo_mode` | Dashboard | Pipeline | `local` / `regional` / `national` |
| `market_geos` | Dashboard | Pipeline | JSON array of {city, state} |
| `status` | Both | Dashboard | TEXT: `draft`, `running`, `completed`, `failed`, `awaiting_review` |
| `error_message` | Pipeline | Dashboard | |
| `client_context` | Dashboard | Pipeline | JSONB: `{core_services, differentiators, service_area, notes}` |
| `review_gate_enabled` | Dashboard | Pipeline | Boolean, default false |
| `performance_tracking_enabled` | Dashboard | Pipeline (cron) | Boolean, default false. Opt-in for monthly cron ranking tracking. |
| `research_snapshot_at` | Pipeline (syncJim) | Dashboard | Staleness timestamp |
| `audit_snapshot_at` | Pipeline (syncDwight) | Dashboard | Staleness timestamp |
| `strategy_snapshot_at` | Pipeline (syncMichael) | Dashboard | Staleness timestamp |
| `created_at`, `completed_at` | Auto / Pipeline | Dashboard | |

**Pipeline writes**: `status`, `error_message`, `service_key` (auto-detect), `*_snapshot_at` timestamps
**Dashboard writes**: All creation fields, `client_context`, `review_gate_enabled`, `performance_tracking_enabled`, `status` (draft→running)
**Dashboard reads**: Full row + relations (`audit_rollups`, `audit_assumptions`, `audit_clusters`, `audit_keywords`)

---

### `audit_keywords`

| Column | Writer | Reader | Notes |
|--------|--------|--------|-------|
| `id` | Auto | Dashboard | PK |
| `audit_id` | Pipeline | Both | FK |
| `keyword` | Pipeline | Dashboard | |
| `rank_pos` | Pipeline | Dashboard | 100 = synthetic (no ranking) |
| `search_volume` | Pipeline | Dashboard | Geo-qualified (sum across service-area states) when `geo_mode != 'national'`; national volume when `geo_mode = 'national'` or geo lookup suppressed |
| `cpc` | Pipeline | Dashboard | |
| `ranking_url` | Pipeline | Dashboard | |
| `intent` | Pipeline | Dashboard | |
| `topic` | Pipeline | Dashboard | |
| `cluster` | Pipeline | Dashboard | = topic initially |
| `canonical_key` | Pipeline (Phase 3c) | Dashboard | Geo-agnostic slug |
| `canonical_topic` | Pipeline (Phase 3c) | Dashboard | Display name |
| `is_near_miss` | Pipeline | Dashboard | |
| `is_top_10` | Pipeline | Dashboard | |
| `is_striking_distance` | Pipeline | Dashboard | |
| `is_brand` | Pipeline (Phase 3c) | Dashboard | |
| `is_near_me` | Pipeline (Phase 2) | Dashboard | |
| `intent_type` | Pipeline (Phase 3c) | Dashboard | |
| `primary_entity_type` | Pipeline (Phase 3c) | Dashboard | `Service`, `Course`, `Product`, `LocalBusiness`, `FAQPage`, `Article` — default `Service` |
| `source` | Pipeline | Dashboard | `ranked` or `keyword_research` |
| `current_ctr` | Pipeline | Dashboard | |
| `current_traffic` | Pipeline | Dashboard | |
| `target_ctr` | Pipeline | Dashboard | |
| `target_traffic` | Pipeline | Dashboard | |
| `delta_traffic` | Pipeline | Dashboard | |
| `delta_leads_low/high` | Pipeline | Dashboard | |
| `delta_revenue_low/mid/high` | Pipeline | Dashboard | |

**Pipeline writes**: Phase 2 (source=keyword_research), Phase 3/3b (source=ranked), Phase 3c (canonical_key, canonical_topic, is_brand, intent_type)
**Dashboard reads**: `useAllKeywords()`, `useAssumptionsPreview()`, `useAudit()` relation
**Dashboard writes**: `useDeleteKeywords()` (DELETE by id)

---

### `audit_clusters`

| Column | Writer | Reader | Notes |
|--------|--------|--------|-------|
| `id` | Auto | Dashboard | PK |
| `audit_id` | Pipeline | Both | FK |
| `canonical_key` | Pipeline | Dashboard | Contractual join to `execution_pages` |
| `canonical_topic` | Pipeline | Dashboard | Display name |
| `topic` | Pipeline | Dashboard | Legacy (= canonical_topic) |
| `near_miss_positions` | Pipeline | Dashboard | |
| `total_volume` | Pipeline | Dashboard | SUM of keyword search_volume in cluster (fixed from MAX in 2026-03-23) |
| `keyword_count` | Pipeline | Dashboard | Number of keywords in cluster |
| `est_new_leads_low/high` | Pipeline | Dashboard | Near-miss leads |
| `est_revenue_low/mid/high` | Pipeline | Dashboard | Near-miss revenue (secondary) |
| `tar_revenue_low/mid/high` | Pipeline | Dashboard | Total Addressable Revenue at target visibility (primary) |
| `sample_keywords` | Pipeline | Dashboard | JSON array |
| `status` | Edge fn / Dashboard | Dashboard | TEXT: `inactive` / `active` / `complete` / `hidden` |
| `hidden_reason` | Dashboard | Dashboard | Free-text explanation when status = `hidden` |
| `activated_at` | Edge fn | Dashboard | |
| `activated_by` | Edge fn | Dashboard | |
| `target_publish_date` | Edge fn | Dashboard | |
| `notes` | Edge fn | Dashboard | |
| `primary_entity_type` | Pipeline (Phase 3c/3d) | Dashboard | `Service`, `Course`, `Product`, `LocalBusiness`, `FAQPage`, `Article` — default `Service` |
| `authority_score` | Pipeline (track-rankings) | Dashboard | 0-100, position-weighted |
| `authority_score_updated_at` | Pipeline | Dashboard | |

**Pipeline writes**: Phase 3b (initial), Phase 3d (rebuild with canonical keys, preserves status/activation/hidden/entity_type)
**Dashboard reads**: `useAuditClusters()`, `useAudit()` relation, ClustersPage, StrategyPage, OverviewPage
**Dashboard writes**: Via `cluster-action` edge function (status, activation fields), direct update (hidden status/reason)

---

### `audit_rollups`

| Column | Writer | Reader | Notes |
|--------|--------|--------|-------|
| `audit_id` | Pipeline | Dashboard | FK |
| `total_volume_analyzed` | Pipeline | Dashboard | |
| `near_miss_keyword_count` | Pipeline | Dashboard | |
| `opportunity_topics_count` | Pipeline | Dashboard | |
| `monthly_revenue_low/mid/high` | Pipeline | Dashboard | Near-miss revenue (secondary) |
| `tar_revenue_low/mid/high` | Pipeline | Dashboard | Total Addressable Revenue at target visibility (primary) |
| `total_keyword_count` | Pipeline | Dashboard | SUM of keyword_count across clusters |

**Pipeline writes**: Phase 3b (initial), Phase 3d (rebuild)
**Dashboard reads**: `useAudits()` relation, `useAudit()` relation, ResearchPage, OverviewPage

---

### `audit_assumptions`

| Column | Writer | Reader | Notes |
|--------|--------|--------|-------|
| `audit_id` | Dashboard/Pipeline | Both | FK |
| `benchmark_id` | Dashboard | Pipeline | FK → benchmarks |
| `ctr_model_id` | Dashboard | Pipeline | FK → ctr_models |
| `cr_used_min/mid/max` | Dashboard | Pipeline | Conversion rates |
| `acv_used_min/mid/max` | Dashboard | Pipeline | Average contract values |
| `target_ctr` | Dashboard | Pipeline | |
| `near_miss_min_pos/max_pos` | Dashboard | Pipeline | Position range |
| `min_volume` | Dashboard | Pipeline | Minimum search volume |
| `tar_position` | Dashboard | Pipeline | Target visibility position for TAR CTR (default 5) |

**Pipeline writes**: `ensureAssumptions()` auto-creates from benchmarks if missing at sync time
**Dashboard writes**: `useUpdateAssumptions()` on Settings page (includes `tar_position`)
**Dashboard reads**: `useAuditAssumptions()`, `useAudit()` relation, revenue recalculation, TAR preview

---

## Agent Output Tables

### `audit_snapshots`

| agent_name | Writer Phase | Key JSONB Columns | Dashboard Consumer |
|------------|-------------|-------------------|-------------------|
| `dwight` | Phase 6c (syncDwight) | `executive_summary`, `prioritized_fixes[]`, `agentic_readiness[]`, `structured_data_issues[]`, `heading_issues[]`, `security_issues[]`, `platform_notes`, `site_metadata` | `useAuditSiteFindings()` → AuditPage |
| `jim` | Phase 3 (syncJim) | `research_summary_markdown`, `keyword_overview{}`, `position_distribution[]`, `branded_split{}`, `intent_breakdown[]`, `top_ranking_urls[]`, `competitor_analysis[]`, `competitor_summary{}`, `striking_distance[]`, `content_gap_observations[]`, `key_takeaways[]` | `useResearchSiteFindings()` → ResearchPage |
| `gap` | Phase 5 | `keyword_overview` (JSONB with `authority_gaps[]`, `format_gaps[]`, `gap_summary`, `ai_citation_gaps[]`) | `useAuditSnapshots()`, `useAiCitationGaps()` |

**Shared columns**: `id`, `audit_id`, `agent_name`, `snapshot_version`, `agent_run_id`, `row_count`, `created_at`

**`prioritized_fixes[]` item schema** (Dwight snapshots):

| Field | Type | Notes |
|-------|------|-------|
| `number` | integer | Fix sequence number within tier |
| `issue` | string | Issue title from AUDIT_REPORT.md |
| `affected_pages` | string | Page count or URL list |
| `fix` | string | Remediation recommendation |
| `priority_tier` | integer | 1=Critical, 2=High, 3=Medium, etc. |
| `priority_label` | string | "Critical", "High", "Medium" |
| `status` | string | `flagged` (default), `false_positive`, `verified`, `resolved` |
| `original_severity` | string | Baseline `priority_label` at parse time (never changes) |
| `verified_at` | string? | ISO timestamp of verification check |
| `verification_source` | string? | `direct_http`, `manual`, `re-verification` |
| `verification_note` | string? | Human-readable explanation of the verification finding |

Phase 1a (`verify-dwight.ts`) writes `verification_results.json` to disk. syncDwight loads it and merges corrections into fix objects before writing to `audit_snapshots`. False positive fixes display as struck-through in the dashboard.

---

### `agent_technical_pages`

Written by syncDwight (Phase 6c). One row per crawled URL.

| Column | Notes |
|--------|-------|
| `url` | Full URL |
| `status_code` | HTTP status |
| `word_count` | |
| `title`, `h1`, `meta_description` | Page metadata |
| `depth` | Crawl depth |
| `indexability` | |
| `inlinks_count`, `outlinks_count` | |
| `semantic_closest_url`, `semantic_similarity_score`, `semantic_flag` | Near-duplicate detection |
| `crawl_data` | JSONB overflow (extra columns from crawl) |

**Dashboard reads**: `useAgentTechnicalPages()` → AuditPage

---

### `agent_architecture_pages`

Written by syncMichael (Phase 6b). One row per recommended page.

| Column | Notes |
|--------|-------|
| `url_slug` | Recommended URL |
| `page_status` | `new` / `exists` |
| `silo_name` | Content silo assignment |
| `role` | Page role in silo |
| `primary_keyword` | Target keyword |
| `primary_keyword_volume` | |
| `action_required` | What to do |

**Dashboard reads**: `useAgentArchitecturePages()` → StrategyPage

---

### `agent_architecture_blueprint`

Written by syncMichael (Phase 6b). One row per audit.

| Column | Notes |
|--------|-------|
| `blueprint_markdown` | Full architecture blueprint |
| `executive_summary` | Summary extract |
| `snapshot_version` | |

**Dashboard reads**: `useAgentBlueprint()` → StrategyPage

---

### `agent_runs`

Written by syncDwight + syncMichael. Tracks agent execution history.

| Column | Notes |
|--------|-------|
| `agent_name` | `dwight` / `michael` |
| `run_date` | |
| `status` | `completed` |
| `source_path` | Disk artifact path |
| `metadata` | JSONB: `{page_count}` etc. |

**Dashboard reads**: Implicit via relations

---

### `audit_coverage_validation`

Written by Phase 6.5 (Validator, Sonnet). Cross-checks gap analysis vs architecture blueprint.

| Column | Notes |
|--------|-------|
| `gap_topic` | Gap topic string from gap analysis |
| `gap_type` | `authority` / `format` / `unaddressed` |
| `estimated_volume` | Monthly search volume (integer, nullable) — carried from gap analysis |
| `revenue_signal` | `high` / `medium` / `low` / `unknown` — CPC × volume threshold |
| `blueprint_page` | URL slug of addressing page, or null |
| `status` | `addressed` / `partially_addressed` / `unaddressed` |
| `notes` | Required for unaddressed/partially_addressed gaps |

**Dashboard reads**: Not currently consumed by UI (available for future use)

---

## Performance Tables

### `baseline_snapshots`

Written by syncJim (first sync only, if near_miss > 0).

| Column | Notes |
|--------|-------|
| `keyword` | |
| `baseline_rank` | Initial position |
| `baseline_volume` | |

**Dashboard reads**: `useBaselineSnapshots()` → PerformancePage (Near-Miss Baseline section)

---

### `ranking_snapshots`

Written by `track-rankings.ts` (monthly cron or on-demand).

| Column | Notes |
|--------|-------|
| `keyword` | |
| `position` | Current SERP position |
| `search_volume` | |
| `snapshot_date` | |
| `canonical_key` | For cluster aggregation |

**Dashboard reads**: Via `ranking_deltas` view

---

### `cluster_performance_snapshots`

Written by `track-rankings.ts` during `aggregateClusterPerformance()`.

| Column | Notes |
|--------|-------|
| `canonical_key`, `canonical_topic` | Cluster identity |
| `snapshot_date` | |
| `keyword_count` | |
| `avg_position` | Excludes unranked |
| `keywords_p1_3/p4_10/p11_30/p31_100` | Position buckets |
| `total_volume` | |
| `estimated_traffic` | |
| `revenue_low/mid/high` | |
| `authority_score` | 0-100, position-weighted |
| `authority_score_delta` | Change from prior snapshot |

**Dashboard reads**: `useClusterPerformance()` → PerformancePage, `useClusterAuthorityTrend()` → ClustersPage authority chart

---

### `page_performance`

Written by `track-rankings.ts` for published execution pages.

| Column | Notes |
|--------|-------|
| `execution_page_id` | FK |
| `url_slug` | |
| `silo` | |
| `snapshot_date` | |
| `published_at` | |
| `pre_publish_avg_position` | |
| `current_avg_position` | |
| `keywords_gained_p1_10` | |
| `keywords_total` | |

New GA4 behavioral columns (written by `track-rankings.ts` step 9):

| Column | Notes |
|--------|-------|
| `organic_sessions` | GA4 organic sessions |
| `organic_engagement_rate` | GA4 organic engagement rate |
| `organic_cr` | GA4 organic conversion rate |
| `organic_conversions` | GA4 organic key events/conversions |
| `ga4_snapshot_date` | Date of GA4 data fetch |

**Dashboard reads**: `usePagePerformance()` → PerformancePage (Published Page Performance)

---

### `analytics_connections`

Stores GSC/GA4 property IDs per audit. Service account handles auth centrally.

| Column | Writer | Notes |
|--------|--------|-------|
| `audit_id` | Manual insert | FK audits, UNIQUE |
| `gsc_property_url` | Manual insert | e.g. `https://www.example.com/` |
| `ga4_property_id` | Manual insert | e.g. `513955424` |
| `last_gsc_sync_at` | Pipeline | Updated by fetch-gsc-data.ts |
| `last_ga4_sync_at` | Pipeline | Updated by fetch-ga4-data.ts |
| `status` | Manual | `active`, `disabled`, or `error` |

**RLS**: service_role ALL + super_admin SELECT

---

### `gsc_page_snapshots`

Written by `fetch-gsc-data.ts` (Phase 1c + track-gsc.ts weekly).

| Column | Notes |
|--------|-------|
| `page_url` | Normalized path (e.g. `/services/hvac`) |
| `snapshot_date` | |
| `clicks`, `impressions`, `ctr`, `avg_position` | GSC metrics |
| `top_queries` | JSONB array of top 5 queries per page |

**Dashboard reads**: Deferred (Phase 4 dashboard UI)

---

### `ga4_page_snapshots`

Written by `track-rankings.ts` step 9 (GA4 fetch).

| Column | Notes |
|--------|-------|
| `page_url` | Normalized path |
| `snapshot_date` | |
| `total_sessions`, `total_conversions`, `total_revenue` | All-channel metrics |
| `organic_sessions`, `organic_engaged_sessions` | Organic Search channel |
| `organic_engagement_rate`, `organic_cr` | Derived rates |
| `organic_conversions`, `organic_avg_session_dur` | Organic behavioral |

**Dashboard reads**: Deferred (Phase 4 dashboard UI)

---

### `audit_assumptions` (new columns)

New observed CR columns (written by `track-rankings.ts` step 9):

| Column | Writer | Notes |
|--------|--------|-------|
| `observed_cr` | Pipeline | Computed from GA4 pages with 30+ organic sessions |
| `observed_cr_source` | Pipeline | Always `'ga4'` |
| `observed_cr_updated_at` | Pipeline | Timestamp |
| `use_observed_cr` | Dashboard/manual | Boolean, defaults FALSE, never auto-enabled |

When `use_observed_cr = true`, `sync-to-dashboard.ts` uses `observed_cr` as `cr_used_mid` in TAR calculation.

---

## LLM Visibility Tables

### `llm_visibility_snapshots`

Written by syncJim (Phase 3b) and `track-llm-mentions.ts` (monthly cron or on-demand). One row per keyword × platform × domain.

| Column | Writer | Reader | Notes |
|--------|--------|--------|-------|
| `id` | Auto | Dashboard | PK, UUID |
| `audit_id` | Pipeline | Both | FK → audits |
| `domain` | Pipeline | Dashboard | Client domain or competitor domain |
| `snapshot_date` | Pipeline | Dashboard | DATE |
| `keyword` | Pipeline | Dashboard | |
| `platform` | Pipeline | Dashboard | `google`, `chat_gpt` |
| `mention_count` | Pipeline | Dashboard | |
| `ai_search_volume` | Pipeline | Dashboard | Nullable |
| `top_citation_domains` | Pipeline | Dashboard | JSONB array of domain strings |
| `is_estimated` | Pipeline | Dashboard | Boolean, default false. True for competitor rows (aggregate API data, not per-keyword measured) |
| `created_at` | Auto | Dashboard | |

**UNIQUE constraint:** `(audit_id, snapshot_date, keyword, platform, domain)` — allows client and competitor data to coexist.

**Pipeline writes**: syncJim (client + competitor mentions from `llm_mentions.json`), `track-llm-mentions.ts` (client mentions only, monthly)
**Dashboard reads**: `useLlmVisibilitySnapshots()` → AiVisibilityPage, PerformancePage (via `useAiVisibilityTrend`)

---

### `llm_mention_details`

Written by syncJim (Phase 3b) and `track-llm-mentions.ts`. Qualitative mention records.

| Column | Writer | Reader | Notes |
|--------|--------|--------|-------|
| `id` | Auto | Dashboard | PK, UUID |
| `audit_id` | Pipeline | Both | FK → audits |
| `keyword` | Pipeline | Dashboard | |
| `platform` | Pipeline | Dashboard | `google`, `chat_gpt` |
| `mention_text` | Pipeline | Dashboard | Nullable |
| `citation_urls` | Pipeline | Dashboard | JSONB array |
| `source_domains` | Pipeline | Dashboard | JSONB array |
| `captured_at` | Auto | Dashboard | |

**Pipeline writes**: syncJim, `track-llm-mentions.ts`, `ai-visibility-analysis.ts`
**Dashboard reads**: `useLlmMentionDetails()` → AiVisibilityPage

**Note**: `ai-visibility-analysis.ts` writes `mention_text: null` and `citation_urls: []` — LLM Mentions API returns domains, not full URLs or snippet text. `source_domains` is populated.

---

## Ad-Hoc Research Tables

### `keyword_lookups`

Ad-hoc keyword volume lookups via DataForSEO. Each row = one keyword result; `batch_id` groups results from a single lookup session. Super-admin only.

| Column | Type | Writer | Description |
|--------|------|--------|-------------|
| `id` | uuid PK | pipeline | Auto-generated |
| `audit_id` | uuid FK→audits | pipeline | Audit this lookup belongs to |
| `batch_id` | uuid | pipeline | Groups all keywords from one lookup invocation |
| `keyword` | text | pipeline | The looked-up keyword |
| `volume` | integer | pipeline | Monthly search volume (0 if not found) |
| `cpc` | numeric(10,2) | pipeline | Cost per click |
| `competition` | numeric(5,4) | pipeline | Competition score (0-1) |
| `competition_level` | text | pipeline | LOW / MEDIUM / HIGH |
| `looked_up_by` | uuid FK→auth.users | pipeline | User who ran the lookup |
| `looked_up_at` | timestamptz | pipeline | When the lookup was performed |
| `estimated_cost` | numeric(10,4) | pipeline | DataForSEO API cost for the batch |

**Unique**: `(audit_id, batch_id, keyword)`
**RLS**: super_admin only (`has_role` check)
**Dashboard reads**: `useKeywordLookupHistory()` → KeywordLookupPage (history accordion, last 90 days)

---

## Content Factory Tables

### `execution_pages`

Written by syncMichael (Phase 6b) and Cluster Strategy (on-demand), updated by Pam + Oscar.

| Column | Writer | Notes |
|--------|--------|-------|
| `url_slug` | syncMichael / Cluster Strategy | |
| `silo` | syncMichael / Cluster Strategy | |
| `priority` | syncMichael / Cluster Strategy | 1=create, 2=optimize, 3=differentiate, 4=maintain |
| `source` | syncMichael / Cluster Strategy / Dashboard | `michael` (syncMichael), `cluster_strategy` (activation), `manual` (dashboard useAddRecommendedPages) |
| `buyer_stage` | Cluster Strategy | `awareness`, `consideration`, `decision`, `retention` — null for architecture pages |
| `strategy_rationale` | Cluster Strategy | Why this page was recommended — null for architecture pages |
| `status` | Pipeline + Dashboard | `not_started` → `brief_ready` → `in_progress` → `review` → `published`. Also `deprecated` (set by syncMichael on strategic re-run for stale uncommitted pages or by Michael's deprecation recommendations). Oscar writes `in_progress` (dashboard shows "Draft Ready"). `review` = manual user action ("In Review"). |
| `page_brief` | syncMichael | JSONB |
| `canonical_key` | syncMichael | Join to `audit_clusters` |
| `cluster_active` | Pipeline (rebuild) | Boolean, gates content production |
| `metadata_markdown` | Pam | |
| `content_outline_markdown` | Pam | |
| `schema_json` | Pam | JSON-LD |
| `content_html` | Oscar | Production HTML (65K token budget, streaming) |
| `published_at` | Dashboard | Set when status → published |
| `snapshot_version` | syncMichael | |

**Dashboard reads**: `useExecutionPages()` → ContentPage, ImplementationPage, ClustersPage
**Dashboard writes**: `useUpdateExecutionPageStatus()` (status), `useAddRecommendedPages()` (INSERT)

---

### `pam_requests`

| Column | Writer | Reader |
|--------|--------|--------|
| `audit_id`, `page_url`, `silo_name`, `page_role` | Dashboard (INSERT) | Pipeline |
| `target_keywords` | Dashboard | Pipeline |
| `domain` | Dashboard | Pipeline |
| `status` | Pipeline | Dashboard | `pending` → `processing` → `completed` / `failed` |
| `error_message` | Pipeline | Dashboard |

**Dashboard polls**: 3s interval while pending/processing

---

### `oscar_requests`

Same pattern as `pam_requests`.

| Column | Writer | Reader |
|--------|--------|--------|
| `audit_id`, `page_url`, `domain` | Dashboard (INSERT) | Pipeline |
| `status` | Pipeline | Dashboard | `pending` → `processing` → `completed` / `failed` |
| `error_message` | Pipeline | Dashboard |

**Dashboard polls**: 3s interval while pending/processing

---

### `cluster_strategy`

Written by `generate-cluster-strategy.ts` (on-demand, per-cluster via `/activate-cluster`).

| Column | Notes |
|--------|-------|
| `canonical_key` | Cluster identity |
| `strategy_markdown` | Full Opus strategy document |
| `recommended_pages` | JSON |
| `buyer_stages` | JSON |
| `format_gaps` | JSON |
| `entity_map` | JSONB — entity type mapping from Section 0 |
| `ai_optimization_notes` | Section 5 prose fallback |
| `ai_optimization_targets` | JSONB — structured AI/search targets from Section 5: `[{query, target_type, structural_pattern, applies_to_page, condition, rationale}]` |
| `model_used` | |

**Dashboard reads**: `useClusterStrategy()`, `useClusterStrategyPoll()` → StrategyPage

---

## Local Presence Tables

### `gbp_snapshots`

Written by Phase 6d (LocalPresence).

| Column | Notes |
|--------|-------|
| `listing_found` | Boolean (missing GBP = high-value signal) |
| `business_name`, `phone`, `address`, `website` | Listing data |
| `claimed_status` | `claimed` / `unclaimed` / `unknown` |
| `canonical_nap` | Name/Address/Phone tuple (source of truth) |
| `data_source` | `gbp` |

**Dashboard reads**: `useGbpSnapshot()` → LocalPresencePage
**Dashboard column names differ**: `gbp_missing` (= !listing_found), `matched_name`, `category`, `is_claimed`, `rating`, `review_count`, `photo_count`, `canonical_name/address/phone`

---

### `citation_snapshots`

Written by Phase 6d (LocalPresence). One row per directory.

| Column | Notes |
|--------|-------|
| `directory_name` | Google, Yelp, Angi, BBB, etc. (11 directories) |
| `listing_found` | Boolean |
| `nap_match_name/address/phone` | Boolean, compared to GBP canonical NAP |
| `listing_url` | |
| `data_source` | `gbp` (Google) or `serp` (others) |

**Dashboard reads**: `useCitationSnapshots()` → LocalPresencePage

---

## Reference Tables

### `prospects`

| Column | Writer | Reader |
|--------|--------|--------|
| `name`, `domain`, `geo_type`, `target_geos` | Dashboard | Pipeline |
| `status` | Both | Both | `discovery` → `running` → `qualified` / `converted` |
| `scout_run_at`, `scout_output_path` | Pipeline | Dashboard |
| `converted_to_audit_id` | Dashboard | Dashboard |
| `share_token` | Edge fn (generate_share_token) | Edge fn (get_share_report) | UUID, unique partial index |
| `share_token_created_at` | Edge fn | Dashboard | |
| `brand_favicon_url` | Pipeline (Scout) | Edge fn (get_share_report) | Google favicon URL |
| `scout_markdown` | Pipeline (Scout) | Edge fn (get_share_report) | Full scout report markdown |
| `scout_scope_json` | Pipeline (Scout) | Edge fn (get_share_report) | scope.json JSONB |
| `prospect_narrative` | Pipeline (Scout) | Edge fn (get_share_report) | Plain-language outreach doc |

**Dashboard reads**: `useProspects()`, `useProspect()`, `useProspectStatus()` (2s poll while running)
**Pipeline writes**: Scout updates status, scout_run_at, scout_output_path, brand_favicon_url, scout_markdown, scout_scope_json, prospect_narrative

---

### `benchmarks`

Read-only reference data. Pipeline reads at sync time, Dashboard reads for audit creation.

| Key Columns | Notes |
|-------------|-------|
| `service_key` | HVAC, Plumbing, Electrical, etc. |
| `cr_min/max`, `acv_min/max` | Industry conversion/revenue benchmarks |

---

### `ctr_models`

Read-only reference data. Dashboard reads default model for audit creation.

| Key Columns | Notes |
|-------------|-------|
| `model_key` | |
| `buckets` | JSON CTR curve |
| `is_default` | |

---

### `client_profiles`

| Column | Writer | Reader |
|--------|--------|--------|
| All fields | Dashboard | Pipeline (Oscar) |

**Dashboard reads/writes**: `useClientProfile()`, `useUpsertClientProfile()` — Settings page
**Pipeline reads**: Oscar reads for brand voice injection

---

## Views

### `v_opportunity_breakdown`

Server-side view joining `audit_clusters` + `audit_assumptions` with eligibility calculation.

**Key columns**: `canonical_key`, `canonical_topic`, `eligibility_status`, `best_rank`, `total_volume`, `est_revenue_*`, `ctr_gain_used`
**Dashboard reads**: `useOpportunityBreakdown()` → ResearchPage

### `ranking_deltas`

Server-side view computing position changes from `ranking_snapshots`.

**Key columns**: `keyword`, `canonical_key`, `current_position`, `baseline_position`, `position_delta`, `search_volume`
**Dashboard reads**: `useRankingDeltas()` → PerformancePage

### `audit_topic_dominance`

**Key columns**: `canonical_key`, `canonical_topic`, `leader_domain`, `leader_share`, `client_share`
**Dashboard reads**: `useCompetitorDominance()` → ResearchPage (3s poll for 90s if empty)

### `audit_topic_competitors`

**Key columns**: `canonical_key`, `competitor_domain`, `appearance_count`, `share`, `is_client`
**Dashboard reads**: `useTopicCompetitors()` → ResearchPage

---

## Edge Functions

| Function | Action | Pipeline Server Endpoint | Request Shape | Response Shape |
|----------|--------|-------------------------|---------------|----------------|
| `run-audit` | (default) | `/trigger-pipeline` | `{audit_id}` | `{ok, status}` |
| `scout-config` | `write_config` | `/scout-config` | `{domain, config}` | `{ok}` |
| `scout-config` | `trigger_scout` | `/trigger-pipeline` | `{domain}` | `{ok}` or `{status:'pipeline_already_running'}` |
| `scout-config` | `read_report` | `/scout-report` | `{domain}` | `{markdown, scope, date, narrative}` |
| `scout-config` | `generate_share_token` | (Supabase-only) | `{prospect_id}` | `{token, share_url, domain, name}` |
| `scout-config` | `get_share_report` | (Supabase-only, **no auth**) | `{token}` | `{prospect, markdown, scope, narrative}` |
| `pipeline-controls` | `recanonicalize` | `/recanonicalize` | `{domain, email}` | `{ok}` |
| `pipeline-controls` | `track_rankings` | `/track-rankings` | `{domain, email, force: true}` | `{ok}` |
| `pipeline-controls` | `track_gsc` | `/track-gsc` | `{domain, email}` | `{ok}` |
| `pipeline-controls` | `track_llm_mentions` | `/track-llm-mentions` | `{domain, email}` | `{ok}` |
| `pipeline-controls` | `lookup_keywords` | `/lookup-keywords` | `{keywords[], location_codes?, audit_id?}` | `{results[], total, found, estimated_cost}` |
| `pipeline-controls` | `ai_visibility_analysis` | `/ai-visibility-analysis` | `{domain, email, audit_id, keywords?, competitor_domains?}` | Full analysis result JSON |
| `pipeline-controls` | `rerun_pipeline` | `/trigger-pipeline` | `{domain, email}` | `{ok}` |
| `pipeline-controls` | `resume_pipeline` | `/trigger-pipeline` | `{domain, email, annotations?, audit_id}` | `{success, start_from:'1b'}` |
| `pipeline-controls` | `generate_brief` | `/generate-brief` | `{domain, email}` | `{status:'brief_generation_started'}` |
| `pipeline-controls` | `generate_content` | `/generate-content` | `{domain, email}` | `{status:'content_generation_started'}` |
| `cluster-action` | `activate` | `/activate-cluster` | `{audit_id, canonical_key, target_publish_date?, notes?}` | cluster status |
| `cluster-action` | `deactivate` | `/deactivate-cluster` | `{audit_id, canonical_key}` | cluster status |
| `share-audit` | `status/create/revoke/verify` | (Supabase-only) | varies | varies |
| `manage-users` | `list` | (Supabase-only) | `{action:'list'}` | `{users[]}` |
| `export-audit` | (default) | `/export-audit` | `{domain}` | Binary ZIP stream |
| `run-competitor-dominance` | (default) | (Supabase-only) | `{audit_id}` | rebuilt view |

**Auth patterns**:
- `validateSuperAdmin`: JWT → `has_role('super_admin')` — used by `pipeline-controls`, `scout-config` (except `get_share_report`), `manage-users`
- `resolveAuthContext`: JWT → user lookup + audit ownership check — used by `cluster-action`, `share-audit`

---

## RPC Functions

| Function | Parameters | Returns | Used By |
|----------|-----------|---------|---------|
| `has_role` | `{_user_id, _role}` | `boolean` | AuthContext (role check loop), edge function auth |

---

## Disk Artifacts (Pipeline Only)

These files live on the pipeline server disk and are NOT in Supabase. They feed downstream phases and are served via the `/artifact` and `/scout-report` endpoints.

| Path | Phase | Contents |
|------|-------|----------|
| `audits/{domain}/scout/{date}/scope.json` | Scout | Topics, locales, services, gap_summary |
| `audits/{domain}/scout/{date}/prospect-narrative.md` | Scout | Plain-language outreach document |
| `audits/{domain}/auditor/{date}/AUDIT_REPORT.md` | Dwight | Full technical audit |
| `audits/{domain}/auditor/{date}/internal_all.csv` | Dwight | Crawl data (all internal URLs) |
| `audits/{domain}/auditor/{date}/*.csv` | Dwight | Supplementary crawl exports |
| `audits/{domain}/research/{date}/gsc_data.json` | Phase 1c | GSC page data + zero-click queries + date range |
| `audits/{domain}/research/{date}/gsc_summary.md` | Phase 1c | GSC performance summary (markdown, injected into Strategy Brief) |
| `audits/{domain}/research/{date}/strategy_brief.md` | Phase 1b | Strategic framing (4 sections) |
| `audits/{domain}/research/{date}/keyword_research_matrix.json` | Phase 2 | Service × city × intent matrix |
| `audits/{domain}/research/{date}/ranked_keywords.json` | Jim | DataForSEO ranked keywords (geo-qualified volumes when `geo_mode != 'national'`) |
| `audits/{domain}/research/{date}/ranked_keywords.national.json` | Jim | Original national volumes backup (only created when geo-qualifying Mode A) |
| `audits/{domain}/research/{date}/llm_mentions.json` | Jim | AI platform mention data (domain + competitor mentions) |
| `audits/{domain}/research/{date}/ai_visibility_data.json` | AI Visibility | Full structured analysis result (per-keyword mentions, competitor summary, costs) |
| `audits/{domain}/research/{date}/ai_visibility_report.md` | AI Visibility | SOW 2.5 deliverable: executive summary, citation tables, structural gaps, recommendations |
| `audits/{domain}/research/{date}/research_summary.md` | Jim | 10-11 section research narrative (Section 11 conditional: AI Visibility) |
| `audits/{domain}/research/{date}/content_gap_analysis.md` | Gap | Authority + format gaps |
| `audits/{domain}/research/{date}/coverage_validation.md` | Validator | Gap vs blueprint cross-check |
| `audits/{domain}/architecture/{date}/architecture_blueprint.md` | Michael | Silo structure + page plan |
| `audits/{domain}/content/{date}/{slug}/metadata.md` | Pam | Page metadata |
| `audits/{domain}/content/{date}/{slug}/outline.md` | Pam | Content outline |
| `audits/{domain}/content/{date}/{slug}/schema.json` | Pam | JSON-LD schema |
| `audits/{domain}/content/{date}/{slug}/page.html` | Oscar | Production HTML |

---

## Column Name Mismatches (Pipeline vs Dashboard)

Known cases where pipeline writes and dashboard reads use different column names or shapes:

| Table | Pipeline Writes | Dashboard Reads | Resolution |
|-------|----------------|-----------------|------------|
| `gbp_snapshots` | `listing_found` | `gbp_missing` | Dashboard inverts boolean |
| `gbp_snapshots` | `claimed_status` | `is_claimed` | Dashboard maps string→boolean |
| `gbp_snapshots` | `canonical_nap` (object) | `canonical_name/address/phone` (separate cols) | Dashboard destructures |
| `audit_keywords` | `delta_revenue_mid` | (computed client-side) | Dashboard recalculates in `useAssumptionsPreview` |

---

## Polling Contracts

| Hook | Table/Edge Fn | Interval | Condition |
|------|--------------|----------|-----------|
| `useAuditStatus` | `audits` | 2s | While `status = 'running'` |
| `useProspectStatus` | `prospects` | 2s | While `status = 'running'` |
| `usePamRequests` | `pam_requests` | 3s | While `status = 'pending'/'processing'` |
| `useOscarRequests` | `oscar_requests` | 3s | While `status = 'pending'/'processing'` |
| `useClusterStrategyPoll` | `cluster_strategy` | 5s | For 90s while generating |
| `useCompetitorDominance` | `audit_topic_dominance` | 3s | For 90s while empty |
