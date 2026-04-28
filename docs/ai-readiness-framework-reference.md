# AI Search Readiness Framework — Reference Document

> **Purpose:** Reference for rebuilding the Agentic Readiness section using Aleyda Solis's 3-layer framework. The current schema-only scorecard was removed (2026-04-28) as too narrow. This document captures what to build when we circle back.
>
> **Sources:**
> - [3-Layer Framework for AI Presence, Readiness & Business Impact](https://www.aleydasolis.com/en/ai-search/a-3-layer-framework-to-measure-ai-presence-readiness-and-business-impact-redefining-metrics-for-the-ai-search-era/)
> - [10 Characteristics of AI Search Winning Brands](https://www.aleydasolis.com/en/ai-search/ai-search-winning-brands-characteristics/)

---

## The 3-Layer Framework

### Layer 1: Presence Metrics
**Question:** Are we showing up in AI answers?

| KPI | Formula | What It Answers |
|-----|---------|-----------------|
| Prompt Coverage | (Tracked prompts with brand / Total tracked prompts) x 100 | Are we showing up? |
| Recommendation Rate | (Appearances where AI recommends / Appearances) x 100 | Are we endorsed or just listed? |
| Linked Citation Rate | (Appearances with clickable link / Appearances) x 100 | Can visibility drive visits? |
| Comparative Win Rate | (Comparison prompts where preferred / Comparison appearances) x 100 | Do we win shortlists? |
| Representation Accuracy | (Appearances with correct positioning / Total appearances) x 100 | Are we understood correctly? |

**Measurement:** 30-250+ prompts, monthly, segmented by platform/stage/persona. Prioritize 2-3 AI platforms by referral traffic.

**What we have today:** `track-llm-mentions.ts` and `ai-visibility-analysis.ts` partially cover this. Not yet surfaced on the dashboard.

### Layer 2: Readiness Assessment
**Question:** What structural factors explain our visibility patterns?

The 10 characteristics (see detailed section below). Grouped by diagnostic theme:

| Theme | Characteristics | When to Prioritize |
|-------|----------------|-------------------|
| Crawl/Fetch Barriers | Accessible | Content hard to reach |
| Content Parsing | Extractable | Mentions without links |
| Content Quality | Useful, Fresh, Differentiated | Weak category visibility |
| Entity Clarity | Recognizable, Consistent | Brand misdescription |
| Trust Signals | Corroborated, Credible, Transactable | Weak recommendations |

**Prioritization:** (Likely impact on key visibility gap x Commercial importance) / Ease of implementation

### Layer 3: Business Impact
**Question:** Does improved visibility create value?

Four confidence layers (keep separate in reporting):

1. **Observed** (highest confidence): Platform-passed referrer/UTM data — AI-referred sessions, conversion rate, revenue per visit
2. **Proxy: Own Analytics** (medium): Branded search lift, direct traffic lift, survey discovery
3. **Proxy: Third-Party** (medium-low): Similarweb AI traffic comparison, prompt-level samples
4. **Model** (lowest, forward-looking): Projected incremental revenue, attribution models

**Key principle:** "Measured AI referral traffic is the floor, not the ceiling."

---

## The 10 Readiness Characteristics (Detailed)

### 1. Accessible
AI systems must crawl, retrieve, and parse content.

- **Win:** SSR HTML, valid structured data, unblocked crawl paths, machine-readable feeds
- **Lose:** Client-side JS hiding content, robots.txt blocks, auth walls
- **What we assess today:** Dwight crawl, Phase 1a (sitemap, schema, redirects, robots.txt)
- **Gap:** JS rendering detection, crawl budget analysis

### 2. Useful
Content must solve problems with depth and evidence.

- **Win:** Original insights, expert analysis, data-backed claims, coherent topic coverage
- **Lose:** Generic overviews, surface-level content, algorithm-first writing
- **What we assess today:** Gap analysis (Phase 5), coverage scoring (Phase 4b)
- **Gap:** Per-page content depth scoring, evidence/data density

### 3. Recognizable
Brand must be a clearly defined entity AI can identify.

- **Win:** Consistent naming, Organization schema, verified profiles, aligned descriptions
- **Lose:** Inconsistent naming, missing entity schema, conflicting listings
- **What we assess today:** Structured data assessment in Dwight, entity schema checks
- **Gap:** Cross-platform entity consistency scoring (website vs directories vs social)

### 4. Extractable
Information organized so AI can isolate and reuse it.

- **Win:** Clear heading hierarchy, concise summaries upfront, self-contained sections, explicit definitions
- **Lose:** Information buried in prose, unclear structure, scattered ideas
- **What we assess today:** Heading issues in Dwight
- **Gap:** Explicit extractability scoring (summary presence, section self-containment, definition clarity)

### 5. Consistent
Positioning and facts align across all touchpoints.

- **Win:** Unified messaging across website, LinkedIn, directories, media; matching structured and visible content
- **Lose:** Contradictory descriptions, stale profiles, inconsistent product naming
- **What we assess today:** Local Presence NAP matching across 11 directories
- **Gap:** Cross-platform messaging alignment beyond NAP (descriptions, services, positioning)

### 6. Corroborated
Independent sources validate expertise and claims.

- **Win:** Credible publication mentions, digital PR, industry directory listings, third-party validation
- **Lose:** Zero external mentions, unsupported claims
- **What we assess today:** Citation snapshots (11 directories), LLM mention tracking
- **Gap:** Digital PR / external mention depth, industry-specific authority signals

### 7. Credible
Demonstrate real expertise and trustworthiness.

- **Win:** Expert authorship, cited sources, original research, positive sentiment, trust signals
- **Lose:** Unattributed claims, weak evidence, negative sentiment, anonymous content
- **What we assess today:** Nothing explicit
- **Gap:** Authorship detection, E-E-A-T signal scoring, sentiment analysis, review aggregation

### 8. Differentiated
Clear reason for AI to select you over competitors.

- **Win:** Original frameworks, proprietary methodologies, unique positioning, branded concepts
- **Lose:** Generic positioning, commodity messaging, indistinguishable from competitors
- **What we assess today:** Strategy Brief touches qualitatively
- **Gap:** Competitive differentiation scoring, unique content detection

### 9. Fresh
Important information remains current.

- **Win:** Regular updates to key pages, current stats/examples, transparent publication dates, appropriate cadence
- **Lose:** Outdated screenshots/data, stale ranking content, missing last-updated dates
- **What we assess today:** Nothing explicit
- **Gap:** Last-updated detection, content staleness scoring, publication date presence

### 10. Transactable
Product data is machine-readable for AI commerce. *(E-commerce specific)*

- **Win:** Valid product schema, complete feeds, clear pricing/availability/variants
- **Lose:** Unstructured product data, mismatched feeds
- **What we assess today:** N/A (service business clients)
- **Gap:** N/A unless we expand to e-commerce verticals

---

## Implementation Roadmap (When We Circle Back)

### Phase A: Consolidate Existing Signals
No new data collection — synthesize what we already have into the 10-characteristic framework.

- Map Dwight findings → Accessible + Extractable + Recognizable
- Map Local Presence → Consistent + Corroborated
- Map Coverage Scoring → Useful
- Map Phase 1a verification → Accessible
- Render as a single "AI Readiness Assessment" card with per-characteristic status

### Phase B: Surface Layer 1 (Presence)
Connect existing `track-llm-mentions.ts` and `ai-visibility-analysis.ts` to a dashboard section.

- Prompt coverage across ChatGPT, Perplexity, Gemini
- Recommendation rate and citation rate
- Historical trend tracking

### Phase C: Fill Gaps
New data collection for characteristics we don't assess:

- **Credible:** Authorship detection, E-E-A-T signals
- **Fresh:** Last-updated detection, staleness scoring
- **Differentiated:** Competitive positioning analysis
- **Extractable:** Summary/definition density scoring

### Phase D: Layer 3 (Business Impact)
Requires GA4 integration (partially exists via `fetch-ga4-data.ts`):

- AI-referred session tracking (observed layer)
- Branded search lift correlation (proxy layer)
- Revenue attribution modeling

---

## Code Preserved

- `src/lib/agentic-score.ts` — scoring utility (kept in lovable-repo, unused)
- `agentic_readiness` column on `audit_snapshots` — Dwight still writes signals to Supabase
- `track-llm-mentions.ts` — Layer 1 presence tracking (pipeline)
- `ai-visibility-analysis.ts` — Layer 1 analysis (pipeline)
