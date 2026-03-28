# Forge OS v3.0 Execution Plan

> **Generated:** 2026-03-28
> **Updated:** 2026-03-28 (owner feedback incorporated)
> **Source:** `docs/REVIEW_v3.md` (35-finding system review)
> **Sizing:** Each session is scoped for a single Claude Code context window (~100K tokens of working memory). Sessions average 2-4 files changed, with explicit completion criteria.
>
> **Decisions resolved:**
> - SEC-2: Cloudflare Tunnel (not Railway private networking)
> - Brief build location: Phase 0 prospect-mode first (Option A), post-pipeline version deferred
> - UX-3 (Agentic Readiness Score): Remove the card, don't compute a placeholder metric
> - Session 10 dependency relaxed: can run after Session 3 (schema), not gated on Sessions 4-6
> - Pre-Session 8 gate: verify `client_context` write path (Settings → audits.client_context → pipeline) is reliable

---

## Sequencing Principles

1. **Security before features.** Critical and high-severity security findings (SEC-1 through SEC-6) are addressed first. A system with root containers and path injection vulnerabilities should not receive new functionality until the attack surface is reduced.

2. **Schema integrity before application logic.** Missing database constraints (DATA-3, DATA-5, DATA-7, DATA-8) are applied before changing the code that writes to those tables. This prevents new code from inheriting old schema weaknesses.

3. **Bug fixes before new features.** Known bugs (BUG-1 `.or()` syntax, SEC-4 `canManage`) are fixed before adding new capabilities that would build on broken foundations.

4. **Backend reliability before frontend polish.** Sync failure handling (DATA-1, DATA-2), retry logic (DATA-6), and operational visibility (OPS-1 through OPS-3) are addressed before UX improvements. A beautiful dashboard displaying incorrect data is worse than an ugly dashboard displaying correct data.

5. **Structural improvements before output quality.** Code cleanup (dead code removal, type safety) is done before agent prompt improvements, because prompt changes require testing and the codebase should be clean before that testing cycle begins.

6. **UX improvements last.** Dashboard information architecture changes (UX-1 through UX-5) come after the data they display is reliable.

---

## Group 1 — Critical Security Fixes

### Session 1 — Container Security & Network Hardening

**Scope:** Fix Docker root execution (SEC-1) and document the network access control path (SEC-2).

**Depends on:** None

**Files affected:**
- `forge-os-pipeline/Dockerfile.railway`
- `forge-os-pipeline/docs/PIPELINE.md` (network security section update)

**Work:**
- Add a non-root user to `Dockerfile.railway`: create `appuser` with a fixed UID, `chown` the app directory, add `USER appuser` after the build step. Ensure the `audits/` volume mount directory is writable by the new user.
- Verify that `run-pipeline.sh` and all spawned child processes function correctly without root (no `/root/` path dependencies, no privileged port bindings — port 3847 is unprivileged).
- For SEC-2, document in `PIPELINE.md` the concrete steps to implement Cloudflare Tunnel. **Decision: Cloudflare Tunnel** — stable hostname, zero infrastructure cost, removes ISP dependency permanently. This is an infrastructure change, not a code change, so the session produces the runbook rather than the implementation.

**Definition of done:** `docker build` succeeds with the new Dockerfile. Container starts, `/health` responds, and a test pipeline trigger works. No process runs as uid 0 inside the container.

---

### Session 2 — Auth & RBAC Hardening (Dashboard)

**Scope:** Fix `canManage` bug (SEC-4), add route-level role guards (SEC-3), and restrict CORS on edge functions (SEC-6).

**Depends on:** None (independent of Session 1)

**Files affected:**
- `lovable-repo/src/contexts/AuthContext.tsx`
- `lovable-repo/src/App.tsx`
- `lovable-repo/src/components/auth/ProtectedRoute.tsx`
- All Supabase edge functions (CORS header change)

**Work:**
- **SEC-4:** Remove `|| userRole === null` from `canManage` in `AuthContext.tsx`. Replace with explicit loading state handling — `canManage` should be `false` while `isLoading` is true, `true` only when `userRole === 'super_admin'`.
- **SEC-3:** Add a `requireRole` prop to `ProtectedRoute`. Apply it to route definitions in `App.tsx`: `/scout/*` requires `super_admin` or `admin`, `/admin/users` requires `super_admin`, `/audits/:id/keyword-lookup` requires `super_admin`. Show a "Not authorized" page (not a redirect) when role check fails after loading completes.
- **SEC-6:** Update CORS headers in all 10 edge functions from `Access-Control-Allow-Origin: *` to `Access-Control-Allow-Origin: https://app.forgegrowth.ai`. Add `http://localhost:8080` as an allowed origin for development (check `Deno.env.get('ENVIRONMENT')` or use a list).
- **SEC-5:** Add domain format validation in `scout-config` edge function before passing to pipeline. Reject domains containing `..`, `/`, or characters outside `[a-zA-Z0-9.-]`.

**Definition of done:** Direct URL navigation to `/scout` without login shows "Not authorized" (not a redirect loop). `canManage` is `false` during loading state. CORS preflight from a third-party origin to any edge function is rejected. Path traversal `domain=../admin/config` in scout-config returns 400.

---

## Group 2 — Schema Integrity

### Session 3 — Database Constraints & Field Fixes

**Scope:** Add missing unique constraints (DATA-3), fix `agent_runs` field names (DATA-5), add CHECK constraints (DATA-8), and tighten revenue column precision (DATA-7).

**Depends on:** None

**Files affected:**
- `forge-os-pipeline/scripts/migrations/009-schema-integrity.sql` (new migration)
- `forge-os-pipeline/scripts/run-canonicalize.ts` (fix agent_runs field names)

**Work:**
- Write migration `009-schema-integrity.sql`:
  - `ALTER TABLE execution_pages ADD CONSTRAINT uq_execution_pages_audit_slug UNIQUE (audit_id, url_slug);` — verify no existing duplicates first with a pre-check query.
  - `ALTER TABLE audit_clusters ADD CONSTRAINT chk_cluster_status CHECK (status IN ('inactive', 'active', 'complete', 'hidden'));` — verify all existing values are in the allowed set.
  - Fix `agent_runs` insert in `run-canonicalize.ts`: change `agent` → `agent_name`, `started_at`/`completed_at` → correct column names (verify against live schema).
  - `ALTER TABLE audit_rollups ALTER COLUMN monthly_revenue_low TYPE numeric(12,2);` (and similar for `_mid`, `_high`). Repeat for `audit_clusters.est_revenue_*` and `tar_revenue_*`.
- **Pre-flight:** Query `information_schema.columns` to verify exact column names in `agent_runs` before writing the code fix.
- **Pre-flight:** Query for existing duplicate `(audit_id, url_slug)` pairs in `execution_pages` and resolve them before adding the constraint.

**Definition of done:** Migration applies cleanly. `agent_runs` inserts from `run-canonicalize.ts` write to correct columns (verify with a test insert). No existing data violates the new constraints.

---

## Group 3 — Bug Fixes

### Session 4 — Fix .or() Syntax & Sync Failure Handling

**Scope:** Fix `.or()` Supabase filter bug (BUG-1), fix sync silent failures (DATA-1), and add batch insert decomposition (DATA-2).

**Depends on:** Session 3 (schema constraints in place)

**Files affected:**
- `forge-os-pipeline/scripts/generate-cluster-strategy.ts` (line ~519)
- `forge-os-pipeline/scripts/run-canonicalize.ts` (line ~174)
- `forge-os-pipeline/scripts/sync-to-dashboard.ts` (syncJim, syncDwight, syncMichael, rebuildClustersAndRollups)

**Work:**
- **BUG-1:** Fix `.or()` syntax in both files. The current filter likely uses `.or('field.eq.value1,field.eq.value2')` string format where it should use the PostgREST filter syntax correctly. Read the current code, verify the intended behavior, and fix the filter expression. Test with a cluster that has existing execution_pages to confirm dedup works.
- **DATA-1:** Change `syncJim()`, `syncDwight()`, `syncMichael()` to throw on missing artifact directories instead of returning `null`. The calling code in `pipeline-generate.ts` already has try/catch — the throws will be caught and reported. Add an explicit `agent_runs` entry with `status: 'failed'` when sync fails.
- **DATA-2:** Add batch insert decomposition to `syncJim()`: if the batch insert for `audit_keywords` fails, fall back to row-by-row insert. Log each individual failure. Report the count of successful vs. failed inserts. Apply the same pattern to `rebuildClustersAndRollups()` for `audit_clusters` inserts.
- **DATA-4:** In `rebuildClustersAndRollups()`, log a warning when a saved activation status cannot be restored because the canonical key no longer exists. Write the orphaned activations to `agent_runs` metadata for audit trail.

**Definition of done:** A cluster strategy generation with existing execution_pages correctly deduplicates (no constraint violation). A sync run with a missing artifact directory throws and is logged. A batch insert with one bad row succeeds for the other rows and reports the failure.

---

## Group 4 — Operational Reliability

### Session 5 — Retry Logic & API Resilience

**Scope:** Add retry logic for Anthropic and DataForSEO API calls (DATA-6), and improve `repairJSON()` diagnostics.

**Depends on:** None

**Files affected:**
- `forge-os-pipeline/scripts/anthropic-client.ts`
- `forge-os-pipeline/scripts/track-rankings.ts`
- `forge-os-pipeline/scripts/track-llm-mentions.ts`
- `forge-os-pipeline/scripts/pipeline-generate.ts` (repairJSON)

**Work:**
- Add retry logic to `callClaude()` in `anthropic-client.ts`: retry on 429 (rate limit) and 529 (overloaded) with exponential backoff (1s, 4s, 16s). Max 3 attempts. Log each retry. Do not retry on 400 (bad request) or 401 (auth).
- Add retry logic to DataForSEO HTTP calls in `track-rankings.ts` and `track-llm-mentions.ts`: retry on 5xx and network errors with 3 attempts and exponential backoff. Do not retry on 4xx.
- Improve `repairJSON()` in `pipeline-generate.ts`: when all 4 repair strategies fail, include the first 200 characters of the input in the error message for diagnostics. Also log the attempted repair strategies and which ones partially succeeded.

**Definition of done:** A transient 429 from Anthropic is retried and succeeds on the second attempt (verify with logs). A DataForSEO timeout is retried. `repairJSON()` failures include diagnostic context in the error.

---

### Session 6 — Operational Visibility

**Scope:** Add health monitoring scaffolding (OPS-2), cron failure alerting (OPS-3), and disk cleanup policy (OPS-1).

**Depends on:** None

**Files affected:**
- `forge-os-pipeline/src/pipeline-server-standalone.ts` (`/health` enhancement)
- `forge-os-pipeline/scripts/cron-track-all.ts`
- `forge-os-pipeline/scripts/cron-llm-mentions-all.ts`
- `forge-os-pipeline/scripts/disk-cleanup.ts` (new file)

**Work:**
- **OPS-2:** Enhance `/health` endpoint to include: last successful pipeline run timestamp (from `agent_runs`), last cron execution time, disk usage of `audits/` directory, count of in-flight operations. This gives an external monitoring tool (UptimeRobot, Railway's health checks, or a simple curl-based monitor) enough signal to detect degradation.
- **OPS-3:** Add error reporting to `cron-track-all.ts` and `cron-llm-mentions-all.ts`: after processing all domains, if any failed, write a summary to `agent_runs` with `agent_name: 'cron-rankings'` / `'cron-llm-mentions'` and `status: 'partial_failure'` with the failed domains in metadata. This makes cron failures visible from the dashboard (if `agent_runs` is ever surfaced) and queryable from Supabase.
- **OPS-1:** Create `scripts/disk-cleanup.ts`: for each domain in `audits/`, retain the 3 most recent date-stamped directories per category (auditor, research, architecture, scout, content). Delete older directories. Add a `--dry-run` flag that logs what would be deleted without deleting. Wire this into `cron-track-all.ts` to run after the weekly tracking pass.

**Definition of done:** `/health` returns last pipeline run time and disk usage. Cron jobs with intentional failures write failure records to `agent_runs`. `disk-cleanup.ts --dry-run` lists directories that would be removed.

---

## Group 5 — Code Quality & Dead Code Removal

### Session 7 — Dead Code Cleanup & Type Safety

**Scope:** Remove deprecated code (CODE-1, CODE-2, CODE-3), remove unused permissions (SEC-13), and address type safety (QUAL-3 partial).

**Depends on:** Sessions 1-4 (security and bug fixes should be stable before cleanup)

**Files affected:**
- `lovable-repo/src/hooks/useAudits.ts` (remove deprecated hooks)
- `lovable-repo/src/contexts/AuthContext.tsx` (remove `isGuest`)
- `forge-os-pipeline/scripts/` (archive stale SQL files, remove Python scripts)
- `supabase/functions/generate-report/` (remove deprecated edge function)

**Work:**
- **CODE-1:** Remove `useGenerateReport()` and `useRecalculateAudit()` from `useAudits.ts`. Verify no import references remain.
- Remove `isGuest` from `AuthContext.tsx`. Verify no consumers.
- **CODE-3:** Delete `scripts/generate-brief-pdf.py` and `scripts/generate-sales-report.py`. These are Python scripts from before the TypeScript pipeline.
- **CODE-2:** Move the 18 loose SQL migration files in `scripts/` (not in `scripts/migrations/`) to `scripts/migrations/archive/`. This preserves history without cluttering the active scripts directory.
- **SEC-13:** Delete the `generate-report` edge function or add `throw new Error('Deprecated')` at the top. Remove any references to it in the codebase.
- **QUAL-3 (partial):** Regenerate Supabase types. Run `supabase gen types typescript --linked` to produce fresh types reflecting all migrations through 009. Replace the local types file. This will resolve a portion of the `(supabase as any)` casts by providing correct column types. Remaining casts that reference columns added after the last type generation will resolve automatically.

**Definition of done:** No deprecated hooks imported anywhere. No Python scripts in `scripts/`. Stale migrations archived. `generate-report` edge function removed or disabled. TypeScript compilation (`npx tsc --noEmit`) passes in both repos after type regeneration.

---

## Group 6 — Agent Output Quality

> **Pre-Session 8 gate:** Before starting this group, verify the `client_context` write path is reliable: Settings page → `audits.client_context` JSONB → `loadClientContextAsync()` in pipeline. Strategy Brief and Jim both depend on this data path. If the write path has bugs, fix them before touching agent quality.

### Session 8 — QA Gates for Ungated Agents

**Scope:** Add QA gates for Strategy Brief (QUAL-2) and Pam (QUAL-1). Add output section validation for Phase 1b.

**Depends on:** Session 5 (retry logic in place so QA-triggered re-runs don't fail on transient errors). Pre-gate: `client_context` write path verified.

**Files affected:**
- `forge-os-pipeline/scripts/pipeline-generate.ts` (QA rubrics)
- `forge-os-pipeline/scripts/run-pipeline.sh` (QA gate for Phase 1b)
- `forge-os-pipeline/scripts/generate-brief.ts` (section validation)

**Work:**
- **QUAL-2:** Add a QA rubric for Strategy Brief in `QA_RUBRICS`. Check for: presence of all 4 expected section headers (Visibility Posture, Keyword Research Directive, Architecture Directive, Risk Flags), minimum word count per section (50 words), and absence of conversational preamble. Wire the QA gate into `run-pipeline.sh` after Phase 1b. On ENHANCE, re-run Phase 1b. On FAIL, halt with error (Strategy Brief is upstream-critical — a bad brief cascades).
- **QUAL-1:** Add section validation to `generate-brief.ts` (Pam). After parsing the Claude response, verify that the three expected sections (metadata, schema, outline) are present and non-empty. If any section is missing, log the error, set `pam_requests.status` to `'failed'` with a descriptive error message, and do not write the incomplete brief to `execution_pages`. This prevents Oscar from consuming a malformed brief.
- Add section header validation to `strategy-brief.ts`: after generating `strategy_brief.md`, verify all 4 expected headers exist. Log a warning if any are missing (do not fail the phase — the QA gate handles that).

**Definition of done:** A Strategy Brief missing the "Architecture Directive" section triggers ENHANCE and is re-generated. A Pam brief with a missing schema section results in `pam_requests.status = 'failed'` (not a silent write). Section validation logs are visible in pipeline output.

---

### Session 9 — Reduce Redundant Agent Reasoning

**Scope:** Eliminate duplicate analysis between Strategy Brief and Michael (redundant architecture analysis), and add dedup logic between Jim's AI Visibility and the standalone AI Visibility Assessment.

**Depends on:** Session 8 (QA gates ensure output quality before optimizing prompts)

**Files affected:**
- `forge-os-pipeline/scripts/pipeline-generate.ts` (Michael prompt)
- `forge-os-pipeline/scripts/ai-visibility-analysis.ts`
- `forge-os-pipeline/scripts/sync-to-dashboard.ts` (LLM visibility dedup)

**Work:**
- **Michael prompt optimization:** Michael currently receives `strategy_brief.md` but re-derives architecture analysis from raw inputs. Modify Michael's prompt to explicitly consume the Strategy Brief's "Architecture Directive" section as a given starting point rather than re-analyzing. Add an instruction: "The Architecture Directive below is pre-validated. Build on it — do not re-derive the competitive positioning or structural gaps it describes." This reduces prompt tokens and output redundancy.
- **AI Visibility dedup:** When `ai-visibility-analysis.ts` runs, check if `llm_visibility_snapshots` already has entries for this audit from today's date (written by Jim's Phase 3 sync). If so, skip the Jim-equivalent portion of the analysis and only produce the standalone-specific outputs (structural gaps analysis, recommendations). Log the dedup decision.
- **Jim Section 11 / AI Visibility interaction:** Add a note in `PIPELINE.md` documenting the overlap and the dedup behavior, so future developers understand why the standalone analysis skips certain work when Jim data exists.

**Definition of done:** Michael's output no longer contains a "Competitive Positioning" section that duplicates the Strategy Brief. Running AI Visibility Analysis after a full pipeline skips duplicate snapshot writes. PIPELINE.md documents the dedup behavior.

---

## Group 7 — New Functionality

### Session 10 — Prospect Intelligence Brief Automation

**Scope:** Automate the production of prospect intelligence briefs currently produced manually as static HTML (Section 3.7 findings).

**Depends on:** Session 3 (schema integrity). Isolated code path — does not touch sync, retry, or monitoring infrastructure being fixed in Sessions 4-6.

**Files affected:**
- `forge-os-pipeline/scripts/generate-prospect-brief.ts` (new)
- `forge-os-pipeline/src/pipeline-server-standalone.ts` (new endpoint)
- `forge-os-pipeline/scripts/run-pipeline.sh` (optional: add as Phase 0 output)
- `supabase/functions/pipeline-controls/index.ts` (new action)
- Template HTML file (new)

**Work:**
- Create `scripts/generate-prospect-brief.ts`:
  - Input: Scout data (`scope.json`, `prospect-narrative.md`, `ranked_keywords.json`) + client context
  - Output: HTML intelligence brief in `audits/{domain}/reports/prospect_brief.html`
  - Approach: Phase 0 prospect-mode only (Option A). HTML template with data injection for structured sections (keyword tables, competitor grids, metrics cards) + single Sonnet call (~$0.06) for narrative sections (executive summary, opportunity analysis). Post-pipeline client brief deferred to Session 11.
  - Template derived from the existing SMA/IMA briefs as the design baseline
- Add `/generate-prospect-brief` endpoint to pipeline server (or extend `/trigger-pipeline` with a mode flag)
- Add `generate_prospect_brief` action to `pipeline-controls` edge function
- Wire into Scout flow: after Phase 0 completes, auto-generate the brief if prospect-config includes the flag
- Serve via existing `/artifact` endpoint (already supports file serving from `audits/{domain}/`)

**Definition of done:** Running Scout for a new prospect automatically produces an HTML intelligence brief. The brief is accessible via `/artifact` endpoint and shareable via the existing share token mechanism. Visual quality matches the existing SMA/IMA briefs.

---

### Session 11 — Post-Pipeline Client Intelligence Brief

**Scope:** Extend the brief system from Session 10 to produce a comprehensive post-pipeline "Client Intelligence Brief" using full audit data.

**Depends on:** Session 10 (prospect brief template and infrastructure)

**Files affected:**
- `forge-os-pipeline/scripts/generate-client-brief.ts` (new)
- `forge-os-pipeline/scripts/run-pipeline.sh` (add as post-Phase 6d step)
- Template HTML file (new, extends prospect template)

**Work:**
- Create `scripts/generate-client-brief.ts`:
  - Input: All pipeline artifacts (Dwight audit report, Jim research, Michael architecture, keyword data, revenue modeling, local presence data)
  - Output: Full HTML intelligence brief in `audits/{domain}/reports/client_brief.html`
  - Extends the prospect brief template with additional sections: Technical Health Summary, Revenue Opportunity Detail, Architecture Recommendations, Content Strategy Overview, Local Presence Assessment
  - Single Sonnet call for narrative synthesis (~$0.06-0.10)
- Wire into `run-pipeline.sh` as the final step after Phase 6d (non-fatal — pipeline success doesn't depend on brief generation)
- Add dashboard "Download Report" button on Overview page linking to the `/artifact` endpoint

**Definition of done:** A completed full-pipeline audit produces an HTML client brief. The brief includes all major pipeline findings. The Overview page has a "Download Report" action that serves the brief.

---

## Group 8 — UX/UI Improvements

### Session 12 — Clusters Page Fix & Sidebar Indicators

**Scope:** Fix Clusters page showing 0 keywords (UX-1) and add legend/tooltips for sidebar indicators (UX-2).

**Depends on:** Session 4 (sync reliability fixes — UX-1 may be a data issue)

**Files affected:**
- `lovable-repo/src/pages/audit/ClustersPage.tsx`
- `lovable-repo/src/hooks/useClusterFocus.ts` (or `useAgentData.ts`)
- `lovable-repo/src/components/layout/AuditSidebar.tsx`

**Work:**
- **UX-1:** Investigate why `keyword_count` shows 0 on completed audits. Likely causes: (a) the query filters by `cluster_active` which excludes inactive clusters, (b) `keyword_count` is not populated during Phase 3d rebuild, (c) the dashboard query doesn't join `audit_keywords` correctly. Read the cluster query in the hooks, trace the data path, and fix. Add empty state messaging that distinguishes "no clusters yet" from "clusters exist but have no keywords" from "pipeline completed but cluster data not synced."
- **UX-1 (button state):** Fix the "Generating..." button state on clusters that were never activated. `useClusterStrategyPoll` should not return an in-progress state for clusters that don't have a pending strategy generation.
- **UX-2:** Add a tooltip to the green/gray dots in `AuditSidebar.tsx`: green = "Data available", gray = "Not yet available". Add a small legend at the bottom of the sidebar nav group: "● = data ready".

**Definition of done:** Clusters page on a completed audit shows correct keyword counts. "Activate" button (not "Generating...") appears on inactive clusters. Sidebar dots have tooltips explaining their meaning.

---

### Session 13 — Overview & Research Page Polish

**Scope:** Fix Agentic Readiness Score placeholder (UX-3), add content priority indicators (UX-5), and Research page code maintenance.

**Depends on:** Session 12 (data display fixes first)

**Files affected:**
- `lovable-repo/src/pages/audit/OverviewPage.tsx`
- `lovable-repo/src/pages/audit/ExecutionPage.tsx`
- `lovable-repo/src/pages/audit/ResearchPage.tsx` (optional refactor if context allows)

**Work:**
- **UX-3:** Remove the Agentic Readiness Score card from Overview. Placeholder metrics undermine dashboard credibility with clients. Do not compute a substitute metric — just remove the card and let the remaining 8 scorecard items fill the grid.
- **UX-5:** Add a priority indicator to content queue cards in `ExecutionPage.tsx`. Priority derived from: cluster authority score (lower = higher priority), buyer stage (awareness > consideration > decision for new sites), and keyword volume. Show as a colored badge or sort order.
- **UX-4 (if context allows):** Add a "Generate All Briefs" bulk action button to `ExecutionPage.tsx` that triggers Pam for all `not_started` pages in the current filter. This sends multiple `pam_requests` inserts in one action.
- **Research page (optional):** If context remains, extract the three tab contents (Rankings, Revenue, Competition) from the 63.8KB `ResearchPage.tsx` into separate components. This is maintenance-only — no user-visible change.

**Definition of done:** Overview page shows a meaningful metric (or no placeholder) where "Agentic Readiness Score —" was. Content queue cards show visual priority distinction. Bulk brief generation (if implemented) triggers multiple Pam requests.

---

### Session 14 — Settings Reorganization & Scout Polish

**Scope:** Improve Settings page visual separation (S6 finding), fix Scout dashboard icon-only buttons (S8), and clean up Scout report raw JSON (M15).

**Depends on:** None (independent of other sessions, but lower priority)

**Files affected:**
- `lovable-repo/src/pages/audit/AuditSettings.tsx`
- `lovable-repo/src/pages/ScoutDashboard.tsx`
- `lovable-repo/src/pages/ScoutReport.tsx`

**Work:**
- **Settings (S6):** Add visual section separators between configuration sections (Client Context, NAP, Revenue Assumptions) and operational sections (Pipeline Controls, Danger Zone). Use a horizontal rule or card grouping with section headers ("Configuration" / "Operations" / "Danger Zone"). Pipeline Controls should have a subtle warning background. Danger Zone should have a destructive-action visual treatment (red border or background).
- **Scout (S8):** Add tooltips to the 5 icon-only buttons on `ScoutDashboard.tsx`. Tooltips: "Run Scout", "View Report", "Share", "Convert to Audit", "Delete". Consider grouping "Delete" under a `...` overflow menu to separate destructive from productive actions.
- **Scout report (M15):** If `ScoutReport.tsx` renders raw JSON for the scope block, wrap it in a formatted display component (key-value table or structured card) instead of showing raw `JSON.stringify` output.

**Definition of done:** Settings page has clear visual separation between config and operations. Scout buttons have descriptive tooltips. Scout report does not display raw JSON to users.

---

## Dependency Graph

```
Session 1  (Container Security)    ─┐
Session 2  (Auth & RBAC)           ─┤── parallel (no deps)
Session 3  (Schema Integrity)      ─┤
                                    │
                                    ├─→ Session 4  (Bug Fixes)
                                    │         │
Session 5  (Retry Logic)          ─┤         ├─→ Session 8  (QA Gates) [gate: verify client_context]
Session 6  (Operational Visibility)┤         │         │
                                    │         │         └─→ Session 9  (Agent Optimization)
                                    │         │
                                    ├─────────┴─→ Session 7  (Dead Code Cleanup)
                                    │
Session 3 ─────────────────────────→ Session 10 (Prospect Brief)
                                           │
                                           └─→ Session 11 (Client Brief)

Session 4  ────────────────────────→ Session 12 (Clusters + Sidebar UX)
                                           │
                                           └─→ Session 13 (Overview + Research UX)

Independent: Session 14 (Settings + Scout UX)
```

---

## Summary

| Group | Sessions | Finding Coverage | Risk Reduction |
|-------|----------|-----------------|----------------|
| 1. Critical Security | 1-2 | SEC-1 through SEC-6 | Eliminates root execution, path injection, auth bypass, CORS exposure |
| 2. Schema Integrity | 3 | DATA-3, DATA-5, DATA-7, DATA-8 | Prevents duplicate data, enforces valid states |
| 3. Bug Fixes | 4 | BUG-1, DATA-1, DATA-2, DATA-4 | Fixes silent failures, broken filters, data loss paths |
| 4. Operational Reliability | 5-6 | DATA-6, OPS-1, OPS-2, OPS-3 | Adds retry logic, health monitoring, disk management |
| 5. Code Quality | 7 | CODE-1, CODE-2, CODE-3, SEC-13, QUAL-3 | Removes dead code, improves type safety |
| 6. Agent Quality | 8-9 | QUAL-1, QUAL-2, redundant reasoning | Adds QA gates, validates output structure |
| 7. New Functionality | 10-11 | Section 3.7 (Prospect Intelligence Brief) | Automates manual report production |
| 8. UX/UI | 12-14 | UX-1 through UX-5, S6, S8, M15 | Fixes data display, adds workflow guidance |

**Total sessions:** 14
**Critical path:** Sessions 1-4 → 7-9 (security → schema → bugs → cleanup → quality)
**Parallel tracks:** Sessions 5-6 run alongside 1-4. Sessions 12-14 run after Session 4.

---

*Forge OS v3.0 Execution Plan — Generated 2026-03-28*
