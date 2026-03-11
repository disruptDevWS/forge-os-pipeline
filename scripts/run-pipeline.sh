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
#   audit_snapshots     — Phase 3b, 6b, 6c
#   agent_runs          — all generation phases
#   audits              — agent_pipeline_status updates throughout
#
# THE run-audit EDGE FUNCTION WRITES NOTHING TO THE ABOVE.
# It only sets audits.status='running' + agent_pipeline_status='queued'.
# ─────────────────────────────────────────────────────────────
#
# Phase 1:  Dwight — Comprehensive SF crawl + analysis → AUDIT_REPORT.md + CSVs
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
#
# All phases run synchronously. No NanoClaw, Docker, or WhatsApp dependency.
#
# Usage:
#   ./scripts/run-pipeline.sh <domain> <email> [seed_matrix.json] [competitor_urls] [--mode sales|full]
#   ./scripts/run-pipeline.sh foxhvacpro.com matt@forgegrowth.ai
#   ./scripts/run-pipeline.sh foxhvacpro.com matt@forgegrowth.ai --mode sales
#   ./scripts/run-pipeline.sh newsite.com matt@forgegrowth.ai audits/newsite.com/seed_matrix.json "comp1.com,comp2.com"

set -euo pipefail

DOMAIN="${1:?Usage: ./scripts/run-pipeline.sh <domain> <email> [seed_matrix.json] [competitor_urls] [--mode sales|full]}"
EMAIL="${2:?Usage: ./scripts/run-pipeline.sh <domain> <email> [seed_matrix.json] [competitor_urls] [--mode sales|full]}"
SEED_MATRIX="${3:-}"
COMPETITOR_URLS="${4:-}"
DATE=$(date +%Y-%m-%d)

# Parse --mode flag from any position
MODE="full"
for i in "$@"; do
  if [[ "$i" == "--mode" ]]; then
    shift_next=true
    continue
  fi
  if [[ "${shift_next:-}" == "true" ]]; then
    MODE="$i"
    shift_next=false
  fi
done

# Clear positional args that were actually --mode flags
[[ "$SEED_MATRIX" == "--mode" ]] && SEED_MATRIX=""
[[ "$COMPETITOR_URLS" == "--mode" || "$COMPETITOR_URLS" == "sales" || "$COMPETITOR_URLS" == "full" ]] && COMPETITOR_URLS=""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

MODE_ARGS=""
[[ "$MODE" != "full" ]] && MODE_ARGS="--mode $MODE"

echo "=== Post-Audit Pipeline: $DOMAIN ($DATE) [mode=$MODE] ==="

# Helper: update dashboard pipeline status (non-fatal)
update_status() {
  npx tsx scripts/update-pipeline-status.ts "$DOMAIN" "$EMAIL" "$1" 2>/dev/null || true
}

# Trap errors to mark pipeline as failed
trap 'update_status failed' ERR

update_status audit

# ─── Phase 1: Dwight — Comprehensive SF Crawl ───────────────
# Runs Screaming Frog CLI with 15 export tabs, 12 bulk exports,
# 5 reports. Produces 20+ CSV files + AUDIT_REPORT.md.
# Copies internal_all.csv + semantically_similar_report.csv to
# architecture dir for Michael.
echo ""
echo "--- Phase 1: Dwight (Comprehensive SF Crawl) ---"
npx tsx scripts/pipeline-generate.ts dwight --domain "$DOMAIN" --user-email "$EMAIL"

# ─── Phase 2: Keyword Research ───────────────────────────────
# Reads Dwight's AUDIT_REPORT.md to extract services + locations.
# Builds service × city × intent matrix, validates with DataForSEO,
# seeds audit_keywords with is_near_me set from the start.
echo ""
echo "--- Phase 2: Keyword Research (Service × City Matrix) ---"
npx tsx scripts/pipeline-generate.ts keyword-research --domain "$DOMAIN" --user-email "$EMAIL"

update_status research

# ─── Phase 3: Jim — DataForSEO → disk artifacts ─────────────
# Calls foundational_scout.sh for ranked-keywords + competitors,
# then claude --print (sonnet) for research_summary.md.
# Now receives site inventory from Dwight and keyword opportunities
# from KeywordResearch as primary research foundation.
# Produces: audits/{domain}/research/{date}/ranked_keywords.json,
#           competitors.json, research_summary.md
echo ""
echo "--- Phase 3: Jim (DataForSEO + Research Summary) ---"
SEED_ARGS=""
[[ -n "$SEED_MATRIX" ]] && SEED_ARGS="--seed-matrix $SEED_MATRIX"
[[ -n "$COMPETITOR_URLS" ]] && SEED_ARGS="$SEED_ARGS --competitor-urls $COMPETITOR_URLS"
npx tsx scripts/pipeline-generate.ts jim --domain "$DOMAIN" --user-email "$EMAIL" $SEED_ARGS $MODE_ARGS

# ─── Phase 3b: sync jim → Supabase ──────────────────────────
# Parses ranked_keywords.json → populates audit_keywords (~1000 rows),
# audit_clusters, audit_rollups. Needed before competitors step.
echo ""
echo "--- Phase 3b: Sync Jim → Supabase ---"
npx tsx scripts/sync-to-dashboard.ts --domain "$DOMAIN" --user-email "$EMAIL" --agents jim

# ─── Phase 3c: Canonicalize Topics ───────────────────────────
# Claude Haiku semantic grouping of keywords into clean topic labels.
# Populates canonical_key, canonical_topic, cluster for all audit_keywords.
# Must run before competitors (clean keys eliminate duplicate SERP calls).
echo ""
echo "--- Phase 3c: Canonicalize Topics (Claude Haiku) ---"
npx tsx scripts/pipeline-generate.ts canonicalize --domain "$DOMAIN" --user-email "$EMAIL"

# ─── Phase 3d: Rebuild Clusters ──────────────────────────────
# Canonicalize updates canonical_key/topic on keywords but doesn't
# rebuild clusters. Re-aggregate using canonical groupings.
echo ""
echo "--- Phase 3d: Rebuild Clusters (post-canonicalize) ---"
npx tsx scripts/sync-to-dashboard.ts --domain "$DOMAIN" --user-email "$EMAIL" --rebuild-clusters

update_status architecture

if [[ "$MODE" != "sales" ]]; then
  # ─── Phase 4: Competitor SERP Analysis ──────────────────────
  # Fetches live SERP data from DataForSEO for top keyword topics
  # (needs audit_keywords populated by sync jim in Phase 3b).
  # Populates audit_topic_competitors + audit_topic_dominance.
  echo ""
  echo "--- Phase 4: Competitor SERP Analysis ---"
  npx tsx scripts/pipeline-generate.ts competitors --domain "$DOMAIN" --user-email "$EMAIL"

  # ─── Phase 5: Content Gap Analysis ──────────────────────────
  # Queries competitive data from Supabase (needs audit_topic_competitors
  # + audit_topic_dominance from Phase 4), synthesizes via claude --print.
  # Writes content_gap_analysis.md to disk + inserts audit_snapshots.
  echo ""
  echo "--- Phase 5: Content Gap Analysis ---"
  npx tsx scripts/pipeline-generate.ts gap --domain "$DOMAIN" --user-email "$EMAIL"
else
  echo ""
  echo "--- [SALES MODE] Skipping Phases 4-5 (Competitors + Gap) ---"
fi

# ─── Phase 6: Michael Architecture ────────────────────────────
# Reads ALL disk artifacts: Jim's research_summary.md + ranked_keywords.json,
# Dwight's internal_all.csv + semantically_similar_report.csv,
# Gap's content_gap_analysis.md. Plus Supabase clusters (revenue data).
# Generates architecture_blueprint.md.
echo ""
echo "--- Phase 6: Michael Architecture ---"
npx tsx scripts/pipeline-generate.ts michael --domain "$DOMAIN" --user-email "$EMAIL" $MODE_ARGS

# ─── Phase 6.5: Coverage Validation ──────────────────────────
# Cross-checks Gap's identified gaps against Michael's blueprint.
# Writes coverage_validation.md + audit_coverage_validation rows.
if [[ "$MODE" != "sales" ]]; then
  echo ""
  echo "--- Phase 6.5: Coverage Validation ---"
  npx tsx scripts/pipeline-generate.ts validator --domain "$DOMAIN" --user-email "$EMAIL"
fi

# ─── Phase 6b+c: Sync remaining agents → Supabase ───────────
echo ""
echo "--- Phase 6b: Sync Michael → Supabase ---"
npx tsx scripts/sync-to-dashboard.ts --domain "$DOMAIN" --user-email "$EMAIL" --agents michael

echo ""
echo "--- Phase 6c: Sync Dwight → Supabase ---"
npx tsx scripts/sync-to-dashboard.ts --domain "$DOMAIN" --user-email "$EMAIL" --agents dwight

update_status complete

# ─── Summary ──────────────────────────────────────────────────
echo ""
echo "=== Pipeline Complete [mode=$MODE] ==="
echo "  Phase 1:  Dwight   — Comprehensive SF crawl (20+ CSVs) → AUDIT_REPORT.md"
echo "  Phase 2:  KWRes.   — Service × city × intent matrix → keyword_research_summary.md"
echo "  Phase 3:  Jim      — DataForSEO ranked-keywords + competitors → research_summary.md"
echo "  Phase 3b: sync     — ranked_keywords.json → audit_keywords (preliminary clusters)"
echo "  Phase 3c: canon.   — Claude Haiku semantic topic grouping → canonical_key/topic"
echo "  Phase 3d: rebuild  — Re-aggregate clusters using canonical groupings"
if [[ "$MODE" != "sales" ]]; then
  echo "  Phase 4:  Compet.  — SERP analysis → audit_topic_competitors/dominance"
  echo "  Phase 5:  Gap      — Competitive gap synthesis → content_gap_analysis.md"
else
  echo "  Phase 4:  SKIPPED  (sales mode)"
  echo "  Phase 5:  SKIPPED  (sales mode)"
fi
echo "  Phase 6:  Michael  — All artifacts → architecture_blueprint.md"
if [[ "$MODE" != "sales" ]]; then
  echo "  Phase 6.5: Valid.  — Coverage validation (gap vs blueprint cross-check)"
fi
echo "  Phase 6b: sync     — architecture_blueprint.md → Supabase"
echo "  Phase 6c: sync     — internal_all.csv + AUDIT_REPORT.md → Supabase"
echo ""
echo "Dashboard tabs: Research, Strategy, Content Factory, Technical Audit"
