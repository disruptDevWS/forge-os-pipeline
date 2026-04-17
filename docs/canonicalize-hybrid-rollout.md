# Canonicalize Hybrid Mode — Rollout Checklist

## Overview

Hybrid canonicalize replaces Sonnet-only semantic grouping with vector pre-clustering (embeddings) plus Sonnet arbitration for edge cases. This document tracks the rollout sequence from shadow validation through full migration.

## Architecture

- **Legacy mode** (`--canonicalize-mode legacy`): Current Sonnet-only behavior. Default.
- **Hybrid mode** (`--canonicalize-mode hybrid`): Vector pre-clustering + Sonnet arbitration. Authoritative output.
- **Shadow mode** (`--canonicalize-mode shadow`): Runs both legacy (authoritative) and hybrid (comparison). Legacy output written first, hybrid second with `canonicalize_mode='shadow_hybrid'`.

Hybrid handles ONLY `canonical_key` and `canonical_topic` clustering. Other fields (`is_brand`, `is_near_me`, `intent_type`, `primary_entity_type`) remain Sonnet-based in all modes.

## Thresholds (starting values)

| Threshold | Value | Meaning |
|-----------|-------|---------|
| Auto-assign | >= 0.85 | Single centroid match above this → auto-assign |
| Ambiguity band | 0.75 – 0.85 | Multiple matches or borderline → Sonnet arbitration |
| Below floor | < 0.75 | No match → new topic candidate → Sonnet arbitration |

Do NOT tune until shadow-mode comparison data is available.

## Rollout Sequence

### Phase 1: Deploy (current)
- [x] Deploy with `--canonicalize-mode legacy` as default
- [x] No behavior change for any client
- [x] Migrations 016 + 017 applied
- [x] Hybrid module code deployed but inactive

### Phase 2: Shadow Validation
- [ ] Select one client with a representative keyword set (100-300 keywords)
- [ ] Run re-canonicalize with `--canonicalize-mode shadow`
- [ ] Generate diff report: `npm run canonicalize:shadow-compare -- --audit-id <uuid>`
- [ ] Review:
  - Agreement rate (target: > 90%)
  - Disagreements — are hybrid's groupings better, worse, or different-but-equivalent?
  - Arbitration rate — what % of keywords needed Sonnet? (target: < 25%)
  - Prior-lock rate — N/A on first shadow run
  - New topics created by hybrid — are they genuine splits or noise?

### Phase 3: Threshold Tuning (if needed)
- [ ] If agreement rate is low, analyze disagreements for threshold sensitivity
- [ ] Adjust AUTO_ASSIGN_THRESHOLD and AMBIGUITY_LOWER_BOUND in `pre-cluster.ts`
- [ ] Re-run shadow mode and compare again
- [ ] Do not move to Phase 4 until agreement rate is satisfactory

### Phase 4: Hybrid Pilot
- [ ] Select one client
- [ ] Run full re-canonicalize with `--canonicalize-mode hybrid`
- [ ] Validate output quality against prior legacy runs
- [ ] Verify downstream phases (rebuild clusters, Michael, Gap) produce correct output
- [ ] Verify cluster strategies are not orphaned (or are correctly deprecated)

### Phase 5: Gradual Migration
- [ ] Migrate additional clients to hybrid mode one at a time
- [ ] Monitor for: unexpected topic proliferation, orphaned strategies, cluster count drift
- [ ] Change default mode from `'legacy'` to `'hybrid'` in pipeline-generate.ts

### Phase 6: Legacy Retirement
- [ ] All clients running hybrid for >= 2 cycles with no issues
- [ ] Remove legacy Sonnet-only clustering code path
- [ ] Remove shadow mode infrastructure
- [ ] Update PIPELINE.md and DECISIONS.md

## Cost Impact

- **Shadow mode**: ~2x cost per canonicalize run (runs both paths). Acceptable for validation, not long-term.
- **Hybrid mode**: Lower Sonnet cost (only arbitration cases) + OpenAI embedding cost (~$0.0001 per keyword). Net cheaper than legacy for audits with > 50 keywords.
- **Embedding cost**: text-embedding-3-small at $0.02/1M tokens. 300 keywords ≈ 3000 tokens ≈ $0.00006. Negligible.

## Re-run Stability

Hybrid mode locks prior assignments on re-run when ALL three conditions are met:
1. Prior `canonical_key` exists on the keyword
2. That canonical topic still exists in the current run
3. Prior assignment was hybrid-originated (`classification_method IS NOT NULL`)

Hybrid's first run after legacy runs does NOT inherit legacy clustering — this is by design. The first hybrid run re-evaluates everything, then subsequent hybrid re-runs are stable.

## Monitoring Queries

```sql
-- Classification method distribution for an audit
SELECT classification_method, count(*)
FROM audit_keywords
WHERE audit_id = '<uuid>'
  AND classification_method IS NOT NULL
GROUP BY classification_method;

-- Shadow comparison: agreement rate
SELECT
  count(*) FILTER (WHERE canonicalize_mode IS NULL OR canonicalize_mode = 'legacy') AS legacy_rows,
  count(*) FILTER (WHERE canonicalize_mode = 'shadow_hybrid') AS hybrid_rows
FROM audit_keywords
WHERE audit_id = '<uuid>';

-- Average similarity scores by method
SELECT classification_method, avg(similarity_score), min(similarity_score), max(similarity_score)
FROM audit_keywords
WHERE audit_id = '<uuid>'
  AND similarity_score IS NOT NULL
GROUP BY classification_method;
```
