# Data Contract: NanoClaw Pipeline ↔ Forge OS Dashboard

> **Purpose**: Authoritative map of every Supabase table, who writes it (pipeline), who reads it (dashboard), and which columns matter. Use this before adding columns, changing sync logic, or building new UI components.
>
> **Last updated**: 2026-03-19

---

## Table of Contents

1. [Core Tables](#core-tables)
2. [Agent Output Tables](#agent-output-tables)
3. [Performance Tables](#performance-tables)
4. [Content Factory Tables](#content-factory-tables)
5. [Local Presence Tables](#local-presence-tables)
6. [Reference Tables](#reference-tables)
7. [Views](#views)
8. [Edge Functions](#edge-functions)
9. [RPC Functions](#rpc-functions)
10. [Disk Artifacts](#disk-artifacts)

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
| `research_snapshot_at` | Pipeline (syncJim) | Dashboard | Staleness timestamp |
| `audit_snapshot_at` | Pipeline (syncDwight) | Dashboard | Staleness timestamp |
| `strategy_snapshot_at` | Pipeline (syncMichael) | Dashboard | Staleness timestamp |
| `created_at`, `completed_at` | Auto / Pipeline | Dashboard | |

**Pipeline writes**: `status`, `error_message`, `service_key` (auto-detect), `*_snapshot_at` timestamps
**Dashboard writes**: All creation fields, `client_context`, `review_gate_enabled`, `status` (draft→running)
**Dashboard reads**: Full row + relations (`audit_rollups`, `audit_assumptions`, `audit_clusters`, `audit_keywords`)

---

### `audit_keywords`

| Column | Writer | Reader | Notes |
|--------|--------|--------|-------|
| `id` | Auto | Dashboard | PK |
| `audit_id` | Pipeline | Both | FK |
| `keyword` | Pipeline | Dashboard | |
| `rank_pos` | Pipeline | Dashboard | 100 = synthetic (no ranking) |
| `search_volume` | Pipeline | Dashboard | |
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
| `total_volume` | Pipeline | Dashboard | |
| `est_new_leads_low/high` | Pipeline | Dashboard | |
| `est_revenue_low/mid/high` | Pipeline | Dashboard | |
| `sample_keywords` | Pipeline | Dashboard | JSON array |
| `status` | Edge fn (cluster-action) | Dashboard | null / `active` / `inactive` |
| `activated_at` | Edge fn | Dashboard | |
| `activated_by` | Edge fn | Dashboard | |
| `target_publish_date` | Edge fn | Dashboard | |
| `notes` | Edge fn | Dashboard | |
| `authority_score` | Pipeline (track-rankings) | Dashboard | 0-100, position-weighted |
| `authority_score_updated_at` | Pipeline | Dashboard | |

**Pipeline writes**: Phase 3b (initial), Phase 3d (rebuild with canonical keys, preserves status/activation)
**Dashboard reads**: `useAuditClusters()`, `useAudit()` relation, ClustersPage, StrategyPage
**Dashboard writes**: Via `cluster-action` edge function (status, activation fields)

---

### `audit_rollups`

| Column | Writer | Reader | Notes |
|--------|--------|--------|-------|
| `audit_id` | Pipeline | Dashboard | FK |
| `total_volume_analyzed` | Pipeline | Dashboard | |
| `near_miss_keyword_count` | Pipeline | Dashboard | |
| `opportunity_topics_count` | Pipeline | Dashboard | |
| `monthly_revenue_low/mid/high` | Pipeline | Dashboard | mid = headline number |

**Pipeline writes**: Phase 3b (initial), Phase 3d (rebuild)
**Dashboard reads**: `useAudits()` relation, `useAudit()` relation, ResearchPage

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

**Pipeline writes**: `ensureAssumptions()` auto-creates from benchmarks if missing at sync time
**Dashboard writes**: `useUpdateAssumptions()` on Settings page
**Dashboard reads**: `useAuditAssumptions()`, `useAudit()` relation, revenue recalculation

---

## Agent Output Tables

### `audit_snapshots`

| agent_name | Writer Phase | Key JSONB Columns | Dashboard Consumer |
|------------|-------------|-------------------|-------------------|
| `dwight` | Phase 1 (syncDwight) | `executive_summary`, `prioritized_fixes[]`, `agentic_readiness[]`, `structured_data_issues[]`, `heading_issues[]`, `security_issues[]`, `platform_notes`, `site_metadata` | `useAuditSiteFindings()` → AuditPage |
| `jim` | Phase 3 (syncJim) | `research_summary_markdown`, `keyword_overview{}`, `position_distribution[]`, `branded_split{}`, `intent_breakdown[]`, `top_ranking_urls[]`, `competitor_analysis[]`, `competitor_summary{}`, `striking_distance[]`, `content_gap_observations[]`, `key_takeaways[]` | `useResearchSiteFindings()` → ResearchPage |
| `gap` | Phase 5 | `keyword_overview` (JSONB with `authority_gaps[]`, `format_gaps[]`, `gap_summary`) | `useAuditSnapshots()` |

**Shared columns**: `id`, `audit_id`, `agent_name`, `snapshot_version`, `agent_run_id`, `row_count`, `created_at`

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

Written by Phase 6.5 (Validator). Cross-checks gap analysis vs blueprint.

| Column | Notes |
|--------|-------|
| `gap_identifier` | Reference to gap analysis item |
| `gap_type` | `authority` / `format` |
| `addressed_by_silo` | Which silo covers it |
| `addressed_by_page_slug` | Which page covers it |
| `coverage_status` | `covered` / `partial` / `uncovered` |

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

Written by `track-rankings.ts` (weekly cron or on-demand).

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

**Dashboard reads**: `usePagePerformance()` → PerformancePage (Published Page Performance)

---

## Content Factory Tables

### `execution_pages`

Written by syncMichael (Phase 6b), updated by Pam + Oscar.

| Column | Writer | Notes |
|--------|--------|-------|
| `url_slug` | syncMichael | |
| `silo` | syncMichael | |
| `priority` | syncMichael | 1=create, 2=optimize, 3=differentiate, 4=maintain |
| `status` | Pipeline + Dashboard | `not_started` → `brief_generated` → `content_generated` → `published` |
| `page_brief` | syncMichael | JSONB |
| `canonical_key` | syncMichael | Join to `audit_clusters` |
| `cluster_active` | Pipeline (rebuild) | Boolean, gates content production |
| `metadata_markdown` | Pam | |
| `content_outline_markdown` | Pam | |
| `schema_json` | Pam | JSON-LD |
| `html_content` | Oscar | Production HTML |
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
| `ai_optimization_notes` | |
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
| `pipeline-controls` | `track_rankings` | `/track-rankings` | `{domain, email}` | `{ok}` |
| `pipeline-controls` | `rerun_pipeline` | `/trigger-pipeline` | `{domain, email}` | `{ok}` |
| `pipeline-controls` | `resume_pipeline` | `/trigger-pipeline` | `{domain, email, annotations?, audit_id}` | `{success, start_from:'1b'}` |
| `cluster-action` | `activate` | `/activate-cluster` | `{audit_id, canonical_key, target_publish_date?, notes?}` | cluster status |
| `cluster-action` | `deactivate` | `/deactivate-cluster` | `{audit_id, canonical_key}` | cluster status |
| `share-audit` | `status/create/revoke/verify` | (Supabase-only) | varies | varies |
| `manage-users` | `list` | (Supabase-only) | `{action:'list'}` | `{users[]}` |
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
| `audits/{domain}/research/{date}/strategy_brief.md` | Phase 1b | Strategic framing (4 sections) |
| `audits/{domain}/research/{date}/keyword_research_matrix.json` | Phase 2 | Service × city × intent matrix |
| `audits/{domain}/research/{date}/ranked_keywords.json` | Jim | DataForSEO ranked keywords |
| `audits/{domain}/research/{date}/research_summary.md` | Jim | 10-section research narrative |
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
