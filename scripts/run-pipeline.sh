#!/bin/bash
# run-pipeline.sh — Sequential post-audit agent pipeline
#
# DATA OWNERSHIP CONTRACT (see docs/PIPELINE.md for full spec)
# ─────────────────────────────────────────────────────────────
# EXPECTS TO EXIST:
#   audits              — created by Dashboard useCreateAudit
#   audit_assumptions   — created by Dashboard (or auto-created by sync from benchmarks)
#   benchmarks          — seeded reference data (one row per service vertical)
#   ctr_models          — seeded reference data (one row with is_default=true)
#
# THIS PIPELINE WRITES:
#   audit_keywords      — Phase 2 (source='keyword_research'), Phase 3b (source='ranked'),
#                         Phase 3c (UPDATE canonical_key/topic/intent/brand)
#   audit_clusters      — Phase 3b (preliminary), Phase 3d (canonical, authoritative)
#   audit_rollups       — Phase 3b (preliminary), Phase 3d (canonical, authoritative)
#   audit_topic_competitors — Phase 4
#   audit_topic_dominance   — Phase 4
#   audit_coverage_validation — Phase 6.5
#   agent_architecture_pages  — Phase 6b
#   agent_architecture_blueprint — Phase 6b
#   execution_pages     — Phase 6b (UPSERT)
#   agent_technical_pages — Phase 6c
#   gbp_snapshots       — Phase 6d
#   citation_snapshots  — Phase 6d
#   audit_snapshots     — Phase 3b, 6b, 6c
#   agent_runs          — all generation phases
#   audits              — agent_pipeline_status updates throughout
#
# THE run-audit EDGE FUNCTION WRITES NOTHING TO THE ABOVE.
# It only sets audits.status='running' + agent_pipeline_status='queued'.
# ─────────────────────────────────────────────────────────────
#
# Phase 1:  Dwight — DataForSEO OnPage crawl + analysis → AUDIT_REPORT.md + CSVs
# Phase 1a: Verify Dwight — HTTP checks for sitemap, schema, redirect integrity
# Phase 2:  KeywordResearch — Service × city × intent matrix → keyword_research_summary.md + audit_keywords (seeded)
# Phase 3:  Jim — DataForSEO ranked-keywords + competitors → research_summary.md
# Phase 3b: sync jim — ranked_keywords.json → Supabase (audit_keywords, clusters, rollups)
# Phase 3c: canonicalize — Claude Haiku semantic topic grouping → canonical_key/topic
# Phase 3d: rebuild clusters — re-aggregate using canonical_key (post-canonicalize)
# Phase 4:  Competitors — DataForSEO SERP per topic → audit_topic_competitors/dominance
# Phase 5:  Gap — Competitive gap synthesis → content_gap_analysis.md + audit_snapshots
# Phase 6:  Michael — Reads ALL disk artifacts → architecture_blueprint.md
# Phase 6.5: Validator — Coverage validation (gap vs blueprint cross-check)
# Phase 6b: sync michael — architecture_blueprint.md → Supabase
# Phase 6c: sync dwight — internal_all.csv + AUDIT_REPORT.md → Supabase
# Phase 6d: local presence — GBP lookup + SERP citation scan → gbp_snapshots, citation_snapshots
#
# All phases run synchronously.
#
# Usage:
#   ./scripts/run-pipeline.sh <domain> <email> [seed_matrix.json] [competitor_urls] [--mode sales|full|prospect] [--prospect-config <path>]
#   ./scripts/run-pipeline.sh foxhvacpro.com matt@forgegrowth.ai
#   ./scripts/run-pipeline.sh foxhvacpro.com matt@forgegrowth.ai --mode sales
#   ./scripts/run-pipeline.sh newsite.com matt@forgegrowth.ai audits/newsite.com/seed_matrix.json "comp1.com,comp2.com"
#   ./scripts/run-pipeline.sh prospect.com matt@forgegrowth.ai --mode prospect --prospect-config audits/prospect.com/prospect-config.json

set -euo pipefail

DOMAIN="${1:?Usage: ./scripts/run-pipeline.sh <domain> <email> [seed_matrix.json] [competitor_urls] [--mode sales|full|prospect] [--prospect-config <path>]}"
EMAIL="${2:?Usage: ./scripts/run-pipeline.sh <domain> <email> [seed_matrix.json] [competitor_urls] [--mode sales|full|prospect] [--prospect-config <path>]}"
SEED_MATRIX="${3:-}"
COMPETITOR_URLS="${4:-}"
DATE=$(date +%Y-%m-%d)

# Parse --mode, --prospect-config, and --start-from flags from any position
MODE="full"
PROSPECT_CONFIG=""
START_FROM=""
NEXT_FLAG=""
for i in "$@"; do
  if [[ "$i" == "--mode" ]]; then
    NEXT_FLAG="mode"
    continue
  fi
  if [[ "$i" == "--prospect-config" ]]; then
    NEXT_FLAG="prospect-config"
    continue
  fi
  if [[ "$i" == "--start-from" ]]; then
    NEXT_FLAG="start-from"
    continue
  fi
  if [[ "$NEXT_FLAG" == "mode" ]]; then
    MODE="$i"
    NEXT_FLAG=""
  elif [[ "$NEXT_FLAG" == "prospect-config" ]]; then
    PROSPECT_CONFIG="$i"
    NEXT_FLAG=""
  elif [[ "$NEXT_FLAG" == "start-from" ]]; then
    START_FROM="$i"
    NEXT_FLAG=""
  fi
done

# Phase ordering for --start-from
PHASE_ORDER=(1 1a 1b 2 3 3b 3c 3d 4 5 6 6.5 6b 6c 6d)
should_run_phase() {
  local phase="$1"
  [[ -z "$START_FROM" ]] && return 0
  local started=false
  for p in "${PHASE_ORDER[@]}"; do
    [[ "$p" == "$START_FROM" ]] && started=true
    [[ "$p" == "$phase" ]] && { $started && return 0 || return 1; }
  done
  return 0
}

# Clear positional args that were actually flags
[[ "$SEED_MATRIX" == "--mode" || "$SEED_MATRIX" == "--prospect-config" ]] && SEED_MATRIX=""
[[ "$COMPETITOR_URLS" == "--mode" || "$COMPETITOR_URLS" == "sales" || "$COMPETITOR_URLS" == "full" || "$COMPETITOR_URLS" == "--prospect-config" ]] && COMPETITOR_URLS=""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

MODE_ARGS=""
[[ "$MODE" != "full" ]] && MODE_ARGS="--mode $MODE"

echo "=== Post-Audit Pipeline: $DOMAIN ($DATE) [mode=$MODE] ==="

# ─── Phase 0: Scout (Prospect Discovery) ─────────────────────
# In prospect mode, only Scout runs — skips the full pipeline.
if [[ "$MODE" = "prospect" ]]; then
  if [[ -z "$PROSPECT_CONFIG" ]]; then
    echo "ERROR: --prospect-config is required for prospect mode"
    exit 1
  fi
  echo ""
  echo "--- Phase 0: Scout (Prospect Discovery) ---"
  npx tsx scripts/pipeline-generate.ts scout \
    --domain "$DOMAIN" --prospect-config "$PROSPECT_CONFIG"
  echo ""
  echo "=== Scout Complete ==="
  exit 0
fi

# Helper: update dashboard pipeline status (non-fatal)
update_status() {
  npx tsx scripts/update-pipeline-status.ts "$DOMAIN" "$EMAIL" "$1" 2>/dev/null || true
}

# Trap errors to mark pipeline as failed
trap 'update_status failed' ERR

update_status audit

[[ -n "$START_FROM" ]] && echo "  Resuming from Phase $START_FROM (skipping earlier phases)"

# ─── Phase 1: Dwight — DataForSEO OnPage Crawl ───────────────
if should_run_phase 1; then
echo ""
echo "--- Phase 1: Dwight (DataForSEO OnPage Crawl) ---"
npx tsx scripts/pipeline-generate.ts dwight --domain "$DOMAIN" --user-email "$EMAIL"

# QA gate: Dwight
echo "--- QA: Dwight ---"
QA_RESULT=$(npx tsx scripts/pipeline-generate.ts qa --domain "$DOMAIN" --user-email "$EMAIL" --phase dwight 2>&1) || {
  echo "  QA ENHANCE for Dwight — re-running with feedback..."
  npx tsx scripts/pipeline-generate.ts dwight --domain "$DOMAIN" --user-email "$EMAIL"
  npx tsx scripts/pipeline-generate.ts qa --domain "$DOMAIN" --user-email "$EMAIL" --phase dwight || {
    echo "  QA FAILED for Dwight after retry"
    update_status failed
    exit 1
  }
}
echo "  QA PASSED: Dwight"
else echo "  [SKIP] Phase 1: Dwight"; fi

# ─── Phase 1a: Verify Dwight (HTTP checks) ──────────────────
if should_run_phase 1a; then
echo ""
echo "--- Phase 1a: Verify Dwight (HTTP checks) ---"
npx tsx scripts/verify-dwight.ts --domain "$DOMAIN"
else echo "  [SKIP] Phase 1a: Verify Dwight"; fi

# ─── Phase 1b: Strategy Brief ────────────────────────────────
if should_run_phase 1b; then
echo ""
echo "--- Phase 1b: Strategy Brief ---"
npx tsx scripts/strategy-brief.ts --domain "$DOMAIN" --user-email "$EMAIL" --force
else echo "  [SKIP] Phase 1b: Strategy Brief"; fi

# ─── Review Gate (opt-in pause after Phase 1b) ──────────────
if should_run_phase 1b && [ "$MODE" = "full" ]; then
  REVIEW_GATE=$(npx tsx scripts/update-pipeline-status.ts "$DOMAIN" "$EMAIL" check-review-gate 2>/dev/null)
  if [ "$REVIEW_GATE" = "pause" ]; then
    echo "[Pipeline] Pausing for Strategy Brief review — status → awaiting_review"
    npx tsx scripts/update-pipeline-status.ts "$DOMAIN" "$EMAIL" awaiting_review
    exit 0
  fi
fi

# ─── Phase 2: Keyword Research ───────────────────────────────
if should_run_phase 2; then
echo ""
echo "--- Phase 2: Keyword Research (Service × City Matrix) ---"
npx tsx scripts/pipeline-generate.ts keyword-research --domain "$DOMAIN" --user-email "$EMAIL"

update_status research
else echo "  [SKIP] Phase 2: Keyword Research"; fi

# ─── Phase 3: Jim — DataForSEO → disk artifacts ─────────────
if should_run_phase 3; then
echo ""
echo "--- Phase 3: Jim (DataForSEO + Research Summary) ---"
SEED_ARGS=""
[[ -n "$SEED_MATRIX" ]] && SEED_ARGS="--seed-matrix $SEED_MATRIX"
[[ -n "$COMPETITOR_URLS" ]] && SEED_ARGS="$SEED_ARGS --competitor-urls $COMPETITOR_URLS"
npx tsx scripts/pipeline-generate.ts jim --domain "$DOMAIN" --user-email "$EMAIL" $SEED_ARGS $MODE_ARGS

# QA gate: Jim
echo "--- QA: Jim ---"
QA_RESULT=$(npx tsx scripts/pipeline-generate.ts qa --domain "$DOMAIN" --user-email "$EMAIL" --phase jim 2>&1) || {
  echo "  QA ENHANCE for Jim — re-running with feedback..."
  npx tsx scripts/pipeline-generate.ts jim --domain "$DOMAIN" --user-email "$EMAIL" $SEED_ARGS $MODE_ARGS
  npx tsx scripts/pipeline-generate.ts qa --domain "$DOMAIN" --user-email "$EMAIL" --phase jim || {
    echo "  QA FAILED for Jim after retry"
    update_status failed
    exit 1
  }
}
echo "  QA PASSED: Jim"
else echo "  [SKIP] Phase 3: Jim"; fi

# ─── Phase 3b: sync jim → Supabase ──────────────────────────
if should_run_phase 3b; then
echo ""
echo "--- Phase 3b: Sync Jim → Supabase ---"
npx tsx scripts/sync-to-dashboard.ts --domain "$DOMAIN" --user-email "$EMAIL" --agents jim
else echo "  [SKIP] Phase 3b: Sync Jim"; fi

# ─── Phase 3c: Canonicalize Topics ───────────────────────────
if should_run_phase 3c; then
echo ""
echo "--- Phase 3c: Canonicalize Topics (Claude Haiku) ---"
npx tsx scripts/pipeline-generate.ts canonicalize --domain "$DOMAIN" --user-email "$EMAIL"
else echo "  [SKIP] Phase 3c: Canonicalize"; fi

# ─── Phase 3d: Rebuild Clusters ──────────────────────────────
if should_run_phase 3d; then
echo ""
echo "--- Phase 3d: Rebuild Clusters (post-canonicalize) ---"
npx tsx scripts/sync-to-dashboard.ts --domain "$DOMAIN" --user-email "$EMAIL" --rebuild-clusters

update_status architecture
else echo "  [SKIP] Phase 3d: Rebuild Clusters"; fi

if [[ "$MODE" != "sales" ]]; then
  # ─── Phase 4: Competitor SERP Analysis ──────────────────────
  if should_run_phase 4; then
  echo ""
  echo "--- Phase 4: Competitor SERP Analysis ---"
  npx tsx scripts/pipeline-generate.ts competitors --domain "$DOMAIN" --user-email "$EMAIL"
  else echo "  [SKIP] Phase 4: Competitors"; fi

  # ─── Phase 5: Content Gap Analysis ──────────────────────────
  if should_run_phase 5; then
  echo ""
  echo "--- Phase 5: Content Gap Analysis ---"
  npx tsx scripts/pipeline-generate.ts gap --domain "$DOMAIN" --user-email "$EMAIL"

  # QA gate: Gap
  echo "--- QA: Gap ---"
  QA_RESULT=$(npx tsx scripts/pipeline-generate.ts qa --domain "$DOMAIN" --user-email "$EMAIL" --phase gap 2>&1) || {
    echo "  QA ENHANCE for Gap — re-running with feedback..."
    npx tsx scripts/pipeline-generate.ts gap --domain "$DOMAIN" --user-email "$EMAIL"
    npx tsx scripts/pipeline-generate.ts qa --domain "$DOMAIN" --user-email "$EMAIL" --phase gap || {
      echo "  QA FAILED for Gap after retry"
      update_status failed
      exit 1
    }
  }
  echo "  QA PASSED: Gap"
  else echo "  [SKIP] Phase 5: Gap"; fi
else
  echo ""
  echo "--- [SALES MODE] Skipping Phases 4-5 (Competitors + Gap) ---"
fi

# ─── Phase 6: Michael Architecture ────────────────────────────
if should_run_phase 6; then
echo ""
echo "--- Phase 6: Michael Architecture ---"
npx tsx scripts/pipeline-generate.ts michael --domain "$DOMAIN" --user-email "$EMAIL" $MODE_ARGS

# QA gate: Michael
echo "--- QA: Michael ---"
QA_RESULT=$(npx tsx scripts/pipeline-generate.ts qa --domain "$DOMAIN" --user-email "$EMAIL" --phase michael 2>&1) || {
  echo "  QA ENHANCE for Michael — re-running with feedback..."
  npx tsx scripts/pipeline-generate.ts michael --domain "$DOMAIN" --user-email "$EMAIL" $MODE_ARGS
  npx tsx scripts/pipeline-generate.ts qa --domain "$DOMAIN" --user-email "$EMAIL" --phase michael || {
    echo "  QA FAILED for Michael after retry"
    update_status failed
    exit 1
  }
}
echo "  QA PASSED: Michael"
else echo "  [SKIP] Phase 6: Michael"; fi

# ─── Phase 6.5: Coverage Validation ──────────────────────────
if [[ "$MODE" != "sales" ]]; then
  if should_run_phase 6.5; then
  echo ""
  echo "--- Phase 6.5: Coverage Validation ---"
  npx tsx scripts/pipeline-generate.ts validator --domain "$DOMAIN" --user-email "$EMAIL"
  else echo "  [SKIP] Phase 6.5: Validator"; fi
fi

# ─── Phase 6b: Sync Michael → Supabase ────────────────────────
if should_run_phase 6b; then
echo ""
echo "--- Phase 6b: Sync Michael → Supabase ---"
npx tsx scripts/sync-to-dashboard.ts --domain "$DOMAIN" --user-email "$EMAIL" --agents michael
else echo "  [SKIP] Phase 6b: Sync Michael"; fi

# ─── Phase 6c: Sync Dwight → Supabase ─────────────────────────
if should_run_phase 6c; then
echo ""
echo "--- Phase 6c: Sync Dwight → Supabase ---"
npx tsx scripts/sync-to-dashboard.ts --domain "$DOMAIN" --user-email "$EMAIL" --agents dwight
else echo "  [SKIP] Phase 6c: Sync Dwight"; fi

# ─── Phase 6d: Local Presence Diagnostic (GBP + Citations) ────
if should_run_phase 6d; then
echo ""
echo "--- Phase 6d: Local Presence Diagnostic (GBP + Citations) ---"
npx tsx scripts/local-presence.ts --domain "$DOMAIN" --user-email "$EMAIL" --force
else echo "  [SKIP] Phase 6d: Local Presence"; fi

update_status complete

# ─── Summary ──────────────────────────────────────────────────
echo ""
echo "=== Pipeline Complete [mode=$MODE] ==="
echo "  Phase 1:  Dwight   — DataForSEO OnPage crawl → AUDIT_REPORT.md [QA ✓]"
echo "  Phase 2:  KWRes.   — Service × city × intent matrix → keyword_research_summary.md"
echo "  Phase 3:  Jim      — DataForSEO ranked-keywords + competitors → research_summary.md [QA ✓]"
echo "  Phase 3b: sync     — ranked_keywords.json → audit_keywords (preliminary clusters)"
echo "  Phase 3c: canon.   — Claude Haiku semantic topic grouping → canonical_key/topic"
echo "  Phase 3d: rebuild  — Re-aggregate clusters using canonical groupings"
if [[ "$MODE" != "sales" ]]; then
  echo "  Phase 4:  Compet.  — SERP analysis → audit_topic_competitors/dominance"
  echo "  Phase 5:  Gap      — Competitive gap synthesis → content_gap_analysis.md [QA ✓]"
else
  echo "  Phase 4:  SKIPPED  (sales mode)"
  echo "  Phase 5:  SKIPPED  (sales mode)"
fi
echo "  Phase 6:  Michael  — All artifacts → architecture_blueprint.md [QA ✓]"
if [[ "$MODE" != "sales" ]]; then
  echo "  Phase 6.5: Valid.  — Coverage validation (gap vs blueprint cross-check)"
fi
echo "  Phase 6b: sync     — architecture_blueprint.md → Supabase"
echo "  Phase 6c: sync     — internal_all.csv + AUDIT_REPORT.md → Supabase"
echo "  Phase 6d: local    — GBP lookup + citation scan (11 directories)"
echo ""
echo "Dashboard tabs: Research, Strategy, Content Factory, Technical Audit"
