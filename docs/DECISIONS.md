# Architecture Decision Log

Non-obvious choices that would look wrong without context. Check here before "fixing" something.

---

**2026-04-22: Michael prompt revision — 8 architectural decisions**

The Michael prompt was revised to fix material regressions in the forgegrowth.ai April 22 architecture blueprint: split GEO/AEO into distinct commercial pages, created near-me slug pages, inflated page count, and included geographic pages on a national client. Eight changes were made:

1. **Two-tier Strategy Brief authority** — Strategy Brief content is classified as binding constraints (prohibitions: "do not," "avoid," "exclude") vs strategic framing (everything else). When structured data (keyword matrix, revenue clusters, gap analysis) conflicts with a binding constraint, the constraint wins. Deferred opportunities surface in a new `## Deferred Targets` section. *Why:* The previous "CRITICAL INSTRUCTION" framing was too vague — Michael treated all brief content as authoritative framing but overrode specific prohibitions when volume data looked compelling.

2. **Cluster coherence over page count (Rule 4b)** — Replaced fixed page-count caps ("max 15/25 new pages") with a coherence principle: each silo must be topically complete with distinct intent coverage. Do not inflate by splitting adjacent intents. Total page count is a downstream cluster activation decision. *Why:* Caps were arbitrary and either too tight (suppressing legitimate coverage) or gaming-incentivized (splitting intents to hit the cap with more pages).

3. **Near-me slug prohibition (Rule 14)** — Changed from "do not use near-me keywords as primary_keyword" to "do not create pages whose URL slug contains near-me." Near-me queries are captured through properly-structured geographic pages with location-modified primary keywords. *Why:* The old rule banned near-me *keywords* but Michael still created near-me *slugs* because the rule didn't explicitly cover URL construction.

4. **Conditional geographic injection by `geo_mode`** — Replaced rigid Rule 16 ("geo pages are roles within a silo") with `getGeographicArchitectureBlock()` that injects no geographic rules for `national`, `CITY_METRO_GEO_BLOCK` for `city/metro`, and `STATE_GEO_BLOCK` for `state`. *Why:* Rule 16 was hardcoded for multi-state medical education clients (IMA/SMA) and actively harmful for national clients (forgegrowth) — prescribing geographic page structures when no geographic pages should exist.

5. **Service-primary container methodology** — Both geographic blocks establish: service is the primary topical container, location is the qualifier. Service+location pages nest under service pillars, not under locations. Geographic hub pages are complementary, not primary. Dual-parent relationship (service pillar + geographic hub). *Why:* This is the load-bearing structural claim. Inverting it (location-primary structure) fragments topical authority across geographic siblings instead of accumulating it at the service level.

6. **Deferred Targets mechanism** — New output format section that reports opportunities the structured data surfaced but that were deferred due to Strategy Brief binding constraints. Each entry: Opportunity, Signal, Constraint, Decision. *Why:* Without this, Michael silently suppressed opportunities when brief constraints won — making it impossible to audit what was deferred and whether the constraint was correct.

7. **Cannibalization pre-finalization self-check** — Before finalizing silo tables, Michael reviews them for internal cannibalization (competing primary keywords, near-duplicate intent, parent/child overlap) and consolidates. The Cannibalization Warnings section reports resolved risks, not self-created ones. *Why:* Michael was creating cannibalization risks in silo tables and then flagging them post-hoc in the warnings section — generating the problem and the diagnosis simultaneously.

8. **State-mode geographic guidance** — The STATE_GEO_BLOCK adds: delivery-intent queries are typically city-level, regulatory/licensing are state-level, comparative follow the data. Let keyword data drive the geographic level. *Why:* Rule 16 prescribed city-level pages uniformly, but state-mode clients have mixed geographic intent levels that keyword data should drive.

Validation: forgegrowth.ai (national, `geo_mode='national'`) blueprint produced 46 valid pages in 6 silos. Zero near-me slugs, zero geographic pages, 3 deferred targets, 6 resolved cannibalization warnings. GEO/AEO in one silo (not split). Coverage assessment rows cause false positive slug corruption (~30%) — non-blocking, pre-existing parser issue.

---

**2026-04-22: Review gate is a full process exit, not a pause — programmatic re-runs must account for it**

During forgegrowth.ai hybrid promotion, a full pipeline trigger (`/trigger-pipeline` without `start_from`) silently stopped after Phase 1b because `review_gate_enabled = true`. The pipeline child process exited cleanly with code 0 (`exit 0` in `run-pipeline.sh:240`), the in-flight tracker cleared, and the audit sat in `awaiting_review`. The operator had to make a second API call with `start_from: '2'` to complete the remaining phases.

This is by design — the gate is opt-in and the exit-not-pause behavior is intentional (Railway's ephemeral filesystem means a sleeping process would lose state on deploy). But any automated or scripted full re-run on a review-gate-enabled audit must check for this condition or it will appear to "complete" Phase 1 and stop.

Recommendation: Before programmatic full re-runs, check `audits.review_gate_enabled`. If true, either (a) temporarily disable it, (b) use `start_from: '2'` to skip directly past the gate, or (c) expect to make a second resume call.

---

**2026-04-22: `core_services` injection into Haiku classification prompt — conditional, not universal**

The Haiku classification prompt in `classify-keywords.ts` now conditionally injects `core_services` from `audits.client_context` when populated. Two additions: (1) a guidance line ("prefer Service/Course over Article when keyword matches a listed service/program") and (2) the actual service list ("This business specifically offers: X, Y, Z").

Design decisions:
- **Conditional injection, not always-on:** When `core_services` is absent or empty, the prompt is identical to pre-injection behavior. No regression risk for audits without client context.
- **Extracted from existing Supabase query:** `pipeline-generate.ts` already fetches `client_context` for brand detection. `core_services` extraction added to the same query — no additional DB call.
- **Comma-separated string → array split:** Mirrors the pattern in `client-context.ts:mapDashboardContext()` (`.split(',').map(s => s.trim()).filter(Boolean)`). Handles both string and array formats defensively.
- **Guidance line says "prefer", not "always":** Haiku retains discretion. A keyword like "how to study for NREMT" about a course topic may still correctly get Article if the keyword is purely informational. The guidance biases toward Course/Service for ambiguous cases only.

---

**2026-04-21: Session B — Legacy Sonnet eliminated in hybrid mode; classification extracted to Haiku + rules**

In hybrid mode, legacy Sonnet grouping is skipped entirely. The new path: classification extraction (Haiku + deterministic rules) → hybrid pre-cluster + arbitrate + persist → rebuild. Legacy mode retains the full legacy Sonnet path unchanged. Shadow mode runs legacy Sonnet + hybrid (unchanged).

Classification extraction decisions per field:
- `is_brand`: Hybrid — deterministic string match against domain/business name/competitor names, Haiku fallback for ambiguous cases (~65% deterministic, ~35% Haiku)
- `intent_type`: Haiku only — deterministic rules too error-prone (21-34% coverage, 22-30% error rate)
- `primary_entity_type`: Hybrid — vertical default (e.g., "Course" for education) + Haiku for ambiguous cases (~85% deterministic)
- `is_near_me`: Deterministic (unchanged) — `keyword.includes(' near me')`
- `intent`: Backward-compatible copy of `intent_type` (addendum correction #4)

The extraction path writes `canonicalize_mode` on every keyword it processes, maintaining the Session A invariant. Cost: ~$0.02-0.03 per 1000 keywords vs ~$0.30-0.50 for legacy Sonnet (~90-95% reduction).

Code: `src/agents/canonicalize/classify-keywords.ts` (new), integrated in `pipeline-generate.ts` `runCanonicalize()`.

---

**2026-04-21: Session B — `audit_keywords.cluster` column split: `silo` column added (migration 019)**

The `cluster` column on `audit_keywords` was overloaded: it stored either `canonical_topic` (from canonicalize) or `silo_name` (from syncMichael's backfill). Migration 019 adds a dedicated `silo` column, backfills it from `cluster` where values differed from `canonical_topic`, and restores `cluster` to be canonical_topic-exclusive.

syncMichael now writes to `silo` instead of `cluster`. Pam now joins keywords via `canonical_key` instead of `cluster` (locked per Session B addendum — architecturally correct long-term join). Pages with NULL `canonical_key` fall through to volume-based fallback (top 50 by search_volume).

Accepted consequence: pages with NULL `canonical_key` (~45% IMA, ~14% forgegrowth, ~57% ecohvac) get less keyword context in briefs until Phase 3+ embedding-based backfill raises coverage.

---

**2026-04-21: Pam filters `cluster_strategy` by `status='active'` — prevents deprecated strategy leakage**

Pam's `generate-brief.ts` had two queries against `cluster_strategy` (entity_map and ai_optimization_targets) that didn't filter on `status`. After re-canonicalization orphans a strategy (sets status='deprecated'), Pam could pull stale strategy data for briefs. Both queries now include `.eq('status', 'active')`. Fallback behavior when no active strategy exists: `entityMap=null`, `clusterAiTargets=[]` — brief still generates, just without strategy enrichment.

---

**2026-04-21: syncMichael execution_pages.status protection is already comprehensive — no additional guard needed**

Session B Check 5 verified that `isCommitted()` in `rerun-utils.ts` + syncMichael's manual SELECT→UPDATE/INSERT branching in `sync-to-dashboard.ts` already protects `execution_pages.status` from being reset on re-runs. The `isCommitted()` predicate covers: non-`not_started` status (catches Oscar `in_progress`/`review`), `source='cluster_strategy'`, `source='manual'`, and `published_at != null`. All paths confirmed:

- Strategic rerun + committed page: metadata-only update, status preserved.
- Strategic rerun + non-committed page: status reset to `not_started` (intentional — allows re-processing).
- First-run / failure-resume + existing page: metadata-only update, status preserved.
- New page: inserted as `not_started`.

No new guard was needed. If future status values are added (beyond `not_started`, `in_progress`, `review`), verify they are covered by `isCommitted()`.

---

**2026-04-21: Column-wiring discipline — columns added to `audits` must be wired in the same phase they're introduced**

The `canonicalize_mode` column was added to `audits` in migration (Phase 2.3b, 2026-04-20) but neither `handleTrigger` nor `handleRecanonicalize` in `pipeline-server-standalone.ts` read it. The column existed as documentation only — the actual mechanism was the `--canonicalize-mode` CLI flag hardcoded to `legacy` in `run-pipeline.sh`. Both production clients (SMA, IMA) were promoted to hybrid via manual flag overrides, masking the gap. The fix (Session A, 2026-04-21) added DB lookups in both handlers to read `audits.canonicalize_mode` and pass it to downstream scripts.

**Principle**: When a new column is added to `audits` (or any table that controls pipeline behavior), the wiring — the code path that reads the column and acts on it — must ship in the same commit or be explicitly flagged as pending wiring with a TODO and a tracking item. "The column exists" is not the same as "the column works." The wiring gap was caught by a post-Phase-2 architectural review; it should have been caught by the migration author.

NULL `canonicalize_mode` is treated as `legacy` per the column DEFAULT. If the DEFAULT ever changes, the read-site mapping in `handleTrigger` and `handleRecanonicalize` must change with it.

---

**2026-04-21: Sales-mode audits DO run Phase 3c and 3d — orphaned clusters on legacy prospects are historical**

The post-Phase-2 architectural review (Area 4) hypothesized that foxhvacpro's 15 orphaned clusters were caused by Phase 3c being skipped in sales mode. Investigation of `run-pipeline.sh` shows Phase 3c and 3d run in ALL modes — only Phases 4 (Competitors), 5 (Gap), and 6.5 (Validator) are skipped in sales mode. The orphaned clusters on foxhvacpro and boiseserviceplumbers are historical artifacts from pre-canonicalize era runs, not a repeating pattern.

No sales-mode guard was implemented. The affected clients (foxhvacpro, boiseserviceplumbers) are legacy prospects that Matt is not pursuing; they will be deleted or left as-is. If future sales-mode orphan patterns emerge, the investigation should start from the specific write path producing orphans, not from a mode-skip assumption.

---

**2026-04-20: IMA promoted to hybrid canonicalize — SUCCESS (Phase 2.4)**

IMA (`08409ae8`) promoted from `canonicalize_mode='legacy'` to `'hybrid'`. First fresh-evaluation hybrid run (no prior hybrid state, all 1,100 keywords evaluated from scratch). Pipeline completed all phases (3c→6d + client brief). 76 distinct canonical_keys (up from 66), 64 clusters (up from 62), 89 vector auto-assigned, 905 Sonnet arbitrated, 0 prior-locked.

Committed page `how-to-become-an-emt-in-idaho` preserved (status=in_progress, source=michael). Its canonical_key changed from orphaned `emt_training` → `emt_career_info` (improvement — now maps to live cluster). Performance snapshots preserved (32/32). Backfill rate improved from 45.8% → 54.7%.

**Operational gap flagged:** `canonicalize_mode` column on `audits` is documentation only — pipeline-server-standalone.ts, edge functions, and dashboard re-triggers do NOT read it. The actual mechanism is the `--canonicalize-mode` CLI flag in run-pipeline.sh. Manual re-triggers from Settings page run whatever the pipeline server defaults to. This is acceptable for now (both clients are hybrid, all new audits will get the right default once the server reads the column) but should be addressed in an upcoming session.

Phase 2.3c lock determinism fix is present but not load-bearing this run (no prior hybrid state to contaminate). Becomes load-bearing on next IMA re-canonicalize. Report: `docs/phase-2.4-ima-promotion-2026-04-20.md`.

---

**2026-04-20: Lock determinism fix — legacy write exclusion in hybrid mode (Phase 2.3c)**

Root cause of 16.5% canonical_key drift on SMA promotion: legacy and hybrid write to the SAME columns (`canonical_key`, `canonical_topic`, `cluster`) on `audit_keywords`. In hybrid mode, legacy's write is redundant — hybrid overwrites it. But if hybrid fails AFTER legacy writes (as happened during SMA's Phase 2.3b: env bug crashed hybrid, legacy's stochastic Sonnet output remained in DB), any retry captures the contaminated state via `priorHybridSnapshot`.

Fix: `buildLegacyUpdatePayload()` in `src/agents/canonicalize/build-legacy-payload.ts` — when `canonicalizeMode === 'hybrid'`, payload excludes `canonical_key`, `canonical_topic`, `cluster`. These are written exclusively by hybrid's persist step. In legacy/shadow modes, no behavioral change.

The lock predicate and topicMap construction were NOT the bug — both are correct. The 14-topic count (vs prior 12) was from legacy Sonnet's fresh stochastic output, not from a hybrid module defect. SMA's current 14-key state is accepted as the new baseline (legacy contamination from the failed attempt is now the committed state).

Future consideration: dedicated hybrid columns (not sharing with legacy) would make this contamination vector architecturally impossible. Not scoped — current fix is sufficient. Report: `docs/phase-2.3c-lock-determinism-fix-2026-04-20.md`.

---

**2026-04-20: SMA promoted to hybrid canonicalize — SUCCESS WITH OBSERVATIONS**

SMA (`c07eb21d`) promoted from `canonicalize_mode='legacy'` to `'hybrid'`. First production hybrid client. Pipeline ran to completion. All committed content preserved, performance data intact, no data loss.

Key observation: 21 of 127 keywords (16.5%) had different canonical_key values post-promotion despite all being `prior_assignment_locked`. Root cause diagnosed and fixed in Phase 2.3c (see entry above). Zero operational impact on SMA (0 active clusters, no committed content affected).

Infrastructure changes: Added `canonicalize_mode TEXT DEFAULT 'legacy'` column to `audits` table (was CLI flag only). Fixed env propagation bug in `pipeline-generate.ts` (same as `run-canonicalize.ts` fix from shadow validation). Report: `docs/phase-2.3b-sma-promotion-2026-04-20.md`.

---

**2026-04-20: Size gate — clusters with <3 members ineligible for vector auto-assign**

`MIN_CLUSTER_SIZE_FOR_AUTO_ASSIGN = 3` in `src/agents/canonicalize/hybrid/pre-cluster.ts`. Clusters with fewer than 3 members route to Sonnet arbitration instead of vector auto-assign, regardless of similarity score. Prior-locked variants bypass the gate entirely (lock evaluates first).

Rationale: IMA data showed single-member clusters (e.g., "EMT Jobs" with 1 member) pulling geo variants via centroid = single vector. A single vector lacks the averaging effect of multi-member centroids, creating false-confidence auto-assigns. Post-gate validation: 62.7% of size-gated keywords were redirected to different (better-fit) clusters by Sonnet, confirming the cold-start vulnerability.

N=3 calibration: IMA has 9 clusters with <3 members (15.8% of topics), affecting 50 keywords (5% of corpus). Cost: ~1.25 extra Sonnet batches per run. N=2 would miss 2-member clusters that still lack centroid diversity. N=4 would over-route and defeat the efficiency purpose of vector auto-assign.

Classification method `sonnet_arbitration_size_gated` distinguishes these cases from natural-ambiguity arbitrations in the audit trail. This allows monitoring of size gate behavior without conflating it with genuine ambiguity.

---

**2026-04-20: Auto-assign threshold lowered from 0.85 to 0.82**

IMA shadow data showed 82/83 cases in the 0.80–0.85 band were assign_existing Sonnet arbitrations (98.8% vector agreement). Lowering AUTO_ASSIGN_THRESHOLD from 0.85 to 0.82 in `src/agents/canonicalize/hybrid/pre-cluster.ts` eliminates ~50 redundant Sonnet calls per 1000-keyword audit. The ambiguity band becomes 0.75–0.82 (lower bound unchanged).

Post-change validation: IMA auto-assign rate increased from 5.6% to 10.7%. In the 0.82–0.85 band specifically, 76% of newly auto-assigned keywords went to the same cluster Sonnet had previously chosen. The remaining 24% were categorically benign (more specific routing or equivalent cluster naming). SMA showed 100% prior-lock stability — the threshold change has no effect on locked keywords.

This is a one-way door: reverting would cause re-run instability (auto-assigned keywords that are now locked at 0.82+ would need to re-arbitrate). The 0.75 lower bound was explicitly NOT tuned — that requires separate analysis.

---

**2026-04-20: Lock predicate must snapshot hybrid assignments before legacy canonicalize runs**

The hybrid lock predicate (classification_method IS NOT NULL → preserve prior assignment) has a sequencing dependency: legacy canonicalize runs FIRST and overwrites canonical_key in the DB, then hybrid reads from the DB. Without a snapshot, the lock preserves legacy's overwrite, not hybrid's prior value. This was caught by the re-run stability test: 76/127 SMA keywords moved clusters between identical hybrid runs because the lock was locking the wrong value.

Fix: `runCanonicalize()` snapshots all (id → canonical_key, canonical_topic) pairs where classification_method IS NOT NULL before legacy runs. This snapshot passes to `runHybridCanonicalize()` as `priorHybridSnapshot`, which overrides DB-read values for hybrid-origin keywords. After fix: 0 movements, 100% lock rate, output identical between runs.

This is a fundamental ordering constraint: any consumer of hybrid-origin data that runs after legacy must read hybrid's values from a pre-legacy snapshot, not from the DB. If a new module is added between legacy and hybrid, it must either not touch canonical_key or participate in the snapshot protocol.

---

**2026-04-20: Arbitration batches at 40 cases per Sonnet call**

107 SMA arbitration cases in one call hit the 8192 default max_tokens limit, producing truncated JSON. Fix: (a) added `canonicalize-arbitration: 16384` to PHASE_MAX_TOKENS, (b) batched into chunks of 40. New topics from earlier batches accumulate into the topic list so later batches can reference them. IMA's 934 cases ran cleanly across 24 batches.

40 was chosen because: ~80 tokens per case response × 40 = ~3200 output tokens, well within 16384. Prompt size grows linearly with case count + topic list (~50 tokens per topic × 49 IMA topics ≈ 2450). At 40 cases per batch, total prompt fits comfortably even with 50+ topics.

---

**2026-04-17: Hybrid canonicalize uses vector-first clustering with Sonnet arbitration only for ambiguous cases**

Phase 2 of the embeddings initiative restructures canonicalization from pure-Sonnet single-shot to a three-stage pipeline: (1) embed keywords via OpenAI text-embedding-3-small, (2) cosine-similarity pre-cluster against existing topic centroids (0.82+ auto-assign, 0.75-0.82 ambiguity band, <0.75 new topic), (3) Sonnet arbitration only for the ambiguity band and new-topic candidates. (Note: threshold was initially 0.85, lowered to 0.82 in Phase 2.1 — see separate entry.) This reduces Sonnet calls by ~60-80% on re-runs and produces deterministic, reproducible clustering for the auto-assigned majority.

Three modes: `legacy` (unchanged), `hybrid` (vector-first, writes primary columns), `shadow_hybrid` (vector-first, writes shadow_* columns only). Shadow mode preserves legacy output untouched for A/B comparison.

Re-run lock predicate has three AND clauses: (a) prior canonical_key exists, (b) that topic still exists in the current run's topic set, (c) prior classification_method IS NOT NULL (i.e., hybrid-originated). Legacy assignments (classification_method=NULL) are intentionally NOT locked — hybrid's first run after legacy reclassifies everything using vector similarity. This prevents inheriting potentially suboptimal legacy clustering decisions.

Scope is deliberately narrow: hybrid handles ONLY canonical_key/canonical_topic. The is_brand, intent_type, primary_entity_type classifications remain Sonnet-based in the legacy path. `is_near_me` is deterministic (string match `keyword.includes(' near me')` at Phase 3c line ~2628 of `pipeline-generate.ts`), not Sonnet-classified.

---

**2026-04-17: Shadow columns for hybrid comparison instead of JSONB blob**

Shadow-mode hybrid output goes to dedicated shadow_* columns (shadow_canonical_key, shadow_canonical_topic, shadow_classification_method, shadow_similarity_score, shadow_arbitration_reason) rather than a shadow_data JSONB column. Dedicated columns allow SQL filtering/aggregation in the comparison script without JSON extraction functions, and make the schema self-documenting. These columns are NULL for non-shadow runs. Migration 018.

Initial implementation incorrectly wrote hybrid results to primary columns (canonical_key/canonical_topic) in all modes — this was caught during review and fixed before any shadow run. The correctness property: shadow mode NEVER touches canonical_key, canonical_topic, or cluster columns.

---

**2026-04-17: Arbitrator uses dependency injection (_setCallClaude) instead of direct import**

The hybrid arbitrator module lives in `src/agents/canonicalize/hybrid/arbitrator.ts` but needs `callClaude()` from `scripts/anthropic-client.ts`. Direct import violates TypeScript's rootDir boundary (src/ cannot import from scripts/). Rather than restructuring the project, the arbitrator exposes `_setCallClaude(fn)` which `pipeline-generate.ts` calls before invoking the hybrid path. This keeps the module boundary clean and makes the dependency explicit. The arbitrator throws if called without injection — fail-fast, not silent fallback.

---

**2026-04-13: Content queue uses soft-delete (status=deprecated), not hard delete**

Removing a page from the Execution content queue sets `status='deprecated'` rather than deleting the row. Consistent with the existing Michael re-run deprecation pattern (Migration 012). Data is preserved for audit trail; the pipeline re-run would restore the page if appropriate. `useExecutionPages()` now filters `.neq('status','deprecated')` so removed pages are invisible in the dashboard but the row persists in the DB. Published pages are excluded from the remove action — you must un-publish before removing. Soft delete chosen over hard delete because: (a) pages may have Pam brief content that is non-trivial to regenerate, (b) reversibility is cheap, (c) the "add page" flow exists for users who want a different slug.

---

**2026-04-13: Cluster activation step 12b — silo-match fallback for Michael pages with null canonical_key**

`generateClusterStrategy()` step 12 activates execution_pages by `canonical_key = args.canonicalKey`. Michael-sourced pages get `canonical_key` via a backfill in `syncMichael()` that matches `primary_keyword` to `audit_keywords.keyword`. When that match fails (keyword phrasing mismatch between blueprint and keyword table), the page retains `canonical_key=null` and is invisible to step 12.

Added step 12b: after the canonical_key update, also update pages WHERE `silo = cluster.canonical_topic AND canonical_key IS NULL`. Sets both `cluster_active=true` and `canonical_key=args.canonicalKey` so deactivation works correctly on subsequent runs. Silo name is the join key because Michael assigns silo from the blueprint's silo header, which matches `audit_clusters.canonical_topic`. This is a safe secondary filter — it only fires on rows the first query already missed, and setting `canonical_key` on those rows is a repair, not an override.

Observed on forgegrowth.ai audit `d1a9b155`: `services/local-seo` (Michael-sourced, `silo='Local SEO'`, `canonical_key=null`) was not activated when the Local SEO cluster (`canonical_key='local_seo'`, `canonical_topic='Local SEO'`) was activated. Step 12b would have caught it. DB patched directly for this instance.

---

**2026-04-13: Anthropic streaming 'terminated' error is retryable**

Oscar's content phase uses `max_tokens=65536`, which triggers streaming via `client.messages.stream(...).finalMessage()`. When the stream connection drops mid-response, the Anthropic SDK throws `Error('terminated')`. `isRetryable()` in `anthropic-client.ts` caught `ECONNRESET`, `fetch failed`, and `ETIMEDOUT` for network-class errors but not `'terminated'`. All 3 retry attempts were bypassed, propagating a hard failure.

`'terminated'` added to the network error check alongside the other stream-drop signatures. The error is transient (network hiccup between Railway and Anthropic), not a structural problem (bad prompt, context overflow, auth failure). Do not confuse with `APIUserAbortError` — that indicates a client-side abort and is not retryable.

---

**2026-04-09: Intel layer scoped to content effort only — framework deferred**

An "intel layer" proposal was drafted to create a persistent `configs/intel/` directory containing markdown files for Google ranking signal knowledge (derived from the May 2024 API Content Warehouse leak), injected into Phase 1b, Phase 5, Phase 6 (Michael), Pam, Oscar, and Cluster Strategy (Opus) prompts at generation time. Proposed initial files: `scoring-signals.md` (8 modules of named signals) and `content-effort-spec.md` (five effort dimensions for service businesses). Proposed framework: `readIntelFile()` + `extractIntelSections()` utilities, PIPELINE.md contract additions for each affected phase, CHANGELOG discipline, `agent_runs.metadata.intel_files_injected` logging.

**Decision**: implement only the content effort spec, and only in `configs/oscar/seo-playbook.md` as a new section 5 (no code changes, no `configs/intel/` directory, no framework). Park `scoring-signals.md` at `docs/research/google-signals-leak.md` as human consultation material — not injected into any agent prompt. Defer Pam injection, Michael injection, Cluster Strategy injection, Phase 1b/5 injection, and the framework scaffolding entirely.

**Why the framework was deferred (YAGNI)**:
- Two intel files is not a framework-worthy quantity. The framework cost (PIPELINE.md contract updates across 6 injection points, two utility functions, section extraction heading conventions, metadata logging, CHANGELOG discipline) is justified when 3+ files genuinely need coordinated injection patterns. Right now it's architectural speculation.
- Single-file disk edits (seo-playbook.md) are already the simplest possible injection pattern. Building a framework on top of that pattern adds complexity without adding capability.
- Accumulated context drift is a real risk the proposal itself flagged — multiple intel files × multiple agents × version iterations eventually produces contradictory instructions that are hard to trace. The framework makes adding more files cheap, which is precisely when drift accelerates.

**Why Michael injection was deferred specifically**:
- Prompt compliance just failed on SMA (`c07eb21d`): Michael corrupted 13+ url_slugs with parenthetical annotations, and Pam overrode `entity_map.entity_type` on schema generation. The root cause in both cases was agents ignoring directives already in their prompts. Adding MORE prompt content to Michael before validating the slug-style hardening holds against a real run would create confounding variables — if the next Michael blueprint comes back clean, was it from the slug rules or from the new `siteRadius/siteFocusScore` constraint? Untestable.
- The proposal's own self-critique flagged that `siteRadius` framing could cause Michael to over-prune the blueprint, interpreting "minimize topical drift" as "only recommend pages semantically identical to core services." That would destroy the informational/comparison/process content that actually drives effort scoring. The constraint needs a coherence-test framing, not a minimization framing — and the timing to design that framing is after SMA re-runs clean, not before.

**Why `scoring-signals.md` was parked, not injected**:
- The hexdocs leak confirmed schema field existence. It did NOT confirm field weight, live deployment status, or composite signal formulas. The file's prose makes strong claims about implications ("Topic dilution is a measurable penalty," "Variance is penalized independently from average quality") that are plausible interpretations, not verified behavior. When injected into agent prompts, Sonnet treats interpretive prose as operational fact.
- Human reasoning can hold the "confirmed schema field / uncertain weight" distinction. Agent prompts can't.
- The right place for speculative reference material is `docs/research/` where a human consults it before making prompt decisions — not `configs/intel/` where an agent reads it at generation time.

**Why content effort earned the single-file implementation**:
- The five effort dimensions with concrete low/high contrast examples are effective prompt engineering independent of whether "contentEffort" is the specific Google signal being optimized for. Show-don't-tell with before/after beats abstract directives regardless of source motivation.
- Oscar is downstream of Pam. Injecting the spec into Oscar's seo-playbook (disk read, no code change) is the cheapest test — if it produces better HTML, the effect surfaces without any code risk. If Oscar produces wall-to-wall `[PLACEHOLDER:]` flags because client_profiles lack depth, that's a signal the dimensions need source-hierarchy tuning before wiring into Pam.
- The spec was revised before insertion to resolve five integration conflicts with the existing playbook: flag taxonomy unified to `[PLACEHOLDER:]` (no new `<!-- REVIEW -->` convention), readability-vs-precision tiebreaker added, em dashes removed from Target examples to respect the existing anti-pattern rule, source-of-truth hierarchy made explicit (Pam brief → client_profiles → industry standards, no fabrication), Dimension 5 (Evidence Anchoring) reframed as baseline rather than per-page-type primary emphasis.

**Observation point**: first Oscar run against the updated playbook. Watch for (a) whether dimensions surface in production HTML or collapse into placeholder flags, (b) whether the readability target vs. technical precision tiebreaker produces scannable output or dense prose walls, (c) whether Pam's existing `effort_risk` flags (if any — Pam doesn't emit these yet) get resolved correctly. If Oscar output improves cleanly, Pam injection becomes the next consideration. If Oscar produces degraded or placeholder-heavy output, the spec needs revision before any further injection.

**What is NOT in this decision**:
- No commitment to building the framework later. If a future intel file is proposed, it will be evaluated on its own merits with the same YAGNI filter.
- No commitment to Pam injection. That is a separate decision contingent on observed Oscar output quality.
- No claim that Google's `contentEffort` signal weight is known. The operational spec is useful regardless.

---

**2026-04-09: Pam must treat `entity_map.entity_type` as an override, not a suggestion**

`generate-brief.ts` contained two competing directives in the schema generation prompt: (a) "the schema JSON-LD you produce must use the entity type and key attributes defined in the entity_map" and (b) "use the most specific Schema.org @type available — for vocational training programs, prefer EducationalOccupationalProgram over Service; for content pages about a program, prefer Course over Article." No explicit precedence between the two. When Pam had to pick, the general specificity rule won because it matched keyword patterns in the page context.

Observed on SMA (audit `c07eb21d`, page `/online-emt-course/cost`): Cluster Strategy's entity_map specified `Course` with `hasCourseInstance` for state variants. Pam emitted `"@type":"EducationalOccupationalProgram"` on the `#course` node instead. Both types are valid schema.org entities, but the entity_map contract is the whole point of generating an expensive Opus strategy per cluster — if Pam can override it on a per-page basis, the cluster's entity graph becomes incoherent across pages.

**Fix scope (Issue 3 of 3 integrity fixes queued for 2026-04-09)**:
1. Prompt fix in `generate-brief.ts`: move the entity_map directive above the specificity rule. Make it hard-binding: "WHEN `entity_map.entity_type` IS PRESENT, use it verbatim for the primary entity @type. Do not substitute a more specific type." Rewrite the specificity rule to apply ONLY as fallback when entity_map is absent (legacy audits, ad-hoc pages without cluster activation).
2. Post-generation assertion: if entity_map was provided to the prompt, walk the parsed schema `@graph` and collect all `@type` values. If the expected type is not among them, log a drift record to `agent_runs` with `agent_name='pam-schema-drift'`, `status='completed'`, and `metadata` containing `url_slug`, `canonical_key`, `expected_type`, `actual_types`, and `pam_request_id`. `pam_requests` has no `metadata` column so `agent_runs` is the only table — the dashboard Clusters/Settings page can query `agent_runs` for distinct agent_names to surface "schema drift detected" as an actionable signal. Drift is non-fatal: the brief still ships, the drift is logged for visibility.
3. Oscar untouched — Oscar reads the schema Pam already wrote. The decision point is Pam.

Existing pages with drifted schema are SEO quality debt, not a broken surface. Regeneration is per-page via the dashboard "Regenerate" button.

---

**2026-04-09: Michael's blueprint parser is prompt-hardened first, validator-hardened second**

`parseArchitectureBlueprint()` (in `sync-to-dashboard.ts`) extracts rows from markdown tables under `### Silo N:` headings, reading `url_slug` from a slug/url/path column by index. When Sonnet writes slugs with CTAs, comparisons, or annotation notes inline (e.g., `aemt-course-online (enrollment CTA), upcoming-advanced-emt-classes` or literal em-dash placeholders), the parser has no validation and stores the entire cell as a slug. These corrupted rows propagate through `syncMichael()` into `execution_pages`, producing pages that can never be fetched at those URLs.

Observed on SMA (audit `c07eb21d`): 13+ `execution_pages` with `source='michael'` and slugs like `online-emt-course (national), all geo cluster pages, emt-online-vs-in-person`, `—` (bare em dash), and `aemt-course-online (what is AEMT, scope of practice), aemt-vs-emt`. All 13 are Michael-sourced — cluster_strategy-sourced pages (state pages + cost page) are clean.

The fix is phased, not layered-simultaneous: **prompt first, then parser validation, then QA gate**. A parser validator that silently drops rows is still wrong if the prompt keeps producing dirty output — "silently dropped" is not better than "corrupted." The prompt has to be fixed first so the parser validator becomes a backstop, not a filter.

**Fix scope (Issue 2 of 3, phased)**:

*Phase A (deploy first):* Prompt hardening in `runMichael()` (`scripts/pipeline-generate.ts`). Add a STYLE RULES block: "URL slug column must contain ONE slug per row, no parentheticals, no commas, no em dashes, no notes. Use the 'Action Required' column for enrollment CTAs, annotations, comparisons, and cross-references." Add a rejection example showing the observed corruption pattern.

*Phase B (after A stabilizes):* Parser validation in `parseArchitectureBlueprint()`. After `cleanSlug` normalization, validate against `^[a-z0-9\-\/]+$`. If slug contains comma, paren, em dash, or em-dash placeholder: log warning, skip row, increment `parseWarnings` counter. On completion, if `parseWarnings > 0`, write to `agent_runs.metadata.parse_warnings` so dashboard can surface it.

*Phase C (with B):* Pre-flight slug validity check before `runQA()`. Count tables and count rows with invalid slugs. If >10% corruption, ENHANCE the output via the existing QA retry infrastructure instead of accepting. Michael already has this retry path — adding a deterministic check is ~10 lines and prevents the problem from ever reaching sync.

SMA's existing `agent_architecture_pages` corruption is handled by one-shot cleanup or Phase 6 re-run, not an emergency.

---

**2026-04-09: `cluster_strategy` orphaning by canonicalization is deprecation, not remap**

Cluster Strategy (Opus, ~$0.15–0.50/cluster) is generated on-demand by `/activate-cluster` and stores `canonical_key` as a foreign key to `audit_clusters`. Phase 3c (Canonicalize) runs during full pipeline re-runs and renames canonical keys based on updated semantic clustering. When this happens, `rebuildClustersAndRollups()` logs orphaned activations to `agent_runs.metadata` but leaves `cluster_strategy` rows with a `canonical_key` that no longer exists in `audit_clusters`.

Observed on SMA (audit `c07eb21d`): cluster_strategy for `online_emt_course` generated 2026-04-01 with `canonical_topic = "Online EMT Course"`. Apr 2 re-canonicalization renamed the cluster to `emt_basic_course` with `canonical_topic = "EMT Basic Course"`. Execution_pages were rewired to the new key during rebuild, but cluster_strategy kept the old key and the old topic label. Dashboard queries joining `audit_clusters` to `cluster_strategy` by canonical_key miss the strategy entirely.

**Why remap-by-topic-match does NOT work**: the initial fix plan was to build an old→new canonical_key map by comparing `canonical_topic` strings before DELETE. Verification against SMA's actual rows shows `canonical_topic` drifts along with `canonical_key` — Sonnet's canonicalization rephrases the human-readable label, not just the slug. "Online EMT Course" → "EMT Basic Course" is not a string-matchable rename. Any exact-match remap logic would fail on exactly the cases it's meant to fix.

Remap-by-keyword-overlap (compute Jaccard similarity on the keyword set in each cluster) would work in theory but introduces a non-deterministic linkage that can produce wrong matches silently. The cost of a wrong remap (Opus strategy attached to the wrong cluster) is worse than the cost of orphaning (Opus strategy inaccessible but preserved).

**Fix scope (Issue 1 of 3)**: Mark orphaned `cluster_strategy` rows as deprecated rather than attempting remap.

1. Migration: add `status text default 'active'` and `deprecated_at timestamptz` to `cluster_strategy`. Verify via `information_schema.columns` before writing the migration.
2. `rebuildClustersAndRollups()`: after the DELETE/INSERT cycle and cluster_records build, compute `lostKeys = activeClusterKeys \ new canonical_keys`. For each lost key, UPDATE `cluster_strategy` SET `status = 'deprecated'`, `deprecated_at = now()` where `audit_id = ? AND canonical_key IN lostKeys`. Does NOT delete the strategy document — preservation is deliberate for audit trail and future manual remap decisions.
3. Dashboard (follow-up PR): Cluster Focus page queries `cluster_strategy` by canonical_key AND `status = 'active'` only. Deprecated strategies can be exposed under a separate "Archived Strategies" panel for review.
4. Settings page re-canonicalization flow gets a pre-run warning: "This will rebuild clusters from the latest keyword snapshot. If canonical keys change, existing cluster strategies may be deprecated. Continue?"

The latent variant of the URL-slug problem (new cluster_strategy runs on the renamed cluster recommend a new URL structure, orphaning existing execution_pages from the old URL tree) is addressed by the deprecation flow: dashboard users see the deprecated strategy and can choose whether to regenerate or leave the existing URL structure intact. The existing SMA schema @id URLs are internally consistent (they derive from `url_slug`, not from `canonical_key`) so the stored HTML remains correct.

---

**2026-04-09: Scout filters non-commercial keywords from top_opportunities**

`isCommercialKeyword()` strips three categories from `top_opportunities` (and the share-report gap table) before they reach the prospect:
1. **Informational prefixes** — "what is/are/does", "how to/do/does", "who is", "where is", "why do/does". These are FAQ queries, not buyer intent.
2. **Brand/navigational** — keywords containing 2+ tokens from the prospect's company name or domain stem (filler words like "the/of/in" excluded; topic root words excluded so a brand named "Castle Lock" doesn't kill "lock change boise").
3. **"Best X" queries** — ALL of them. Initially we tried to keep "best X" when X matched a service category, but real-world data showed too much noise: "best car key" is shopping for a key fob on Amazon, "best safe" isn't a locksmith service at all. Listicle/comparison intent doesn't convert for local service businesses, full stop.

Filter applies in `runScout()` only, not `generateKeywordCandidates()` (Phase 2). Scout sees the prospect with no client context, so these queries pollute the gap story; Phase 2 has full context to use them properly.

---

**2026-04-07: Franchise/network domains are a prospector-level filter, not a Scout fix**

Scout narratives are written for single-location independent operators. When a brand appears across multiple geo-modified domains (e.g., `speedy-locksmith-boise.com`, `speedy-locksmith-phoenix.com`), the data isn't wrong but the framing is — a franchise owner doesn't need "you're invisible in Boise" messaging. Sending a single-location narrative to a network operator undermines credibility.

This is NOT a Scout-level fix. Scout processes one domain at a time and has no visibility into sibling domains. The correct screening point is SERP Prospector, which sees all domains from a SERP pull and can detect when a brand name appears across multiple geo-modified domains (strong franchise/licensed network signal). Until automated detection is built, the manual rule is: before sending any Scout report, verify the domain is an independent single-location operator. Franchise or network = skip.

---

**2026-04-07: "Near me" keywords filtered from Scout — GBP-driven, not on-page SEO**

"Near me" queries (e.g., "locksmith near me") are resolved by Google using user location + GBP signals, not on-page content. DataForSEO position data for these terms is noise — position 100 (synthetic) is meaningless, and real rankings are GBP-driven. Filtering happens in two places: (1) removed from synthetic candidate generation (saves DataForSEO budget), (2) stripped from ranked keywords after dedup, before topic filtering (catches "near me" from DataForSEO ranked results). `near_me_filtered` count added to scope.json for transparency. Phase 2 (full pipeline) is NOT changed — Phase 3c already flags with `is_near_me` via deterministic string match (`keyword.includes(' near me')` in `pipeline-generate.ts`), not Sonnet classification.

---

**2026-04-07: Scout topic matching uses word-level roots, not full-phrase substring**

Topic stems like "locksmith services" required the ENTIRE phrase to appear in a keyword for it to match. "locksmith boise" failed because it contains "locksmith" but not "locksmith services". Word-level matching strips generic suffixes (services, repair, installation, replacement, etc.) to extract root words, normalizes plurals by dropping trailing 's', and scores keywords by root-word overlap. Best score wins; ties broken by specificity (more root words = more specific topic). This fixed ~55% of keywords falling to "Other" in locksmith verticals.

---

**2026-04-06: Startup reconciliation resets orphaned jobs, not shutdown-time cleanup**

When Railway sends SIGTERM, the server drains connections and exits cleanly (code 0). But detached child processes (pipeline runs, Pam, Oscar) get SIGKILLed when the container tears down, leaving Supabase records stuck in `running`/`processing`. Cleanup happens on the NEXT startup, not during shutdown, because: (1) Railway SIGKILLs the container 30s after SIGTERM — not enough time to wait for long-running pipelines, (2) the new instance is the one that needs consistent state, (3) no race condition between old and new instances.

The 60-second delay before first reconciliation ensures the old instance has fully exited (Railway's drain period). The `inFlight` check prevents resetting jobs that the current instance legitimately started. The 10-minute threshold for `pam_requests`/`oscar_requests` avoids racing with brief/content generation started on the current instance (no generation takes 10 minutes).

Reconciliation does NOT touch `execution_pages` because Oscar only writes `status = 'in_progress'` + `content_html` as a single atomic update AFTER HTML generation completes. If Oscar gets killed during the Claude call, `execution_pages` stays at its previous status (`not_started`/`brief_ready`). The orphaned record is always `oscar_requests`, not `execution_pages`. Same for Pam.

---

**2026-04-03: Scout keyword deduplication uses suffix-only state stripping**

`buildCanonicalKey()` normalizes keywords for near-duplicate detection by lowercasing, then stripping ONLY the last token if it matches a US state name, then sorting remaining tokens alphabetically. This means "water heater repair boise idaho" → strip "idaho" → sort → key, but "idaho falls water heater repair" → "repair" is last → no stripping → "idaho" preserved as part of the city name. The suffix-only approach is intentional to avoid mangling compound city names (Idaho Falls, New York, etc.). Do not change this to strip state names from any position.

---

**2026-04-03: Scout CPC backfill marks inferred values, never overwrites measured data**

When a keyword has $0 CPC but other keywords in the same topic have measured CPC, we backfill from the topic's max CPC and set `cpc_inferred: true`. This is strictly additive — measured CPC values are never touched. The gap table shows inferred values with a tilde prefix (`~$20.68`), and the report prompt includes an explicit instruction not to misrepresent inferred values as measured. `scope.json` carries `cpc_inferred` on individual opportunities and `max_topic_cpc` at root. Jim Phase 3 ignores unknown keys, so this is not a breaking change.

---

**2026-04-03: Scout candidate expansion only activates for low-presence domains**

Intent modifier variants (`best {service} {city}`, `{service} cost {city}`, `{service} services {city}`, `{service} near me`) and the raised keyword cap (200→500) are gated behind `rankedKeywords.length < 50`. High-presence domains that already have 50+ ranked keywords never enter this path — their existing ranking data is rich enough. The `SCOUT_SESSION_BUDGET` ($2.00) check still enforces the cost ceiling for all domains regardless.

---

**2026-04-03: Scout share report removes all technical sections for prospect audience**

The share page (`ScoutShareReport.tsx`) no longer includes the collapsible Technical Details section (which rendered the full scout_markdown with Opportunity Map, Gap Matrix, Canonical Topic Set, etc.). These are replaced by a "Revenue You're Missing" section with a lead card and simple gaps table using business-language headers ("Search Term", "Monthly Searches", "Ad Cost/Click"). The full scout_markdown remains accessible on the dashboard at `/scout/:id`. The share page is for service business owners, not SEO professionals.

---

**2026-04-03: NarrativeSection share variant leads with problem, not wins**

The `NarrativeSection` component accepts a `variant` prop (`'share'` | `'dashboard'`). In share variant, "Where Demand Is Escaping You" renders before "Where You're Winning" — problem first creates urgency, then acknowledging wins builds trust. Accent colors follow heading meaning (green=winning, orange=escaping) regardless of position. Reorder only activates if both expected headings are found (defensive guard against unexpected narrative formats).

---

**2026-04-02: Em dash style constraint in all client-facing LLM prompts**

Excessive em dash usage is a common tell for AI-generated content — prospects may perceive it negatively. All four client-facing prose prompts (scout report, prospect narrative, prospect brief, client brief) now include a STYLE RULES block: "Avoid em dashes. One per section maximum. Use periods, commas, or restructure sentences instead." This is intentional and should not be removed. Internal/technical prompts (Dwight, Jim, Michael, QA) do not have this constraint since their output is not client-facing.

---

**2026-04-02: Scout share report uses imported icon, not public/brand/ path**

The Scout share page (`ScoutShareReport.tsx`) imports `forge-growth-icon.png` from `src/assets/` (Vite import, always bundled) instead of referencing `/brand/...` from `public/`. The `public/brand/` PNGs are now also committed to git (for other pages that use them), but the share page uses the import path because it's guaranteed to work regardless of static asset serving.

---

**2026-04-02: Client brief download uses /artifact endpoint, not a new endpoint**

The pipeline server's `/artifact` endpoint already serves any file from `audits/{domain}/` by path. Rather than adding a dedicated `/read-client-brief` endpoint, the `read_client_brief` edge function action calls `/artifact` with `file: 'reports/client_brief.html'`. This reuses existing infrastructure and works for any future report file without new server endpoints.

---

**2026-04-02: Performance tracking is opt-in per audit (performance_tracking_enabled)**

`cron-track-all.ts` runs monthly and calls DataForSEO ranked_keywords (~$0.05/audit). Without a filter, every completed audit incurs cost whether or not anyone cares about ongoing tracking. `performance_tracking_enabled` (boolean, default false) gates cron inclusion — superadmin toggles it on the Audits Dashboard.

The recency threshold in `track-rankings.ts` changed from 6 days (weekly) to 25 days (monthly) to match the cron cadence. The on-demand "Track Rankings" button in Settings always passes `force: true` through the edge function so it bypasses the threshold — an explicit user action should never be silently skipped.

---

**2026-04-01: Scout allows empty target_geos for national geo mode**

When `geo_type === 'national'`, `target_geos` is legitimately empty — national mode uses no geo qualifiers on keywords and defaults to location code `2840` (US national). Three code paths in `runScout()` were updated:

1. **Validation** (line ~4412): checks `geo_type` before rejecting empty `target_geos`
2. **Synthetic keywords** (Step 2 fallback): bare topic patterns (e.g., `"seo agency"`) instead of `{pattern} {geo}` combinations
3. **Opportunity map** (Step 3): bare topic phrases (e.g., `"search engine optimization"`) instead of `{topic} {metro/state}` combinations

All three had the same root pattern: iterating `target_geos` or `allGeos` produced zero candidates for national mode. The dashboard's `buildPipelineGeos('national')` correctly returns `[]` — the pipeline just wasn't handling it.

---

**2026-04-01: agent_runs has no token columns — do not insert input_tokens/output_tokens**

`generate-cluster-strategy.ts` was inserting `input_tokens: 0, output_tokens: 0` into `agent_runs`, but that table has no such columns. The Supabase client silently failed with a schema cache error. This caused the `agent_runs` row to never be created for cluster activations. If token tracking is needed later, add columns via migration first.

---

**2026-04-01: Re-run stability — committed page protection and scenario detection**

When a pipeline re-runs for an existing audit, three scenarios are detected via `agent_runs`:
- **first_run**: No prior completed run → standard INSERT/upsert behavior
- **strategic_rerun**: Prior completed run + generation phase re-ran → committed pages preserved, stale uncommitted pages deprecated
- **failure_resume**: Prior completed run + `startFrom` is past the generation phase → full replace (re-syncing same artifacts)

"Committed" is defined in `scripts/rerun-utils.ts`: `status !== 'not_started' || source === 'cluster_strategy' || source === 'manual' || published_at != null`. This predicate lives in one shared file because it will evolve (e.g., deprecation TTL).

syncDwight preserves user-modified fix statuses from prior `audit_snapshots` during re-runs. Priority chain: fresh parse (flagged) → prior snapshot restore → Phase 1a verification (authoritative).

syncMichael conditional upsert: committed pages get metadata-only updates (page_brief, silo, priority), stale uncommitted pages get `status: 'deprecated'`. Michael's prompt in re-run mode receives committed architecture table + GSC/GA4 performance data + deprecation candidates output section.

`source` column values: `michael` (syncMichael), `cluster_strategy` (activation), `manual` (dashboard useAddRecommendedPages).

---

**2026-04-01: Review gate resumes from Phase 2, not 1b**

`pipeline-controls` edge function (`resume_pipeline` action) passes `start_from: '2'` — not `'1b'`. The original `'1b'` caused an infinite loop: Phase 1b re-ran, hit the review gate again, exited, repeat. Phase 1b (Strategy Brief) is already complete when the user approves the review, so resume must skip it.

---

**2026-04-01: railpack.json adds curl + jq to Railway container**

Railpack's default Node.js image doesn't include `curl` or `jq`. `foundational_scout.sh` (Phase 3 DataForSEO API calls) requires both. `railpack.json` with `deploy.aptPackages: ["curl", "jq"]` restores them. The previous Dockerfile had `apt-get install curl jq` — this was lost when Docker was removed (2026-03-31).

---

**2026-03-31: Streaming for high-token API requests (>16K max_tokens)**

Anthropic API requires streaming for operations that may exceed 10 minutes. `callClaude()` in `anthropic-client.ts` automatically uses `client.messages.stream().finalMessage()` when `max_tokens > 16384`. Returns the same `Message` shape — transparent to all callers. Threshold set at 16K because only `content` (65536) and potentially future phases exceed it. Without this, Oscar requests fail with "Streaming is required for operations that may take longer than 10 minutes."

---

**2026-03-31: Oscar phase name must be passed explicitly**

`callClaudeAsync(prompt, 'sonnet')` only sets the model — it does NOT pass the phase name, so `PHASE_MAX_TOKENS` lookup falls through to `default: 8192`. Oscar must use `callClaudeAsync(prompt, { model: 'sonnet', phase: 'content' })` to get the configured 65536 tokens. This was the root cause of all truncated Oscar output.

---

**2026-03-31: Cloudflare Tunnel retired — Railway direct URL**

`PIPELINE_BASE_URL` points directly to `https://nanoclaw-production-e8b7.up.railway.app`. The Cloudflare Tunnel (`pipeline.forgegrowth.ai` → `localhost:3847`) was originally needed when the pipeline server ran locally behind an Eero router (SEC-2). Railway eliminated that need. Railway provides HTTPS natively; `PIPELINE_TRIGGER_SECRET` bearer token handles auth.

---

**2026-03-31: Docker removed — Railway Railpack**

`Dockerfile.railway` and `railway.toml` deleted. Railway uses Railpack (their default builder) which auto-detects Node.js from `package.json`. `railpack.json` specifies `deploy.aptPackages: ["curl", "jq"]` because `foundational_scout.sh` (Phase 3 DataForSEO calls) requires both. Eliminates EACCES permission issues with volume mounts and the node user UID mismatch.

---

**2026-03-31: Oscar status mapping — `in_progress` not `review`**

`execution_pages.status` CHECK constraint allows: `not_started`, `brief_ready`, `in_progress`, `review`, `published`. Dashboard maps `in_progress` → "Draft Ready" and `review` → "In Review". Oscar writes `in_progress` so drafts appear as "Draft Ready" automatically. The `review` status is reserved for manual user promotion (i.e., "I'm reviewing this draft").

---

**2026-03-30: ADC + SA impersonation over SA key or OAuth for GSC/GA4**

Single operator model. The Forge Analytics service account (`fg-analytics@concise-vertex-490015-d0.iam.gserviceaccount.com`) already has read-only access to test clients' GSC + GA4 properties. Auth uses Application Default Credentials (ADC) + IAM impersonation — not SA JSON keys (blocked by org policy `iam.disableServiceAccountKeyCreation`, correctly). ADC identity (matt@forgegrowth.ai) gets `roles/iam.serviceAccountTokenCreator` on the SA, then `generateAccessToken` produces scoped SA tokens. Local dev: `gcloud auth application-default login`. Railway: `GOOGLE_ADC_JSON` env var (stringified ADC credentials). This eliminates per-user OAuth flows, refresh token storage, and SA key security liability. `analytics_connections` stores only property IDs (not tokens). New clients require adding the SA as read-only user to their GSC/GA4 properties.

---

**2026-03-30: GSC as Phase 1c (not post-pipeline)**

GSC data enriches Strategy Brief (1b), Jim (Phase 3), and Pam (OPTIMIZE). Running before Strategy Brief maximizes downstream value. Non-fatal — pipeline continues if no analytics_connections row exists or if GSC API fails. Positioned after Phase 1a (Verify Dwight) to keep technical crawl data fresh before GSC overlay.

---

**2026-03-30: GA4 extends track-rankings (not in pipeline)**

GA4 behavioral data (sessions, engagement, conversions) only meaningful for published pages. `track-rankings.ts` already runs weekly for completed audits with published content — natural fit. GA4 fetch is non-fatal (step 9 in try/catch). Dynamic import to avoid loading google-auth when no GA4 connection.

---

**2026-03-30: Observed CR is opt-in, never auto-enabled**

`audit_assumptions.use_observed_cr` defaults FALSE. `track-rankings.ts` writes `observed_cr` from GA4 data but never sets `use_observed_cr = true`. Operator must toggle manually via Settings page. Prevents surprise revenue projection changes when GA4 data first arrives.

---

**2026-03-30: Raw HTTP over googleapis package**

No `googleapis` npm dependency. GSC Search Analytics API, GA4 Data API, and IAM Credentials API (for SA impersonation) are simple REST endpoints with straightforward request/response shapes. ADC token refresh uses standard OAuth2 `refresh_token` grant. Keeps dependency footprint minimal.

---

**2026-03-30: Cluster Strategy Section 5 outputs structured JSON, not prose**

Section 5 (AI & Search Optimization) was converted from markdown prose to structured JSON (`ai_targets[]` with `query`, `target_type`, `structural_pattern`, `applies_to_page`, `condition`, `rationale`). Rationale: Pam needs machine-readable targets to inject into per-page briefs — prose recommendations can't be filtered by page or mapped to specific structural patterns. The structured format lets Pam filter targets relevant to the current page (`applies_to_page` match or null for cluster-wide) and inject them as typed guidance for Oscar. The prose fallback (`ai_optimization_notes`) is preserved for backward compatibility and for rendering the full strategy document in the dashboard. `ai_optimization_targets` stored as JSONB on `cluster_strategy` (migration 010).

---

**2026-03-30: Pam injects 5 new context blocks conditionally, not unconditionally**

Five new context sections added to Pam's prompt: Technical Baseline (Dwight), AI Citation Gaps (Gap agent), GBP Canonical Entity, Sibling Content Coverage, Performance Context (OPTIMIZE only). All are conditionally injected — if the data doesn't exist (no Dwight snapshot, no GBP listing, no gap analysis, no sibling briefs, not OPTIMIZE mode), the section is an empty string and adds zero tokens. This avoids bloating the prompt for early-stage audits where most enrichment data doesn't exist yet. All queries are wrapped in try/catch with empty-string defaults — a failed enrichment query never blocks brief generation.

---

**2026-03-30: GBP canonical NAP takes priority over client_profiles for schema Organization entity**

When GBP data exists, Pam's prompt instructs schema generation to use GBP canonical name/address/phone verbatim, not client_profiles values. Rationale: GBP is the authoritative external identifier that Google's Knowledge Graph uses for entity disambiguation. Schema Organization attributes must match what Google already knows about the business. If GBP says "Veterans Plumbing Corp" and client_profiles says "Veterans Plumbing Corporation", the schema must use the GBP version. Column names in gbp_snapshots are `canonical_name`, `canonical_address`, `canonical_phone` (separate columns, not a nested JSONB object).

---

**2026-03-27: Keyword lookups use single table with batch_id grouping, not a sessions table**

`keyword_lookups` stores one row per keyword result. A UUID `batch_id` groups rows from the same lookup invocation. No separate `keyword_lookup_sessions` table — batch metadata (count, cost, timestamp) is derived client-side via `useMemo` grouping on `batch_id`. Rationale: a sessions table would add a write dependency (insert session first, then reference FK), complicate the best-effort insert pattern (if session insert fails, all keyword inserts fail), and provide no benefit — the only consumer is the history accordion which already groups client-side. The unique constraint `(audit_id, batch_id, keyword)` prevents duplicate rows from retries without needing session-level dedup. `estimated_cost` is stored as `numeric(10,4)` (not text) to enable future aggregation (total spend per audit, cost trends).

---

**2026-03-26: AI Visibility Analysis uses intent-driven query generation, not ranked keywords**

The AI Visibility Assessment (SOW 2.5) generates queries from client context via Haiku rather than pulling top-ranked keywords. Rationale: top-ranked keywords bias toward organic search performance, which doesn't correlate with AI platform visibility. AI assistants answer natural-language questions ("best HVAC service in Boise") not keyword-shaped queries ("boise hvac repair"). Haiku generates 10-15 queries spanning discovery/consideration/comparison intents from `client_profiles` + `audits.client_context`. Deterministic fallback from `service_key` + `market_city` if client context is too sparse or Haiku fails.

---

**2026-03-26: AI Visibility Analysis runs via child process spawn, not direct import**

`ai-visibility-analysis.ts` lives in `scripts/` (alongside other analysis scripts that import from `scripts/anthropic-client.ts`, `scripts/dataforseo-llm-mentions.ts`, etc). The server's `src/` directory has `rootDir: ./src` in tsconfig, preventing cross-directory imports. The handler spawns `npx tsx scripts/ai-visibility-analysis.ts` and collects JSON via stdout sentinels (`__AI_VIS_RESULT_START__`/`__AI_VIS_RESULT_END__`), matching the spawn pattern used by other handlers while returning results synchronously.

---

**2026-03-26: Competitor AI mention data is re-aggregated to domain totals before prompt injection**

DataForSEO's `/aggregated_metrics/live` endpoint returns one total per domain×platform. The pipeline code then evenly distributes this across keywords (`Math.round(mentionCount / keywords.length)`), creating synthetic per-keyword counts. Both Jim's `aiVisibilityBlock` and Gap's `aiVisibilitySection` now re-aggregate competitor mentions back to domain×platform totals before injecting into prompts. This prevents Jim/Gap from treating synthetic distributions as granular measurements. Both blocks include explicit caveats: "Competitor counts are aggregate totals, not per-keyword measurements."

---

**2026-03-26: Jim Section 11 requires explicit cross-reference pointers for structural gap analysis**

Section 11.4 (Structural Gap Analysis) instructs Jim to cross-reference citation sources against Site Inventory and All Ranked URLs, naming specific signals (schema markup, content depth, structured page patterns). Without these explicit pointers, Sonnet produces generic gap analysis even though the right data is in context. The prompt names the exact data sources and signals because Sonnet won't reliably cross-reference two distant sections of a large prompt without being told to.

---

**2026-03-26: Entity type classification uses Sonnet (not Haiku) in Phase 3c**

Phase 3c (Canonicalize) was upgraded from Haiku to Sonnet before entity anchoring was added. The `primary_entity_type` classification (Service, Course, Product, etc.) runs as part of the existing Sonnet canonicalization call — no additional LLM call. Entity type flows: Phase 3c → `audit_keywords` → `audit_clusters` → Cluster Strategy (Section 0 Entity Map) → Pam (Page Identity block).

---

**2026-03-26: Cluster strategy uses header-based JSON extraction, not positional indexing**

`extractJsonBySection(text, sectionHeader)` finds a section by regex header match, scans to the next `### N.` header, and parses the first JSON code fence within that range. This replaced fragile positional `extractJson(text, index)` calls that broke when new sections were added. Each section's header regex is explicit: `### 0. Entity Map`, `### 1. Buyer Journey Map`, etc.

---

**2026-03-26: Buyer journey pages inserted into execution_pages with slug deduplication**

Cluster strategy's `recommended_pages` are inserted into `execution_pages` with `source: 'cluster_strategy'` (vs `'michael'` for architecture pages). Insertion uses per-row insert with slug dedup check (same pattern as sync-michael) to prevent duplicates if strategy is regenerated. `buyer_stage` and `strategy_rationale` columns carry journey context into Pam's brief generation.

---

**2026-03-26: `select('*')` in Pam's page data query is intentional for migration-order safety**

`generate-brief.ts` uses `.select('*')` instead of listing specific columns when fetching from `execution_pages`. This ensures Pam works regardless of whether migrations for new columns (`source`, `buyer_stage`, `strategy_rationale`) have been applied. Missing columns simply return undefined. This is a deliberate trade-off: slightly less type safety for zero-downtime deployment.

---

**2026-03-25: LLM Mentions budget guard is non-fatal — Jim never fails because of AI visibility**

`fetchAllLlmMentions()` is wrapped in a try/catch inside `runJim()`. If the DataForSEO LLM Mentions API fails, exceeds budget (`LLM_MENTIONS_BUDGET`, default $1.00), or credentials aren't configured, Jim proceeds without AI visibility data. Section 11 (AI Visibility) is conditionally omitted from the narrative, and `llm_mentions.json` is not written. Same principle in `runGap()` — if `llm_mentions.json` is missing, `ai_citation_gaps` defaults to an empty array. The LLM Mentions API is additive intelligence, not core pipeline functionality.

**2026-03-25: Client and competitor LLM mentions share one table with domain column**

`llm_visibility_snapshots` stores both client and competitor mention data in the same table, distinguished by the `domain` column. The alternative was separate tables (`llm_client_snapshots` + `llm_competitor_snapshots`), but the data shape is identical and the 5-column UNIQUE constraint `(audit_id, snapshot_date, keyword, platform, domain)` naturally separates them. Dashboard queries filter by `domain === audit.domain` for client data. This follows the same "data coexistence" pattern used in `ranking_snapshots` (though that table is client-only, the principle of one table per data shape applies).

**2026-03-25: Monthly cron cadence for LLM mentions (not weekly like rankings)**

AI platform mentions change slowly — brands don't appear/disappear from AI outputs week-to-week. The 25-day recency check in `track-llm-mentions.ts` (vs 6-day for rankings) reflects this reality and controls DataForSEO costs. The standalone tracker also only fetches client mentions (no competitor re-check) to further limit API spend. Competitor data is refreshed on full pipeline runs only.

**2026-03-25: Verification layer uses structured corrections map, not inline annotation parsing**

Phase 1a (`verify-dwight.ts`) writes `verification_results.json` with corrections keyed by issue text pattern. `syncDwight()` loads this file after `parseAuditReport()` and merges corrections into fix objects. The alternative was having `parseAuditReport()` detect `[VERIFIED: ...]` annotations in the markdown — rejected because regex-based annotation parsing is fragile and creates coupling between the verification output format and the report parser. The report annotations exist for human-readable disk artifact accuracy only; they are never machine-parsed. `original_severity` is set on ALL fix objects at parse time (not just corrected ones) so future re-verification has a baseline to diff against.

**2026-03-25: Phase 1a runs between Dwight QA and Phase 1b, not before Phase 6c**

Verification runs immediately after Dwight produces AUDIT_REPORT.md (post-QA). The alternative was running before Phase 6c (syncDwight), but Phase 1b (Strategy Brief), Phase 2 (Keyword Research), and Phase 6 (Michael) all read AUDIT_REPORT.md — the report annotation benefits all downstream phases. The corrections map is consumed by syncDwight at Phase 6c regardless of when it was generated.

**2026-03-24: Keyword lookup utility in `src/` not `scripts/`**

`dataforseo-keywords.ts` lives in `src/` because `tsconfig.json` has `rootDir: "./src"` and the server imports it. The pipeline's existing `bulkKeywordVolume()` in `scripts/pipeline-generate.ts` filters zero-volume keywords (correct for revenue modeling). The lookup utility returns ALL keywords including zero-volume — users need to know what has no volume, not just what does. Duplicating the DataForSEO call logic rather than refactoring `pipeline-generate.ts` avoids touching a 1000+ line file for a standalone feature.

**2026-03-24: Keyword lookup is synchronous (200), not async (202)**

Unlike `/trigger-pipeline` and `/recanonicalize` which spawn background processes and return 202, `/lookup-keywords` blocks and returns results directly. DataForSEO volume API responds in 1-5 seconds for up to 1000 keywords — fast enough for synchronous. The 500-keyword cap prevents accidental expensive calls (~$0.075 per 1000-keyword batch per location).

**2026-03-24: TSV clipboard copy instead of CSV**

Spreadsheet apps (Google Sheets, Excel) auto-parse tab-separated values into columns on paste. CSV requires an import dialog. Since the primary use case is paste-into-spreadsheet, TSV is the correct clipboard format. The copy also preserves the current sort order.

**2026-03-24: Static reports via `public/reports/` with Vercel rewrite passthrough**

Self-contained HTML reports (intelligence briefs, etc.) served as static files from Vercel. Required adding a passthrough rewrite rule (`/reports/:path*`) before the SPA catch-all in `vercel.json`. Alternative was Supabase Storage (bucket created, file uploaded) but the Vercel path gives a cleaner URL on the dashboard domain and doesn't require a separate service.

---

**2026-03-24: Validator resilience — max_tokens bump + truncation detection + JSON repair**

Phase 6.5 (Coverage Validator) failed on IMA's audit (35 clusters, 30+ gaps) because `max_tokens: 4096` was too low — JSON response truncated at ~14K chars. Bumped to 16384 (matches other synthesis phases). Added `TruncationError` class and `warnOnTruncation` option to `callClaude()` — when `stop_reason === 'max_tokens'`, always logs a warning; when the flag is set, throws `TruncationError` carrying the partial output so callers can attempt repair. Generalized `repairJSON()` with an optional `arrayKey` parameter (tries specified key for truncation recovery instead of hardcoded `"groups"`). Validator now catches `TruncationError` and attempts `repairJSON(partial, 'coverage')`. Cost impact of token bump: zero (cap, not minimum). Added defensive dedup guardrail to validator prompt as safety net.

**2026-03-24: Gap agent deduplication — canonical_key pre-aggregation + structural prompt constraint**

Phase 5 (Gap agent) produced near-duplicate authority_gaps on IMA (5 EMT variants, 4 burn/first-aid variants) because dominance data had multiple rows per canonical_key (one per geo-variant keyword). Two-layer fix: (1) Pre-aggregate dominance and weakTopics by `canonical_key` before injecting into the prompt — keep the row with lowest `client_share` as representative, prefix each line with `[canonical_key]`. (2) Replace the single "deduplicate semantic equivalents" sentence in the prompt with a structural constraint: each authority_gap MUST correspond to a distinct `[canonical_key]`, max 15 is an upper bound not a target, typical audit 6-12. The `[canonical_key]` prefix provides context; the structural constraint is the enforcement mechanism. Gap QA rubric floor is "5+ specific content gaps" (line ~4607) — target range of 6-12 stays above this, no rubric update needed.

---

**2026-03-23: Phase 2 service_area → Bucket 3 cities + cap raised from 3 to 5**

Bucket 3 (city-qualified keywords in state mode) relied entirely on Haiku extracting city names from AUDIT_REPORT.md. With JS rendering disabled, crawls return thin HTML and Haiku finds 0 locations — Bucket 3 never fires. The user already enters `service_area` in Settings (e.g., "Boise, Nampa, Meridian"). This data was available via `loadClientContextAsync()` as `extras.service_area` but Phase 2 discarded `extras`. Now Phase 2 parses `service_area`, filters out state names (already in Bucket 2), deduplicates against Haiku results, and merges into `locations`. City cap raised from 3 to 5 because explicit user input is reliable (not noisy Haiku extraction). Cost impact: ~160 more candidates in a 500-cap matrix — well within budget.

**2026-03-23: Robust prose parsing for service_area city extraction**

`service_area` is free-text — users enter prose like "Primarily serving Idaho, Eastern Oregon, and Eastern Washington" not just "Boise, Nampa, Meridian". Naive comma-split produced tokens like "Primarily serving Idaho" which, when concatenated with long service names, exceeded DataForSEO's keyword character limit (all 380 candidates rejected → pipeline failed). Parser now: (1) strips leading prose prefixes ("Primarily serving..."), (2) splits on commas AND the word "and", (3) rejects tokens with prose/filler words, (4) rejects directional state patterns ("Eastern Oregon"), (5) rejects tokens >4 words. When no cities are extractable, logs diagnostic instead of injecting garbage. This means `service_area` with only regional descriptions correctly yields 0 city hints — Bucket 3 won't fire, which is correct behavior.

---

**2026-03-10: Moved all DataForSEO/keyword/revenue logic out of run-audit Edge Function into the pipeline**

The `run-audit` Supabase Edge Function used to run DataForSEO keyword fetch + clustering + revenue modeling (Stage 1) before the pipeline existed. When the pipeline trigger was added, this became redundant — the pipeline's Phase 2 (KeywordResearch) and Phase 3 (Jim) handle all keyword seeding and research. The edge function was slimmed to a thin trigger: validate audit, mark as running, POST to pipeline server. It writes **nothing** to audit_keywords, audit_clusters, or audit_rollups.

**2026-03-10: audit_assumptions auto-creation fallback in sync-to-dashboard.ts**

`audit_assumptions` is primarily created by the Dashboard UI's `useCreateAudit` hook, which looks up benchmarks and CTR models at audit creation time. But if the pipeline runs for a domain where assumptions don't exist (e.g., audit auto-created by sync, or assumptions insert failed), `syncJim()` would silently skip all keyword sync — zero keywords, zero revenue, zero rollups. Added `ensureAssumptions()` that runs before any agent sync and auto-creates assumptions from the `benchmarks` table (matching service_key, falling back to 'other') and the default CTR model.

**2026-03-10: Phase 3d (rebuild clusters) added after canonicalize**

Phase 3b (sync jim) inserts keywords and builds clusters in one pass — but at that point `canonical_key` doesn't exist yet. The `cluster` field is populated by `extractTopic()` (naive 5-word truncation), so "air conditioner repair boise idaho" and "air conditioner repair boise" become separate clusters. Phase 3c (canonicalize) then assigns `canonical_key` to group them, but never rebuilt the clusters. Added Phase 3d which deletes existing clusters/rollups and re-aggregates using `canonical_key` as the grouping key. Clustering key priority: `canonical_key > cluster > topic > 'general'`.

**2026-03-10: Navigational intent exclusion from near-miss (three-layer defense)**

Problem: Canonicalize (Phase 3c) runs AFTER sync jim (Phase 3b) sets `is_near_miss`. Keywords like "ross boise" were being classified as navigational by canonicalize, but `is_near_miss` was already set to true by sync. Three fixes:
1. sync-to-dashboard.ts `isNearMiss` filter now checks `intent !== 'navigational'` at insert time
2. Canonicalize's post-step clears `is_near_miss` (and zeroes revenue) for any keyword where it sets `is_brand=true` or `intent_type=navigational`
3. Canonicalize prompt strengthened: "ONLY use navigational when the keyword contains a recognizable brand name. Generic service keywords like 'hvac contractors boise' are NEVER navigational."

**2026-03-10: Pipeline trigger server runs independently of WhatsApp**

The original codebase's main process connected to WhatsApp via baileys, which blocked startup if auth fails (405 reconnect loop in WSL2). The pipeline trigger HTTP server (`src/pipeline-server.ts`) was moved to start BEFORE WhatsApp connection. Added `--pipeline-only` flag to skip WhatsApp entirely. The pipeline server listens on port 3847 with Bearer token auth and a duplicate-domain guard (in-flight Set). (Historical context — WhatsApp code has since been removed.)

**2026-03-10: 409 from pipeline server treated as success in run-audit Edge Function**

When the same domain is triggered twice (user clicks retry, or race condition), the pipeline server returns 409 (already running). The edge function initially treated this as a fatal error, marking the audit as failed. Changed to treat 409 as success with `status: "pipeline_already_running"`.

**2026-03-11: Scout (Phase 0) uses JSON config, not YAML**

Scout takes a `prospect-config.json` file as input rather than CLI flags or YAML. JSON was chosen because: (1) the pipeline already uses JSON everywhere (seed_matrix.json, ranked_keywords.json, scope.json), (2) no YAML dependency exists in the project, (3) config files are version-controlled per-prospect in `audits/{domain}/prospect-config.json` alongside other artifacts.

**2026-03-11: Scout skips resolveAudit — uses prospects table instead**

Scout runs before a client is onboarded, so no `audits` row exists. Instead of creating a throwaway audit record, Scout uses a separate `prospects` table with its own lifecycle (discovery → scouted → converted). The `converted_to_audit_id` FK links a prospect to its eventual audit after conversion. This keeps the `audits` table clean for actual paying clients.

**2026-03-12: Scout skips crawl entirely (DataForSEO-only)**

Scout originally included a lightweight SF crawl (Internal:All only) for topic extraction. Removed because: (1) Dwight does a comprehensive crawl in Phase 1 if the prospect converts, making Scout's crawl redundant; (2) topic extraction from DataForSEO ranked keywords works just as well — the Idaho Medical Academy test proved this with 13 clean canonical topics and no crawl data; (3) removing the crawl saves 30–60s per scout run.

**2026-03-11: Prospect mode exits after Scout — no full pipeline**

When `run-pipeline.sh` is called with `--mode prospect`, only Phase 0 (Scout) runs, then the script exits cleanly. The full pipeline (Phases 1–6c) runs separately after the prospect converts to a client. This prevents wasting compute/API budget on prospects that may never convert.

**2026-03-11: Geo-flexibility via geo_mode + market_geos on audits table**

The pipeline originally hardcoded one geographic model: `market_state` (single state) + `market_city` (comma-separated cities). This breaks for course providers, regional businesses, and multi-state expansion plays where the unit of geography is a state or metro. Added `geo_mode` (`city`|`metro`|`state`|`national`) and `market_geos` (JSONB) columns. A `resolveGeoScope(audit)` helper replaces all direct `market_city`/`market_state` reads — returns `{ mode, locales[], state, label }` ready for query construction. Existing `market_city`/`market_state` columns are NOT removed (backward compat with Dashboard code).

**2026-03-11: resolveGeoScope throws on null geo_mode — no silent defaults**

If an audit row has `geo_mode=NULL` (should not happen after migration backfill, but could occur from manual inserts), `resolveGeoScope()` throws a loud error instead of silently defaulting to city mode. This prevents accidental misclassification of geographic scope. The backfill `UPDATE` in the migration sets all existing rows to `geo_mode='city'`.

**2026-03-11: Mode-aware MATRIX_CAPS for KeywordResearch**

`MAX_KEYWORD_MATRIX_SIZE` was a flat cap of 200 for all audits. For state mode (e.g., 4 states × 15 services × 4 intent variants), the matrix can grow significantly. Replaced with per-mode caps: city=200, metro=300, state=500, national=200 (no geo multiplier). Truncation logs a warning but does not throw.

**2026-03-11: generateKeywordCandidates handles state/national modes**

For state mode, `locales` are state names (e.g., "Idaho", "Washington") — the `{service} {locale} {state}` variant is skipped to avoid "phlebotomy training Idaho Idaho". For national mode, `locales` is empty — candidates are `{service}` without any geo modifier.

**2026-03-12: KeywordResearch consumes scope.json as optional priors (soft dependency)**

When a prospect converts to a client, Scout's `scope.json` contains topics and gap keywords already discovered. KeywordResearch now loads this file using `findLatestDatedDir()` + inline `fs.existsSync()` rather than extending `resolveArtifactPath()`. Rationale: scope.json is read in exactly one place (KeywordResearch), and extending the `'research' | 'architecture'` union type on `resolveArtifactPath()` would touch 6 call sites for no benefit. Scout priors are injected into the Haiku extraction prompt for validation against crawl data (not blindly trusted), and gap keywords are pre-seeded at priority 0 so they survive matrix truncation. The `marketCity`/`marketState` bug in the synthesis prompt was fixed in the same change — those variables were undeclared in `runKeywordResearch` scope; `kwGeo.label` is the correct source.

**2026-03-12: Oscar disk fallback removed (DB-only source of truth)**

Oscar's `gatherBrief()` had a dual-source pattern: query `execution_pages` from Supabase first, then fall back to disk files (`metadata.md`, `content_outline.md`, `schema.json`) if DB columns were null. This masked real failures — if Pam's upsert to `execution_pages` failed silently, Oscar would happily read stale disk data and produce content from outdated briefs. Removed the disk fallback entirely; Oscar now warns on null `metadata_markdown` and `schema_json` fields. The existing hard check (`if (!brief.contentOutlineMarkdown) throw`) enforces the critical requirement.

**2026-03-12: Pam logs warnings for missing enrichment files**

`generate-brief.ts` had empty catch blocks around `architecture_blueprint.md` and `research_summary.md` reads — when these files were absent, the brief was generated silently without silo structure or striking distance context. Added WARNING logs after each try-catch so operators can see which enrichments are missing. No behavior change — files remain optional.

**2026-03-12: PIPELINE_BASE_URL replaces PIPELINE_TRIGGER_URL**

Edge functions (`run-audit`, `scout-config`) were inconsistent: `run-audit` used `PIPELINE_TRIGGER_URL` as a full endpoint URL, while `scout-config` treated it as a base URL and appended paths. Standardized to `PIPELINE_BASE_URL` — edge functions append `/trigger-pipeline`, `/scout-config`, `/scout-report` in code. Both functions fall back to `PIPELINE_TRIGGER_URL` for backward compatibility. This means one Supabase secret serves all three pipeline server endpoints.

**2026-03-12: Pipeline server network access (SEC-2 — resolved 2026-03-30)**

Originally the pipeline server ran on a local machine with port 3847 forwarded through an EERO router. Public IP exposure was a security risk (SEC-2). A Cloudflare Tunnel (`pipeline.forgegrowth.ai` -> `localhost:3847`) was implemented as an intermediate fix. Now that the server runs on Railway (cloud-hosted), both the local port exposure and the Cloudflare Tunnel are unnecessary. `PIPELINE_BASE_URL` points directly to Railway's public HTTPS URL (`https://nanoclaw-production-e8b7.up.railway.app`). Auth is handled by `PIPELINE_TRIGGER_SECRET` bearer token. The tunnel has been retired.

**2026-03-12: Convert-to-client wired end-to-end (Scout → Pipeline)**

Prospect conversion flow: Dashboard `useConvertProspect` creates an `audits` row (with `geo_mode` and `market_geos` from the prospect — required by `resolveGeoScope()`), creates `audit_assumptions`, updates prospect `status='converted'`, then invokes `run-audit` edge function. The edge function sets audit `status='running'` and POSTs to `/trigger-pipeline`. KeywordResearch (Phase 2) automatically finds Scout's `scope.json` on disk and pre-seeds the keyword matrix with gap keywords. No manual data migration needed between prospect and audit phases.

**2026-03-12: Gemini embeddings removed from SF crawl (Dwight Phase 1)**

SF's `--config semantic_config.seospiderconfig` enabled Gemini API embeddings for content similarity detection. Removed because: (1) the embedding API times out on sites >500 pages — exactly the sites where cannibalization matters; (2) Jim's canonicalization (Phase 3c) and Michael's topic overlap analysis (Phase 6) already cover the same cannibalization signal from keyword and architecture angles; (3) the semantic similarity report (`Content:Semantically Similar`, `Content:Near Duplicates`) was a nice-to-have but not critical-path for the audit. The `semanticReport` variable in the prompt and Michael's `resolveArtifactPath('semantically_similar_report.csv')` both gracefully handle the file not existing. If content-level similarity analysis is needed for a specific client, it can be a standalone tool.

**2026-03-12: SF crawl uses async spawn instead of spawnSync**

The SF CLI was invoked via `child_process.spawnSync('bash', [tmpScript], { timeout: 600_000 })`. For large sites, the 600s timeout caused `ETIMEDOUT` even when the crawl had completed — SF was still processing (API calls, report generation). Switched to async `child_process.spawn()` wrapped in a Promise, which has no timeout cap. SF's Java process manages its own timeouts internally.

**2026-03-12: Jim research_summary.md truncation guard**

Claude Sonnet can hit output token limits on large prompts. When this happens, `callClaudeAsync()` captures only the continuation fragment (e.g., "Continuing Section 10 from the cut-off point:") instead of the full report. This caused `keyword_overview` to be all zeros (no Section 2 to parse). Fix: (1) reduced prompt size — keyword table from 200→100 rows, competitor table from 50→20; (2) added structural validation checking for `# Research Summary` header and `## 8.` section; (3) auto-retries once if validation fails. The retry is cheap (same prompt, no new API calls) and catches truncation before it propagates to sync.

**2026-03-12: Dwight filters internal_all.csv to HTML pages before analysis**

Dwight's prompt was receiving all resources from `internal_all.csv` — CSS, JS, images, fonts — inflating the page count and diluting the analysis. Added a `Content Type` column filter that keeps only `text/html` rows. The filter uses simple comma-split (not a full CSV parser) which works because MIME type values never contain commas. Non-HTML resources are counted but excluded from the prompt: `Filtered internal_all.csv: {n} HTML pages ({dropped} non-HTML resources excluded)`.

**2026-03-12: Agentic readiness scorecard regex allows explanatory text**

The sync-dwight parser extracts PASS/FAIL signals from Section 10.4 of AUDIT_REPORT.md. The original regex `(PASS|FAIL)\s*\|` failed on rows like `FAIL — zero structured data site-wide |` because text appeared between the status and the pipe delimiter. Fixed to `(PASS|FAIL)[^|]*\|` which matches any text after PASS/FAIL up to the next pipe. The scorecard template was also updated to instruct "PASS or FAIL — explanation" format.

**2026-03-12: top_10_non_branded uses domain-name heuristic (not is_brand flag)**

`keyword_overview.top_10_non_branded` is needed at Jim sync time, but `is_brand` is null until Canonicalize runs (Phase 3c). Rather than defer the computation, sync-jim uses a domain-name heuristic: strip TLD from domain, remove hyphens, compare spaceless versions against each keyword. E.g., `idahomedicalacademy` matches `idaho medical academy`. This catches the most common branded keywords without waiting for Canonicalize. The count is re-synced with canonical `is_brand` data if sync-jim runs again after Phase 3c.

**2026-03-12: keyword_overview exposes DataForSEO cap metadata**

DataForSEO's `ranked_keywords/live` endpoint returns max 1000 results but the response's `total_count` field reports the true total (e.g., 3735 for idahomedicalacademy.com). Added `keywords_capped: true` and `dataforseo_total: 3735` to `keyword_overview` in the Jim snapshot so the dashboard can render "1,000+" / "400+" instead of presenting capped numbers as absolutes.

**2026-03-13: Screaming Frog replaced with DataForSEO OnPage API (Dwight Phase 1)**

SF CLI was a Java desktop app that couldn't run on cloud, had site-unreachable failures, and cost $209/yr. Replaced with DataForSEO's OnPage API (`scripts/dataforseo-onpage.ts`) which: (1) runs anywhere (pure HTTP), (2) handles JS rendering, (3) costs ~$0.025/crawl for 200-page sites. The new `scripts/onpage-to-csv.ts` transformer produces CSV files with identical headers to SF output (`INTERNAL_ALL_KEEP_COLUMNS`) so all downstream consumers (Dwight prompt, Michael prompt, sync-dwight) work unchanged. `Spelling Errors` and `Grammar Errors` columns are empty (never consumed meaningfully). `Link Score` maps to `onpage_score` (0-100 vs SF's proprietary metric). Polling uses 15s intervals with 30-min timeout for large sites.

**2026-03-13: Claude CLI replaced with Anthropic SDK (@anthropic-ai/sdk)**

The pipeline spawned the `claude` CLI binary (`/home/forgegrowth/.local/bin/claude`) via `child_process.spawn`/`spawnSync`. This had multiple problems: (1) binary dependency that can't deploy to Railway, (2) `spawnSync` has a 120s timeout cap regardless of the `timeout` parameter, (3) required stripping all `CLAUDE*` env vars to prevent conversation transcript leaking into output, (4) `stripClaudePreamble()` was needed to clean XML artifacts. New `scripts/anthropic-client.ts` uses `@anthropic-ai/sdk` directly with per-phase `max_tokens` config. Model mapping: `sonnet` → `claude-sonnet-4-5-20250514`, `haiku` → `claude-haiku-3-5-20241022`. All 15 call sites in `pipeline-generate.ts` plus `generate-brief.ts` and `generate-content.ts` migrated.

**2026-03-13: loadEnv() falls through to process.env for cloud deployment**

Local dev reads from `.env` file. When no `.env` exists (Railway, Docker), `loadEnv()` now falls through to `process.env`. This lets the same code run on both home server and Railway without code changes. Applied to all four files: `pipeline-generate.ts`, `sync-to-dashboard.ts`, `generate-brief.ts`, `generate-content.ts`.

**2026-03-13: QA Agent evaluates generation phases via Haiku**

New `runQA()` function in `pipeline-generate.ts` evaluates LLM output after each generation phase (Dwight, Jim, Gap, Michael) using phase-specific rubrics. Each rubric has critical/high/medium weighted checks. Verdict logic: PASS (all critical pass, ≤1 high fail), ENHANCE (critical fail or 2+ high fails, but meaningful content), FAIL (broken/empty). On ENHANCE, the phase re-runs and QA evaluates again. On persistent FAIL, pipeline halts. Results logged to `audit_qa_results` Supabase table. Cost: ~$0.005 per QA eval (Haiku).

**2026-03-13: Pipeline server health endpoint for Railway**

Added `GET /health` to `pipeline-server.ts` returning `{ status: 'ok', uptime, inFlight }`. Railway uses this for health checks and zero-downtime deploys. Also created `pipeline-server-standalone.ts` as a standalone entry point that runs without WhatsApp/container dependencies.

**2026-03-13: Dockerfile.railway for cloud deployment**

`Dockerfile.railway` uses `node:22-slim` + curl + jq (for `foundational_scout.sh`). Railway volume mounts at `/app/audits` for inter-phase artifact persistence. No Claude binary, no Screaming Frog, no Java — pure Node.js + HTTP APIs.

**2026-03-16: Pre-filter aggregator domains from Jim's competitor table**

Jim's DataForSEO competitor data included Yelp ($1.3B ETV), HomeAdvisor, BBB, etc. as top competitors — useless for sales or strategy analysis. Added `AGGREGATOR_DOMAINS` constant and `isAggregatorDomain()` filter that removes these before building the prompt. Phase 4 (Competitors) already had its own Haiku-based classification, but Jim's output feeds the dashboard and Michael directly, so pre-filtering is needed at the data level. The filter runs on `competitors.json` extraction, not the raw file — `competitors.json` on disk stays unmodified for debugging.

**2026-03-16: Evidence-based service expansion in KeywordResearch (Phase 2)**

The KeywordResearch extraction prompt's "do NOT guess" rule was too conservative — boiseserviceplumbers.com extracted only "Residential Plumbing" and "Commercial Plumbing" despite offering emergency plumbing, drain cleaning, water heater repair, etc. Two fixes: (1) relaxed the extraction prompt to include sub-services from navigation, titles, and URL paths; (2) added `expandServicesFromCrawl()` which cross-references `SERVICE_KEYWORD_SEEDS[serviceKey]` against AUDIT_REPORT.md text and internal_all.csv URLs. Only seeds with evidence in the crawl are added — this prevents hallucinating services the business doesn't offer. Also added `detectServiceKey()` for auto-created sales audits where `service_key='other'`: Tier 1 counts seed term matches (min 2), Tier 2 asks Haiku (~$0.001). The detected key is written to the audit row so downstream phases inherit it.

**2026-03-16: Client context as prompt reasoning constraints (not keyword filters)**

Full-mode audits for clients (e.g., Summit Medical Academy) produced irrelevant content recommendations because the pipeline had no business context. Added `client_context` to `prospect-config.json` with `business_model`, `services`, `out_of_scope`, `target_audience`, etc. Injected into Phases 2/3/5/6 as prompt context. The key design choice: `out_of_scope` is injected as **reasoning constraints**, not keyword matrix filters. A keyword filter catches exact matches ("phlebotomy") but misses semantic exclusions ("online-only means no geo city pages"). The LLM needs the reasoning context to make these judgment calls. Sales mode is unaffected (no `client_context` in prospect-config).

**2026-03-16: Deterministic revenue headline for sales mode (not LLM)**

Sales prospects need a dollar figure. Revenue model already existed (benchmarks → audit_assumptions → CR/ACV) but only ran during sync. Added `buildRevenueTable()` which reads `audit_assumptions` and `audit_rollups` to produce a `## Revenue Opportunity` markdown table (Conservative / Expected / Optimistic). This is deterministic — no LLM call — because revenue figures end up in sales reports. A hallucinated number from Michael could misrepresent opportunity to a prospect. The table is passed verbatim to Michael's prompt so the blueprint includes it in one pass (no post-hoc file rewrite).

**2026-03-17: Performance tracking baseline uses first ranking_snapshot, not baseline_snapshots**

The spec assumed `baseline_snapshots` contains all keyword positions for delta computation. It doesn't — it only stores near-miss keywords (positions 11-30, filtered by volume), written once by sync-jim. Resolution: the first `ranking_snapshots` entry per keyword becomes the effective baseline. A `ranking_deltas` SQL view computes deltas at query time by joining earliest vs latest snapshots per keyword. This keeps computation in the database (not TypeScript) — as snapshot volume grows across clients, pulling all rows to compute deltas client-side would degrade. `baseline_snapshots` remains useful only for the "Opportunity Keywords" section on the Performance tab, showing the initial near-miss positions at audit time.

**2026-03-17: avg_position excludes unranked keywords**

`cluster_performance_snapshots.avg_position` and `page_performance.current_avg_position` are computed from only the keywords that have a non-null `rank_position` (i.e., appear in the top 1000 in DataForSEO). Keywords where DataForSEO returned no ranking are stored with `rank_position=null` in `ranking_snapshots` but excluded from the average. Including them would require inventing a placeholder position (e.g., 1001) which would skew the metric — a cluster with 5 keywords at position 8 and 15 unranked would show avg ~750 instead of 8. The `keyword_count` on `cluster_performance_snapshots` includes all keywords (ranked + unranked) for the cluster, while the position bucket counts (`keywords_p1_3`, `keywords_p4_10`, etc.) only count ranked keywords.

**2026-03-17: Performance tracking as weekly cron, not per-pipeline**

Ranking tracking runs independently of the audit pipeline via `scripts/cron-track-all.ts` (weekly scheduler) and `scripts/track-rankings.ts` (per-domain). Rationale: rankings change slowly (weekly is sufficient), DataForSEO costs $0.05/call, and the pipeline runs once per domain while tracking is ongoing. A 6-day recency check in `track-rankings.ts` prevents double-runs from scheduling drift. The `/track-rankings` endpoint on the pipeline server enables on-demand runs from the dashboard.

**2026-03-17: canonical_key is the contractual bridge between cluster layer and execution layer**

`canonical_key` (set by Phase 3c) is the primary join key between `audit_clusters` and `execution_pages`. Any future phase connecting these tables must use `canonical_key` — not topic string matching, not silo name matching. Silos come from Michael's blueprint headings (e.g., "Core Plumbing Services (Boise)"), canonical_topics from Phase 3c semantic grouping (e.g., "Water Heater Repair") — completely different string spaces. `syncMichael()` backfills `canonical_key` on `execution_pages` by mapping each page's `primary_keyword` through `audit_keywords.canonical_key`.

**2026-03-17: Geo-agnostic canonical keys**

Canonical keys and topics must be geography-agnostic. "Boise water heater repair" and "water heater repair" resolve to `water_heater_repair`. Geographic context lives in keyword-level data and schema markup, not cluster identity. One cluster strategy document serves the topic regardless of geo variants. Phase 3d merges geo variants into combined clusters with correct aggregate volume/revenue. The Phase 3c prompt was strengthened to explicitly show geo-stripping examples and forbid geo prefixes in `canonical_key`.

**2026-03-17: Three-tier model allocation policy (Haiku / Sonnet / Opus)**

Explicit policy for which Claude model to use per phase:
- **Haiku** — high-volume classification, batching, validation (Canonicalize, Competitors, QA, Validator, service detection). Runs dozens of times per pipeline. Cost must stay low.
- **Sonnet** — synthesis and generation phases with large context and structured output (Dwight, Jim, KeywordResearch, Gap, Michael, Pam, Oscar, Scout). Primary workhorse. Good balance of quality and cost.
- **Opus** — strategic judgment phases where a wrong decision has high downstream cost, reasoning requires cross-domain depth, and call frequency is low (Cluster Strategy). A misdirected cluster strategy cascades into weeks of wasted content production — exactly the agency failure mode this system replaces. Cost delta is ~$0.45/cluster vs Sonnet, trivial against the execution cost it governs.

Scout stays on Sonnet despite producing strategic output, because it runs at $2 budget per prospect (many never convert) and Opus would consume ~30% of that on one call. Cluster strategy only fires for converted, paying clients — the right economic boundary for Opus.

**2026-03-17: Cluster strategy prompt includes Jim's research narrative**

`generate-cluster-strategy.ts` loads `research_summary.md` via `resolveArtifactPath()` and extracts Section 8 (Striking Distance) and Section 10 (Key Takeaways). This gives Opus the strategic observations about the domain's competitive position alongside structured cluster data — why the cluster matters competitively, not just what keywords are in it. Falls back gracefully if the file doesn't exist on disk (Railway-only deployments).

**2026-03-17: Cluster activation gates content production**

Cluster activation (`/activate-cluster` endpoint) generates a strategy document via `generate-cluster-strategy.ts` (single Opus call, ~$0.15-0.50) and marks the cluster as `active`. Only pages in active clusters have `cluster_active=true` on `execution_pages`, enabling the dashboard to filter the Content Queue by active clusters. Deactivation (`/deactivate-cluster`) is near-instant (2 Supabase UPDATEs, no LLM call). This creates the upsell mechanic: activating a cluster is the explicit commitment to produce content for that topic.

**2026-03-17: Cluster status preservation through rebuild**

`rebuildClustersAndRollups()` does DELETE+INSERT on `audit_clusters`. Without preservation, re-canonicalize would deactivate all active clusters. The function now saves activation metadata (status, activated_at, activated_by, target_publish_date, notes) before DELETE and restores it after INSERT for clusters whose `canonical_key` survives the rebuild. Also syncs `execution_pages.cluster_active` — surviving active clusters keep their pages flagged, lost clusters get their pages deactivated.

**2026-03-17: client_context lives on disk (prospect-config.json), mirrored to audits table**

The pipeline reads `client_context` from `audits/{domain}/prospect-config.json` via `loadClientContext()`. The dashboard Settings page reads/writes `audits.client_context` JSONB column. These are separate stores — the pipeline never reads from Supabase `client_context`, and the dashboard never reads from disk. They are synced at convert-to-client time. If the pipeline needs to pick up Settings-page edits, the edge function must write to both disk (via `/scout-config`) and Supabase.

**2026-03-17: pipeline-controls edge function for Settings page**

Settings page pipeline actions (re-canonicalize, track rankings) route through a single `pipeline-controls` edge function rather than one edge function per action. This follows the `scout-config` pattern (action switch on request body) and keeps the edge function count manageable. Both actions proxy to existing pipeline server endpoints (`/recanonicalize`, `/track-rankings`).

**2026-03-17: Position-weighted topical authority score**

Authority score = Σ(position_weight) / (keyword_count × 1.0) × 100. Weights: pos 1-3=1.0, 4-10=0.6, 11-20=0.3, 21-30=0.1, 31+=0.05, not ranking=0.0. Denominator is ALL keywords for the `canonical_key` in the ranking snapshot — including keywords the domain has never ranked for. This penalizes clusters with large coverage gaps, not just poor positions. Computed weekly during `track-rankings.ts` and stored in `cluster_performance_snapshots` (historical) and `audit_clusters` (current). Delta = current minus previous snapshot score. The live computation uses snapshot data as the denominator (already contains all audit_keywords). The backfill script uses `audit_keywords` directly since older snapshots may not have had all keywords.

**2026-03-17: Authority score surfaced in Clusters page + Performance page**

The authority score (0-100, position-weighted) is surfaced in two dashboard pages: Performance page shows authority trend chart (recharts line chart per cluster, collapsible), authority/trend columns in the cluster performance table, and a weighted-average summary card. Clusters page shows authority/trend columns in the cluster table, an "Opportunity" badge on the best inactive cluster (highest revenue + authority < 50), an avg authority summary card, and an empty-state info banner linking to Settings when no scores exist yet. Both pages share `AuthorityScoreBadge` (4 color tiers: Low/Building/Strong/Dominant) and `AuthorityDeltaBadge` components. Data comes from `audit_clusters.authority_score` (current) and `cluster_performance_snapshots` (historical trend via `useClusterAuthorityTrend` hook).

**2026-03-18: Citation scan via SERP, not BrightLocal/dedicated citation API**

DataForSEO has no multi-directory citation endpoint — their Business Listings DB is Google Maps only. Rather than adding a new vendor (BrightLocal ~$80/mo), Phase 6d uses DataForSEO's SERP API to search `"Business Name" "City, State" site:{directory}` per directory. This gives presence detection + basic NAP extraction from snippets at ~$0.002/directory. A `data_source: 'serp'` field on `citation_snapshots` allows future upgrade to a dedicated citation API without schema changes. Known limitation: Apple Maps (`maps.apple.com`) blocks Google crawling, so SERP returns `listing_found: false` for most businesses — documented, not a bug.

**2026-03-18: GBP canonical NAP as source of truth for citation matching**

Phase 6d extracts canonical NAP (name, address, phone) from the GBP listing and uses it as the reference for citation consistency checks. Rationale: GBP is the authoritative local listing — citation services like Moz Local and BrightLocal use the same approach. Fallback chain when GBP is missing: `client_profiles.canonical_name/address/phone` (manual entry from Settings page), then domain-derived name. The `gbp_snapshots` row is always upserted, even when `listing_found: false` — a missing GBP is the highest-value sales signal in the audit (unclaimed = immediate action item for the client).

**2026-03-18: Phase 6d runs in both sales and full mode**

Local presence data (GBP claimed status, citation gaps) is a strong sales signal — unclaimed GBP and inconsistent NAP are easy-to-explain audit findings that drive conversions. Keeping Phase 6d in both modes means the Sales Report and the full Architecture Blueprint both benefit from local presence data. Cost is ~$0.026/audit (negligible vs the ~$5-8 total pipeline cost).

**2026-03-18: Phase 1b Strategy Brief — strategic framing before keyword research**

The pipeline was reactive to current rankings rather than generative from client intent. For clients like SMA (online provider, multi-state service area, near-zero non-branded visibility), Phase 2 optimized around crawl-extracted signals because client profile entered mid-pipeline as a constraint layer rather than a strategic directive. Phase 1b synthesizes Dwight output + Scout data + client profile into a `strategy_brief.md` that explicitly resolves visibility posture, keyword matrix construction rules, architecture requirements, and risk flags. This brief is injected into Phase 2 (Sonnet synthesis, not Haiku extraction — the directive informs prioritization, not entity extraction), Michael (architecture + risk flags, Visibility Posture dropped as non-actionable), and Pam (posture + architecture directive). The brief is a disk artifact only (no Supabase table) — it's consumed by downstream prompts, not surfaced in the dashboard. Sonnet, not Haiku, because this is synthesis + strategic reasoning across 3 disparate documents. Cost: ~$0.06/audit. Scout gap report markdown enters the analytical pipeline for the first time here (previously only served the dashboard UI).

**2026-03-18: Two-step audit creation — draft → configure → run**

Previously, creating an audit via `/audits/new` auto-triggered the pipeline immediately with no opportunity to enter client context. Phase 1b (Strategy Brief) produced generic output without business model, services, or out_of_scope constraints. Fix: `useCreateAudit` no longer invokes `run-audit` or sets status to `running`. Audit stays as `draft`. User is redirected to Settings page where client context fields already exist. A draft banner with "Start Pipeline" (and "Skip — start without context") appears at the top of Settings for `status === 'draft'`. AuditsDashboard routes draft audits to Settings instead of Running. The convert-prospect path (`useConvertProspect`) is completely independent and unaffected — it still auto-triggers. Why Settings reuse over a new intermediate page: Settings already has client context form, revenue assumptions, and pipeline trigger button built and working. Why not inline on NewAudit form: it already has domain/service/geo/assumptions — 7 more fields makes it overwhelming.

**2026-03-18: loadClientContextAsync — dual-source client context bridge**

Client context has two entry paths: Scout's `prospect-config.json` (disk) and the Settings page's `audits.client_context` JSONB (DB). Previously all pipeline callers used `loadClientContext()` (sync, disk-only). Added `loadClientContextAsync(domain, sb, auditId)` that tries disk first, falls back to DB with field mapping: `core_services` → split to `services[]`, `differentiators` → `competitive_advantage`, `out_of_scope` → split to `string[]`. Disk file takes priority so Scout-converted prospects use their original context. Dashboard-only fields (`service_area`, `notes`) returned separately as `DashboardExtras` for Phase 1b. All 5 callers updated: strategy-brief.ts, runJim, runMichael, runGap, runKeywordResearch, generate-cluster-strategy.ts. The round-trip works: skip → fill later on Settings → re-run pipeline → `loadClientContextAsync` picks up DB context on re-run.

**2026-03-18: Scout Prospect Narrative — plain-language outreach document**

Scout's technical report (7 sections, tables, JSON scope block) is for the pipeline, not for a prospect. Added `generateProspectNarrative()` which generates `prospect-narrative.md` — a 3-section document ("Where You're Winning", "Where Demand Is Escaping You", "What a Full Analysis Would Reveal") written for a business owner with no SEO knowledge. Uses Sonnet (not Haiku) because the output requires tone calibration, business language translation, and persuasive framing — classification tasks Haiku handles well, but writing tasks benefit from Sonnet's synthesis quality. Non-fatal: wrapped in try/catch inside `runScout()` so Scout succeeds even if narrative generation fails. This prevents a $0.01 narrative call from wasting $2 of DataForSEO spend. The narrative is served via `scout-config` edge function's `read_report` action alongside the existing scout report data.

**2026-03-18: Pipeline Review Gate — opt-in pause after Strategy Brief**

The pipeline runs unattended from trigger to completion. Strategic errors in Phase 1b (wrong services, wrong geo scope, missing out_of_scope constraints) cascade silently into Phases 2-6 — wrong keyword matrix → wrong clusters → wrong architecture. Added an opt-in review gate after Phase 1b: when `audits.review_gate_enabled = true` and mode is `full`, `run-pipeline.sh` queries the flag via `update-pipeline-status.ts check-review-gate`, sets status to `awaiting_review`, and exits cleanly. The user reviews `strategy_brief.md`, optionally adds annotations (appended to `client_context.out_of_scope`), then resumes via `pipeline-controls` edge function (`action: 'resume_pipeline'`, triggers with `start_from: '1b'`). Why opt-in: most audits don't need review — the gate is for high-value or complex clients. Why full-mode only: sales mode runs fast ($2-3), review overhead isn't worth it. Why `update-pipeline-status.ts` not `sync-to-dashboard.ts`: the status script already handles audit status updates with user/audit resolution — adding a query mode is natural extension, while sync handles table-level data operations.

**2026-03-19: Data Contract document (docs/DATA_CONTRACT.md) as cross-repo schema source of truth**

Pipeline and dashboard are separate repos with no shared type system. Schema mismatches (wrong column names, missing enums, assumed-but-nonexistent tables) caused multiple deploy-fail-fix cycles. Created `docs/DATA_CONTRACT.md` — authoritative map of every Supabase table with column-level writer/reader ownership, edge function request/response contracts, disk artifact paths, SQL views, polling intervals, and known column name mismatches (e.g., pipeline writes `listing_found`, dashboard reads `gbp_missing`). Added to CLAUDE.md Session Start as required reading. Rule: if a table, column, edge function, or sync pattern changes, DATA_CONTRACT.md gets updated in the same commit.

**2026-03-19: Prospect Share Token — Supabase-only public read path for Scout reports**

Scout reports were served via `/scout-report` on the pipeline server (residential IP, may change). Sharing with cold prospects required the pipeline server to be up and reachable. Fix: store scout report data (`scout_markdown`, `scout_scope_json`, `prospect_narrative`, `brand_favicon_url`) directly in the `prospects` table at Scout completion via a single UPDATE. A `share_token` UUID on `prospects` (unique partial index) serves as the credential for public access. Two new `scout-config` edge function actions: `generate_share_token` (behind `validateSuperAdmin`) and `get_share_report` (no auth — token IS the credential, reads Supabase only). Key decisions: (1) Token on `prospects` not `audit_shares` — prospects aren't audits, different lifecycle. (2) Single UPDATE at scout completion — no second DB roundtrip. (3) Favicon URL from Google's favicon service (deterministic, no image processing). (4) No RLS changes — edge function uses service role key. (5) `read_report` action still works via pipeline server (for dashboard use), share token is the new public path.

**2026-03-19: PostToolUse hook for automatic TypeScript type checking**

Multiple sessions had type errors caught only at commit/deploy time — curly quotes in strings, nonexistent column references, invalid enum values. Added `.claude/settings.json` with a `PostToolUse` hook that runs `npx tsc --noEmit` after every `Edit` or `Write` tool call. 30s timeout. This catches errors immediately during development instead of after a chain of changes makes the root cause harder to trace.

**2026-03-19: Business Context removed from Scout form**

Scout evaluates a site's current state and market opportunity using DataForSEO ranked keywords and SERP data — it does NOT need business context. The five Business Context fields (Business Model, Core Services, Target Audience, Competitive Advantage, Out of Scope) on the Scout form (`/scout/new`) were collected into `config.client_context` but never consumed by `runScout()`. `loadClientContext()` already returns `null` when the key is absent (`client-context.ts:33` — `config.client_context ?? null`). Business context belongs in `client_profiles` (Settings page, post-conversion), where it's consumed by Oscar for brand voice and content production. Removed: state variables, `clientContext` construction, `client_context` from `CreateProspectParams` interface, `client_context` from `ProspectConfig` interface in `pipeline-generate.ts`, the entire `<Collapsible>` Business Context JSX block.

**2026-03-19: State Abbreviation field removed from Scout form**

The separate "State Abbreviation" input on the Scout form was redundant with `GeoModeSelector`, which already captures state via dropdown (city/metro modes) or text input (state mode). The form now uses `geoData.state || ''` directly. The `state` field in `scope.json` is inert metadata — written at `pipeline-generate.ts:3871` but never consumed by any downstream phase. Phase 2 (KeywordResearch) loads `scope.json` but only reads `services` and `locales` (lines 2872-2873); geo targeting comes from `resolveGeoScope(auditRow)`, not scope.json. For state/national modes where `geoData.state` is undefined, the empty string fallback is safe.

**2026-03-19: Budget/cost removed from Scout reports**

DataForSEO cost (`$0.09 / $2.00`) was exposed in the report format template, the data context section, and `scope.json`. This is internal operational data — a prospect should never see how much the scan cost. Removed `dataforseo_cost` from scope.json, removed the `**DataForSEO Budget Used:**` line from the report prompt, and removed the `**DataForSEO Cost:**` line from the data section. Console cost logs remain for operator visibility. `ScoutMarkdownViewer.tsx` (Lovable) adds a regex strip for existing stored reports that already contain the budget line.

**2026-03-19: Scout topic extraction made geo-agnostic**

Haiku's topic extraction prompt produced geo-specific topics like `{ key: "water-damage-restoration-boise", label: "Water Damage Restoration Boise" }`. The opportunity map candidate generator cross-products topics x metros, so "water damage restoration boise" x metro "Boise" became "water damage restoration boise boise" — DataForSEO returned 0 volume. Fix: updated the Haiku prompt with explicit geo-stripping instructions and examples. Topics are now SERVICE CATEGORIES (e.g., "water-damage-restoration"), and the geo dimension comes from the `config.target_geos` cross-product. This matches the geo-agnostic canonical_key convention established in Phase 3c.

**2026-03-20: Strategy brief served via dedicated `/strategy-brief` endpoint with date resolution**

The review gate pauses the pipeline after Phase 1b (Strategy Brief), but the dashboard had no way to display the brief — users were approving something they couldn't see. Added a `/strategy-brief` endpoint on the pipeline server that scans `audits/{domain}/research/` date directories (descending) for `strategy_brief.md` and returns `{ content, date }`. Not using the existing `/artifact` endpoint because it requires the caller to know the exact date path (`research/2026-03-19/strategy_brief.md`), which the edge function doesn't have. The new endpoint does date resolution server-side, same pattern as `/scout-report`. Edge function proxies as `read_strategy_brief` action on `pipeline-controls`. Dashboard renders in a `StrategyBriefReviewModal` (Dialog + ReactMarkdown) triggered from the `ReviewBanner` on the Settings page.

**2026-03-20: Resume-from-phase exposed in dashboard UI (not just CLI)**

The pipeline server and shell orchestrator already supported `--start-from` for resuming from a specific phase, but the `run-audit` edge function and dashboard UI didn't pass it through. Two UX gaps: (1) Settings page only had "Re-run Full Pipeline" which restarts from Phase 1, wasting 20+ minutes and API budget when only later phases need re-running; (2) DataForSEO transient errors (HTTP 500) in Phase 3 required a full re-run to recover. Fix: `run-audit` edge function now accepts optional `start_from` in the request body and forwards it to the pipeline server. Settings page re-run dialog has a phase dropdown with common resume points (Phase 2, 3, 3c, 6, 6d). Dialog description, confirm button text, and success toast update dynamically based on selection. Only practical resume points are exposed (not every sub-phase) to keep the UI concise.

**2026-03-20: Review gate toggle surfaced in DraftBanner and ConvertToClientDialog**

The review gate toggle was buried in Pipeline Controls (Settings page) — inaccessible before the pipeline starts. For the Draft flow, the user fills in context on Settings then clicks "Start Pipeline" in the DraftBanner, but the review gate toggle was below the fold in a different section. For Convert-to-Client, the pipeline auto-fires with no Settings page visit at all. Fix: added inline Switch toggle in DraftBanner ("Pause for Strategy Brief review before continuing") and in ConvertToClientDialog. Both update `audits.review_gate_enabled` directly. The Pipeline Controls section keeps its toggle for post-start changes. The DraftBanner toggle uses the same Supabase direct update pattern as the Pipeline Controls toggle (not a separate mutation).

**2026-03-21: Dashboard UX audit — coordinated IA reorganization (16 issues, 4 phases)**

Full Playwright-assisted UX walkthrough identified 16 issues across all dashboard pages (3 Critical, 7 Significant, 6 Minor). Rather than patching individually, issues were grouped into a 4-phase implementation sequence unified by a single design principle: reinforce the Research → Strategy → Content Execution workflow and make the user's position unmistakable. Phase 1 (C1/C2/C3/M16/S10): sidebar labels, cluster empty states, workflow indicators, Share button relocation. Phase 2 (S4/S5/S6/S7): progressive disclosure on Overview, sub-tabs on Research, section groups on Settings, data guards on audit list. Phase 3 (S9): Client Profile relocated from Content Queue to Settings. Phase 4 (M11/M14): duplicate nav cards removed from Overview, GeoModeSelector added to New Audit form. Key decisions: (1) Overview section link cards removed rather than restyled — sidebar now has clear labels + status dots, making the cards pure redundancy. (2) New Audit form reuses existing `GeoModeSelector` component from Scout form (`src/components/scout/GeoModeSelector.tsx`) rather than building a new one — single source of truth for geo input across both flows. (3) `geo_mode` + `market_geos` added to audit insert via `(supabase as any)` pattern (same as `useConvertProspect`) since generated types don't include these columns.

**2026-03-21: New Audit form sets geo_mode — prevents pipeline Phase 2 failure**

The New Audit form collected city/state via plain text inputs but never set `geo_mode` or `market_geos` on the audit row. The pipeline's `resolveGeoScope()` (`pipeline-generate.ts:221-228`) throws on null `geo_mode`. This meant audits created through the form (not from prospect conversion) would fail at Phase 2 (KeywordResearch). The convert-from-prospect path worked because `useConvertProspect.ts:74` explicitly sets `geo_mode`. Fix: replaced city/state inputs with `GeoModeSelector`, added `geo_mode` and `market_geos` to `CreateAuditParams` and the Supabase insert in `useAudits.ts`. Legacy `market_city`/`market_state` fields derived from `geoData` for backward compatibility. Geo validation runs before zod schema validation (mode-specific: city requires state+cities, metro requires state+metros, state requires states input, national needs nothing).

**2026-03-23: Total Addressable Revenue (TAR) model replaces near-miss as hero revenue**

Near-miss revenue ($X from positions 11-30 moving to page 1) is good for retention/optimization but fails for sales qualification — a prospect with 100k monthly search volume and zero visibility shows $0 revenue. TAR answers "what is this market worth at target visibility?" using `search_volume × CTR_at_position × CR × ACV` across ALL keywords. Near-miss stays as a secondary "90-day quick wins" signal. TAR position is configurable per-audit (default position 5 = realistic first-page visibility). Calculated at the cluster-rebuild level (`rebuildClustersAndRollups`), stored on both `audit_clusters` and `audit_rollups`.

**2026-03-23: total_volume stores SUM instead of MAX (bug fix)**

`total_volume` on `audit_clusters` was storing `Math.max(volMax, vol)` — the highest single keyword volume in the cluster. Every dashboard consumer (`ClustersPage`, `ResearchPage`, `useAssumptionsPreview`) treated it as the sum across all keywords. Fixed `buildClusterMap()` to accumulate `volSum += vol`. Existing clusters get corrected values after next rebuild/re-canonicalize. Added `keyword_count` as an exact count alongside volume.

**2026-03-23: Hidden clusters — soft delete with reason**

Reuses the existing `status` TEXT column (not an enum) with a new `'hidden'` value + `hidden_reason` TEXT field. Hidden clusters are excluded from default views and stat calculations but preserved for pipeline learning. Dashboard toggle reveals them with dimmed styling. `rebuildClustersAndRollups` preserves hidden status through DELETE+INSERT the same way it preserves active status. Known limitation: canonical_key drift during re-canonicalization can lose hidden (and active) status — accepted as pre-existing risk, operator should review after re-canonicalization.

**2026-03-16: Stripped dead WhatsApp/container code (~5,500 lines)**

The codebase was originally a WhatsApp bot with Docker-isolated Claude Agent SDK containers. WhatsApp was never used in production (WSL2 baileys conflicts), and the pipeline "agents" are single-shot prompt templates calling `callClaude()` — not Agent SDK multi-turn sessions. The actual product is a pipeline toolkit: Dashboard → Supabase Edge Functions → Railway HTTP server → shell orchestrator → TypeScript phase generators → Supabase sync. Deleted: `src/index.ts` (WhatsApp orchestrator), `src/channels/whatsapp.ts` (baileys client), `src/container-runner.ts`, `src/group-queue.ts`, `src/ipc.ts`, `src/task-scheduler.ts`, `src/router.ts`, `src/mount-security.ts`, `src/db.ts` (SQLite), `src/config.ts`, `src/env.ts`, `src/types.ts`, `src/pipeline-server.ts` (replaced by standalone), `src/logger.ts`, all 7 test files, `container/` directory, `groups/` directory, and 6 WhatsApp-focused docs. Removed 12 npm dependencies (baileys, better-sqlite3, pino, qrcode-terminal, cron-parser, zod, pg, qrcode, and their @types). `src/` now contains only `pipeline-server-standalone.ts`. Risk was very low: pipeline scripts have zero imports from any deleted file.

**2026-03-23: Geo-qualified search volume — state-level aggregation**

DataForSEO returns national US search volume (`location_code: 2840`) for all keywords. For regional operators (e.g., SMA in WA, OR, UT, CA, MT, AZ), national volume for "cpr training" (74k/mo) wildly overstates the addressable market. Fix: call `search_volume/live` once per service-area state and sum volumes across states. Rankings stay national (`ranked_keywords/live` keeps `location_code: 2840`) because Google ranks domains nationally — we only replace volumes afterward. City/metro modes use the parent state code because city-level DataForSEO location codes return suppressed or zero volume for most keywords (geographic scope too narrow for their data model). A Boise business is addressable by all Idaho searchers; geo-qualified keyword strings already narrow intent. National mode is unchanged. Cost impact: +$0.375/audit for 6-state operator (6 × $0.075/task vs $0.075 national). `track-rankings.ts` excluded — volume metadata in ranking snapshots is not used for revenue calculations. `sync-to-dashboard.ts` unchanged — reads `ranked_keywords.json` which already contains geo-qualified volumes, so all downstream recalculates automatically. Original national volumes preserved in `ranked_keywords.national.json` as audit trail. Unmatched keywords (DataForSEO suppresses low-volume terms) keep their national volume rather than being zeroed.

**2026-03-23: Dwight crawl — JS rendering disabled by default**

DataForSEO OnPage crawl default changed from `enable_javascript: true` to `false`. An SEO audit should crawl what search engines and LLMs actually see — the raw HTML response. If a site relies on client-side JS to render content, that's a technical SEO problem Dwight should flag (thin pages, low text-to-code ratio, missing content in raw HTML), not mask by rendering JS first. Crawling without JS is faster, cheaper, and more representative of indexability. The `enableJsRendering` option still exists for callers that explicitly want rendered-DOM analysis, but no current pipeline phase uses it.

---

**2026-04-06: Scout revenue estimates — replace CPC with rough monthly revenue framing**

CPC (advertiser cost-per-click) answered "what would I pay Google?" — a business owner's question is "what is this traffic worth to me?" Replaced CPC framing with `volume × CTR × CR × ACV` revenue estimate using vertical-specific assumptions.

- `SCOUT_REVENUE_ESTIMATES`: 14-vertical lookup table with `acv_low`, `acv_high`, `cr`, and `label` (e.g., plumbing: $400-3000 ACV, 2% CR, "service job")
- `detectScoutVertical()`: same seed-matching as `detectServiceKey` tier 1 (≥2 hits in `SERVICE_KEYWORD_SEEDS`), no Haiku fallback — if no match, CPC-derived fallback handles it
- CPC-derived fallback: `medianCpc × 200` as ACV proxy, 2% CR, "customer" label
- `PAGE1_CTR = 0.08` (position 4-5 avg from CTR curve model)
- `scope.json` gains `revenue_assumptions` object and `rough_revenue_monthly` on each `top_opportunities[]` entry — additive, Jim ignores unknown keys
- Share report lead card shows `~$X,XXX/mo potential revenue` with assumptions footer; backward compat falls back to CPC display for old data
- `medical_training` added to `SERVICE_KEYWORD_SEEDS` (additive; full pipeline's `ensureAssumptions()` falls back to `other` benchmark)

**2026-04-06: Scout prospect queuing requires topic_patterns**

`runScout()` validation gate (line ~4511) rejects `topic_patterns: []`. When programmatically creating prospects, `topic_patterns` must contain service keywords (e.g., `["locksmith", "lock", "key", "rekey", "lockout"]`). The dashboard's NewProspectPage collects these from the user; batch/CLI creation must provide them explicitly. This is intentional — Scout cannot generate a meaningful keyword matrix without knowing what the business does.
