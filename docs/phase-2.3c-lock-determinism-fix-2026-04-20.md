# Phase 2.3c — Lock Determinism Bug Fix and Re-Validation

**Date:** 2026-04-20
**Audit ID:** c07eb21d-3120-4242-8754-361a429a6f2c (SMA)
**Bug:** 16.5% canonical_key drift on prior_assignment_locked keywords during Phase 2.3b promotion

## Diagnosis

### Root cause: cross-cycle contamination via shared column writes

The bug is NOT in the hybrid module's topicMap construction or the lock predicate. Both are correct. The bug is in `pipeline-generate.ts`'s legacy canonicalize update step, which writes `canonical_key`, `canonical_topic`, and `cluster` to `audit_keywords` even when `canonicalizeMode === 'hybrid'`.

### Actual failure sequence (Phase 2.3b SMA promotion)

1. **Attempt 1:** Wrong email → failed immediately, no DB writes.
2. **Attempt 2:** Legacy Sonnet ran successfully and wrote fresh `canonical_key` values to all 127 keywords (Sonnet is stochastic — different topic names each run). Then hybrid failed at the embeddings service because `getSupabaseAdmin()` reads `process.env.SUPABASE_URL` which wasn't set (`loadEnv()` returns a local object, doesn't set `process.env`).
3. **Attempt 3:** After env propagation fix. `priorHybridSnapshot` captured attempt 2's contaminated legacy output from the DB (14 distinct keys instead of the original 12). The hybrid module faithfully locked all 127 keywords to these contaminated values. Result: 21 keywords with different canonical_keys than the true prior hybrid state.

### Why 14 topics instead of 12

Sonnet's stochastic output in attempt 2 produced a fresh topic taxonomy with 14 distinct canonical_keys (vs the original 12 from shadow validation). This is expected — Sonnet canonicalization is non-deterministic across runs. The topicMap in the hybrid module correctly reflected what was in the DB at that point; the problem is the DB contained legacy's output rather than the prior hybrid state.

### Contamination vector

Legacy and hybrid write to the **same columns** (`canonical_key`, `canonical_topic`, `cluster`) on `audit_keywords`. In hybrid mode, legacy's write serves no purpose — hybrid will overwrite these columns. But if hybrid fails after legacy writes, the DB is left with legacy's stochastic output. Any retry's `priorHybridSnapshot` (which reads from the DB's current primary columns) then captures this contaminated state.

### Why this doesn't affect legacy-only or shadow mode

- **Legacy-only:** No hybrid step runs, so legacy's write is the final write. No contamination possible.
- **Shadow mode:** Hybrid writes to `shadow_*` columns, not primary columns. Legacy's write to primary columns is the intended final state. No conflict.

## Fix

### Files modified

| File | Lines changed | Purpose |
|------|---------------|---------|
| `scripts/pipeline-generate.ts` | ~20 lines | Import `buildLegacyUpdatePayload`, use conditional payload |
| `src/agents/canonicalize/build-legacy-payload.ts` | 39 lines (new) | Extracted payload builder with mode-conditional logic |
| `src/agents/canonicalize/__tests__/build-legacy-payload.test.ts` | 126 lines (new) | 9 unit tests covering hybrid/legacy/shadow modes |

### Change description

Extracted the legacy update payload construction into `buildLegacyUpdatePayload()`. When `canonicalizeMode === 'hybrid'`, the payload excludes `canonical_key`, `canonical_topic`, and `cluster`. These fields are written exclusively by the hybrid persist step (`src/agents/canonicalize/hybrid/persist.ts`). In legacy and shadow modes, the payload includes all fields (no behavioral change).

This eliminates the contamination window: even if hybrid fails after legacy runs, the DB retains the prior hybrid state in the canonical columns. A retry's `priorHybridSnapshot` will capture the correct prior state.

### What was NOT changed

- Lock predicate in `pre-cluster.ts` — correct, untouched
- `existingTopics` construction in `hybrid/index.ts` — correct, untouched
- Hybrid persist step in `persist.ts` — correct, untouched
- Classification methods — no changes
- Threshold or size gate values — no changes

### Regression test added

`src/agents/canonicalize/__tests__/build-legacy-payload.test.ts` — 9 tests:

1. **hybrid mode — canonical fields excluded:** Asserts `canonical_key`, `canonical_topic`, `cluster` are NOT in the payload
2. **hybrid mode — classification fields included:** Asserts `is_brand`, `intent_type`, `is_near_me`, `primary_entity_type` ARE in the payload
3. **legacy mode — canonical fields included:** Asserts all fields present
4. **legacy mode — all fields:** Full payload equality check
5. **shadow mode — canonical fields included:** Same as legacy
6. **lock determinism with legacy contamination — hybrid prevents contamination:** Simulates the exact bug scenario (legacy produces different canonical values, hybrid mode blocks them)
7. **lock determinism with legacy contamination — legacy allows write:** Confirms legacy mode does write canonical values (expected behavior)
8. **edge: primaryEntityType passthrough**
9. **edge: cluster mirrors canonical_topic**

## Re-promotion validation (confidence check)

### Process

Ran `run-canonicalize.ts` against SMA with `--canonicalize-mode hybrid`. This executes Phase 3c (canonicalize) + Phase 3d (rebuild clusters).

### Results

| Metric | Baseline (post-2.3b) | Post-rerun | Match? |
|--------|----------------------|------------|--------|
| Total keywords | 127 | 127 | Yes |
| Distinct canonical_keys | 14 | 14 | Yes |
| Classification: prior_assignment_locked | 127 | 127 | Yes |
| Canonical_key drift | — | **0** | — |
| Clusters | 9 | 9 | Yes |
| Performance snapshots | 13 | 13 | Yes |

### Drift check result: 0 keywords changed

Zero drift on re-run. All 127 keywords retained their canonical_key values from the accepted baseline (the 14-key state established during Phase 2.3b).

**Note:** This is framed as a confidence check, not a validation gate. The fix's correctness is established by the unit test (which directly asserts the payload contents), not by the re-run result. The re-run would have produced 0 drift even without the fix, because the prior snapshot now accurately reflects the DB state. The fix prevents future contamination from failed attempts.

## Test suite

- **64/64 tests passing** (6 test files)
- **TypeScript typecheck clean** (`npx tsc --noEmit`)
- No regressions from existing tests

## Outcome classification

**SUCCESS**

- Fix applied: legacy update excludes canonical fields in hybrid mode
- Unit test: 9/9 passing, covers the exact bug scenario
- SMA re-run: 0 drift, all metrics match baseline
- DECISIONS.md: documents actual mechanism (cross-cycle contamination)

## Future consideration (flagged, not scoped)

Long-term, hybrid should read from and write to dedicated columns separate from legacy, eliminating the shared-state coupling entirely. This would make the contamination vector architecturally impossible rather than conditionally prevented. Not scoped for this session — the current fix is sufficient and the dedicated-column migration would require schema changes, persist.ts rewrite, and dashboard query updates.

## Recommendation for next session

**Proceed to IMA promotion (Phase 2.4).** SMA's hybrid mode is validated:
- Lock determinism fix verified
- Prior-lock mechanism produces stable output
- No operational impact from the 14-key baseline (accepted as new state)
- IMA has active clusters and committed content — requires the deterministic prior-lock that this fix ensures
