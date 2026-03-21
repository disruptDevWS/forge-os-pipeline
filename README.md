<p align="center">
  <img src="assets/brand/forge-growth-horizontal-logo-400x100-trans-bg.png" alt="Forge Growth" width="400">
</p>

<p align="center">
  <strong>Forge OS Pipeline</strong> — SEO audit pipeline toolkit that powers the Forge Growth platform.
</p>

## What It Is

Forge OS Pipeline is the backend engine behind [Forge Growth](https://forgegrowth.ai). It runs a 13-phase SEO audit pipeline that analyzes a business's online presence, identifies keyword opportunities, maps competitive landscapes, and produces actionable architecture blueprints and content.

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

Each pipeline phase is a **single-shot prompt template** — not a multi-turn agent. It gathers context, builds a prompt, calls Claude once, parses the response, and writes results to disk + Supabase.

## Pipeline Phases

| Phase | Agent | What It Does |
|-------|-------|-------------|
| 0 | Scout | Prospect qualification (~$2, prospect mode only) |
| 1 | Dwight | DataForSEO OnPage crawl + technical audit report |
| 1b | Strategy Brief | Synthesizes Dwight + Scout + client profile → strategic framing |
| 2 | KeywordResearch | Service × city × intent keyword matrix |
| 3 | Jim | DataForSEO research + narrative |
| 3b | sync-jim | Keywords → Supabase (revenue modeling) |
| 3c | Canonicalize | Semantic topic grouping (Haiku) |
| 3d | rebuild-clusters | Re-aggregate with canonical keys |
| 4 | Competitors | SERP analysis (skipped in sales mode) |
| 5 | Gap | Content gap analysis (skipped in sales mode) |
| 6 | Michael | Architecture blueprint |
| 6.5 | Validator | Coverage cross-check (skipped in sales mode) |
| 6b | sync-michael | Architecture → Supabase |
| 6c | sync-dwight | Technical audit → Supabase |
| 6d | LocalPresence | GBP lookup + citation scan → Supabase |

**Post-pipeline (on-demand):** Pam (content briefs) → Oscar (HTML generation)

## Development

```bash
npm run dev              # Run pipeline server with hot reload (tsx)
npm run build            # Compile TypeScript (tsc)
npm run typecheck        # Type-check without emitting (tsc --noEmit)
npm run format           # Format with prettier
npm test                 # Run all tests (vitest run)
npm run sync             # Run sync-to-dashboard.ts
```

### Running the Pipeline

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
| `src/pipeline-server-standalone.ts` | HTTP server (9 endpoints) |
| `scripts/pipeline-generate.ts` | All phase runners |
| `scripts/sync-to-dashboard.ts` | Supabase sync |
| `scripts/anthropic-client.ts` | Anthropic SDK wrapper |
| `scripts/dataforseo-onpage.ts` | DataForSEO OnPage API client |
| `scripts/run-pipeline.sh` | Shell orchestrator |
| `scripts/generate-brief.ts` | Pam: content brief generation |
| `scripts/generate-content.ts` | Oscar: HTML content production |
| `scripts/generate-cluster-strategy.ts` | Cluster activation (Opus) |
| `scripts/local-presence.ts` | GBP lookup + citation scan |
| `scripts/track-rankings.ts` | Performance tracking |

## License

MIT
