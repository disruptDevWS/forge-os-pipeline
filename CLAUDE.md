# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Session Start

**At the start of every new session**, read these documents before doing any work:
1. [docs/PIPELINE.md](docs/PIPELINE.md) — authoritative phase contract (who owns what data, trigger paths, Supabase table ownership)
2. [docs/DECISIONS.md](docs/DECISIONS.md) — why non-obvious choices were made (check here before "fixing" something)
3. [docs/DATA_CONTRACT.md](docs/DATA_CONTRACT.md) — every Supabase table, who writes it (pipeline), who reads it (dashboard), column-level ownership, edge function contracts, and known mismatches

These documents are the source of truth. If a phase responsibility changes, update PIPELINE.md in the same commit. If a non-obvious choice is made, add an entry to DECISIONS.md. If a table, column, edge function, or sync pattern changes, update DATA_CONTRACT.md in the same commit.

## Session End

Before ending a session, execute this checklist:

1. **Update MEMORY.md** with what was accomplished this session, what's in progress, and what's blocked.
2. **Update PIPELINE.md** — review every section touched by this session's work. PIPELINE.md is the authoritative contract for the pipeline's behavior. If any phase, trigger path, Supabase write, CLI flag, external API, mode, threshold, or data flow changed, PIPELINE.md must reflect it before the session ends. Stale documentation causes bugs in future sessions.
3. **Update DECISIONS.md** with any non-obvious architectural choices made this session.
4. **Update DATA_CONTRACT.md** with any new/changed tables, columns, edge functions, or sync patterns.
5. **Commit and push everything** including docs. Never leave uncommitted work.
6. **List the top 3 things to start with next session** so the user has a clear handoff.

## Quick Context

Forge OS is an **SEO audit pipeline toolkit**. Dashboard buttons trigger Supabase Edge Functions, which POST to a Node.js HTTP server on Railway, which spawns a shell orchestrator that runs TypeScript phase generators, then syncs results back to Supabase tables for the dashboard to display.

## Project Structure

- This is a multi-repo project. Primary repos: Forge OS pipeline (TypeScript/Shell agents), Forge OS dashboard (Next.js/Supabase), and a WordPress marketing site.
- Key agents: Dwight (audit), Scout (research), Oscar (content), Pam (SERP enrichment), Michael (architecture).
- Always confirm which repo context you're working in before making changes.

## Workflow Mode

- When I say 'plan' or ask for a plan, stay in planning mode. Do NOT begin implementation unless I explicitly say 'implement', 'build it', 'do it', or similar. Always confirm before switching from planning to implementation.

## Git Discipline

- Always commit and push completed work before ending a session. Never wait to be asked.
- After committing, confirm the commit hash and branch name.

## Debugging Approach

- When diagnosing a bug, ask the user to confirm the root cause hypothesis before implementing a fix. Do not assume the first plausible explanation is correct.
- When a user redirects the debugging direction, fully abandon the prior hypothesis.

## SQL & Database Changes

- **Before writing any SQL migration**, run a live verification query against the Supabase database to confirm that all referenced tables, columns, enums, and functions actually exist. Use `supabase db query --linked` with `information_schema` queries. Never assume database objects exist from a plan or from code — always verify against the live schema first.
- **Before running any SQL migration**, verify the target tables and columns exist (or don't exist, as expected) by querying `information_schema.columns` on the linked database. This catches schema drift between what the code expects and what actually exists.
- **Running migrations**: Use `supabase db query --linked -f <path>` (file flag). Do NOT pass SQL with `--` comments as inline arguments — they get parsed as CLI flags.
- **After running migrations**, verify the new columns/tables exist with a confirmation query.
- Never assume database objects exist from a plan — always verify against the live schema first.

## TypeScript Conventions

- Always run `npx tsc --noEmit` after making TypeScript changes to catch compilation errors before committing.
- Watch for: curly quote characters in strings, non-existent column/enum references in Supabase types, and invalid status enum values.

## Architecture

```
Dashboard → Supabase Edge Function (run-audit)
                    │
                    ▼
    pipeline-server-standalone.ts (HTTP, port 3847)
                    │
                    ▼
          run-pipeline.sh <domain> <email> [flags]
                    │
          ┌─────────┴──────────────────────────────────┐
          ▼                                            ▼
  pipeline-generate.ts (phase runners)     sync-to-dashboard.ts (Supabase sync)
          │                                            │
          ├─ callClaude() → Anthropic API              ├─ audit_keywords
          ├─ DataForSEO APIs                           ├─ audit_clusters
          └─ disk artifacts (audits/{domain}/)         └─ audit_rollups, etc.
```

### Execution Model

Each pipeline phase (Dwight, Jim, Michael, etc.) is a **prompt template**, not an agent. It:
1. Gathers context (disk files + Supabase queries)
2. Builds a prompt string
3. Calls `callClaude()` once (single-shot, no multi-turn, no tool use)
4. Parses the response
5. Writes results to disk + Supabase

`scripts/anthropic-client.ts` wraps the `@anthropic-ai/sdk` Messages API. Per-phase `max_tokens` configured in `PHASE_MAX_TOKENS`. Model mapping: `sonnet` → `claude-sonnet-4-6`, `haiku` → `claude-haiku-4-5`, `opus` → `claude-opus-4-6`. Three-tier policy: Haiku for classification/batching, Sonnet for synthesis/generation, Opus for strategic judgment (cluster strategy).

### Pipeline Phase Order

```
Phase 0  Scout           (prospect mode only, exits after + prospect-narrative.md)
Phase 1  Dwight          Technical crawl + audit report
Phase 1a Verify Dwight   HTTP checks: sitemap, schema, redirect integrity
Phase 1c GSC Data Fetch  Google Search Console data (non-fatal, requires analytics_connections)
Phase 1b Strategy Brief  Synthesize Dwight + Scout + GSC + client profile → strategic framing
     ── Review Gate ──  (opt-in: if review_gate_enabled=true, pauses with awaiting_review)
Phase 2  KeywordResearch Service × city × intent keyword matrix
Phase 3  Jim             DataForSEO research + narrative
Phase 3b sync-jim        Keywords → Supabase (revenue modeling)
Phase 3c Canonicalize    Semantic topic grouping (Sonnet)
Phase 3d rebuild-clusters Re-aggregate with canonical keys
Phase 4  Competitors     SERP analysis (skipped in sales mode)
Phase 5  Gap             Content gap analysis (skipped in sales mode)
Phase 6  Michael         Architecture blueprint
Phase 6.5 Validator      Coverage cross-check (skipped in sales mode)
Phase 6b sync-michael    Architecture → Supabase
Phase 6c sync-dwight     Technical audit → Supabase
Phase 6d LocalPresence   GBP lookup + citation scan → Supabase
```

Post-pipeline (on-demand, per-page): **Pam** (content briefs) → **Oscar** (HTML generation)

On-demand (Settings/Clusters page): **Re-canonicalize** (Phase 3c+3d only) | **Cluster activation** (Opus strategy) | **Track rankings** (DataForSEO)

## Development Commands

```bash
npm run dev              # Run pipeline server with hot reload (tsx)
npm run build            # Compile TypeScript (tsc)
npm run typecheck        # Type-check without emitting (tsc --noEmit)
npm run format           # Format with prettier
npm run format:check     # Check formatting
npm test                 # Run all tests (vitest run)
npm run test:watch       # Watch mode
npm run sync             # Run sync-to-dashboard.ts
```

Run commands directly — don't tell the user to run them.

### Running the Pipeline Manually

```bash
# Full pipeline
./scripts/run-pipeline.sh <domain> <email>

# Sales mode (skips Competitors, Gap, Validator)
./scripts/run-pipeline.sh <domain> <email> --mode sales

# Resume from a specific phase
./scripts/run-pipeline.sh <domain> <email> --start-from 3

# Prospect scout only
./scripts/run-pipeline.sh <domain> <email> --mode prospect --prospect-config audits/<domain>/prospect-config.json
```

## Key Files

| File | Purpose |
|------|---------|
| `src/pipeline-server-standalone.ts` | HTTP server: `/trigger-pipeline`, `/recanonicalize`, `/track-rankings`, `/track-gsc`, `/activate-cluster`, `/deactivate-cluster`, `/scout-config`, `/scout-report`, `/artifact`, `/health` |
| `scripts/pipeline-generate.ts` | All phase runners: `runDwight()`, `runJim()`, `runMichael()`, `runCanonicalize()`, etc. + QA agent |
| `scripts/sync-to-dashboard.ts` | Supabase sync: `syncJim()`, `syncMichael()`, `syncDwight()`, `rebuildClustersAndRollups()` (with cluster status preservation) |
| `scripts/anthropic-client.ts` | Anthropic SDK wrapper — `callClaude()` / `callClaudeAsync()` for all Claude calls |
| `scripts/dataforseo-onpage.ts` | DataForSEO OnPage API client (crawl, poll, fetch pages/summary/microdata) |
| `scripts/onpage-to-csv.ts` | Transforms OnPage API data to CSV files for downstream consumers |
| `scripts/run-pipeline.sh` | Shell orchestrator: runs phases sequentially with QA gates |
| `scripts/foundational_scout.sh` | DataForSEO CLI wrapper for Scout phase |
| `scripts/generate-brief.ts` | Pam: content brief generation (metadata + schema + outline) |
| `scripts/generate-content.ts` | Oscar: HTML content production from briefs |
| `scripts/run-canonicalize.ts` | Standalone Phase 3c+3d runner (re-canonicalize from Settings page) |
| `scripts/generate-cluster-strategy.ts` | Cluster activation: Opus strategy generation (on-demand, per-cluster) |
| `scripts/generate-prospect-brief.ts` | Prospect brief: HTML intelligence brief from Scout data (Sonnet narrative + data injection) |
| `scripts/generate-client-brief.ts` | Client brief: HTML intelligence brief from full pipeline data (Sonnet narrative + Supabase data injection) |
| `scripts/local-presence.ts` | Phase 6d: GBP lookup + SERP citation scan → gbp_snapshots, citation_snapshots |
| `scripts/dataforseo-business.ts` | DataForSEO client: GBP lookup + SERP citation scan |
| `scripts/verify-dwight.ts` | Phase 1a: HTTP verification of Dwight findings (sitemap, schema, redirects) |
| `scripts/google-auth.ts` | Google auth: ADC + SA impersonation, token cache, `getAnalyticsConnection()` |
| `scripts/fetch-gsc-data.ts` | Phase 1c: GSC Search Analytics fetcher → gsc_data.json + gsc_summary.md + gsc_page_snapshots |
| `scripts/fetch-ga4-data.ts` | GA4 Data API fetcher (library module, called from track-rankings) |
| `scripts/track-gsc.ts` | Weekly GSC refresh (mirrors track-rankings pattern) |
| `scripts/strategy-brief.ts` | Phase 1b: synthesize Dwight + Scout + GSC + client profile → strategy_brief.md |
| `scripts/track-rankings.ts` | Performance tracking: DataForSEO ranked_keywords + GA4 behavioral data + authority scoring |
| `scripts/backfill-authority-scores.ts` | Backfill authority scores for existing snapshots |
| `scripts/cron-track-all.ts` | Batch runner: tracks all completed audits weekly |
| `scripts/client-context.ts` | Shared utility: `loadClientContext()`, `buildClientContextPrompt()` |
| `scripts/update-pipeline-status.ts` | Updates audit status in Supabase |
| `scripts/run-migration.ts` | Database migration runner |
| `Dockerfile.railway` | Railway deployment: node:22-slim + curl + jq |

## Runtime Directories (not in repo)

```
audits/{domain}/           # Pipeline artifacts per domain (dated subdirs)
  auditor/{date}/          # Dwight: internal_all.csv, AUDIT_REPORT.md, CSVs
  research/{date}/         # Jim: ranked_keywords.json, research_summary.md
  architecture/{date}/     # Michael: architecture_blueprint.md
  scout/{date}/            # Scout: scout report + scope.json
  content/{date}/{slug}/   # Pam/Oscar: metadata, schema, outline, page.html
```

## Testing Patterns

- **vitest** with `vi.mock()` for module mocking
- CI runs `tsc --noEmit` then `vitest run` on ubuntu/Node 20
- `passWithNoTests: true` in vitest config so CI passes without test files

## Code Conventions

- ESM project (`"type": "module"`). Imports use `.js` extensions (e.g., `import { foo } from './config.js'`).
- Prettier with `singleQuote: true`.
- `loadEnv()` in scripts falls through to `process.env` when `.env` is absent (Railway deployment).
- All Claude calls go through `scripts/anthropic-client.ts` — never spawn a CLI binary.
- Prompt framing: "YOUR ENTIRE RESPONSE IS THE [ARTIFACT]" top/bottom to prevent narration.
- `validateArtifact()` rejects conversational preamble in LLM output.
- `resolveArtifactPath()` handles cross-date fallback (Phase 3 finding Phase 1 artifacts from yesterday).

## Adding a New Pipeline Phase

1. Add a `runNewPhase()` function in `scripts/pipeline-generate.ts` following the existing pattern:
   - Gather context (disk files via `resolveArtifactPath()`, Supabase queries)
   - Build prompt string with "YOUR ENTIRE RESPONSE IS THE [X]" framing
   - Call `callClaude()` or `callClaudeAsync()` with appropriate model/max_tokens
   - Validate output with `validateArtifact()`
   - Write to disk in `audits/{domain}/{subdir}/{date}/`
2. Add the phase to `scripts/run-pipeline.sh` in the correct position
3. If the phase writes to Supabase, add a sync function in `scripts/sync-to-dashboard.ts`
4. If QA-gated, add a rubric in the `QA_RUBRICS` object and a `runQA()` call after the phase
5. Update `docs/PIPELINE.md` — this is a contract, not optional documentation

## Completed

Summary of what has been built and the key decisions behind each system. For full details, see [docs/PIPELINE.md](docs/PIPELINE.md) (contracts) and [docs/DECISIONS.md](docs/DECISIONS.md) (rationale).

### Core Pipeline (Phases 0–6d)

13-phase SEO audit pipeline that runs end-to-end in ~15 minutes per domain. Each phase is a single-shot prompt template — not a multi-turn agent. Phases produce disk artifacts and sync to Supabase tables. Shell orchestrator (`run-pipeline.sh`) handles sequencing, QA gates, and mode flags (full/sales/prospect).

**Key decisions**: Phases are prompt templates not agents (deterministic, debuggable). QA agent uses Haiku rubrics to gate generation phases — ENHANCE re-runs, FAIL halts. Three-tier model policy: Haiku for classification, Sonnet for synthesis, Opus for strategic judgment. Deterministic pre-flight QA checks (keyword count, cluster/topic ratio) run before LLM evaluation.

### Strategy Brief (Phase 1b)

Single Sonnet call (~$0.06) synthesizes Dwight + Scout + client profile into `strategy_brief.md` with four sections: Visibility Posture, Keyword Research Directive, Architecture Directive, Risk Flags. Injected into Phase 2 (keyword directive in Sonnet synthesis prompt), Michael (architecture + risk flags, posture dropped), Pam (posture + architecture). Disk artifact only — no Supabase table. Scout gap report markdown enters the pipeline for the first time here (previously only served dashboard UI).

**Key decisions**: Sonnet not Haiku (synthesis + judgment, not extraction). Single call → markdown (not JSON — downstream agents read it as prompt sections). Brief validates and supplements Phase 2's TypeScript geo_mode conditionals, doesn't replace them. Regenerated every run (no caching — $0.06 isn't worth stale risk). Cross-date fallback on AUDIT_REPORT.md so `--start-from 2` works.

### Keyword Pipeline (Phases 2–3d)

Service × city × intent keyword matrix (Phase 2) → DataForSEO research + narrative (Phase 3) → Supabase sync with revenue modeling (Phase 3b) → semantic canonicalization via Sonnet (Phase 3c) → cluster rebuild with canonical keys (Phase 3d).

**Key decisions**: Canonical keys are geo-agnostic ("water_heater_repair" not "boise_water_heater_repair"). Phase 3d exists because 3b builds clusters before canonical_key exists. Revenue model is three-tier (low/mid/high) from CR × ACV × delta_traffic. Near-me and navigational keywords excluded from striking distance via three-layer defense.

### Scout (Phase 0)

Prospect qualification at $2/run. DataForSEO ranked keywords + bulk volume → Haiku topic extraction → Sonnet report. Produces `scope.json` (Jim-compatible seed data) that persists through conversion. No crawl — Dwight handles that in Phase 1. Generates `prospect-narrative.md` — a plain-language outreach document (3 sections) written for business owners, not SEO professionals. Narrative generation is non-fatal.

**Key decisions**: Scout uses `prospects` table (not `audits`). Prospect mode exits after Scout. scope.json consumed as optional priors by KeywordResearch (gap keywords pre-seeded at priority 0). Narrative uses Sonnet (tone calibration + persuasive framing), wrapped in try/catch so Scout succeeds even if narrative fails.

### Pipeline Review Gate (opt-in)

Opt-in pause after Phase 1b (Strategy Brief) for full-mode audits. When `audits.review_gate_enabled = true`, pipeline sets status to `awaiting_review` and exits. User reviews strategy_brief.md, adds annotations, resumes via `pipeline-controls` edge function (`resume_pipeline` action, triggers with `start_from: '1b'`). Annotations appended to `client_context.out_of_scope`.

**Key decisions**: Opt-in (defaults false) — most audits run unattended. Full-mode only (sales mode runs too fast for review overhead). Uses `update-pipeline-status.ts check-review-gate` for the query (natural extension of existing status script). Resume starts from Phase 1b onward (uses existing `--start-from` flag).

### Content Factory (Pam + Oscar)

On-demand, per-page content production. Pam generates briefs (metadata + JSON-LD schema + outline) from execution_pages. Oscar produces HTML from briefs. Both poll Supabase request tables.

**Key decisions**: Oscar reads from DB only (disk fallback removed). Pam uses sentinel markers to parse three output sections from a single Claude call.

### Cluster Activation + Strategy

On-demand per-cluster. Single Opus call (~$0.15-0.50) produces strategy document. `/activate-cluster` gates content production — only pages in active clusters get `cluster_active=true` on `execution_pages`.

**Key decisions**: Opus justified because a misdirected cluster strategy cascades into weeks of wasted content. Deactivation is instant (2 UPDATEs, no LLM). `cluster_strategy` table stores the strategy document per cluster.

### Performance Tracking + Authority Scoring

Weekly ranking snapshots via DataForSEO `ranked_keywords/live` (~$0.05/call). Position-weighted authority score per cluster: pos 1-3=1.0, 4-10=0.6, 11-20=0.3, 21-30=0.1, 31+=0.05, unranked=0.0. Denominator includes all keywords (penalizes coverage gaps, not just poor positions). Stored in `cluster_performance_snapshots` (historical) + `audit_clusters` (current).

Dashboard surfaces: Performance page (authority trend chart, cluster table with authority/delta columns, weighted-avg summary), Clusters page (authority/delta columns, "Opportunity" badge on best inactive cluster with authority < 50).

**Key decisions**: First `ranking_snapshots` entry = effective baseline (not `baseline_snapshots`). `ranking_deltas` SQL view computes deltas server-side. `avg_position` excludes unranked keywords. Weekly cron with 6-day recency check prevents double-runs.

### Settings Page

Dashboard admin page: Client Context, Revenue Assumptions, Pipeline Controls (re-canonicalize, track rankings, re-run pipeline), Danger Zone. `pipeline-controls` edge function routes to pipeline server endpoints.

**Key decisions**: `client_context` dual-store — pipeline reads from disk (`prospect-config.json`), dashboard reads/writes `audits.client_context` JSONB. `rebuildClustersAndRollups()` preserves cluster activation status through DELETE+INSERT. `pipeline-controls` uses single edge function with action switch (not one per action).

### Local Presence Diagnostic (Phase 6d)

Automatic GBP lookup + citation scan across 11 directories, runs at end of every pipeline (both sales and full mode). DataForSEO Business Data for GBP, SERP API with `site:` filter for citation presence detection. Cost ~$0.026/audit. Stores `gbp_snapshots` (GBP listing data, canonical NAP, claimed status) and `citation_snapshots` (per-directory presence, NAP match booleans). Google citation row synthesized from GBP data (`data_source: 'gbp'`), others from SERP (`data_source: 'serp'`).

**Key decisions**: SERP citation scan (no BrightLocal vendor). GBP canonical NAP = source of truth for NAP comparison. `gbp_snapshots` always upserted even when `listing_found: false` (missing GBP = highest-value sales signal). Runs in both modes because local presence data drives sales conversions.

### Infrastructure

Pipeline server (`pipeline-server-standalone.ts`) on port 3847, 9 endpoints. Supabase Edge Functions as auth layer (2 patterns: `validateSuperAdmin` for admin ops, `resolveAuthContext` for user ops). DataForSEO OnPage API replaced Screaming Frog. Anthropic SDK replaced Claude CLI binary. `loadEnv()` falls through to `process.env` for Railway deployment.

**Key decisions**: 409 from pipeline server = success in edge function (already running). `PIPELINE_BASE_URL` secret serves all endpoints (`https://nanoclaw-production-e8b7.up.railway.app`). Railway provides HTTPS natively; auth via `PIPELINE_TRIGGER_SECRET` bearer token.

### Pre-Audit Client Context Intake

Two-step audit creation flow: Create Draft → Configure on Settings → Start Pipeline. `useCreateAudit` no longer auto-triggers `run-audit`; audit stays as `draft`. User redirected to Settings page for client context entry, then clicks "Start Pipeline" (draft banner). `loadClientContextAsync(domain, sb, auditId)` in `client-context.ts` bridges the dual-store: tries `prospect-config.json` first (Scout path), falls back to `audits.client_context` JSONB with field mapping (`core_services` → `services[]`, `differentiators` → `competitive_advantage`). Dashboard-only fields (`service_area`, `notes`) returned as `DashboardExtras` for Phase 1b. All 5 pipeline callers updated to use async version. Convert-prospect path unaffected (independent hook, auto-triggers).

**Key decisions**: Settings reuse over new intermediate page (already has context form + pipeline trigger). Disk file takes priority over DB so Scout data isn't overwritten. `loadClientContextAsync` checks both sources on every run (no caching) so skip → fill later → re-run works.

## Documentation
When working with any external library or framework, use Context7 MCP to 
fetch current documentation before implementing. Do not rely on training 
data for API signatures, configuration options, or version-specific behavior.