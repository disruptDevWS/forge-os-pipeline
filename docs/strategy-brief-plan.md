# Strategy Brief Architecture Plan

## 1. Current State Data Flow

### How Client Profile and Scout Output Enter the Pipeline

```
PROSPECT MODE (Phase 0):
  Dashboard → /scout-config → prospect-config.json (disk)
  Scout → scope.json + scout-report.md (disk) + prospects table (Supabase)

CONVERSION:
  Dashboard → audits INSERT (geo_mode, market_geos, market_city, market_state)
  prospect-config.json persists on disk (NOT copied to audit)
  audits.client_context JSONB column (dashboard reads/writes independently)

FULL PIPELINE (Phases 1-6d):
  Phase 1 (Dwight)   → AUDIT_REPORT.md, internal_all.csv (no client context)
  Phase 2 (KW)       → reads scope.json (optional), loadClientContext() for services only
  Phase 3 (Jim)      → buildClientContextPrompt() injected into narrative prompt
  Phase 5 (Gap)      → buildClientContextPrompt() for out_of_scope filtering
  Phase 6 (Michael)  → buildClientContextPrompt() for architecture framing
```

### Where scope.json Gets Read

**Single consumer: Phase 2 (KeywordResearch)** — `pipeline-generate.ts:2805-2818`
- Validates Scout services/locales against crawl data (extraction prompt)
- Pre-seeds gap keywords from `gap_summary.top_opportunities` at priority 0

**Scout gap report markdown is NOT used** in the full pipeline. Only served to dashboard via `/scout-report` endpoint.

### Where client_context Gets Loaded

`loadClientContext()` reads `prospect-config.json` from disk (not `audits.client_context` JSONB).

| Phase | Receives client_context? | Form | What it uses |
|-------|------------------------|------|-------------|
| Phase 1 (Dwight) | No | N/A | Technical crawl, no context needed |
| Phase 2 (KW) | Partial | Direct property access | `ctx.services[]` appended to service list only |
| Phase 3 (Jim) | Yes | `buildClientContextPrompt('jim')` | Business model, audience, services, advantage, out_of_scope |
| Phase 5 (Gap) | Yes | `buildClientContextPrompt('gap')` | Same as Jim |
| Phase 6 (Michael) | Yes | `buildClientContextPrompt('michael')` | + pricing_tier, price_range |
| Pam | Via `client_profiles` table | `buildClientProfileSection()` | Different source — DB, not disk |

### Where geo_mode and market_geos Are First Resolved

**First resolution: Phase 2** — `resolveGeoScope(audit)` at line 2830.

No other phase calls `resolveGeoScope()`. Jim, Michael, Gap receive geo context only indirectly:
- Jim gets `kwGeo.label` in the prompt framing (e.g., "business in Washington, Oregon, ...")
- Michael receives it via Jim's research_summary.md content
- Gap doesn't receive geo at all

**Critical gap**: Michael has no direct access to geo_mode. It cannot know whether the client is local, multi-state, or national. It infers market scope from Jim's output, which itself inherited scope from Phase 2's matrix — a game of telephone.

## 2. Insertion Point

### Proposed: Phase 1.5 — Between Dwight QA and Phase 2

**File**: `scripts/run-pipeline.sh`, between line 167 and line 169.

```
Phase 1  Dwight        → AUDIT_REPORT.md
Phase 1  QA gate       → pass/enhance/fail
>>> Phase 1.5 Strategy Brief <<<   NEW
Phase 2  KeywordResearch → keyword matrix
```

**Why here:**
- Has Dwight output (AUDIT_REPORT.md) ← required input
- Has client_profiles / client_context ← available at pipeline start
- Has scope.json ← persists from Scout
- Runs before Phase 2 ← shapes keyword matrix construction
- No async dependency — sequential after Dwight QA, before Phase 2

**run-pipeline.sh insertion** (after line 167):

```bash
# ─── Phase 1.5: Strategy Brief ──────────────────────────────
if should_run_phase 1.5; then
echo ""
echo "--- Phase 1b: Strategy Brief ---"
npx tsx scripts/strategy-brief.ts --domain "$DOMAIN" --user-email "$EMAIL"
else echo "  [SKIP] Phase 1b: Strategy Brief"; fi
```

**PHASE_ORDER update**: `(1 1b 2 3 3b 3c 3d 4 5 6 6.5 6b 6c 6d)`

**Decision**: Use `1b` (not `1.5`). `should_run_phase` uses shell string comparison against `START_FROM` — decimal values break arithmetic. `1b` matches the existing naming convention (`3b`, `3c`, `3d`) and sorts correctly in the `>=` comparison.

## 3. Strategy Brief Agent Spec

### Input Documents

| Source | Path / Query | Max Size | Required? |
|--------|-------------|----------|-----------|
| AUDIT_REPORT.md | `audits/{domain}/auditor/{date}/AUDIT_REPORT.md` | ~30KB, truncate to 20KB | Yes |
| scope.json | `audits/{domain}/scout/{date}/scope.json` | ~5KB | No (graceful without) |
| Scout gap report | `audits/{domain}/scout/{date}/scout-*.md` | ~10KB, truncate to 8KB | No |
| client_context | `loadClientContext(domain)` → prospect-config.json | ~500 chars | No |
| client_profiles row | Supabase `client_profiles` where `audit_id` | ~1KB | No |
| audit row | Supabase `audits` where `id` | ~500 chars | Yes |

**Total prompt size estimate**: ~30-40KB input + ~2KB framing = ~35-42KB ≈ ~10-12K tokens input.

### Output: `strategy_brief.md`

Written to `audits/{domain}/research/{date}/strategy_brief.md`.

```markdown
## Visibility Posture

[One of: "New Market Entry" | "Local Authority with Gaps" | "Established Presence — Topical Expansion" | "Multi-State Scaling" | "National Brand Building"]

[2-3 sentence characterization of the gap between current footprint and target market]

## Keyword Research Directive

Target the following keyword buckets in priority order:

1. [Bucket description with rationale]
2. [Bucket description]
3. [Bucket description]

Matrix construction rules:
- [Explicit instruction, e.g., "Do NOT optimize around current local rankings"]
- [Explicit instruction, e.g., "Include state-level variants for each service area state"]
- [Explicit instruction, e.g., "Unmodified national terms are highest priority"]

## Architecture Directive

- [Structural requirement, e.g., "State landing pages required before topical cluster build"]
- [Structural requirement, e.g., "Service hub pages should be geo-agnostic; location pages link to hubs"]
- [Constraint, e.g., "Brand entity resolution is prerequisite — consolidate name variants"]

## Risk Flags

- [BLOCKING] [description if any, e.g., "NAP inconsistency across 4 directories"]
- [WARNING] [description, e.g., "Out-of-scope content currently ranking — do not cannibalize"]
- [INFO] [description, e.g., "No Schema markup — agentic readiness score 0"]
```

**Why this structure:**
- `Visibility Posture` — anchors the strategic frame; downstream agents can reference it
- `Keyword Research Directive` — Phase 2 reads this section for matrix construction rules
- `Architecture Directive` — Michael reads this section for structural requirements
- `Risk Flags` — all downstream agents check for BLOCKING flags

### Model Recommendation: Sonnet

**Rationale**: This is synthesis + strategic reasoning across 3 disparate documents. It needs to:
- Characterize a gap between current state and target state (judgment)
- Produce specific, actionable directives (not just summarize inputs)
- Identify risks that require cross-referencing multiple signals

Haiku would likely produce generic directives. Sonnet at 8192 max_tokens gives enough room for a thoughtful ~1500-word brief. Not Opus — this doesn't warrant $0.15+ per call; the brief is scaffolding, not the final deliverable.

**Estimated cost**: ~12K input tokens + ~2K output tokens × Sonnet pricing ≈ $0.05-0.07.
**Estimated latency**: ~8-15 seconds.

### Prompt Approach: Single Call → Markdown

**Recommendation: Single Sonnet call producing the full markdown brief.**

Rationale against structured JSON output:
- Downstream agents read the brief as a prompt section (markdown), not as structured data
- Phase 2's matrix construction is TypeScript logic, not LLM-driven — it needs readable directives, not machine-parseable fields
- JSON schema would over-constrain the brief's ability to express nuanced strategic framing
- The brief's value is in its reasoning, not its structure

The brief includes section headings as parse anchors if any downstream consumer needs to extract a specific section (same pattern as extracting Platform Observations from AUDIT_REPORT.md).

## 4. Per-Agent Injection Plan

### Phase 2 (KeywordResearch)

**Injection point**: `pipeline-generate.ts`, after the extraction prompt (Haiku) runs and before matrix construction begins (~line 2920, after services/locations are resolved).

**What gets injected**: The `## Keyword Research Directive` section from `strategy_brief.md`, extracted via regex.

**How it changes Phase 2**:
- The directive's bucket instructions inform the existing three-bucket system
- NOT replacing the TypeScript geo_mode conditionals — the brief validates and supplements them
- If the directive says "do not optimize around current local rankings," Phase 2 can skip city-level near-me variants
- If the directive specifies "include {custom term patterns}," those get added to the matrix

**What becomes redundant**: Nothing fully. The `scopeContext` block (Scout priors validation) stays — it's mechanical validation, not strategic. The `buildClientContextPrompt('keyword-research')` call stays — it adds services. The brief adds strategic *framing* that neither currently provides.

**Prompt length risk**: Low. The directive section is ~300-500 chars. Phase 2's extraction prompt (Haiku) has plenty of headroom at 4096 max_tokens. The synthesis prompt (Sonnet, 8192) is also well under budget.

### Phase 6 (Michael)

**Injection point**: `pipeline-generate.ts:~1506`, alongside `michaelClientContextBlock`.

**What gets injected**: `## Keyword Research Directive`, `## Architecture Directive`, and `## Risk Flags` sections. **Drop `## Visibility Posture`** for Michael — it's framing context, not actionable. Risk Flags are the most important section for Michael since blocking issues (NAP inconsistency, brand identity conflict, out-of-scope content ranking) directly affect architecture decisions.

**What becomes partially redundant**: `buildClientContextPrompt('michael')` overlaps with the brief's business context, but the brief adds strategic *interpretation* of that context. Keep both — the client context block is factual (services, pricing), the brief is analytical (directives, risks).

**Prompt length risk**: Low after dropping Visibility Posture. The three remaining sections total ~2-3KB. Michael's existing prompt is ~20-30KB total with 16384 max_tokens output budget — adding 2-3KB of high-value strategic context is well within bounds.

### Pam (generate-brief.ts)

**Injection point**: `generate-brief.ts`, in the prompt construction section alongside `marketContext` and `architectureContext`.

**What gets injected**: `## Visibility Posture` + `## Architecture Directive` sections only. Pam doesn't need keyword research directives (it works at the page level, not the matrix level).

**What becomes redundant**: Nothing. Pam currently has no strategic framing — it works from cluster data + architecture blueprint + SERP enrichment. The brief adds the "why" behind the architecture.

**Prompt length risk**: Low. Pam's prompt is ~10-12KB total, well under the 16384 max_tokens budget. Adding ~1KB of brief context is fine.

## 5. Phase 2 Changes Given a Strategy Brief

### Recommendation: Belt-and-Suspenders (Option B)

**Keep the TypeScript geo_mode conditionals. Add brief validation.**

Rationale:
- The three-bucket system (Fix 1) is deterministic and tested. Removing it makes Phase 2 dependent on LLM output quality for every run.
- The brief's directive adds *refinement*, not *replacement*: it can say "prioritize bucket 1 over bucket 2" or "add these additional term patterns," but the bucket structure itself should remain in code.
- If the brief is missing (no Scout, no client context → sparse brief), Phase 2 still produces reasonable output from geo_mode alone.

**Specific changes:**
1. Read `strategy_brief.md` from disk (optional, like scope.json)
2. Extract `## Keyword Research Directive` section via regex
3. Inject the directive into the **Sonnet synthesis prompt** (Stage 2), not the Haiku extraction prompt (Stage 1). Rationale: Haiku extracts entities (services, locations) from the audit report — it doesn't make matrix construction decisions. The directive's instructions ("prioritize unmodified national terms," "do not optimize around current local rankings") are strategic guidance for the synthesis step that evaluates and prioritizes the validated keyword matrix.
4. If the directive specifies custom term patterns or additional keyword buckets, add them to the matrix via `addKw()` after the three-bucket loop (TypeScript, not LLM-driven)

**What NOT to do**: Don't inject the directive into the Haiku extraction prompt — that call is entity extraction, not strategy. Don't have the brief output structured JSON that Phase 2's TypeScript parses into matrix rules. The brief should influence the synthesis step (where strategic judgment is appropriate) and supplement the deterministic matrix step (where it adds terms).

## 6. Dependencies and Risks

### Missing scope.json

If Scout didn't run, the brief has no external visibility data. The brief should handle this gracefully:

- **With Scout**: Full three-input synthesis (Scout + Dwight + client profile)
- **Without Scout**: Two-input synthesis (Dwight + client profile). Posture defaults to "Initial Assessment" rather than making visibility claims. Keyword directive focuses on on-page signals and client context services.

The prompt should explicitly state: "If no Scout data is provided, base visibility posture on Dwight's crawl signals only. Do not speculate about external visibility or competitor landscape."

### Missing client_context

If no client profile exists (sales mode, or operator skipped context entry):

- Brief still runs — Dwight's audit report contains service indicators, platform data, and technical state
- Posture is limited to technical assessment ("site signals X services, targets Y geo, technical state is Z")
- Keyword directive defaults to geo_mode-based bucket rules
- Architecture directive focuses on technical issues from Dwight

### Cost and Latency Impact

| Item | Cost | Latency |
|------|------|---------|
| Strategy brief (Sonnet, ~14K tokens) | ~$0.06 | ~10s |
| Current pipeline total (Phases 1-6d) | ~$2.50-5.00 | ~15min |
| **Impact** | **+1.2-2.4%** | **+0.7-1.1%** |

Negligible. One Sonnet call is cheaper than a single QA gate re-run.

### Caching / Re-generation

**Recommendation: Regenerate on every pipeline run. Do not cache.**

Rationale:
- The brief synthesizes Dwight output, which changes every run (site evolves)
- Client context may change between runs (Settings page updates)
- The brief is ~$0.06 and ~10s — caching saves negligible cost/time
- Stale briefs are worse than fresh ones — a brief that says "new market entry" after the client has been ranking for 6 months is actively harmful

**Exception — `--start-from 2` behavior**: When the pipeline resumes from Phase 2, Phase 1b still runs (it's in the phase order before 2). The brief script must:
1. Load AUDIT_REPORT.md via `resolveArtifactPath()` cross-date fallback (finds yesterday's Dwight output)
2. Check if `strategy_brief.md` already exists for today's date in `research/{date}/` — if so, skip generation (unless `--force`)
3. If no brief exists and no AUDIT_REPORT.md is found (neither today nor prior dates), log a warning and skip — do not block the pipeline

### Scout Gap Report Markdown

Currently unused in the full pipeline. The strategy brief should read it — it contains competitive intelligence and revenue estimates that inform posture characterization. This is the first time the Scout markdown enters the analytical pipeline rather than just serving the dashboard UI.

## 7. Recommended Implementation Sequence

1. **`scripts/strategy-brief.ts`** (~150 lines)
   - New standalone script, same pattern as `track-rankings.ts` / `local-presence.ts`
   - CLI: `--domain`, `--user-email`, `--force`
   - Loads 3 inputs (AUDIT_REPORT.md via `resolveArtifactPath()`, scope.json + scout markdown, client_context + client_profiles)
   - Single Sonnet call → `strategy_brief.md` written to `audits/{domain}/research/{date}/`
   - Recency: skip if today's brief exists (unless `--force`)
   - **Critical**: AUDIT_REPORT.md must be loaded via `resolveArtifactPath('auditor', 'AUDIT_REPORT.md')` with cross-date fallback — NOT `findLatestDatedDir()` + hardcoded filename. This ensures `--start-from 2` works: if Dwight ran yesterday and Phase 1b runs today, it finds yesterday's audit report. Same pattern Phase 2 already uses for Dwight artifacts.

2. **`scripts/run-pipeline.sh`** — Add Phase 1.5 block

3. **`scripts/pipeline-generate.ts`** — Phase 2 injection
   - Load `strategy_brief.md` via `resolveArtifactPath('research', 'strategy_brief.md')`
   - Extract keyword directive section
   - Inject into extraction prompt as strategic framing

4. **`scripts/pipeline-generate.ts`** — Michael injection
   - Load `strategy_brief.md` (full)
   - Inject before existing `michaelClientContextBlock`

5. **`scripts/generate-brief.ts`** — Pam injection
   - Load `strategy_brief.md` (posture + architecture directive sections only)
   - Inject alongside `marketContext`

6. **`docs/PIPELINE.md`** — Add Phase 1.5 to contract
7. **`docs/DECISIONS.md`** — Document brief-as-strategic-frame decision
8. **`CLAUDE.md`** — Update phase order + key files

### Dependencies Between Steps

- Step 1 is standalone (no code dependencies)
- Step 2 depends on step 1 (references the script)
- Steps 3-5 are independent of each other (can be done in parallel)
- Steps 6-8 are documentation (do last)

### What This Does NOT Change

- No new Supabase tables — the brief is a disk artifact only
- No new LLM models — uses existing Sonnet
- No changes to Jim, Gap, Canonicalize, Validator, or sync scripts
- No changes to the dashboard
- Phase 2's three-bucket geo_mode logic stays intact
- `buildClientContextPrompt()` stays — it's factual, the brief is analytical
