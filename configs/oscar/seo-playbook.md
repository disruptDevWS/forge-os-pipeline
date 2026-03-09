# Oscar SEO Playbook
# Forge Growth — On-Page & AI Optimization Rules
# Version: 1.0
# Last Updated: 2026-03-03
#
# This file is read by Oscar at the start of every content production run.
# Edit this file to update optimization rules without changing Oscar's system prompt.
# Rules are organized by priority: structural → on-page → AI/LLM → quality checks.

---

## 1. Structural Rules

### Header Hierarchy
- One `<h1>` per page. No exceptions. Use exactly what the brief specifies.
- `<h2>` elements define major page sections. Each `<h2>` should contain or be near the section's primary keyword.
- `<h3>` elements are subsections within an `<h2>` block. Use them for service breakdowns, sub-topics, or FAQ questions.
- Never skip levels. No `<h1>` → `<h3>`. No `<h2>` → `<h4>`.
- Header text should be descriptive and keyword-aware, not clever or abstract. "Our Plumbing Services in Boise, Idaho" beats "What We Do."

### Section Architecture
- Each major section wraps in `<section>` with a descriptive `id` (e.g., `id="services"`, `id="service-areas"`, `id="faq"`).
- Sections follow the brief's specified order. Do not rearrange.
- Introductory/hero section always comes first. Final CTA section always comes last.
- FAQ sections use `<h3>` for questions and `<p>` for answers. Structure them so the question-answer pair is extractable by LLMs and featured snippet parsers.

### Internal Linking
- Every internal link specified in Pam's linking map must appear in the output.
- Use the exact anchor text Pam specified. Do not paraphrase anchor text.
- Links should appear within the body content of the section Pam designated, not appended as a list at the end.
- Anchor text must be contextual: embedded naturally in a sentence, not orphaned as a standalone link.
- Use relative paths (`/water-heater-replacement`), not absolute URLs.

---

## 2. On-Page SEO Rules

### Keyword Placement
- **H1**: Must contain the primary keyword or its close variant. The brief specifies this — use it verbatim.
- **H2s**: Each H2 should contain the section-relevant keyword from the brief. If the brief says "Keywords to use naturally in this section," those keywords should appear in the H2 or within the first two sentences below it.
- **First 100 words**: The primary keyword must appear naturally within the first 100 words of body content (excluding the H1 itself).
- **Meta title and description**: Provided by the brief. Include them verbatim in the metadata comment block.
- **Keyword density**: No explicit target. If a keyword appears more than 3 times per 500 words of body content, you are likely over-optimizing. Rely on semantic variants instead of repeating the exact-match keyword.

### Semantic Expansion
- Use natural synonyms and related terms throughout the content. For "plumber," also use: plumbing professional, plumbing company, licensed plumber, plumbing team, plumbing contractor.
- Geo-modifiers should vary: "in Boise," "Boise, Idaho," "the Boise area," "Treasure Valley," "Boise homeowners." Do not repeat the same geo-modifier construction within the same section.
- Service terms should vary: "water heater replacement," "water heater installation," "new water heater," "replacing your water heater." The brief's keyword targets define the primary terms; expand from there.

### Content Length
- Use the brief's per-section word count targets as a floor, not a ceiling. Meet or exceed the target for each section.
- A section that fully covers its topic at 200 words is better than one that pads to 300. But a section that stops at 150 because the target said 150 is incomplete if the topic has more to say.
- Coverage completeness takes priority over target adherence. Do not pad with restatements or transitional filler — but do not truncate substantive content to hit a number.

### CTA Placement
- Include a CTA element wherever the brief specifies one.
- CTAs should be clear and direct: "Call [phone]" or "Schedule Online." Not "Don't hesitate to reach out to our team of professionals."
- On commercial and transactional pages, the hero section and final section should both contain CTAs.
- Mid-page CTAs (if the brief calls for them) should follow a trust-building or service description section.
- CTA elements use semantic markup only. Do not use typographic separators (pipes, bullets, slashes) between CTA options — that is a visual/design decision for the CMS template. Wrap each CTA option in its own `<p>` element.

---

## 3. AI and LLM Optimization Rules

These rules optimize content for extraction and citation by AI systems (Google AI Overviews, ChatGPT, Perplexity, and similar LLM-powered search/answer systems).

### Entity Clarity
- The business name, location, and primary service category should appear together within the first 150 words. This creates a clear entity signal that LLMs can extract.
- Pattern: "[Business Name] is a [descriptor] [service type] in [Location]."
- Example: "Veterans Plumbing Corp is a veteran-owned plumbing company serving Boise, Idaho."
- This sentence (or a close variant) functions as the entity declaration. LLMs use it as an anchor for associating attributes with the entity.

### Attributive Statements
- Structure key claims as clear, extractable statements. LLMs pull from sentences that make direct attributions.
- Good: "Veterans Plumbing Corp is licensed and insured in the state of Idaho."
- Bad: "Being licensed and insured is something we take seriously." (The entity is implicit, the claim is vague.)
- Good: "We offer same-day emergency plumbing service throughout Boise and the Treasure Valley."
- Bad: "Emergency? No problem. We'll be there." (No extractable claim.)

### Question-Answer Structures
- FAQ sections are prime LLM extraction targets. Structure them precisely:
  - Question in an `<h3>` tag, phrased as users would naturally ask it
  - Answer in `<p>` tags immediately following the `<h3>`
  - First sentence of the answer should directly answer the question (no preamble)
  - Follow-up sentences add context, specifics, or guide toward action
- This structure serves triple duty: featured snippets, FAQ schema (provided by Pam), and LLM extraction.

### List and Process Structures
- "What to Expect" or "How It Works" sections should use `<ol>` for numbered steps.
- Service catalog sections can use brief paragraphs (not lists) when each service needs context and an internal link.
- Lists should have substantive items (full sentences), not bare keywords or fragments.
- LLMs prefer lists with 3-7 items. If a list exceeds 7 items, consider grouping into subcategories.

### Schema Alignment
- Pam provides schema JSON-LD. Oscar includes it verbatim.
- The content on the page must align with the schema entities. If the schema declares a Service with the name "Water Heater Installation and Repair," the page content should use that same service name (not a significantly different variant).
- FAQ schema answers and on-page FAQ answers must be identical. If they differ, flag it in production notes.

---

## 4. Content Quality Rules

### Readability
- Average sentence length: 12-20 words. Mix short punchy sentences with longer explanatory ones.
- Paragraphs: 2-4 sentences. No wall-of-text paragraphs exceeding 5 sentences.
- Reading level: aim for 8th-9th grade (Flesch-Kincaid). The audience is homeowners, not plumbing engineers.
- Use active voice. "We fix leaks" not "Leaks are fixed by our team."

### Trust Signals
- On commercial pages, every section should contain at least one trust signal: license/insurance mention, review reference, years in business, specific credential, warranty mention, or veteran-owned identity.
- Trust signals should be woven into content, not dumped in a separate "trust" section (unless the brief structures it that way).
- Never fabricate trust signals. If specific data (review count, rating, years) is not provided, use `[PLACEHOLDER: ...]`.

### Differentiation
- If the brief includes competitive differentiation notes, use them. Lean into what makes this business different from competitors.
- Do not mention competitors by name unless the brief explicitly instructs it.
- Differentiation should be stated as positive claims about the client, not negative claims about competitors.

### Tone Calibration by Intent
- **Commercial intent**: Confident, authoritative, trust-building. The reader is comparing options. Give them reasons to choose this business. Every section moves toward "this is the right choice."
- **Transactional intent**: Direct, urgent, conversion-focused. The reader is ready to act. Reduce friction. Prominent CTAs. Short, punchy copy. Less persuasion, more facilitation.
- **Informational intent**: Educational, helpful, thorough. The reader wants to learn. Demonstrate expertise. Answer questions completely. Guide toward commercial pages via internal links, but do not hard-sell.

---

## 5. Validation Checklist

Oscar runs these checks internally before finalizing output:

### Structure
- [ ] One `<h1>` present, matches brief
- [ ] H-tag hierarchy is clean (no skipped levels)
- [ ] All sections from brief are present in correct order
- [ ] All `<section>` elements have descriptive `id` attributes
- [ ] `<article>` wraps all page content

### Keywords
- [ ] Primary keyword in H1
- [ ] Primary keyword in first 100 words of body
- [ ] Section-specific keywords appear in or near their designated H2
- [ ] No keyword stuffing (>3x per 500 words for any single term)
- [ ] Geo-modifier forms vary across sections

### Links
- [ ] All internal links from brief's linking map are present
- [ ] Anchor text matches brief's specifications
- [ ] Links use relative paths
- [ ] No generic anchor text ("click here", "learn more")

### Content
- [ ] Per-section word counts meet brief's minimums. No section terminates before its topic is fully covered
- [ ] Total word count meets or exceeds brief's overall target
- [ ] No AI-ism patterns (em dash overuse, "landscape", "leverage", "navigate", "delve")
- [ ] No filler phrases
- [ ] Active voice predominant
- [ ] Placeholders used for all unconfirmed client data
- [ ] FAQ answers match schema FAQ answers (if schema provided)

### Metadata
- [ ] Meta title included in comment block
- [ ] Meta description included in comment block
- [ ] Schema JSON-LD included verbatim from brief
- [ ] Production notes appended with word counts, keyword report, and flags

---

## 6. Anti-Patterns (Do Not Produce)

These patterns indicate low-quality AI content. Oscar must avoid all of them.

### Structural Anti-Patterns
- Sections that repeat the same information with different wording
- H2 sections with only one short paragraph (thin sections)
- Lists used where paragraphs would be more natural and informative
- Orphaned internal links not embedded in contextual sentences

### Writing Anti-Patterns
- Opening a section with "When it comes to [topic]..."
- Using "whether you need X or Y" as a transition (overused AI pattern)
- Em dashes used more than once per 500 words
- Sentences starting with "In fact," "Actually," "Interestingly," or "It's worth noting"
- Closing sections with "Don't hesitate to..." or "Feel free to..."
- Using "we understand that..." as a trust-building crutch
- Rhetorical questions used as section openers ("Looking for a plumber in Boise?")
- "At [Company Name], we..." as a sentence opener more than twice on the entire page

### SEO Anti-Patterns
- Exact-match keyword bolded throughout the page
- Keyword in every single H2 and H3
- Same geo-modifier format repeated in consecutive paragraphs
- Internal links clustered in one section instead of distributed per the linking map
- FAQ answers that are just rewrites of body content from earlier sections

---

## 7. Competitive Context Execution Rules

When the brief includes a Competitive Context section, Oscar applies these rules:

### People Also Ask Integration
- PAA questions answered by competitors (standard snippets) are TABLE STAKES.
  Oscar must ensure the page answers these questions, either in the FAQ section
  or naturally within relevant body sections. If a PAA question maps to an
  existing FAQ in the brief, verify the answer is thorough enough to compete.
  If a PAA question is NOT in the brief's FAQ section, flag it in production
  notes as a recommended addition.

- PAA questions with AI-generated answers are OPPORTUNITIES. Oscar should
  write clear, direct, attributive answers to these questions somewhere on the
  page. Structure them so they are extractable: question as a clear phrase,
  answer in the immediately following sentence(s), entity name included in
  the answer. The goal is to become the source Google cites instead of
  generating its own answer.

- Second-tier PAA questions (with seed_questions) indicate INTENT DEPTH.
  Oscar reviews these for relevance. If a cluster of second-tier questions
  points to a subtopic the brief covers, Oscar ensures that section is
  substantive enough to address the underlying intent. Oscar does not add
  every second-tier question to the page — only those that are relevant and
  would not dilute the page's focus.

### People Also Search Integration
- Related search queries inform SEMANTIC EXPANSION. Oscar weaves these terms
  naturally into body content as synonyms, variant phrases, or contextual
  mentions. They should not appear as a list or keyword dump.

- If a related search query closely matches a keyword in the brief's target
  list, Oscar treats it as reinforcement and ensures it appears in the
  content.

- If a related search query suggests a topic NOT covered in the brief,
  Oscar notes it in production notes as a potential content expansion but
  does NOT add new sections to the page without Pam's architectural
  direction.

### Competitor Calibration
- If the Competitive Context shows competitors averaging significantly
  higher word counts than the brief's target, Oscar flags the discrepancy
  in production notes. Oscar does NOT unilaterally increase word count —
  the brief's targets stand unless the human editor decides otherwise.

- If the Competitive Context shows a common section across competitors
  that the brief does not include, Oscar flags it in production notes.
  Oscar does not add the section — Pam makes structural decisions.

### Differentiation Execution
- Oscar reads the Differentiation Summary and ensures the client's
  identified competitive advantage is prominent in the first 150 words,
  in at least one H2 section heading, and in the final CTA section.
  The differentiation should feel natural, not forced or repetitive.
