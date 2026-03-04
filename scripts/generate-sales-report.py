#!/usr/bin/env python3
"""
Generate a branded Market Position Report PDF from Supabase audit data.

Usage:
    python3 scripts/generate-sales-report.py --domain foxhvacpro.com
    python3 scripts/generate-sales-report.py --domain foxhvacpro.com --company "Fox HVAC Pro"
"""

import argparse
import json
import math
import os
import sys
from datetime import datetime
from pathlib import Path

import requests
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

# ---------------------------------------------------------------------------
# Layer 1: Config + .env
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
FONTS_DIR = PROJECT_ROOT / "assets" / "fonts"
ASSETS_DIR = PROJECT_ROOT / "assets" / "report"
REPORTS_DIR = PROJECT_ROOT / "reports"

# Brand colors (from JSX)
BURNT_ORANGE = HexColor("#CC4E0E")
CHARCOAL = HexColor("#1D1D1D")
BONE_WHITE = HexColor("#F5F2EB")
STEEL_BLUE = HexColor("#3A5A8F")
GRAPHITE = HexColor("#585858")
WHITE = HexColor("#FFFFFF")
LIGHT_GRAY = HexColor("#E8E5DE")
RED_ALERT = HexColor("#B91C1C")
GREEN_GOOD = HexColor("#15803D")
YELLOW_WARN = HexColor("#A16207")

# Risk badge colors
RISK_COLORS = {
    "critical": {"bg": "#FEF2F2", "text": "#B91C1C", "border": "#FECACA"},
    "high": {"bg": "#FFFBEB", "text": "#A16207", "border": "#FDE68A"},
    "medium": {"bg": "#F0F9FF", "text": "#3A5A8F", "border": "#BAE6FD"},
}

CTA_LINK = "https://calendar.app.google/AXxRKHuyMjvhtrNs7"
PAGE_W, PAGE_H = letter  # 612 x 792

# Industry display names (service_key → display label)
INDUSTRY_DISPLAY = {
    "hvac": "HVAC",
    "plumbing": "Plumbing",
    "electrical": "Electrical",
    "roofing": "Roofing",
    "restoration": "Restoration",
    "garage_doors": "Garage Doors",
    "landscaping": "Landscaping/Lawn Care",
    "pest_control": "Pest Control",
    "fencing": "Fencing",
    "tree_service": "Tree Service",
    "remodeling": "Remodeling/General Contractors",
}

# Sanity caps for revenue exposure per-industry (annual)
REVENUE_CAP = 3_000_000

LOGO_PATH = ASSETS_DIR / "forge-growth-horizontal-logo-400x100-trans-bg.png"


def parse_env():
    """Parse .env file without touching process.env."""
    env = {}
    env_path = PROJECT_ROOT / ".env"
    if not env_path.exists():
        return env
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def register_fonts():
    """Register Oswald + Inter TTFs."""
    fonts = {
        "Oswald": "Oswald-Regular.ttf",
        "Oswald-SemiBold": "Oswald-SemiBold.ttf",
        "Oswald-Bold": "Oswald-Bold.ttf",
        "Inter": "Inter-Regular.ttf",
        "Inter-Medium": "Inter-Medium.ttf",
        "Inter-SemiBold": "Inter-SemiBold.ttf",
        "Inter-Bold": "Inter-Bold.ttf",
    }
    for name, filename in fonts.items():
        path = FONTS_DIR / filename
        if not path.exists():
            print(f"Warning: Font {path} not found", file=sys.stderr)
            continue
        pdfmetrics.registerFont(TTFont(name, str(path)))


# ---------------------------------------------------------------------------
# Layer 2: Supabase Queries
# ---------------------------------------------------------------------------


class SupabaseClient:
    def __init__(self, url: str, key: str):
        self.url = url.rstrip("/")
        self.headers = {
            "Authorization": f"Bearer {key}",
            "apikey": key,
            "Content-Type": "application/json",
        }

    def get(self, table: str, params: str) -> list:
        resp = requests.get(
            f"{self.url}/rest/v1/{table}?{params}", headers=self.headers
        )
        resp.raise_for_status()
        return resp.json()


def fetch_all(sb: SupabaseClient, domain: str) -> dict:
    """Fetch all audit data for a domain."""
    # 1. Audit metadata
    audits = sb.get("audits", f"domain=eq.{domain}&order=created_at.desc&limit=1")
    if not audits:
        print(f"Error: No audit found for domain '{domain}'", file=sys.stderr)
        sys.exit(1)
    audit = audits[0]
    audit_id = audit["id"]

    # 2. Revenue rollups
    rollups = sb.get("audit_rollups", f"audit_id=eq.{audit_id}&limit=1")
    rollup = rollups[0] if rollups else {}

    # 3. All keywords (limit=10000 to avoid PostgREST default pagination)
    keywords = sb.get(
        "audit_keywords",
        f"audit_id=eq.{audit_id}&select=keyword,rank_pos,search_volume,is_near_miss,is_top_10,is_striking_distance,delta_revenue_low,delta_revenue_mid,delta_revenue_high,cluster&limit=10000",
    )

    # 4. Topic dominance
    dominance = sb.get("audit_topic_dominance", f"audit_id=eq.{audit_id}")

    # 5. Topic competitors (non-client only, with competitor_type for filtering)
    competitors = sb.get(
        "audit_topic_competitors",
        f"audit_id=eq.{audit_id}&is_client=eq.false&select=canonical_key,competitor_domain,appearance_count,share,competitor_type",
    )

    # 6. Gap snapshot
    gap_snaps = sb.get(
        "audit_snapshots",
        f"audit_id=eq.{audit_id}&agent_name=eq.gap&order=snapshot_version.desc&limit=1",
    )
    gap = gap_snaps[0] if gap_snaps else {}

    # 7. Dwight snapshot
    dwight_snaps = sb.get(
        "audit_snapshots",
        f"audit_id=eq.{audit_id}&agent_name=eq.dwight&order=snapshot_version.desc&limit=1",
    )
    dwight = dwight_snaps[0] if dwight_snaps else {}

    # 8. Audit assumptions (industry benchmarks overrides)
    assumptions = sb.get("audit_assumptions", f"audit_id=eq.{audit_id}&limit=1")
    assumption = assumptions[0] if assumptions else {}

    return {
        "audit": audit,
        "rollup": rollup,
        "keywords": keywords,
        "dominance": dominance,
        "competitors": competitors,
        "gap": gap,
        "dwight": dwight,
        "assumption": assumption,
    }


# ---------------------------------------------------------------------------
# Layer 3: Computation
# ---------------------------------------------------------------------------


def ensure_parsed(val):
    """Ensure a value is parsed from JSON string if needed."""
    if isinstance(val, str):
        try:
            return json.loads(val)
        except (json.JSONDecodeError, TypeError):
            return val
    return val


def compute_report_data(raw: dict, company_override: str | None = None) -> dict:
    audit = raw["audit"]
    rollup = raw["rollup"]
    keywords = raw["keywords"]
    gap = raw["gap"]
    dwight = raw["dwight"]

    assumption = raw.get("assumption") or {}

    # --- Prospect info ---
    domain = audit["domain"]
    if company_override:
        company = company_override
    elif audit.get("business_name"):
        company = audit["business_name"]
    else:
        # Derive company name from domain
        company = domain.split(".")[0].replace("-", " ").title()

    market_city = audit.get("market_city", "")
    market_state = audit.get("market_state", "")
    market = f"{market_city}, {market_state}" if market_city else ""
    service_key = (audit.get("service_key") or "").lower()
    industry = INDUSTRY_DISPLAY.get(service_key, service_key.replace("_", " ").title())
    report_date = datetime.now().strftime("%B %d, %Y")

    # --- Visibility metrics ---
    total_tracked = len(keywords)
    currently_ranking = sum(1 for k in keywords if k.get("rank_pos") is not None)
    top_10 = sum(1 for k in keywords if k.get("is_top_10"))
    striking_distance = sum(1 for k in keywords if k.get("is_striking_distance"))
    visibility_score = min(round(top_10 / total_tracked * 100), 100) if total_tracked > 0 else 0
    ranking_pct = round(currently_ranking / total_tracked * 100, 1) if total_tracked > 0 else 0

    # --- Revenue exposure (mid-tier estimate: cr_mid × acv_mid) ---
    # Sum delta_revenue_mid for keywords where client is absent or outside top 10
    # Falls back to delta_revenue_high if mid not yet populated
    monthly_delta = 0.0
    for k in keywords:
        rp = k.get("rank_pos")
        dr = k.get("delta_revenue_mid") or k.get("delta_revenue_high") or 0
        if rp is None or rp > 10:
            monthly_delta += dr
    annual_opportunity = monthly_delta * 12
    # Sanity cap for local service businesses
    if annual_opportunity > REVENUE_CAP:
        annual_opportunity = REVENUE_CAP
    current_capture_pct = round(top_10 / total_tracked * 100) if total_tracked > 0 else 0

    # Gap data
    keyword_overview = ensure_parsed(gap.get("keyword_overview") or {})
    authority_gaps = keyword_overview.get("authority_gaps") or []
    gap_summary = keyword_overview.get("summary") or ""

    # Fallback narrative if no gap summary exists
    if not gap_summary.strip():
        gap_summary = (
            f"{domain} ranks for {total_tracked} keywords with only {top_10} in the top 10, "
            f"leaving {total_tracked - top_10} high-value search terms where competitors "
            f"capture the traffic instead."
        )
        if market:
            gap_summary += (
                f" The estimated revenue exposure represents search-driven leads your "
                f"competitors are capturing in the {market} market that your site is not "
                f"visible for."
            )
        else:
            gap_summary += (
                " The estimated revenue exposure represents search-driven leads your "
                "competitors are capturing that your site is not visible for."
            )

    # Note: top_gap_revenue is computed after brand-pollution filtering below

    # --- Top 3 competitors (filter using competitor_type from LLM classification) ---
    comp_data = raw["competitors"]

    # Check if any rows have competitor_type populated (new pipeline data)
    has_classifications = any(c.get("competitor_type") for c in comp_data)

    if has_classifications:
        # Use upstream LLM classifications — most accurate
        industry_comps = [
            c for c in comp_data
            if c.get("competitor_type") == "industry_competitor"
        ]
        brand_confusion_domains = {
            c["competitor_domain"] for c in comp_data
            if c.get("competitor_type") in ("brand_confusion", "aggregator", "unrelated")
        }
    else:
        # Fallback heuristic for audits not yet re-run with classifier:
        # Domains on 3+ topics are likely real competitors
        domain_topic_counts = {}
        for c in comp_data:
            d = c["competitor_domain"]
            domain_topic_counts[d] = domain_topic_counts.get(d, 0) + 1
        multi_topic = {d for d, tc in domain_topic_counts.items() if tc >= 3}

        # Name-fragment detection for brand confusion
        client_stem = domain.split(".")[0].lower()
        brand_confusion_domains = set()
        for comp_d in domain_topic_counts:
            if comp_d in multi_topic:
                continue
            comp_stem = comp_d.split(".")[0].lower()
            # Check first 3-7 char prefixes of client stem
            for i in range(3, min(len(client_stem), 8)):
                prefix = client_stem[:i]
                if prefix not in {"the", "and", "pro", "com", "net", "inc"} and prefix in comp_stem:
                    brand_confusion_domains.add(comp_d)
                    break

        industry_comps = [
            c for c in comp_data
            if c["competitor_domain"] in multi_topic
            and c["competitor_domain"] not in brand_confusion_domains
        ]

    # Aggregate appearances for industry competitors
    domain_appearance_counts = {}
    for c in industry_comps:
        d = c["competitor_domain"]
        domain_appearance_counts[d] = domain_appearance_counts.get(d, 0) + (c.get("appearance_count") or 0)

    top_3_domains = sorted(domain_appearance_counts.items(), key=lambda x: x[1], reverse=True)[:3]

    # If fewer than 2 competitors after filtering, relax: include all non-brand-confusion
    # domains sorted by total appearances (even if only 1-2 topic appearances)
    if len(top_3_domains) < 2:
        all_domain_counts = {}
        for c in comp_data:
            cd = c["competitor_domain"]
            if cd not in brand_confusion_domains:
                all_domain_counts[cd] = all_domain_counts.get(cd, 0) + (c.get("appearance_count") or 0)
        # Exclude already-included domains
        existing = {d for d, _ in top_3_domains}
        extras = sorted(
            [(d, cnt) for d, cnt in all_domain_counts.items() if d not in existing],
            key=lambda x: x[1], reverse=True,
        )
        top_3_domains = list(top_3_domains) + extras[:3 - len(top_3_domains)]

    dominance = raw["dominance"]
    dom_by_topic = {}
    for d in dominance:
        dom_by_topic[d.get("canonical_key") or d.get("canonical_topic", "")] = d

    competitors_out = []
    for comp_domain, count in top_3_domains:
        # Find topics where this competitor leads
        comp_topics = [
            d for d in dominance
            if d.get("leader_domain") == comp_domain
        ]
        comp_topics.sort(key=lambda x: x.get("leader_share") or 0, reverse=True)

        if comp_topics:
            top_topic = comp_topics[0].get("canonical_topic", "")
            strength = f"Dominant on {top_topic} terms"
        else:
            strength = f"Strong organic presence ({count} topic appearances)"

        # Get key terms from topic competitors
        comp_entries = [
            c for c in comp_data
            if c["competitor_domain"] == comp_domain
        ]
        comp_entries.sort(key=lambda x: x.get("share") or 0, reverse=True)
        key_terms = ", ".join(
            humanize_canonical_key(c.get("canonical_key", "")) for c in comp_entries[:3]
        )

        competitors_out.append({
            "name": comp_domain,
            "strength": strength,
            "keyTerms": key_terms,
        })

    # --- Authority gaps table (filter brand-confusion entries) ---
    status_to_risk = {"absent": "critical", "weak": "high", "behind": "medium"}
    # Filter out gaps where the top_competitor is a brand-confusion domain
    filtered_gaps = [
        g for g in authority_gaps
        if g.get("top_competitor", "") not in brand_confusion_domains
    ]

    # Deduplicate by normalized word set ("boise hvac" == "hvac boise")
    seen_word_sets = {}
    deduped_gaps = []
    for g in filtered_gaps:
        topic = (g.get("topic") or "").lower().strip()
        word_key = tuple(sorted(topic.split()))
        if word_key in seen_word_sets:
            # Keep higher volume entry
            existing = seen_word_sets[word_key]
            if (g.get("estimated_volume") or 0) > (existing.get("estimated_volume") or 0):
                deduped_gaps.remove(existing)
                deduped_gaps.append(g)
                seen_word_sets[word_key] = g
        else:
            seen_word_sets[word_key] = g
            deduped_gaps.append(g)
    filtered_gaps = deduped_gaps

    # Build cluster_revenue lookup: sum delta_revenue_mid by cluster
    cluster_revenue = {}
    for k in keywords:
        cl = k.get("cluster")
        if cl:
            cl_lower = cl.lower().strip()
            dr = k.get("delta_revenue_mid") or k.get("delta_revenue_high") or 0
            cluster_revenue[cl_lower] = cluster_revenue.get(cl_lower, 0) + dr

    # Industry defaults for floor estimate
    cr_mid = assumption.get("cr_mid") or 0.03
    acv_mid = assumption.get("acv_mid") or 1500

    # Find top gap by revenue (post-filter)
    top_gap_revenue = 0
    top_gap_keyword = ""
    for g in filtered_gaps:
        rev = g.get("revenue_opportunity") or g.get("estimated_revenue") or 0
        rev = parse_revenue(rev)
        if rev > top_gap_revenue:
            top_gap_revenue = rev
            top_gap_keyword = g.get("topic", "")

    gaps_out = []
    for g in sorted(filtered_gaps, key=lambda x: x.get("estimated_volume") or 0, reverse=True)[:8]:
        client_status = (g.get("client_status") or "absent").lower()
        risk = status_to_risk.get(client_status, "medium")

        vol = g.get("estimated_volume") or 0

        # Revenue resolution: direct → cluster match → floor estimate
        rev_raw = g.get("revenue_opportunity") or g.get("estimated_revenue") or 0
        rev_num = parse_revenue(rev_raw)

        if not rev_num:
            # Try matching topic to cluster by exact or substring match
            topic_lower = (g.get("topic") or "").lower().strip()
            matched_cluster_rev = cluster_revenue.get(topic_lower)
            if matched_cluster_rev is None:
                # Substring match: check if topic is in any cluster key or vice versa
                for cl_key, cl_rev in cluster_revenue.items():
                    if topic_lower in cl_key or cl_key in topic_lower:
                        matched_cluster_rev = cl_rev
                        break
            if matched_cluster_rev:
                rev_num = matched_cluster_rev * 12  # annualize
            elif isinstance(vol, (int, float)) and vol > 0:
                # Floor estimate: volume × cr_mid × acv_mid × 12
                rev_num = vol * cr_mid * acv_mid * 12

        # Suppress rows with no volume AND no revenue
        if (not isinstance(vol, (int, float)) or vol <= 0) and not rev_num:
            continue

        rev_str = fmt_currency(rev_num) if rev_num else fmt_currency(0)

        if isinstance(vol, (int, float)):
            vol_str = f"{fmt_number(int(vol))}/mo"
        else:
            vol_str = str(vol)

        gaps_out.append({
            "topic": g.get("topic", ""),
            "status": g.get("client_status", "Absent").title(),
            "competitor": g.get("top_competitor", ""),
            "volume": vol_str,
            "revenue": rev_str,
            "risk": risk,
        })

    # --- Structural risk (biggest authority gap, excluding brand confusion) ---
    if filtered_gaps:
        biggest = max(
            filtered_gaps,
            key=lambda x: x.get("estimated_volume") or 0,
        )
        structural_title = biggest.get("topic", "Untitled Risk")
        biggest_rev = parse_revenue(biggest.get("revenue_opportunity") or biggest.get("estimated_revenue") or 0)
        biggest_vol = biggest.get("estimated_volume") or 0
        biggest_comp = biggest.get("top_competitor", "a competitor")
        biggest_status = (biggest.get("client_status") or "absent").lower()

        # Build a focused description about this specific gap
        structural_desc = (
            f"{biggest_comp} currently dominates \"{biggest.get('topic', '')}\" "
            f"while your site is {biggest_status} for these searches. "
        )
        if biggest_vol:
            structural_desc += f"This topic sees {fmt_number(int(biggest_vol))} monthly searches"
            if biggest_rev:
                structural_desc += f" with a revenue ceiling of {fmt_currency(biggest_rev)}"
            structural_desc += ". "
        structural_desc += (
            "This gap represents your single largest revenue exposure and will "
            "persist until dedicated content is built to compete."
        )
    else:
        structural_title = "Content Gap Identified"
        structural_desc = "Authority gaps exist across key search topics in your market."

    # --- Technical grade (categorical scoring) ---
    TECH_CATEGORIES = {
        "Indexability": ["noindex", "canonical", "redirect", "301", "302", "robots", "sitemap"],
        "Crawlability": ["crawl", "orphan", "internal link", "depth", "pagination", "blocked"],
        "Mobile & Speed": ["mobile", "speed", "core web", "cls", "lcp", "viewport", "render"],
        "Content Quality": ["thin", "duplicate", "title", "meta description", "h1", "heading"],
        "Security": ["https", "ssl", "mixed content", "hsts", "certificate"],
        "Status Errors": ["404", "500", "broken", "error", "status code"],
    }

    has_dwight_data = bool(dwight) and (
        dwight.get("prioritized_fixes") or dwight.get("executive_summary")
    )

    if has_dwight_data:
        prioritized_fixes = ensure_parsed(dwight.get("prioritized_fixes") or [])
        heading_issues = ensure_parsed(dwight.get("heading_issues") or [])
        structured_data_issues = ensure_parsed(dwight.get("structured_data_issues") or [])
        security_issues = ensure_parsed(dwight.get("security_issues") or [])

        # Initialize per-category scores and example issues
        cat_scores = {cat: 100 for cat in TECH_CATEGORIES}
        cat_examples = {cat: "" for cat in TECH_CATEGORIES}

        def classify_issue(issue_text, tier):
            """Classify an issue into a category and deduct from its score."""
            text_lower = issue_text.lower()
            deduction = {1: 25, 2: 12, 3: 5}.get(tier, 5)
            for cat, keywords in TECH_CATEGORIES.items():
                for kw in keywords:
                    if kw in text_lower:
                        cat_scores[cat] = max(0, cat_scores[cat] - deduction)
                        if not cat_examples[cat]:
                            cat_examples[cat] = issue_text[:60]
                        return cat
            # Uncategorized — log to stderr, count toward overall
            print(f"  [tech-health] uncategorized issue (tier {tier}): {issue_text[:80]}", file=sys.stderr)
            return None

        overall_score = 100
        for fix in prioritized_fixes:
            tier = fix.get("priority_tier", 3)
            if isinstance(tier, str):
                tier = int(tier) if tier.isdigit() else 3
            issue_text = fix.get("issue") or fix.get("title") or fix.get("description") or ""
            classify_issue(issue_text, tier)
            # Overall deduction
            deduction = {1: 15, 2: 8, 3: 3}.get(tier, 3)
            overall_score -= deduction

        # Incorporate extra snapshot columns as tier 2 issues
        if isinstance(heading_issues, list):
            for hi in heading_issues:
                txt = hi if isinstance(hi, str) else (hi.get("issue") or hi.get("title") or str(hi))
                classify_issue(txt, 2)
                overall_score -= 8
        if isinstance(structured_data_issues, list):
            for si in structured_data_issues:
                txt = si if isinstance(si, str) else (si.get("issue") or si.get("title") or str(si))
                classify_issue(txt, 2)
                overall_score -= 8
        if isinstance(security_issues, list):
            for si in security_issues:
                txt = si if isinstance(si, str) else (si.get("issue") or si.get("title") or str(si))
                classify_issue(txt, 2)
                overall_score -= 8

        overall_score = max(overall_score, 0)

        # Letter grade from overall score
        if overall_score >= 97:
            grade = "A+"
        elif overall_score >= 93:
            grade = "A"
        elif overall_score >= 90:
            grade = "A-"
        elif overall_score >= 87:
            grade = "B+"
        elif overall_score >= 83:
            grade = "B"
        elif overall_score >= 80:
            grade = "B-"
        elif overall_score >= 77:
            grade = "C+"
        elif overall_score >= 73:
            grade = "C"
        elif overall_score >= 70:
            grade = "C-"
        elif overall_score >= 67:
            grade = "D+"
        elif overall_score >= 63:
            grade = "D"
        elif overall_score >= 60:
            grade = "D-"
        else:
            grade = "F"

        # Build category results with status labels
        tech_categories = []
        for cat in TECH_CATEGORIES:
            score = cat_scores[cat]
            if score >= 90:
                status = "Good"
                color = "green"
            elif score >= 70:
                status = "Needs Work"
                color = "yellow"
            else:
                status = "Critical"
                color = "red"
            tech_categories.append({
                "name": cat,
                "score": score,
                "status": status,
                "color": color,
                "example": cat_examples[cat] if status != "Good" else "",
            })

        tech_summary = clean_summary(dwight.get("executive_summary") or "")
    else:
        # No Dwight snapshot — never fake a grade
        grade = None
        overall_score = None
        tech_categories = []
        tech_summary = (
            "Technical audit pending — full results available in the detailed report."
        )

    return {
        "prospect": {
            "company": company,
            "domain": domain,
            "market": market,
            "industry": industry,
            "reportDate": report_date,
        },
        "marketPosition": {
            "visibilityScore": visibility_score,
            "totalKeywordsTracked": total_tracked,
            "keywordsRanking": currently_ranking,
            "rankingPct": ranking_pct,
            "top10": top_10,
            "strikingDistance": striking_distance,
        },
        "revenueExposure": {
            "totalOpportunity": fmt_currency(annual_opportunity) + "+",
            "currentCapture": f"< {current_capture_pct}%",
            "topGapRevenue": fmt_currency(top_gap_revenue),
            "topGapKeyword": top_gap_keyword,
            "gapExplanation": gap_summary,
        },
        "competitors": competitors_out,
        "authorityGaps": gaps_out,
        "structuralRisk": {
            "title": structural_title,
            "description": structural_desc,
        },
        "technicalGrade": {
            "grade": grade,
            "score": overall_score,
            "summary": tech_summary,
            "categories": tech_categories,
        },
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def parse_revenue(val) -> float:
    """Parse a revenue value that may be a number, string, or range like '81250–682500'."""
    if isinstance(val, (int, float)):
        return float(val)
    if not isinstance(val, str) or not val:
        return 0.0
    # Strip currency symbols and whitespace
    s = val.replace("$", "").replace(",", "").replace("+", "").strip()
    # Handle range formats: '81250–682500' or '81250-682500'
    for sep in ["–", "—", "-"]:
        if sep in s:
            parts = s.split(sep)
            try:
                # Take the high end of the range
                return max(float(p.strip()) for p in parts if p.strip())
            except ValueError:
                continue
    try:
        return float(s) if s else 0.0
    except ValueError:
        return 0.0


def fmt_currency(amount) -> str:
    """Format as $X,XXX,XXX."""
    if isinstance(amount, str):
        return amount
    if amount == 0:
        return "$0"
    return f"${int(amount):,}"


def fmt_number(n) -> str:
    """Format number with commas."""
    return f"{int(n):,}"


def wrap_text(c: Canvas, text: str, font: str, size: float, max_width: float) -> list[str]:
    """Split text into lines that fit within max_width."""
    if not text:
        return []
    words = text.split()
    lines = []
    current = ""
    for word in words:
        test = f"{current} {word}".strip() if current else word
        if c.stringWidth(test, font, size) <= max_width:
            current = test
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def truncate(text: str, max_len: int = 40) -> str:
    if len(text) <= max_len:
        return text
    return text[: max_len - 1] + "…"


def strip_markdown(text: str) -> str:
    """Strip common markdown formatting from text for PDF rendering."""
    import re
    # Bold/italic: **text** or *text* or __text__ or _text_
    text = re.sub(r'\*{1,2}(.+?)\*{1,2}', r'\1', text)
    text = re.sub(r'_{1,2}(.+?)_{1,2}', r'\1', text)
    # Inline code: `text`
    text = re.sub(r'`(.+?)`', r'\1', text)
    # Links: [text](url)
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    # Headers: ## text
    text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)
    return text.strip()


def humanize_canonical_key(key: str) -> str:
    """Convert canonical_key like 'id:boise:water_heater_repair' to 'water heater repair'."""
    if not key:
        return key
    # Strip id: prefix and location segments (e.g., id:boise:, id:meridian:)
    parts = key.split(":")
    if len(parts) >= 3 and parts[0].lower() == "id":
        # Take everything after the second colon
        topic = ":".join(parts[2:])
    elif len(parts) >= 2 and parts[0].lower() == "id":
        topic = parts[1]
    else:
        topic = key
    return topic.replace("_", " ").strip()


def clean_summary(text: str, max_chars: int = 450) -> str:
    """Strip markdown and truncate for PDF display."""
    text = strip_markdown(text)
    # Collapse multiple whitespace/newlines into single spaces
    text = " ".join(text.split())
    if len(text) <= max_chars:
        return text
    # Truncate at last sentence boundary before max_chars
    truncated = text[:max_chars]
    last_period = truncated.rfind(". ")
    if last_period > max_chars * 0.5:
        return truncated[: last_period + 1]
    return truncated.rstrip() + "…"


def draw_rounded_rect(c: Canvas, x, y, w, h, r, fill_color=None, stroke_color=None, stroke_width=1):
    """Draw a rounded rectangle. (x, y) is bottom-left corner."""
    c.saveState()
    if fill_color:
        c.setFillColor(fill_color)
    if stroke_color:
        c.setStrokeColor(stroke_color)
        c.setLineWidth(stroke_width)
    c.roundRect(x, y, w, h, r, fill=1 if fill_color else 0, stroke=1 if stroke_color else 0)
    c.restoreState()


def draw_section_header(c: Canvas, x, y, number: str, title: str, subtitle: str = ""):
    """Draw section header with badge. Returns new y position below the header."""
    # Badge
    badge_w = c.stringWidth(number, "Oswald", 11) + 16
    draw_rounded_rect(c, x, y - 16, badge_w, 20, 4, fill_color=BURNT_ORANGE)
    c.setFillColor(WHITE)
    c.setFont("Oswald", 11)
    c.drawString(x + 8, y - 12, number)

    # Title
    c.setFillColor(CHARCOAL)
    c.setFont("Oswald-SemiBold", 22)
    c.drawString(x + badge_w + 10, y - 14, title)

    new_y = y - 24

    # Subtitle
    if subtitle:
        new_y -= 14
        c.setFont("Inter", 12)
        c.setFillColor(GRAPHITE)
        c.drawString(x + badge_w + 10, new_y, subtitle)

    # Gradient line (solid burnt orange fading — approximate with tapering rect)
    new_y -= 14
    c.setFillColor(BURNT_ORANGE)
    c.rect(x, new_y, PAGE_W - 2 * x, 2, fill=1, stroke=0)
    # Fade overlay: draw bone white rect over the right portion
    c.setFillColor(HexColor("#FFFFFF"))
    c.saveState()
    # Simulate gradient: multiple thin rects with increasing opacity
    fade_start = x + (PAGE_W - 2 * x) * 0.4
    fade_w = (PAGE_W - 2 * x) * 0.6
    steps = 20
    for i in range(steps):
        alpha = i / steps
        r_val = 0xCC / 255 * (1 - alpha) + 1.0 * alpha
        g_val = 0x4E / 255 * (1 - alpha) + 1.0 * alpha
        b_val = 0x0E / 255 * (1 - alpha) + 1.0 * alpha
        c.setFillColorRGB(r_val, g_val, b_val)
        sx = fade_start + (fade_w / steps) * i
        c.rect(sx, new_y, fade_w / steps + 1, 2, fill=1, stroke=0)
    c.restoreState()

    return new_y - 8


def draw_metric_card(c: Canvas, x, y, w, h, value: str, label: str, sublabel: str = "", accent: bool = False):
    """Draw a metric card. (x, y) is top-left corner in our coordinate system."""
    bot_y = y - h
    if accent:
        draw_rounded_rect(c, x, bot_y, w, h, 8, fill_color=CHARCOAL)
    else:
        draw_rounded_rect(c, x, bot_y, w, h, 8, fill_color=WHITE, stroke_color=LIGHT_GRAY)

    # Value
    val_size = 28 if accent else 26
    c.setFont("Oswald-Bold", val_size)
    c.setFillColor(BURNT_ORANGE if accent else CHARCOAL)
    c.drawString(x + 18, bot_y + h - 36, str(value))

    # Label
    c.setFont("Inter-Medium", 9)
    c.setFillColor(BONE_WHITE if accent else GRAPHITE)
    c.drawString(x + 18, bot_y + h - 52, label.upper())

    # Sublabel (auto-sized to fit card width, no truncation)
    if sublabel:
        max_sublabel_w = w - 28  # 18pt left pad + 10pt right pad
        sub_size = 8.5
        while sub_size > 6 and c.stringWidth(sublabel, "Inter", sub_size) > max_sublabel_w:
            sub_size -= 0.5
        c.setFont("Inter", sub_size)
        c.setFillColor(HexColor("#999999") if accent else GRAPHITE)
        c.drawString(x + 18, bot_y + h - 66, sublabel)


def draw_risk_badge(c: Canvas, x, y, level: str):
    """Draw a risk badge. (x, y) is the center-left of the badge."""
    colors = RISK_COLORS.get(level, RISK_COLORS["medium"])
    text = level.upper()
    c.setFont("Inter-SemiBold", 9)
    tw = c.stringWidth(text, "Inter-SemiBold", 9)
    bw = tw + 14
    bh = 16
    bx = x
    by = y - bh / 2

    draw_rounded_rect(c, bx, by, bw, bh, 4, fill_color=HexColor(colors["bg"]), stroke_color=HexColor(colors["border"]))
    c.setFillColor(HexColor(colors["text"]))
    c.drawString(bx + 7, by + 4, text)


def draw_mini_header(c: Canvas, y, domain: str):
    """Draw the mini header for pages 2-3. Returns new y."""
    x = 48
    # Logo (small)
    if LOGO_PATH.exists():
        # Logo aspect ratio is 400x100 = 4:1
        logo_h = 18
        logo_w = logo_h * 4
        c.drawImage(str(LOGO_PATH), x, y - logo_h, logo_w, logo_h, mask="auto")
        text_x = x + logo_w + 8
    else:
        c.setFont("Oswald-Bold", 13)
        c.setFillColor(CHARCOAL)
        c.drawString(x, y - 13, "FORGE GROWTH")
        text_x = x + c.stringWidth("FORGE GROWTH", "Oswald-Bold", 13) + 8

    # Domain reference on right
    right_text = f"{domain} — Market Position Report"
    c.setFont("Inter", 11)
    c.setFillColor(GRAPHITE)
    right_w = c.stringWidth(right_text, "Inter", 11)
    c.drawString(PAGE_W - 48 - right_w, y - 13, right_text)

    # Divider line
    line_y = y - 24
    c.setStrokeColor(LIGHT_GRAY)
    c.setLineWidth(1)
    c.line(x, line_y, PAGE_W - 48, line_y)

    return line_y - 16


# ---------------------------------------------------------------------------
# Layer 4: PDF Rendering
# ---------------------------------------------------------------------------


def render_page1(c: Canvas, d: dict):
    """Render Page 1: Cover."""
    x_margin = 48
    content_w = PAGE_W - 2 * x_margin

    # --- Header bar ---
    y = PAGE_H - 48

    # Logo left
    if LOGO_PATH.exists():
        logo_h = 28
        logo_w = logo_h * 4
        c.drawImage(str(LOGO_PATH), x_margin, y - logo_h, logo_w, logo_h, mask="auto")
    else:
        c.setFont("Oswald-Bold", 20)
        c.setFillColor(CHARCOAL)
        c.drawString(x_margin, y - 20, "FORGE GROWTH")
        c.setFont("Inter", 9)
        c.setFillColor(GRAPHITE)
        c.drawString(x_margin, y - 32, "SEARCH INTELLIGENCE")

    # Date + website right
    c.setFont("Inter", 11)
    c.setFillColor(GRAPHITE)
    date_text = d["prospect"]["reportDate"]
    date_w = c.stringWidth(date_text, "Inter", 11)
    c.drawString(PAGE_W - x_margin - date_w, y - 12, date_text)

    c.setFont("Inter-SemiBold", 11)
    c.setFillColor(STEEL_BLUE)
    site_text = "forgegrowth.ai"
    site_w = c.stringWidth(site_text, "Inter-SemiBold", 11)
    c.drawString(PAGE_W - x_margin - site_w, y - 26, site_text)

    # --- Title block (charcoal rounded rect) ---
    y -= 68
    block_h = 130
    block_y = y - block_h
    draw_rounded_rect(c, x_margin, block_y, content_w, block_h, 12, fill_color=CHARCOAL)

    # "Market Position Report" label
    c.setFont("Inter-SemiBold", 11)
    c.setFillColor(BURNT_ORANGE)
    c.drawString(x_margin + 44, block_y + block_h - 32, "MARKET POSITION REPORT")

    # Company name
    c.setFont("Oswald-Bold", 38)
    c.setFillColor(BONE_WHITE)
    c.drawString(x_margin + 44, block_y + block_h - 72, d["prospect"]["company"])

    # Metadata row
    meta_items = [
        ("DOMAIN", d["prospect"]["domain"]),
        ("MARKET", d["prospect"]["market"]),
        ("INDUSTRY", d["prospect"]["industry"]),
    ]
    meta_x = x_margin + 44
    for label, value in meta_items:
        if not value:
            continue
        c.setFont("Inter", 10)
        c.setFillColor(HexColor("#888888"))
        c.drawString(meta_x, block_y + 18, label)
        label_w = c.stringWidth(label + " ", "Inter", 10)
        c.setFont("Inter-Medium", 13)
        c.setFillColor(BONE_WHITE)
        c.drawString(meta_x + label_w, block_y + 16, value)
        meta_x += label_w + c.stringWidth(value, "Inter-Medium", 13) + 28

    # --- Revenue exposure callout ---
    y = block_y - 20
    rev = d["revenueExposure"]

    # Split explanation into two paragraphs at nearest sentence boundary to midpoint
    explanation = rev["gapExplanation"]
    mid = len(explanation) // 2
    # Find nearest sentence boundary (". ") around midpoint
    best_split = -1
    for i in range(mid, len(explanation)):
        if explanation[i:i+2] == ". ":
            best_split = i + 1
            break
    if best_split == -1:
        for i in range(mid, 0, -1):
            if explanation[i:i+2] == ". ":
                best_split = i + 1
                break

    if best_split > 0:
        para1 = explanation[:best_split].strip()
        para2 = explanation[best_split:].strip()
    else:
        para1 = explanation
        para2 = ""

    # Measure height needed for explanation text (11pt, 16pt spacing)
    explanation_lines_1 = wrap_text(c, para1, "Inter", 11, content_w - 56)
    explanation_lines_2 = wrap_text(c, para2, "Inter", 11, content_w - 56) if para2 else []
    total_explanation_lines = len(explanation_lines_1) + len(explanation_lines_2)
    # Add half-line gap between paragraphs if two paragraphs
    para_gap = 8 if explanation_lines_2 else 0
    callout_text_h = total_explanation_lines * 16 + para_gap
    callout_h = 80 + callout_text_h
    callout_y = y - callout_h

    # Background
    draw_rounded_rect(c, x_margin, callout_y, content_w, callout_h, 8,
                      fill_color=HexColor("#FEF2F2"), stroke_color=HexColor("#FECACA"))
    # Red left border
    c.setFillColor(RED_ALERT)
    c.rect(x_margin, callout_y, 4, callout_h, fill=1, stroke=0)
    # Round the left corners manually by drawing small rects
    draw_rounded_rect(c, x_margin, callout_y, 6, callout_h, 8, fill_color=RED_ALERT)
    # Re-draw the main body over the rounded left part (except the 4px border)
    draw_rounded_rect(c, x_margin + 4, callout_y, content_w - 4, callout_h, 6,
                      fill_color=HexColor("#FEF2F2"))

    inner_x = x_margin + 24
    inner_top = callout_y + callout_h - 24

    # "REVENUE EXPOSURE" label
    c.setFont("Oswald-SemiBold", 14)
    c.setFillColor(RED_ALERT)
    c.drawString(inner_x, inner_top, "REVENUE EXPOSURE")

    # Dollar figure
    c.setFont("Oswald-Bold", 36)
    c.setFillColor(CHARCOAL)
    dollar_text = rev["totalOpportunity"]
    c.drawString(inner_x, inner_top - 38, dollar_text)

    # Suffix
    dollar_w = c.stringWidth(dollar_text, "Oswald-Bold", 36)
    c.setFont("Oswald", 16)
    c.setFillColor(GRAPHITE)
    c.drawString(inner_x + dollar_w + 8, inner_top - 32, "estimated annual revenue at risk")

    # Explanation paragraphs (11pt, 16pt leading)
    c.setFont("Inter", 11)
    c.setFillColor(GRAPHITE)
    text_y = inner_top - 58
    for line in explanation_lines_1:
        c.drawString(inner_x, text_y, line)
        text_y -= 16
    if explanation_lines_2:
        text_y -= 8  # half-line gap between paragraphs
        for line in explanation_lines_2:
            c.drawString(inner_x, text_y, line)
            text_y -= 16

    # --- Section 01: Market Visibility Snapshot ---
    y = callout_y - 28
    y = draw_section_header(c, x_margin, y, "01", "Market Visibility Snapshot")

    # 4 metric cards
    card_gap = 10
    card_w = (content_w - 3 * card_gap) / 4
    card_h = 84
    y -= 4

    mp = d["marketPosition"]
    page1_pct = round(mp["top10"] / mp["totalKeywordsTracked"] * 100, 1) if mp["totalKeywordsTracked"] > 0 else 0
    cards = [
        (f"{mp['visibilityScore']}/100", "Visibility Score", "Very Low" if mp["visibilityScore"] < 25 else "Low" if mp["visibilityScore"] < 50 else "Moderate", True),
        (fmt_number(mp["totalKeywordsTracked"]), "Keywords Tracked", "", False),
        (str(mp["top10"]), "Ranking Page 1", f"{page1_pct}% of tracked keywords", False),
        (str(mp["strikingDistance"]), "Striking Distance", "Near page 1 (pos 11-20)", False),
    ]

    for i, (value, label, sublabel, accent) in enumerate(cards):
        cx = x_margin + i * (card_w + card_gap)
        draw_metric_card(c, cx, y, card_w, card_h, value, label, sublabel, accent)


def render_page2(c: Canvas, d: dict):
    """Render Page 2: Competitive Landscape + Gaps."""
    x_margin = 48
    content_w = PAGE_W - 2 * x_margin

    # Mini header
    y = draw_mini_header(c, PAGE_H - 40, d["prospect"]["domain"])

    # --- Section 02: Competitive Landscape ---
    y = draw_section_header(c, x_margin, y, "02", "Competitive Landscape",
                            "Top competitors by organic search presence in your market")

    # Competitor cards (vertical stack)
    for i, comp in enumerate(d["competitors"][:3]):
        card_h = 58
        card_y = y - card_h
        draw_rounded_rect(c, x_margin, card_y, content_w, card_h, 8,
                          fill_color=BONE_WHITE, stroke_color=LIGHT_GRAY)

        # Numbered circle
        circle_x = x_margin + 22
        circle_y = card_y + card_h / 2
        c.setFillColor(STEEL_BLUE)
        c.circle(circle_x, circle_y, 14, fill=1, stroke=0)
        c.setFillColor(WHITE)
        c.setFont("Oswald-Bold", 14)
        num_text = str(i + 1)
        num_w = c.stringWidth(num_text, "Oswald-Bold", 14)
        c.drawString(circle_x - num_w / 2, circle_y - 5, num_text)

        # Domain name
        text_x = x_margin + 50
        c.setFont("Inter-SemiBold", 14)
        c.setFillColor(CHARCOAL)
        c.drawString(text_x, card_y + card_h - 18, comp["name"])

        # Strength
        c.setFont("Inter", 12)
        c.setFillColor(GRAPHITE)
        c.drawString(text_x, card_y + card_h - 33, comp["strength"])

        # Key terms
        c.setFont("Inter", 11)
        c.setFillColor(STEEL_BLUE)
        key_text = f"Key terms: {comp['keyTerms']}"
        c.drawString(text_x, card_y + card_h - 48, truncate(key_text, 80))

        y = card_y - 8

    # --- Section 03: Authority Gaps ---
    y -= 16
    y = draw_section_header(c, x_margin, y, "03", "Authority Gaps",
                            "High-value search terms where competitors dominate")

    # Table
    col_widths = [140, 62, 110, 80, 78, 58]  # adjusted to fit in content_w
    headers = ["Topic", "Status", "Top Competitor", "Volume", "Est. Revenue", "Risk"]

    # Header row
    row_h = 24
    header_y = y - row_h
    c.setFillColor(CHARCOAL)
    c.rect(x_margin, header_y, content_w, row_h, fill=1, stroke=0)

    c.setFont("Inter-SemiBold", 9.5)
    c.setFillColor(BONE_WHITE)
    col_x = x_margin
    for i, header in enumerate(headers):
        c.drawString(col_x + 8, header_y + 8, header.upper())
        col_x += col_widths[i]

    # Data rows
    y = header_y
    for row_idx, gap in enumerate(d["authorityGaps"][:7]):
        row_h = 24
        row_y = y - row_h
        # Alternating background
        bg = WHITE if row_idx % 2 == 0 else BONE_WHITE
        c.setFillColor(bg)
        c.rect(x_margin, row_y, content_w, row_h, fill=1, stroke=0)

        col_x = x_margin

        # Topic
        c.setFont("Inter-SemiBold", 10)
        c.setFillColor(CHARCOAL)
        c.drawString(col_x + 8, row_y + 8, truncate(gap["topic"], 24))
        col_x += col_widths[0]

        # Status
        status = gap["status"]
        status_color = RED_ALERT if status.lower() == "absent" else YELLOW_WARN
        c.setFont("Inter-SemiBold", 10)
        c.setFillColor(status_color)
        c.drawString(col_x + 8, row_y + 8, status)
        col_x += col_widths[1]

        # Competitor
        c.setFont("Inter", 10)
        c.setFillColor(GRAPHITE)
        c.drawString(col_x + 8, row_y + 8, truncate(gap["competitor"], 18))
        col_x += col_widths[2]

        # Volume
        c.setFont("Inter-Medium", 10)
        c.setFillColor(CHARCOAL)
        c.drawString(col_x + 8, row_y + 8, truncate(gap["volume"], 14))
        col_x += col_widths[3]

        # Revenue
        c.setFont("Inter-SemiBold", 10)
        c.setFillColor(CHARCOAL)
        c.drawString(col_x + 8, row_y + 8, truncate(gap["revenue"], 12))
        col_x += col_widths[4]

        # Risk badge
        draw_risk_badge(c, col_x + 4, row_y + row_h / 2, gap["risk"])

        y = row_y


def render_page3(c: Canvas, d: dict):
    """Render Page 3: Structural Risk + Tech Health + CTA."""
    x_margin = 48
    content_w = PAGE_W - 2 * x_margin

    # Mini header
    y = draw_mini_header(c, PAGE_H - 40, d["prospect"]["domain"])

    # --- Section 04: Biggest Structural Risk ---
    y = draw_section_header(c, x_margin, y, "04", "Biggest Structural Risk",
                            "The single issue costing you the most revenue right now")

    # Charcoal box with orange left border
    risk_lines = wrap_text(c, d["structuralRisk"]["description"], "Inter", 12, content_w - 80)
    risk_text_h = len(risk_lines) * 18
    box_h = 50 + risk_text_h
    box_y = y - box_h

    draw_rounded_rect(c, x_margin, box_y, content_w, box_h, 10, fill_color=CHARCOAL)
    # Orange left border
    c.setFillColor(BURNT_ORANGE)
    c.rect(x_margin, box_y + 4, 5, box_h - 8, fill=1, stroke=0)

    # Risk title
    c.setFont("Oswald-SemiBold", 20)
    c.setFillColor(BURNT_ORANGE)
    c.drawString(x_margin + 32, box_y + box_h - 30, d["structuralRisk"]["title"])

    # Description
    c.setFont("Inter", 12)
    c.setFillColor(BONE_WHITE)
    text_y = box_y + box_h - 50
    for line in risk_lines:
        c.drawString(x_margin + 32, text_y, line)
        text_y -= 18

    y = box_y - 24

    # --- Section 05: Technical Health ---
    y = draw_section_header(c, x_margin, y, "05", "Technical Health",
                            "Site health by category based on automated crawl analysis")

    grade = d["technicalGrade"]["grade"]
    categories = d["technicalGrade"].get("categories") or []

    # Bone box containing grade badge + category grid
    tech_box_h = 150 if categories else 100
    tech_y = y - tech_box_h

    draw_rounded_rect(c, x_margin, tech_y, content_w, tech_box_h, 10,
                      fill_color=BONE_WHITE, stroke_color=LIGHT_GRAY)

    # Overall grade badge (top-right)
    if grade is not None:
        if grade.startswith("A"):
            grade_color = GREEN_GOOD
        elif grade.startswith("B"):
            grade_color = STEEL_BLUE
        elif grade.startswith("C"):
            grade_color = YELLOW_WARN
        else:
            grade_color = RED_ALERT

        badge_x = x_margin + content_w - 70
        badge_y = tech_y + tech_box_h - 42
        c.setStrokeColor(grade_color)
        c.setLineWidth(3)
        c.circle(badge_x, badge_y + 10, 20, fill=0, stroke=1)
        c.setFont("Oswald-Bold", 20)
        c.setFillColor(grade_color)
        gw = c.stringWidth(grade, "Oswald-Bold", 20)
        c.drawString(badge_x - gw / 2, badge_y + 3, grade)

    if categories:
        # 2-column × 3-row category grid
        grid_x = x_margin + 16
        grid_top = tech_y + tech_box_h - 18
        col_w = (content_w - 100) / 2  # leave room for grade badge
        row_h = 40
        status_colors = {
            "green": GREEN_GOOD,
            "yellow": YELLOW_WARN,
            "red": RED_ALERT,
        }

        for idx, cat in enumerate(categories[:6]):
            col = idx % 2
            row = idx // 2
            cx = grid_x + col * col_w
            cy = grid_top - row * row_h

            # Category name (bold)
            c.setFont("Inter-Bold", 10)
            c.setFillColor(CHARCOAL)
            c.drawString(cx, cy, cat["name"])

            # Colored status dot
            dot_color = status_colors.get(cat["color"], GRAPHITE)
            name_w = c.stringWidth(cat["name"], "Inter-Bold", 10)
            c.setFillColor(dot_color)
            c.circle(cx + name_w + 10, cy + 3, 4, fill=1, stroke=0)

            # Status label
            c.setFont("Inter-Medium", 9)
            c.setFillColor(dot_color)
            c.drawString(cx + name_w + 18, cy, cat["status"])

            # Example issue (1 line, if not Good)
            if cat.get("example"):
                c.setFont("Inter", 8)
                c.setFillColor(GRAPHITE)
                example_text = cat["example"]
                max_ex_w = col_w - 20
                while example_text and c.stringWidth(example_text, "Inter", 8) > max_ex_w:
                    example_text = example_text[:-2] + "…"
                c.drawString(cx, cy - 13, example_text)
    else:
        # No data — show pending message
        c.setFont("Inter", 12)
        c.setFillColor(GRAPHITE)
        c.drawString(x_margin + 20, tech_y + tech_box_h / 2 - 6,
                      d["technicalGrade"]["summary"])

    y = tech_y - 14

    # --- CTA block ---
    cta_h = 190
    cta_y = y - cta_h

    draw_rounded_rect(c, x_margin, cta_y, content_w, cta_h, 12, fill_color=STEEL_BLUE)

    cta_center_x = x_margin + content_w / 2

    # "Want the Full Analysis?"
    c.setFont("Oswald-Bold", 24)
    c.setFillColor(WHITE)
    title = "Want the Full Analysis?"
    tw = c.stringWidth(title, "Oswald-Bold", 24)
    c.drawString(cta_center_x - tw / 2, cta_y + cta_h - 36, title)

    # Description
    cta_desc = (
        "This report covers where you stand. The full Market Position Analysis includes "
        "a prioritized action plan, content architecture strategy, detailed technical audit, "
        "and a 90-day roadmap to start capturing the revenue your competitors are taking."
    )
    cta_lines = wrap_text(c, cta_desc, "Inter", 12, content_w - 100)
    c.setFont("Inter", 12)
    c.setFillColorRGB(1, 1, 1, 0.85)
    desc_y = cta_y + cta_h - 56
    for line in cta_lines:
        lw = c.stringWidth(line, "Inter", 12)
        c.drawString(cta_center_x - lw / 2, desc_y, line)
        desc_y -= 17

    # Button — use Inter for the arrow since Oswald lacks → glyph
    btn_label = "Schedule a 15-Minute Review"
    btn_arrow = "  >"
    c.setFont("Oswald-SemiBold", 16)
    label_w = c.stringWidth(btn_label, "Oswald-SemiBold", 16)
    c.setFont("Inter-SemiBold", 16)
    arrow_w = c.stringWidth(btn_arrow, "Inter-SemiBold", 16)
    btn_w = label_w + arrow_w + 48
    btn_h = 38
    btn_x = cta_center_x - btn_w / 2
    btn_y = desc_y - btn_h - 4

    draw_rounded_rect(c, btn_x, btn_y, btn_w, btn_h, 8, fill_color=BURNT_ORANGE)
    c.setFillColor(WHITE)
    c.setFont("Oswald-SemiBold", 16)
    c.drawString(btn_x + 24, btn_y + 12, btn_label)
    c.setFont("Inter-SemiBold", 16)
    c.drawString(btn_x + 24 + label_w, btn_y + 12, btn_arrow)

    # Make button clickable
    c.linkURL(CTA_LINK, (btn_x, btn_y, btn_x + btn_w, btn_y + btn_h))

    # Contact footer inside CTA box
    c.setFont("Inter", 11)
    c.setFillColorRGB(1, 1, 1, 0.65)
    contact = "matt@forgegrowth.ai  |  forgegrowth.ai"
    cw = c.stringWidth(contact, "Inter", 11)
    c.drawString(cta_center_x - cw / 2, btn_y - 16, contact)

    # --- Page footer ---
    footer_y = cta_y - 40
    c.setStrokeColor(LIGHT_GRAY)
    c.setLineWidth(1)
    c.line(x_margin, footer_y, PAGE_W - x_margin, footer_y)
    footer_y -= 14

    # Logo left
    if LOGO_PATH.exists():
        logo_h = 14
        logo_w = logo_h * 4
        c.drawImage(str(LOGO_PATH), x_margin, footer_y - 2, logo_w, logo_h, mask="auto")

    # Confidential right-aligned
    c.setFont("Inter", 9)
    c.setFillColor(GRAPHITE)
    conf = f"Confidential — Prepared for {d['prospect']['company']}"
    conf_w = c.stringWidth(conf, "Inter", 9)
    c.drawString(PAGE_W - x_margin - conf_w, footer_y, conf)


def render_page4(c: Canvas, d: dict):
    """Render Page 4: About Forge Growth."""
    x_margin = 48
    content_w = PAGE_W - 2 * x_margin

    # Mini header
    y = draw_mini_header(c, PAGE_H - 40, d["prospect"]["domain"])

    # --- Section 06: About Forge Growth ---
    y = draw_section_header(c, x_margin, y, "06", "About Forge Growth")

    # Extra clearance below section header rule
    y -= 14

    # Content paragraphs
    paragraphs = [
        (
            "What We Do",
            "Forge Growth is a search intelligence firm that helps service businesses "
            "understand exactly where they stand in their local market — and what it's costing "
            "them. We combine technical SEO auditing, competitive analysis, and revenue modeling "
            "to quantify the gap between where you rank today and where you should be."
        ),
        (
            "Who We Serve",
            "We work exclusively with home service companies — HVAC, plumbing, electrical, "
            "roofing, and restoration businesses — in competitive metro markets. Our clients "
            "are established operators doing $1M–$20M in revenue who know they should be getting "
            "more from search but aren't sure where to start."
        ),
        (
            "What Makes Us Different",
            "Most agencies sell you a package and hope it works. We start with data. Every "
            "engagement begins with a full market position analysis: your keyword footprint, "
            "your competitors' strategies, your technical health, and a revenue model tied to "
            "real search volume. You see the opportunity before you spend a dollar."
        ),
        (
            "Our Approach",
            "We believe the best marketing decisions are the ones backed by evidence. Our "
            "reports don't just tell you what's broken — they show you what it's worth to fix it. "
            "When you're ready to move forward, we build a prioritized roadmap designed to "
            "capture revenue in the first 90 days."
        ),
    ]

    for heading, body in paragraphs:
        # Heading
        c.setFont("Inter-Bold", 12)
        c.setFillColor(CHARCOAL)
        c.drawString(x_margin, y, heading)
        y -= 16

        # Body text
        lines = wrap_text(c, body, "Inter", 11, content_w)
        c.setFont("Inter", 11)
        c.setFillColor(GRAPHITE)
        for line in lines:
            c.drawString(x_margin, y, line)
            y -= 15
        y -= 12

    # --- Contact block ---
    y -= 8
    contact_h = 80
    contact_y = y - contact_h
    draw_rounded_rect(c, x_margin, contact_y, content_w, contact_h, 10,
                      fill_color=CHARCOAL)

    # Contact details (text-only, left-aligned, vertically centered)
    text_x = x_margin + 24
    c.setFont("Inter-Medium", 12)
    c.setFillColor(BURNT_ORANGE)
    c.drawString(text_x, contact_y + contact_h - 26, "matt@forgegrowth.ai")

    c.setFont("Inter", 12)
    c.setFillColor(BONE_WHITE)
    c.drawString(text_x, contact_y + contact_h - 44, "forgegrowth.ai")

    c.setFont("Inter", 11)
    c.setFillColor(HexColor("#888888"))
    c.drawString(text_x, contact_y + contact_h - 60, "Search intelligence for service businesses")

    # --- Page footer ---
    footer_y = contact_y - 24
    c.setStrokeColor(LIGHT_GRAY)
    c.setLineWidth(1)
    c.line(x_margin, footer_y, PAGE_W - x_margin, footer_y)
    footer_y -= 14

    if LOGO_PATH.exists():
        logo_h = 14
        logo_w = logo_h * 4
        c.drawImage(str(LOGO_PATH), x_margin, footer_y - 2, logo_w, logo_h, mask="auto")

    c.setFont("Inter", 9)
    c.setFillColor(GRAPHITE)
    conf = f"Confidential — Prepared for {d['prospect']['company']}"
    conf_w = c.stringWidth(conf, "Inter", 9)
    c.drawString(PAGE_W - x_margin - conf_w, footer_y, conf)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="Generate Market Position Report PDF")
    parser.add_argument("--domain", required=True, help="Domain to generate report for")
    parser.add_argument("--company", help="Company name override (otherwise derived from domain)")
    args = parser.parse_args()

    # Load env
    env = parse_env()
    supabase_url = env.get("SUPABASE_URL")
    supabase_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not supabase_key:
        print("Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env", file=sys.stderr)
        sys.exit(1)

    # Register fonts
    register_fonts()

    # Fetch data
    print(f"Fetching audit data for {args.domain}...")
    sb = SupabaseClient(supabase_url, supabase_key)
    raw = fetch_all(sb, args.domain)

    # Compute report data
    print("Computing report metrics...")
    d = compute_report_data(raw, args.company)

    # Ensure reports dir exists
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    output_path = REPORTS_DIR / f"{args.domain}-market-position-report.pdf"

    # Create PDF
    print(f"Rendering PDF to {output_path}...")
    c = Canvas(str(output_path), pagesize=letter)
    c.setTitle(f"Market Position Report — {d['prospect']['company']}")
    c.setAuthor("Forge Growth")

    render_page1(c, d)
    c.showPage()
    render_page2(c, d)
    c.showPage()
    render_page3(c, d)
    c.showPage()
    render_page4(c, d)
    c.showPage()

    c.save()
    print(f"Done! Report saved to {output_path}")


if __name__ == "__main__":
    main()
