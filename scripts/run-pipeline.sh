#!/bin/bash
# run-pipeline.sh — Sequential post-audit agent pipeline
#
# Phase 1:  Jim — DataForSEO calls → research artifacts to disk
# Phase 1b: sync jim — ranked_keywords.json → Supabase (audit_keywords, clusters, rollups)
# Phase 1c: canonicalize — Claude Haiku semantic topic grouping → canonical_key/topic
# Phase 2:  Dwight — Comprehensive SF crawl + analysis → AUDIT_REPORT.md + CSVs
# Phase 3:  Competitors — DataForSEO SERP per topic → audit_topic_competitors/dominance
# Phase 4:  Gap — Competitive gap synthesis → content_gap_analysis.md + audit_snapshots
# Phase 5:  Michael — Reads ALL disk artifacts → architecture_blueprint.md
# Phase 5b: sync michael — architecture_blueprint.md → Supabase
# Phase 5c: sync dwight — internal_all.csv + AUDIT_REPORT.md → Supabase
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

# ─── Phase 1: Jim — DataForSEO → disk artifacts ─────────────
# Calls foundational_scout.sh for ranked-keywords + competitors,
# then claude --print (sonnet) for research_summary.md.
# Produces: audits/{domain}/research/{date}/ranked_keywords.json,
#           competitors.json, research_summary.md
echo ""
echo "--- Phase 1: Jim (DataForSEO + Research Summary) ---"
SEED_ARGS=""
[[ -n "$SEED_MATRIX" ]] && SEED_ARGS="--seed-matrix $SEED_MATRIX"
[[ -n "$COMPETITOR_URLS" ]] && SEED_ARGS="$SEED_ARGS --competitor-urls $COMPETITOR_URLS"
npx tsx scripts/pipeline-generate.ts jim --domain "$DOMAIN" --user-email "$EMAIL" $SEED_ARGS $MODE_ARGS

# ─── Phase 1b: sync jim → Supabase ──────────────────────────
# Parses ranked_keywords.json → populates audit_keywords (~1000 rows),
# audit_clusters, audit_rollups. Needed before competitors step.
echo ""
echo "--- Phase 1b: Sync Jim → Supabase ---"
npx tsx scripts/sync-to-dashboard.ts --domain "$DOMAIN" --user-email "$EMAIL" --agents jim

# ─── Phase 1c: Canonicalize Topics ───────────────────────────
# Claude Haiku semantic grouping of keywords into clean topic labels.
# Populates canonical_key, canonical_topic, cluster for all audit_keywords.
# Must run before competitors (clean keys eliminate duplicate SERP calls).
echo ""
echo "--- Phase 1c: Canonicalize Topics (Claude Haiku) ---"
npx tsx scripts/pipeline-generate.ts canonicalize --domain "$DOMAIN" --user-email "$EMAIL"

# ─── Phase 2: Dwight — Comprehensive SF Crawl ───────────────
# Runs Screaming Frog CLI with 15 export tabs, 12 bulk exports,
# 5 reports. Produces 20+ CSV files + AUDIT_REPORT.md.
# Copies internal_all.csv + semantically_similar_report.csv to
# architecture dir for Michael.
echo ""
echo "--- Phase 2: Dwight (Comprehensive SF Crawl) ---"
npx tsx scripts/pipeline-generate.ts dwight --domain "$DOMAIN" --user-email "$EMAIL"

if [[ "$MODE" != "sales" ]]; then
  # ─── Phase 3: Competitor SERP Analysis ──────────────────────
  # Fetches live SERP data from DataForSEO for top keyword topics
  # (needs audit_keywords populated by sync jim in Phase 1b).
  # Populates audit_topic_competitors + audit_topic_dominance.
  echo ""
  echo "--- Phase 3: Competitor SERP Analysis ---"
  npx tsx scripts/pipeline-generate.ts competitors --domain "$DOMAIN" --user-email "$EMAIL"

  # ─── Phase 4: Content Gap Analysis ──────────────────────────
  # Queries competitive data from Supabase (needs audit_topic_competitors
  # + audit_topic_dominance from Phase 3), synthesizes via claude --print.
  # Writes content_gap_analysis.md to disk + inserts audit_snapshots.
  echo ""
  echo "--- Phase 4: Content Gap Analysis ---"
  npx tsx scripts/pipeline-generate.ts gap --domain "$DOMAIN" --user-email "$EMAIL"
else
  echo ""
  echo "--- [SALES MODE] Skipping Phases 3-4 (Competitors + Gap) ---"
fi

# ─── Phase 5: Michael Architecture ────────────────────────────
# Reads ALL disk artifacts: Jim's research_summary.md + ranked_keywords.json,
# Dwight's internal_all.csv + semantically_similar_report.csv,
# Gap's content_gap_analysis.md. Plus Supabase clusters (revenue data).
# Generates architecture_blueprint.md.
echo ""
echo "--- Phase 5: Michael Architecture ---"
npx tsx scripts/pipeline-generate.ts michael --domain "$DOMAIN" --user-email "$EMAIL" $MODE_ARGS

# ─── Phase 5b+c: Sync remaining agents → Supabase ───────────
echo ""
echo "--- Phase 5b: Sync Michael → Supabase ---"
npx tsx scripts/sync-to-dashboard.ts --domain "$DOMAIN" --user-email "$EMAIL" --agents michael

echo ""
echo "--- Phase 5c: Sync Dwight → Supabase ---"
npx tsx scripts/sync-to-dashboard.ts --domain "$DOMAIN" --user-email "$EMAIL" --agents dwight

# ─── Summary ──────────────────────────────────────────────────
echo ""
echo "=== Pipeline Complete [mode=$MODE] ==="
echo "  Phase 1:  Jim      — DataForSEO ranked-keywords + competitors → research_summary.md"
echo "  Phase 1b: sync     — ranked_keywords.json → audit_keywords (~1000 rows)"
echo "  Phase 1c: canon.   — Claude Haiku semantic topic grouping → canonical_key/topic"
echo "  Phase 2:  Dwight   — Comprehensive SF crawl (20+ CSVs) → AUDIT_REPORT.md"
if [[ "$MODE" != "sales" ]]; then
  echo "  Phase 3:  Compet.  — SERP analysis → audit_topic_competitors/dominance"
  echo "  Phase 4:  Gap      — Competitive gap synthesis → content_gap_analysis.md"
else
  echo "  Phase 3:  SKIPPED  (sales mode)"
  echo "  Phase 4:  SKIPPED  (sales mode)"
fi
echo "  Phase 5:  Michael  — All artifacts → architecture_blueprint.md"
echo "  Phase 5b: sync     — architecture_blueprint.md → Supabase"
echo "  Phase 5c: sync     — internal_all.csv + AUDIT_REPORT.md → Supabase"
echo ""
echo "Dashboard tabs: Research, Strategy, Content Factory, Technical Audit"
