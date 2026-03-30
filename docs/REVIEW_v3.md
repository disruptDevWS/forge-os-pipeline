# Forge OS v3.0 System Review

> **Initiated:** 2026-03-28
> **Reviewer:** Claude Code (clean-eyes structural audit)
> **Repos in scope:** `forge-os-pipeline` (Railway), `lovable-repo` (Vercel), Supabase schema + edge functions
> **Method:** Full source read of both repos (~15,000 LOC pipeline, ~12,000 LOC dashboard), Playwright UI walkthrough, static analysis

---

## System Overview

Forge OS is an AI-powered SEO audit and content intelligence platform for local service businesses. It automates the full research-to-content lifecycle: technical site crawling, keyword research, competitive gap analysis, site architecture planning, content brief generation, and HTML content production — all orchestrated through a 13-phase pipeline that costs approximately $3-5 per full audit run.

**Data flows end-to-end as follows:** A React SPA dashboard (Vercel) triggers Supabase Edge Functions, which POST to a Node.js HTTP server on Railway (port 3847). The server spawns a shell orchestrator (`run-pipeline.sh`) that runs TypeScript phase generators sequentially. Each phase is a single-shot prompt template — not a multi-turn agent — that gathers context from disk artifacts and Supabase, builds a prompt, calls the Anthropic API once, validates the response, and writes results to both disk and Supabase. The dashboard then reads from Supabase to display results across 10+ sub-pages per audit.

**Key architectural decisions that define the system's shape:** (1) Phases are prompt templates, not agents — this makes output deterministic and debuggable but means recovery from partial failures requires manual `--start-from` intervention. (2) Disk artifacts are the source of truth between phases; Supabase is the sync target for dashboard display. This creates a dual-store pattern that `resolveArtifactPath()` bridges with cross-date fallback. (3) A three-tier model policy (Haiku for classification, Sonnet for synthesis, Opus for strategic judgment) controls cost while matching model capability to task complexity. (4) The pipeline server uses a single shared secret (`TRIGGER_SECRET`) for all endpoints, with Supabase Edge Functions serving as the auth/RBAC layer.

The system has reached functional maturity — 8 completed audits visible in production, all major pipeline phases operational, content factory (Pam/Oscar) working on-demand, cluster activation with Opus strategy generation deployed. The transition to v3.0 is about hardening what exists: closing error handling gaps, tightening security boundaries, improving data model integrity, and making the dashboard's information architecture match the pipeline's actual workflow.

---

## UX/UI Findings

### Audit Dashboard (Screenshot: 01-login-page.png)

The audit list is clean and scannable. Each card shows domain, service category, location, date, pipeline progress (e.g., "4/4 Full Pipeline"), and revenue range. Two issues persist:

- **"Other" service category** (boiseserviceplumbers.com): Displays raw `service_key` value "Other" instead of the user's `custom_service_label`. The pipeline auto-detects service key but the dashboard doesn't fall back to the custom label when `service_key = 'other'`.
- **"Location not set"** (boiseserviceplumbers.com): Shows literal "Location not set" text. Should show "—" or omit the location element entirely for cleaner presentation.
- **Revenue ranges are wide** ($1,030 – $61,772/mo): The 60:1 ratio between low and high estimates reduces decision utility. This is a modeling issue (CR × ACV range), not a display issue, but the dashboard could surface the mid-point estimate more prominently.

### Overview Page (Screenshot: 02-overview-page.png)

The page has improved significantly from the wall-of-text state documented in the prior UX audit. The headline insight ("This site ranks for 92 keywords. 15 are in the top 10 — and 0 are non-branded.") is punchy and decision-relevant. Revenue range card is clear. "What Happens Next" section provides 4 actionable items derived from pipeline data.

**Remaining issues:**
- **Scorecard grid (9 cards)** partially duplicates sidebar navigation indicators. The cards show clickable info icons but don't navigate to the relevant page — missed opportunity for workflow guidance.
- **Agentic Readiness Score shows "—"**: This metric appears on every completed audit but has no data. Either compute it or remove the card to avoid confusion.
- **No progress indicator**: The sidebar shows green/gray dots next to each nav item, but there's no legend or tooltip explaining what they mean. Users see colored dots without context.

### Sidebar Navigation (All audit detail pages)

**C1 from prior audit is resolved.** Sidebar labels are now concise and readable: Overview, Research, Technical, Local Presence, Roadmap, Clusters, Content, Performance, AI Visibility. No truncation observed at standard desktop width.

**New observations:**
- Green dots next to nav items indicate data presence but lack any explanatory tooltip or legend. A first-time user cannot distinguish "data available" from "data processing" from "not yet available" without hovering (which shows tooltip text not visible in screenshots).
- "Share" button is now in the page header toolbar area (top-right), not styled as a nav item — **S10 from prior audit is resolved**.
- "Keyword Lookup" nav item is below the separator, visible to all users in the sidebar. Per the code, it should only appear for `super_admin` users, but the route itself lacks role enforcement.

### Research Page (Screenshot: 03-research-page.png)

**S5 from prior audit is partially resolved.** The page now has tab navigation (Rankings / Revenue / Competition) instead of a single vertical scroll. The Rankings tab surfaces Position Distribution, Striking Distance Opportunities table, Unified Keyword Engine (collapsible), Branded vs Non-Branded split, and Intent Breakdown.

**Remaining issues:**
- The page is still a single 63.8KB React component. The tabs help navigation but the underlying code complexity creates maintenance risk.
- Striking Distance table shows 19 rows without pagination. With larger audits (200+ keywords), this would degrade.
- Revenue Delta column shows "—" for most rows. These are keywords where revenue modeling data is incomplete (no CPC). The "—" is correct but the column takes space without adding value for most rows.

### Clusters Page (Screenshot: 04-clusters-page.png)

**C2 from prior audit persists in a different form.** The audit is "Completed" with "4/4 Full Pipeline" but the Clusters page shows all 6 clusters with "Keywords: 0" and "Generating..." buttons (disabled). The "Opportunity" badge appears on every cluster. This creates confusion: the pipeline completed successfully, but the cluster keyword counts read as zero, and the activation buttons are stuck in a generating state.

**Root cause hypothesis:** The `keyword_count` field on `audit_clusters` is populated during Phase 3d (rebuild), but the clusters page queries may be filtering by `cluster_active` or another field that eliminates the keyword association. The "Generating..." button state appears to be a polling artifact — `useClusterStrategyPoll` may be returning an in-progress state for clusters that were never activated.

**Additional observations:**
- Actions column is cut off at the right edge of the table. The "Hide" button text is partially visible. The table needs horizontal scroll or column priority.
- Authority scores show "—" for all clusters with an info alert linking to Settings to trigger a manual refresh. Good empty state messaging.
- The "Quick Win" column shows "—" for all rows. If this column is empty for all non-activated clusters, consider hiding it until clusters are activated.

### Content Queue (Screenshot: 05-content-queue.png)

Content queue is functional. 16 pages in a 2-column card grid, each showing URL slug, silo assignment, primary keyword + volume, status dropdown, and Generate Brief / Brief Details buttons. Status pipeline badges at top (16 Not Started / 0 Brief Ready / 0 Draft Ready / 0 In Review / 0 Published).

**Observations:**
- Client Profile panel from prior UX audit (S9) has been moved — the page now says "Brand voice and client profile are configured in Settings." This addresses the S9 finding.
- NEW badge filter (green "NEW: 13") works as a toggle. Good filter UX.
- Cards are visually uniform. No way to distinguish high-priority pages from low-priority without reading each card. A priority indicator (color, badge, sort) would help users focus on the highest-impact content first.
- No bulk actions. If a user wants to generate briefs for all 16 pages, they must click each one individually.

### Scout Dashboard

The `/scout` route redirected back to `/audits` during Playwright testing, likely due to a race condition where `userRole` hasn't loaded from the `has_role()` RPC before the component's redirect logic fires. The Header correctly showed Scout/Users links on audit pages (role was loaded), but direct navigation to `/scout` triggers the redirect before role resolution completes.

This is a symptom of the broader issue that **route-level role guards are missing**. The redirect lives inside the `ScoutDashboard` component, not in the route definition. If the component renders before the role is resolved, it redirects prematurely.

---

## Architecture & Data Flow

### Phase Boundaries and Data Ownership

Phase boundaries are generally clean. Each phase reads from well-defined inputs (disk artifacts + Supabase) and writes to designated outputs. The `PIPELINE.md` contract is accurate and maintained.

**Cross-phase dependency risks:**

1. **Phase 3b → 3c → 3d ordering fragility.** `syncJim()` (Phase 3b) deletes all `audit_keywords` with `source='ranked'` before inserting new ones. If the insert fails mid-batch (e.g., Supabase timeout), keywords are lost. Phase 3c (Canonicalize) then reads from `audit_keywords` — if Phase 3b left the table in a partial state, canonicalization operates on incomplete data. There is no transaction wrapping across these phases.

2. **Cross-date artifact fallback.** `resolveArtifactPath()` silently falls back to yesterday's artifacts if today's don't exist. This is documented and intentional, but creates a correctness risk: if Phase 1 ran yesterday and produced artifacts, but today's Phase 2 run uses a different keyword matrix, Phase 3 (Jim) could reference stale Phase 1 data without any warning logged.

3. **Cluster rebuild delete-then-insert.** `rebuildClustersAndRollups()` saves cluster activation status, deletes all clusters, inserts new ones, then restores status by matching `canonical_key`. If canonicalization changes a key (e.g., "hvac_repair" → "hvac_repair_service"), the activation state is orphaned. No audit trail exists for these lost activations.

### Phases That Could Be Collapsed

- **Phase 3b (syncJim) and Phase 3c (Canonicalize) could run within a single TypeScript process.** Currently, 3b syncs to Supabase, then 3c reads back from Supabase. If canonicalization ran in-memory on the same keyword array, it would eliminate one round-trip and the risk of partial-sync state between them.
- **Phase 6b (syncMichael) and Phase 6c (syncDwight)** are independent sync operations that could run in parallel rather than sequentially, saving ~30 seconds per audit.

### Disk Artifact Structure

The `audits/{domain}/{category}/{date}/` structure is sound. Date-stamped directories enable historical comparison. However:

- **No cleanup mechanism.** Artifacts accumulate indefinitely on the Railway volume. With 8 audits and multiple runs per audit, disk usage grows unbounded. A retention policy (e.g., keep last 3 runs) is needed.
- **No integrity checking.** If a disk artifact is corrupted (partial write, disk full), downstream phases silently consume bad data. A checksum or minimum-size validation at read time would catch this.

---

## Agent Output Quality

### Per-Agent Assessment

| Agent | Model | Prompt Quality | Output Validation | Risk Level |
|-------|-------|---------------|-------------------|------------|
| **Dwight** (Phase 1) | DataForSEO OnPage | N/A (API crawl) | `validateArtifact()` checks size ≥500 bytes + preamble detection | Medium — regex-based AUDIT_REPORT.md parsing in syncDwight is fragile |
| **Strategy Brief** (Phase 1b) | Sonnet | Good — 4-section structure, geo mode guidance, conflict checks | No output validation — writes raw markdown to disk | Medium — downstream agents (Phase 2, Michael, Pam) assume section headers exist |
| **Jim** (Phase 3) | Sonnet | Good — 11-section research narrative with structured data injection | `validateArtifact()` + QA gate | Low — well-validated, QA-gated |
| **Canonicalize** (Phase 3c) | Sonnet | Adequate — batch classification with JSON output | JSON parse with `repairJSON()` fallback | Medium — `repairJSON()` has weak recovery for truncated output |
| **Competitors** (Phase 4) | DataForSEO SERP | N/A (API data) | Minimal | Low — data pass-through |
| **Gap** (Phase 5) | Sonnet | Good — authority + format gaps with structured JSON | QA gate | Low |
| **Michael** (Phase 6) | Sonnet | Good — architecture blueprint with page plan, buyer journey coverage | QA gate | Low |
| **Cluster Strategy** | Opus | Excellent — entity map, buyer journey, recommended pages, format gaps | `extractJsonBySection()` header-based extraction | Medium — `.or()` syntax bug in execution_pages dedup (see Bugs) |
| **Pam** (Brief) | Sonnet | Good — system prompt + SEO playbook + brand voice injection | **No section validation** — writes raw output to DB | High — malformed output silently propagates to Oscar |
| **Oscar** (Content) | Sonnet | Good — HTML extraction with 3-strategy fallback chain | Warns but doesn't fail if `<article>` tag missing | Medium — HTML quality not validated |

### Redundant Reasoning Across Agents

- **Strategy Brief and Michael** both analyze site architecture and competitive positioning. The brief generates "Architecture Directive" which Michael then re-derives from the same inputs. Michael should consume the brief's directive rather than re-analyzing.
- **Jim Section 11 (AI Visibility)** and the standalone **AI Visibility Analysis** both assess AI platform presence. Jim's assessment is inline during the pipeline; the standalone analysis is on-demand. There's no deduplication if both run — `llm_visibility_snapshots` gets written twice with potentially different data.

### QA Gate Coverage Gaps

QA gates exist for Dwight, Jim, Gap, and Michael. **The following agents could silently degrade without QA catching it:**

- **Strategy Brief** (Phase 1b): No QA gate. If Sonnet produces a brief missing the "Keyword Research Directive" section, Phase 2 proceeds without strategic framing. The brief is only $0.06 to regenerate — a QA check would be cheap insurance.
- **Pam** (content briefs): No QA gate. A malformed brief (missing schema section, garbled outline) propagates silently to Oscar, which then produces low-quality HTML. This is the highest-risk gap because content is the final user-facing output.
- **Canonicalize** (Phase 3c): No QA gate. If canonicalization produces duplicate canonical keys or misclassifies entity types, the cluster structure is wrong. The deterministic pre-flight checks (keyword count, cluster/topic ratio) partially mitigate this, but don't catch semantic errors.

---

## Data Model Integrity

### Missing Constraints

**[NEEDS VERIFICATION]** The following observations are based on code analysis and `DATA_CONTRACT.md` review. Live schema verification via `information_schema` queries is recommended before acting on these.

1. **`audit_keywords` lacks a unique constraint on `(audit_id, keyword, source)`.** `syncJim()` uses delete-then-insert rather than upsert, which works but means duplicate keywords can exist if the delete fails and the insert succeeds on retry. A unique constraint would enforce idempotency.

2. **`execution_pages` lacks a unique constraint on `(audit_id, url_slug)`.** The cluster strategy script manually checks for duplicates before inserting (line 519), but the check has a `.or()` syntax bug that may cause it to fail. A database-level constraint would be the correct enforcement point.

3. **`agent_runs` has inconsistent field names across writers.** `run-canonicalize.ts` writes `agent` (not `agent_name`) and `started_at`/`completed_at` (not `run_date`). If the table schema expects `agent_name`, these inserts silently fail or write to wrong columns.

4. **Revenue columns use `numeric` without precision constraints.** `audit_rollups.monthly_revenue_low/mid/high` and `audit_clusters.est_revenue_*` / `tar_revenue_*` are typed as numeric but could accept values with arbitrary precision. For currency, `numeric(12,2)` would be appropriate.

5. **`audit_clusters.status` is a TEXT column, not an ENUM.** Valid values are `inactive`, `active`, `complete`, `hidden`. No CHECK constraint enforces these values. A `text CHECK (status IN (...))` constraint would prevent invalid states.

### RLS Policy Gaps

**[NEEDS VERIFICATION]** Based on code patterns:

- **`keyword_lookups`** has RLS enforced (super_admin only via `has_role` check). Verified in migration 008.
- **`agent_runs`, `agent_technical_pages`, `agent_architecture_pages`, `agent_architecture_blueprint`** — these tables are written by the pipeline using the service role key (bypasses RLS). Dashboard reads them with the anon/user key. If RLS is not configured to allow reads for audit owners, these queries would fail silently (Supabase returns empty arrays, not errors).
- **`audit_coverage_validation`** is written by Phase 6.5 but not read by any dashboard component. If RLS is not configured, this is a low-risk gap (no consumer).
- **`pam_requests` and `oscar_requests`** are read/written by both dashboard and pipeline. RLS should allow the audit owner to insert requests and read their own, while the pipeline service role handles processing status updates.

### Tables Written by Multiple Agents

- **`execution_pages`**: Written by `syncMichael` (Phase 6b), `generate-cluster-strategy.ts` (on-demand), Pam (brief fields), Oscar (HTML content), and dashboard status updates. No conflict resolution pattern exists. If `syncMichael` runs during a re-run while a user is generating briefs via Pam, the delete-then-insert in syncMichael would destroy in-progress brief data.
- **`audit_clusters`**: Written by Phase 3b (initial), Phase 3d (rebuild), `generate-cluster-strategy.ts` (activation), `track-rankings.ts` (authority scores), and dashboard hide/unhide. The rebuild preserves activation status via a savepoint map, but authority scores written by `track-rankings.ts` are lost on rebuild.

---

## Security

### Critical

**SEC-1: Docker container runs as root.** `Dockerfile.railway` has no `USER` directive. The pipeline server and all spawned child processes run as uid 0. If an attacker achieves code execution (e.g., via command injection through a malformed domain name), they have full container access including the ability to read environment variables (API keys, Supabase service role key). **Severity: Critical.** Fix: Add `USER node` after the build step.

**SEC-2: Pipeline server network access — RESOLVED.** Originally the server ran locally with port 3847 exposed via public IP. A Cloudflare Tunnel was implemented as an intermediate fix. Now the server runs on Railway (cloud-hosted) at `https://nanoclaw-production-e8b7.up.railway.app` with HTTPS natively provided. Auth via `PIPELINE_TRIGGER_SECRET` bearer token. No local port exposure, no tunnel required. **Severity: Resolved.**

### High

**SEC-3: Route-level role guards missing in dashboard.** `/scout`, `/scout/new`, `/scout/:id`, `/admin/users`, and `/audits/:id/keyword-lookup` rely on component-level redirects rather than route-level guards. Direct URL navigation can reach these pages before the role check fires, as observed during Playwright testing (Scout redirect race condition). **Severity: High.** Fix: Add `requireRole` prop to `ProtectedRoute` and enforce in `App.tsx` route definitions.

**SEC-4: `canManage` permission includes unauthenticated users.** In `AuthContext.tsx` line 29: `const canManage = userRole === 'super_admin' || userRole === null`. The `|| userRole === null` condition grants manage permissions to users whose role hasn't loaded yet (loading state) and potentially to unauthenticated users. **Severity: High.** Fix: Remove `|| userRole === null`.

**SEC-5: Path injection in scout-config edge function.** The `domain` parameter is passed unchecked to construct a file path: `audits/${domain}/prospect-config.json`. A domain like `../admin/config.json` would traverse directories. The pipeline server validates domains with regex, but the edge function does not validate before constructing the path. **Severity: High.** Fix: Validate domain format in the edge function before passing to pipeline.

**SEC-6: CORS headers set to `Access-Control-Allow-Origin: *` on all edge functions.** Any website can make cross-origin requests to the Supabase edge functions. Combined with the anon key (publicly visible in source), this allows any website to invoke edge functions if they can obtain a valid JWT. **Severity: High.** Fix: Restrict CORS to `app.forgegrowth.ai` and `localhost:8080`.

### Medium

**SEC-7: Single shared secret for all pipeline endpoints.** `TRIGGER_SECRET` provides identical access to `/trigger-pipeline`, `/deactivate-cluster`, `/export-audit`, `/lookup-keywords`, etc. No endpoint-specific scoping. If the secret leaks, an attacker can trigger arbitrary pipeline operations, export all audit data, or run expensive DataForSEO queries.

**SEC-8: DataForSEO credentials in edge function.** `run-competitor-dominance` uses DataForSEO Basic Auth (base64-encoded login:password) directly from Deno environment variables. If edge function logs are exposed or the function response leaks error details, credentials could be visible.

**SEC-9: No rate limiting on any endpoint.** Pipeline server, edge functions, and DataForSEO API calls all lack rate limiting. An attacker (or a bug) could trigger unlimited pipeline runs, keyword lookups, or competitor dominance analyses, running up API costs.

**SEC-10: No audit logging for privileged operations.** `manage-users` edge function creates/deletes users, grants/revokes audit access, and changes roles without logging these actions anywhere. No compliance trail exists for who did what and when.

**SEC-11: Share link passwords not rate-limited.** The `share-audit` edge function's `verify` action accepts unlimited password attempts. While the password is server-generated (8 chars, alphanumeric), there's no lockout or delay after failed attempts.

### Low

**SEC-12: Hardcoded Supabase URL and anon key in dashboard source.** The anon key is public by design (Supabase's model), but hardcoded fallback values in `useShareAudit.ts` (lines 94-95) mean these values persist even if environment variables change.

**SEC-13: Deprecated `generate-report` edge function still callable.** Uses OpenAI API key and has no budget enforcement. Not linked from dashboard UI, but the endpoint exists and is authenticated.

**SEC-14: `handleArtifact` in pipeline server checks for `..` and `/` in filenames but doesn't resolve symlinks.** If an attacker creates a symlink in the `audits/` directory, they could read arbitrary files. Low risk because the attacker would need filesystem access to create the symlink.

---

## Redundancy & Dead Code

### Unused Functions and Imports

| Item | Location | Status |
|------|----------|--------|
| `TruncationError` import | `pipeline-generate.ts` line 32 | Imported but never caught — only `throw new Error()` used |
| `useGenerateReport()` | `useAudits.ts` line 305 | Marked `@deprecated`, 0 call sites |
| `useRecalculateAudit()` | `useAudits.ts` line 325 | Marked `@deprecated`, 0 call sites |
| `getPipelineProgress()` | `useAgentData.ts` | Defined, only 2 references (both possibly dead code paths) |
| `isGuest` derived permission | `AuthContext.tsx` line 30 | Defined, 0 usage sites in codebase |
| `generate-report` edge function | `supabase/functions/generate-report/` | Deprecated, uses OpenAI, not called by dashboard |
| `generate-brief-pdf.py` | `scripts/` | Python script, likely pre-dates TypeScript pipeline |
| `generate-sales-report.py` | `scripts/` | Python script, likely pre-dates TypeScript pipeline |
| `semantic_config.seospiderconfig` | `configs/` | Screaming Frog config from before DataForSEO OnPage replaced it |

### Duplicate Logic

- **Geo normalization** (`normalizeTargetGeos`, `buildPipelineGeos`) is implemented identically in both `useProspects.ts` and `useConvertProspect.ts`. Should be extracted to a shared utility.
- **Domain regex validation** is defined in both `pipeline-server-standalone.ts` (line 34) and edge functions. The patterns are slightly different — the server uses a strict regex while some edge functions don't validate domain format at all.
- **`loadEnv()`** and `process.env` are both used in `pipeline-generate.ts` main(). The function loads from `.env` and falls through to `process.env` on Railway. This dual pattern works but creates confusion about which source takes precedence.

### Legacy Naming Artifacts

- **`lovable-repo/`** directory name: historical artifact from Lovable.dev. Documented in CLAUDE.md. Not confusing since it's documented, but any new developer would wonder.
- **`agent_pipeline_status` vs `status`** on the `audits` table: The pipeline writes to `agent_pipeline_status` (granular: research, architecture, complete) which then maps to `status` (user-facing: running, completed, failed). Both columns exist and are maintained in sync by `update-pipeline-status.ts`. The dual-column pattern works but adds complexity to every status check.

### Stale Migration Files

18 SQL migration files exist in `forge-os-pipeline/scripts/` as loose files (not in the versioned `scripts/migrations/` directory). These appear to be legacy one-off migrations from early development. They should either be moved to the versioned directory with sequence numbers or archived to a `scripts/migrations/archive/` directory to reduce confusion about which migrations are current.

---

## Operational Reliability

### Silent Failure Points

1. **Sync functions return `null` on missing files.** `syncJim()`, `syncDwight()`, and `syncMichael()` all return `null` if the artifact directory doesn't exist, logging a warning but not throwing. The pipeline orchestrator doesn't check these return values. An audit can reach "completed" status even if sync failed to write any data to Supabase. The dashboard then shows empty pages with no explanation of what went wrong.

2. **LLM visibility sync is wrapped in try-catch with no re-throw** (sync-to-dashboard.ts lines 1112-1198). If the `llm_visibility_snapshots` insert fails, the sync continues and reports success. The dashboard shows stale LLM data while new data is missing.

3. **Batch insert failures are not decomposed.** If 1 of 500 keyword rows in a batch insert fails (e.g., constraint violation), the entire batch fails. No fallback to row-by-row insert exists. The error is logged but the sync reports failure for all 500 rows, not just the problematic one.

4. **`repairJSON()` gives up silently.** When JSON repair fails after 4 strategies, it throws `Error('JSON repair failed')` with no context about what input was attempted. The calling code catches this but has no information to diagnose or recover.

### Missing Retry Logic

- **DataForSEO API calls** in `track-rankings.ts` and `track-llm-mentions.ts` have no retry logic. A transient network error fails the entire tracking run. The `cron-track-all.ts` batch runner continues to the next domain but doesn't retry the failed one.
- **Anthropic API calls** in `callClaude()` have no retry logic. A 429 (rate limit) or 529 (overloaded) response fails the phase. The QA gate mechanism provides one implicit retry for QA-gated phases (re-runs on ENHANCE), but non-QA-gated phases (Strategy Brief, Canonicalize, Pam, Oscar) fail permanently.

### `agent_runs` Consistency

`agent_runs` is written by syncDwight, syncMichael, syncJim, track-rankings, track-llm-mentions, ai-visibility-analysis, run-canonicalize, strategy-brief, and generate-cluster-strategy. However:

- **Field name inconsistency:** `run-canonicalize.ts` writes `agent` instead of `agent_name` and `started_at`/`completed_at` instead of `run_date`. These inserts may be going to wrong columns or silently failing.
- **Not all phases log to `agent_runs`.** Phase 1a (verify-dwight), Phase 2 (KeywordResearch), Phase 4 (Competitors), Phase 5 (Gap), and Phase 6.5 (Validator) don't write agent_runs entries. Pipeline state after a failure can only be partially reconstructed from this table.
- **No `failed` status entries.** `agent_runs` only gets written on success. If a phase fails, there's no agent_runs record of the attempt. The only failure signal is `audits.status = 'failed'` and `audits.error_message`.

### Cron Jobs and Background Processes

- **`cron-track-all.ts`** runs weekly via external scheduler (not Railway's built-in cron). It processes all completed audits sequentially with 30-second delays between DataForSEO calls. If the cron job fails silently (scheduler misconfiguration, Railway restart), rankings go stale without any alert.
- **`cron-llm-mentions-all.ts`** exists but its scheduling mechanism isn't documented. It uses a 25-day recency check (vs 6-day for rankings), suggesting monthly runs.
- **No health check beyond `/health` endpoint.** The pipeline server's `/health` endpoint returns server status and in-flight operations, but no external monitoring consumes it. If the server crashes, there's no alert — the next edge function call simply fails with a network error.

### Midnight UTC Edge Case

The pipeline uses `date +%Y-%m-%d` for artifact directory names. If a pipeline run starts at 23:50 UTC and crosses midnight, Phase 1 artifacts go to `2026-03-28/` and Phase 3 artifacts go to `2026-03-29/`. `resolveArtifactPath()` handles this with cross-date fallback, but it's a silent workaround — no logging indicates that artifacts span two dates.

---

## Prospect Intelligence Brief (Section 3.7)

### Current State

Two static HTML intelligence briefs exist at:
- `lovable-repo/public/reports/sma_intelligence_brief.html`
- `lovable-repo/public/reports/ima_intelligence_brief.html`

These are manually produced outside the pipeline and served as static files from Vercel. They represent the intended output of a planned "Scout Narrative" capability — a sales-ready document that synthesizes Scout findings into a prospect-facing intelligence brief.

### Structural Gap Assessment

**Data available post-Scout (Phase 0):**
- `scope.json`: topics, locales, services, gap summary, competitor domains
- `prospect-narrative.md`: 3-section outreach document (business context, visibility snapshot, opportunity framing)
- `ranked_keywords.json`: full keyword ranking data
- `scout_markdown`: research narrative

**Data NOT available until downstream phases:**
- Technical audit findings (Phase 1 Dwight)
- Revenue modeling (Phase 3b sync)
- Architecture recommendations (Phase 6 Michael)
- Content gap analysis (Phase 5)

The static briefs contain technical audit findings and specific revenue projections that would require running the full pipeline, not just Scout. A Scout-only brief would cover competitive positioning and keyword opportunity, but not technical health or site architecture.

### Build Location

**[DECISION REQUIRED]** Two viable paths:

**Option A: Phase 0 output (prospect-mode only, pre-conversion).** Generates after Scout completes. Contains: competitive landscape, keyword opportunity sizing, market position assessment. Missing: technical findings, revenue modeling, architecture recommendations. Suitable for initial prospect engagement.

**Option B: Post-pipeline output (full audit, post-conversion).** Generates after all phases complete. Contains everything from Option A plus technical findings, revenue projections, and implementation roadmap. Suitable for client onboarding document.

**Recommended:** Both, with different depth. Phase 0 produces a "Prospect Intelligence Brief" (competitive + opportunity focus). Post-pipeline produces a "Client Intelligence Brief" (full findings). The template structure is shared; the data injection varies.

### Delivery Model

**[DECISION REQUIRED]** Three options:

1. **Static HTML served from Vercel** (current). Simple, shareable, no auth required. But: manual production, no data binding, stale if audit re-runs.
2. **Dashboard-rendered view.** Dynamic, always current, role-gated. But: requires auth to view, harder to share externally.
3. **Pipeline-generated HTML artifact.** Automated, stored in `audits/{domain}/reports/`, served via `/artifact` endpoint. Shareable via share token. Combines automation with external access.

**Recommended:** Option 3 for the v3.0 model. The pipeline generates the HTML from a template + data injection. The dashboard provides a "Download Report" or "Share Report" action. Share tokens gate external access.

### Template vs. Generation

**[DECISION REQUIRED]**

**Template approach:** Fixed HTML/CSS template with data placeholders (`{{revenue_range}}`, `{{top_keywords_table}}`). Fast rendering, consistent design, no LLM cost. Requires template maintenance when new data fields are added.

**Generation approach:** Claude produces the full report from data + design constraints. More flexible, can adapt narrative tone to client context. Costs ~$0.06 per report (Sonnet). Risk of inconsistent visual design.

**Recommended:** Template with data injection for the structured sections (charts, tables, metrics) and a single Sonnet call for the narrative sections (executive summary, opportunity analysis). This hybrid approach controls cost (~$0.06) while allowing the narrative to adapt to each client's context.

### Automation Trigger

**[DECISION REQUIRED]** At what client volume does manual production become the constraint?

At the current pace (~2 audits/week), manual production is feasible but increasingly burdensome. The break-even point for pipeline integration is approximately **5-10 active clients** — at that volume, the time spent manually producing and updating reports exceeds the time to build and maintain the automated pipeline.

Given that the system already has 8 completed audits and appears to be in active use, **the trigger for pipeline integration is now**. The manual production of the SMA and IMA briefs should be the last manually produced reports.

---

## Summary Risk Register

| # | Finding | Severity | Category | Affected Component |
|---|---------|----------|----------|-------------------|
| SEC-1 | Docker container runs as root | **Critical** | Security | `Dockerfile.railway` |
| SEC-2 | Pipeline server network access — **RESOLVED** (Railway direct URL) | ~~Critical~~ Resolved | Security | `pipeline-server-standalone.ts`, Railway config |
| SEC-3 | Route-level role guards missing | **High** | Security | `App.tsx`, `ProtectedRoute.tsx` |
| SEC-4 | `canManage` includes unauthenticated users | **High** | Security | `AuthContext.tsx` |
| SEC-5 | Path injection in scout-config edge function | **High** | Security | `scout-config/index.ts` |
| SEC-6 | CORS `*` on all edge functions | **High** | Security | All edge functions |
| DATA-1 | Sync functions silently skip on missing files | **High** | Reliability | `sync-to-dashboard.ts` |
| DATA-2 | Batch insert failures not decomposed | **High** | Reliability | `sync-to-dashboard.ts` |
| DATA-3 | `execution_pages` lacks unique constraint on `(audit_id, url_slug)` | **High** | Data Integrity | Supabase schema |
| DATA-4 | Cluster rebuild can orphan activation state | **High** | Data Integrity | `rebuildClustersAndRollups()` |
| BUG-1 | `.or()` syntax bug in cluster strategy dedup | **High** | Bug | `generate-cluster-strategy.ts:519`, `run-canonicalize.ts:174` |
| UX-1 | Clusters page shows 0 keywords on completed audit | **High** | UX | `ClustersPage.tsx`, cluster query logic |
| SEC-7 | Single shared secret for all endpoints | **Medium** | Security | `pipeline-server-standalone.ts` |
| SEC-8 | DataForSEO creds in edge function | **Medium** | Security | `run-competitor-dominance/index.ts` |
| SEC-9 | No rate limiting anywhere | **Medium** | Security | All endpoints |
| SEC-10 | No audit logging for privileged ops | **Medium** | Security | `manage-users/index.ts` |
| SEC-11 | Share passwords not rate-limited | **Medium** | Security | `share-audit/index.ts` |
| DATA-5 | `agent_runs` field name inconsistency | **Medium** | Data Integrity | `run-canonicalize.ts` |
| DATA-6 | No retry logic for DataForSEO/Anthropic API calls | **Medium** | Reliability | Multiple scripts |
| DATA-7 | Revenue columns lack precision constraints | **Medium** | Data Integrity | Supabase schema |
| DATA-8 | `audit_clusters.status` is unconstrained TEXT | **Medium** | Data Integrity | Supabase schema |
| QUAL-1 | Pam output has no section validation | **Medium** | Quality | `generate-brief.ts` |
| QUAL-2 | Strategy Brief has no QA gate | **Medium** | Quality | `strategy-brief.ts` |
| QUAL-3 | 60+ `(supabase as any)` casts in dashboard | **Medium** | Maintainability | Dashboard hooks |
| OPS-1 | No disk artifact cleanup/retention | **Medium** | Operations | Pipeline server |
| OPS-2 | No external health monitoring | **Medium** | Operations | Pipeline server |
| OPS-3 | Cron job failures have no alerting | **Medium** | Operations | `cron-track-all.ts` |
| UX-2 | Sidebar green dots lack legend/tooltip | **Low** | UX | `AuditSidebar.tsx` |
| UX-3 | Agentic Readiness Score always shows "—" | **Low** | UX | `OverviewPage.tsx` |
| UX-4 | No bulk brief generation | **Low** | UX | `ExecutionPage.tsx` |
| UX-5 | Content queue lacks priority indicators | **Low** | UX | `ExecutionPage.tsx` |
| CODE-1 | Deprecated hooks retained | **Low** | Maintainability | `useAudits.ts` |
| CODE-2 | Stale migration files in scripts/ | **Low** | Maintainability | `forge-os-pipeline/scripts/*.sql` |
| CODE-3 | Python scripts likely dead | **Low** | Maintainability | `scripts/*.py` |

---

*Forge OS v3.0 System Review — Completed 2026-03-28*
