> **Human reference material only. Not injected into agent prompts.**
> Consult before making prompt-level changes to Michael, Cluster Strategy, or Pam
> that touch topical coherence, entity architecture, or content effort. See
> DECISIONS.md 2026-04-09 entry "Intel layer scoped to content effort only" for
> the framework deferral rationale.

---

# Scoring Signals Reference

> **Purpose**: Authoritative reference of named Google ranking signals derived from the
> Google API Content Warehouse documentation leak (May 2024). Intended for human consultation
> when making prompt-level decisions about Cluster Strategy (Opus), Phase 1b (Strategy Brief),
> Phase 5 (Gap), and Phase 6 (Michael). This is not an SEO blog summary. Field names are canonical.
>
> **Primary source**: hexdocs.pm/google_api_content_warehouse/0.4.0
> Key modules: `QualityNsrNsrData`, `QualityNsrPQData`,
> `QualityAuthorityTopicEmbeddingsVersionedItem`, `IndexingDocjoinerAnchorSpamInfo`
>
> **Interpretation note**: Field existence in a schema does not confirm field weight in the
> live algorithm. These are confirmed data structures Google collects and computes.
> Weight and current deployment status are not disclosed. Reason to track: named signals
> confirm the *type* of measurement Google applies, which is sufficient to inform
> architectural decisions even without knowing exact coefficients.
>
> **Last updated**: 2026-04-09

---

## Module 1: Site-Level Quality — `QualityNsrNsrData`

The primary site-level scoring aggregate. Fields here apply to the domain as a whole
(or to "sitechunks" — Google's segmentation of a domain into scored portions).

### `nsr` — Normalized Site Rank
Site-level quality rank normalized within its competitive slice. Not PageRank.
The aggregate measure of a site's quality position relative to similar sites.
**Implication**: Every site is benchmarked against its topical peers, not the entire web.
A home services site is ranked against other home services sites, not against news publishers.

### `localityScore`
"Locality score of the site, i.e. the locality component of the LocalAuthority signal."
A dedicated float signal for how well a site is recognized as a local authority.
**Implication for service businesses**: This is not satisfied by having location keywords
in content. It is a composite signal likely informed by: GBP data, local link patterns,
NAP citation consistency, geo-qualified query performance. A site with strong keyword
coverage but weak off-site local signals can have poor `localityScore`.

### `titlematchScore`
"Titlematch score of the site, a signal that tells how well titles are matching user queries."
This is a SITE-WIDE aggregate, not a page-level score.
**Implication**: Auditing title tags is not just a per-page exercise. The aggregate pattern
of how well a domain's title tags mirror the actual query language of searchers is scored
at the domain level. A site where service pages use internal naming conventions instead of
searcher language ("Our HVAC Solutions" vs. "AC Repair Boise ID") accumulates domain-level
title match drag.

### `chromeInTotal`
Site-level Chrome browser views. Explicitly named as a quality input.
**Implication**: Chrome data is a quality proxy. For SMBs with low brand recognition,
this is a structural disadvantage unless GBP/local pack presence generates branded search
behavior. Growing organic impressions and clicks is not just a traffic goal — it builds
the Chrome data signal that feeds site-level quality scoring.

### `clutterScore`
"Delta site-level signal in Q* penalizing sites with a large number of distracting/annoying
resources loaded by the site."
**Implication**: Sites built on page-builder templates with aggressive popups, floating chat
widgets, consent banners, third-party scripts, and auto-play elements accumulate clutter
penalty. This is separate from Core Web Vitals — it is a quality demotion applied at the
site level, not a page speed metric.

### `chardEncoded` / `chardScoreVariance`
Site-level content quality predictor ("chard"). `chardScoreVariance` measures spread
across the site — how inconsistent quality is page-to-page.
**Implication**: Variance is penalized independently from average quality. A site with
10 strong pages and 40 thin pages has high `chardScoreVariance`, which scores worse than
a uniformly mediocre site. Consistent quality across all indexed pages matters more than
isolated excellence.

### `nsrdataFromFallbackPatternKey`
Boolean. "If true, indicates we do not have NSR data computed for the chunk, and instead
the data is coming from an average of other host chunks."
**Implication**: Unscored pages (new pages, thin pages with no engagement history) inherit
the domain average. Weak pages are not neutral — they contaminate the average that
propagates to new/unscored pages. This is the structural argument for removing thin pages:
it is not just about crawl budget, it is about protecting the quality average that
new content inherits.

### `siteQualityStddev`
"Estimate of site's PQ rating stddev — spread of the page-level PQ ratings of a site."
Explicitly distinct from NSR variance. Measures the distribution of page quality scores.
**Implication**: Same as `chardScoreVariance` — distribution matters. Build consistently,
not episodically.

### `impressions`
Site-level impressions (SERP appearances). Tracked as a quality signal input.
**Implication**: Impression growth across the domain is a quality signal, not just a
traffic metric. Even ranking position 8–15 for a keyword contributes impressions that
feed this signal. Content investment that generates impressions before it generates
clicks still builds domain-level quality input.

### `smallPersonalSite`
Score for "small personal site promotion." Google actively scores and separates small
personal sites from other site types.
**Implication**: Service business sites that present as personal blogs or sole-proprietor
operations without clear business entity signals may be scored under the personal site
model rather than the local business model. Entity disambiguation via schema and
consistent business presentation matters.

### `healthScore`
A categorical signal. Likely tied to YMYL (Your Money Your Life) health content.
**Implication for service businesses**: Home services, restoration, and trades adjacent
to health/safety (mold remediation, water damage, electrical) should be aware that
Google applies categorical health signals to these verticals. Content claims in these
areas carry higher quality scrutiny than standard commercial content.

---

## Module 2: Page-Level Quality — `QualityNsrPQData`

URL-level quality signals. These score individual pages, and their averages feed the
site-level signals in Module 1.

### `contentEffort`
"LLM-based effort estimation for article pages."
Versioned float signal (`QualityNsrVersionedFloatSignal`) — Google iterates on this model.
Applied at the URL level. Estimates how difficult the content would be to replicate.
**Implication**: This is Google's mechanical answer to the "helpful content" question.
It is not sentiment or topical coverage — it is replication difficulty. See
`configs/oscar/seo-playbook.md` section 5 "Content Effort Requirements" for the
operational spec injected into Oscar's production instructions.

### `chard`
"URL-level chard prediction." Individual page quality score, separate from the site aggregate.
**Implication**: Each page has its own quality score that feeds the site average. A page
with strong topical coverage, internal links, and engagement history scores higher.
Thin pages with no engagement drag the average down even if the content is technically correct.

### `linkIncoming` / `deltaLinkIncoming`
Incoming link value at the URL level, plus the *change* in incoming link value.
`deltaLinkIncoming` means the rate of change in link acquisition is scored, not just
the absolute total.
**Implication**: Link velocity matters at the page level. A page accumulating new
referring domains is scored differently from a page with a static link profile of the
same aggregate value.

### `tofu`
"URL-level tofu prediction." A separate content quality predictor from chard.
Likely targets different quality dimensions (chard appears to be content quality;
tofu may target topical fit or format quality).
**Implication**: Multiple quality models run on each URL. Optimizing for one dimension
(topical coverage) while ignoring others (format, structure, usefulness signals) produces
incomplete page quality scores.

---

## Module 3: Topical Identity — `QualityAuthorityTopicEmbeddingsVersionedItem`

The topical coherence scoring module. These signals define a site's topical identity
and measure how well individual pages fit within it.

### `siteFocusScore`
"Number denoting how much a site is focused on one topic."
A single float. Higher = more focused.
**Implication**: Topic dilution is a measurable penalty. A contractor site covering
plumbing, HVAC, electrical, roofing, and landscaping under one domain scores lower
on `siteFocusScore` than a plumbing-only site. For multi-service businesses, the
architectural question is whether topical breadth is a feature or a liability — and
the signal suggests it is a liability unless topical coherence can be maintained
through very strong silo architecture.

### `siteRadius`
"The measure of how far page_embeddings deviate from the site_embedding."
The site has a topical center of gravity (its `siteEmbedding`). Every page is measured
for its distance from that center. Higher radius = more topical drift.
**Implication**: Every page that doesn't reinforce the site's topical identity increases
`siteRadius`. This includes: boilerplate city pages with no unique content, blog posts
on loosely related topics, thin service pages for discontinued offerings, generic FAQ
content that doesn't connect to the site's service model. Michael's blueprint must
explicitly scope pages to minimize radius expansion.

### `siteEmbedding` / `pageEmbedding`
Compressed vector representations of site-level and page-level topical content.
The relationship between these two determines `siteRadius`.
**Implication**: Content isn't measured by keyword presence — it is measured by its
semantic vector relationship to the site's established topical identity. This is why
keyword stuffing fails: adding keywords to a page doesn't necessarily move its
embedding vector toward the site embedding.

### `versionId`
These signals are versioned. Google iterates the topical embedding model.
**Implication**: `siteRadius` and `siteFocusScore` are not static assessments.
As Google's embedding model evolves, a site's topical coherence score can change
without any action on the site's part. Monitoring these dimensions over time matters.

---

## Module 4: NavBoost — Click-Based Re-ranking

NavBoost is one of the most frequently cited signals in the leak. It is a re-ranking
layer applied on top of the base ranking using click behavior data.

### Core behavior
NavBoost re-ranks results based on click logs. This is confirmed by both the leak
and Google's own testimony in antitrust proceedings (Pandu Nayak, 2023).
Chrome browser data is an explicit input.

### Signal types tracked
- Bad clicks (user returned to SERP immediately)
- Good clicks (user engaged with the result)
- Last longest click (the final result a user clicked and stayed on)
- Site-wide impressions
- Topic-level clicks and impressions (not just page-level)

**Implication**: Click behavior is measured at the topic level across the domain,
not just per URL. A domain that consistently satisfies users for HVAC queries
builds topic-level NavBoost signal that benefits all HVAC pages, not just
the page that was clicked.

### Click satisfaction definition
NavBoost click dissatisfaction is NOT measured by dwell time alone. It is triggered
when a user continues searching for semantically similar queries after clicking a result.
If the result satisfied the intent, the search session ends or pivots. If not, the user
issues another query that NavBoost interprets as the same underlying need.
**Implication**: Pages that partially answer intent but don't resolve it generate
demotion signals even if the user spent 3 minutes on the page. Full intent resolution
— not time-on-page — is the relevant metric.

### Query bundling
NavBoost bundles queries based on interpreted meaning, not exact match.
[best locksmith boise], [locksmith near me boise], [emergency locksmith boise id] are
likely treated as the same intent bundle. Performance on any of them affects the
bundle's overall signal.

---

## Module 5: Link Architecture — `IndexingDocjoinerAnchorSpamInfo`

### `trustedTarget`
"True if this URL is on trusted source."
Trusted sources accumulate this designation and then operate under looser anchor spam rules.
**Implication**: Established authority domains can absorb anchor diversity that would
penalize newer sites. For SMB clients with new or low-authority domains, anchor text
diversity has less flexibility — precise, descriptive anchor text matters more.

### `phraseAnchorSpamPenalty`
"Combined penalty for anchor demotion." This is anchor-specific, not link-authority-specific.
A link can pass authority while its anchor text receives a spam penalty.
**Implication**: Low-quality or keyword-stuffed anchor text is penalized independently
from the link's authority value. Clean, contextual anchor text matters even when
acquiring links from legitimate sources.

### Fresh link multiplier
Freshdocs contains a link value multiplier for links from newer pages vs. older pages.
Newer page links appear to receive a value boost.
**Implication**: A link acquisition strategy that targets established high-authority pages
exclusively may be leaving value on the table if those pages are years old with
no new link acquisition. Links in newly published, actively indexed content carry
their own multiplier.

---

## Module 6: Demotion Signals

These are explicitly named demotion mechanisms in the leak. All of them apply to
typical SMB service business sites.

| Signal | What it penalizes | SMB risk level |
|--------|------------------|----------------|
| `clutterScore` | Distracting/annoying site resources | HIGH — page builders, chat popups, modal CTAs |
| `gibberishScores` | Spun content, filler AI content, nonsense | HIGH — templatized city pages, AI-generated without editing |
| `keywordStuffingScore` | Keyword stuffing | MEDIUM — often found in meta descriptions, footer text |
| `phraseAnchorSpamPenalty` | Spam anchor text | MEDIUM — directory link spam |
| `spamBrainTotalDocSpamScore` | Overall spam score (0–1) | LOW for legitimate sites |
| NavBoost dissatisfaction | Partial intent resolution | HIGH — service pages that list features but don't answer the decision question |
| Location identity mismatch | Ranking for locations not tied to locality identity | HIGH — multi-city expansion before local authority established |

### Location identity demotion (specific to local service businesses)
The leak explicitly mentions a demotion for "location identity" — pages targeting locations
not associated with the site's established geographic identity.
**Implication**: A plumber in Boise attempting to rank for Denver service pages before
establishing strong Boise locality signals will receive a location identity demotion.
Geographic expansion strategy must sequence behind local authority establishment, not
run parallel to it. This directly constrains how Michael builds multi-city blueprints
for clients with no existing local authority.

---

## Module 7: Index Tier and Storage

Google uses different storage tiers for different content:
- Flash: Most important and regularly updated content
- SSD: Less important content
- HDD: Irregularly updated content

**Implication**: Content that is rarely updated falls to the lowest-priority storage tier.
This is not a ranking signal directly, but it affects crawl freshness and re-evaluation
frequency. For service businesses where information changes (pricing, service offerings,
seasonal availability), regular meaningful updates (not cosmetic date changes) keep
content in higher-priority storage and trigger re-evaluation.

Google also retains the **last 20 versions** of a document. Historical scoring associated
with prior versions persists until the version history cycles out.

---

## Module 8: Site Classification

Google explicitly classifies sites by business model type. Named categories in the leak:
- News sites
- YMYL (Your Money Your Life)
- Personal blogs / small personal sites
- Ecommerce sites
- Video sites

**Implication**: Service businesses need clear entity signals that classify them as local
businesses, not personal blogs or generic content sites. A solo operator's website with
no clear `LocalBusiness` schema, sparse NAP data, and blog-style content may be
classified under the personal blog model rather than the local business model — with
corresponding quality expectations applied.

Schema `@type: LocalBusiness` (or appropriate sub-type: `Locksmith`, `Plumber`,
`ElectricalContractor`, etc.) in `@graph` is the primary entity signal that drives
correct classification.

---

## How to Use This Reference

This file is **not injected into agent prompts**. It exists so that when you are
making prompt-level changes to generation agents, you can consult a single canonical
source on what signals the change is meant to influence.

When a prompt change is motivated by a specific signal from this file:

1. Cite the module and field name in the commit message (e.g., "Michael: constrain
   multi-city expansion per Module 6 location identity demotion").
2. Add a DECISIONS.md entry explaining the causal link — what the signal implies and
   what prompt change it motivated.
3. Observe the next pipeline run for the affected client to see whether the prompt
   change produced the intended output shift.

Do NOT paste sections of this file into agent system prompts wholesale. The
speculative prose (implications, likely-informed-by, may-be) was written for human
reasoning, not agent instruction. Agents treat "implications" as rules and lose
the uncertainty.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-09 | Initial creation. Modules derived from direct hexdocs review: `QualityNsrNsrData`, `QualityNsrPQData`, `QualityAuthorityTopicEmbeddingsVersionedItem`, `IndexingDocjoinerAnchorSpamInfo`. SEL analysis (Andrew Ansley, May 2024) used for NavBoost and demotion context. Parked in `docs/research/` as human reference material, not injected into agent prompts. See DECISIONS.md entry "Intel layer scoped to content effort only" for deferral rationale. |
