# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Context

NanoClaw is an **SEO audit pipeline toolkit**. Dashboard buttons trigger Supabase Edge Functions, which POST to a Node.js HTTP server on Railway, which spawns a shell orchestrator that runs TypeScript phase generators, then syncs results back to Supabase tables for the dashboard to display.

**Before modifying pipeline code**, read [docs/PIPELINE.md](docs/PIPELINE.md) (authoritative phase contract — who owns what data) and [docs/DECISIONS.md](docs/DECISIONS.md) (why non-obvious choices were made). If a phase responsibility changes, update PIPELINE.md in the same commit.

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
Phase 0  Scout           (prospect mode only, exits after)
Phase 1  Dwight          Technical crawl + audit report
Phase 2  KeywordResearch Service × city × intent keyword matrix
Phase 3  Jim             DataForSEO research + narrative
Phase 3b sync-jim        Keywords → Supabase (revenue modeling)
Phase 3c Canonicalize    Semantic topic grouping (Haiku)
Phase 3d rebuild-clusters Re-aggregate with canonical keys
Phase 4  Competitors     SERP analysis (skipped in sales mode)
Phase 5  Gap             Content gap analysis (skipped in sales mode)
Phase 6  Michael         Architecture blueprint
Phase 6.5 Validator      Coverage cross-check (skipped in sales mode)
Phase 6b sync-michael    Architecture → Supabase
Phase 6c sync-dwight     Technical audit → Supabase
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
| `src/pipeline-server-standalone.ts` | HTTP server: `/trigger-pipeline`, `/recanonicalize`, `/track-rankings`, `/activate-cluster`, `/deactivate-cluster`, `/scout-config`, `/scout-report`, `/artifact`, `/health` |
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
| `scripts/track-rankings.ts` | Performance tracking: DataForSEO ranked_keywords snapshot |
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
