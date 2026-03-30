# Oscar's SEO and AI Optimization Playbook

These rules are embedded by construction — they should emerge naturally from good writing, not be imposed as a compliance checklist.

## 1. Structural Rules
- One `<h1>` per page — from the brief, verbatim
- `<h2>` for major sections — keyword-aware but descriptive, not abstract
- `<h3>` for subsections — never skip heading levels
- `<section id="...">` for each major content area — ids should be descriptive slugs
- FAQ: `<h3>` for the question, `<p>` for the answer — first sentence of the answer directly responds to the question. This structure makes answers extractable by LLMs, voice search, and featured snippets.

## 2. On-Page SEO — Natural Integration
- Primary keyword in H1 and in the first 100 words — not forced, reads naturally
- Section H2s carry topical keywords — they describe what the section covers, which naturally includes relevant terms
- Semantic expansion throughout: synonyms, varied geo modifiers, related service terms — never repeat the same exact phrase more than needed for clarity
- CTAs: at minimum in the hero section and final section, optionally mid-page after a trust-building section. Direct and specific — "Schedule your EMT course" not "Contact us today"

## 3. AI and LLM Optimization — Entity and Extractability
- Entity clarity: business name + location + primary service in the first 150 words. Make it easy for an LLM to answer "who does X in Y" from this page.
- Attributive statements: claims should be clear and attributable — "Summit Medical Academy offers EMT training in Boise" not "training is available here"
- Direct answers: for any PAA question or query fan-out item the brief identifies, answer it directly and completely in the first sentence of the relevant paragraph. Don't bury the answer.
- Lists: use `<ol>` for sequential steps, `<ul>` for non-sequential items. Substantive list items — full sentences, not fragments. 3–7 items is the extractable sweet spot.
- Schema alignment: page content entity names must match schema entity names exactly — if the schema says "EMT Training" the page should not call it "Emergency Medical Technician Courses"
- Chunk self-containment: each `<section>` should be independently understandable — a reader or LLM retrieving only that chunk should know what it covers and who it's from without needing surrounding page context. This does NOT mean each section must restate the business name and location. It means each section's `<h2>` + opening sentence must establish sufficient context. Exception: sections that build on each other sequentially (process steps, numbered how-to content) are exempt from self-containment — but the `<h2>` must name the step, not just number it ("Step 3: Schedule Your Skills Assessment" passes; "Step 3" fails).
- AI optimization patterns — apply conditionally, not uniformly. Evaluate each section against its intent and structural role before choosing a pattern:
  - Direct-answer opening: apply when the section targets a question-intent keyword, corresponds to a PAA item, or is explicitly flagged [OPPORTUNITY] or [AI CITATION GAP] in the brief. Do NOT apply when the section is context-setting, narrative, building an argument, or part of a sequential explanation.
  - Q&A substructure (h3 question + p answer): apply when multiple distinct questions fall under one H2. Do NOT apply when the section develops a single continuous argument or is a commercial/transactional conversion section.
  - Self-contained chunk scope: apply when the section covers a discrete, independently searchable concept. Relax when sections are explicitly linked as a sequence in the brief.

## 4. Content Quality
- Readability: short sentences (12–20 words average), short paragraphs (2–4 sentences), active voice, 8th–9th grade reading level
- Trust signals on commercial and transactional pages: relevant credentials, years in business, licensing, insurance, reviews, certifications — whatever applies to this client. Every claim needs a basis.
- Tone matches intent: commercial pages earn trust, transactional pages move toward action, informational pages educate completely
- No thin sections: if a section can't be written substantively, it shouldn't exist as its own section
- Citation signals: on informational and commercial pages, prefer specific verifiable claims over general statements. "Idaho Medical Academy's EMT program runs [PLACEHOLDER: program_duration] weeks" is more citation-worthy than "a comprehensive EMT program." If specific data exists in the client profile (reviews, certifications, years, accreditation body, program duration, pass rates), use it with attribution. If not, placeholder it. In the production notes, flag any section that relies entirely on general claims where specific client data would substantially improve citation-worthiness — label these `[CITATION OPPORTUNITY: needs <field>]`.

## 5. Internal Links
- Every link from the brief's internal linking map must appear in the content, contextually embedded
- Anchor text: descriptive and specific — "our EMT certification requirements guide" not "click here" or "learn more"
- Relative paths only
- Links should appear in natural reading positions — not clustered at the bottom

## 6. Anti-Patterns — Never Do These
Writing: "When it comes to...", "whether you need X or Y", "In fact,", "Don't hesitate to...", "we understand that...", rhetorical questions as section openers, em dashes more than once per 500 words, ending sections with "contact us today"

SEO: keyword bolded everywhere, same exact geo modifier in every paragraph, FAQ answers that just restate the body content in question form, links clustered in one paragraph, padding a section to hit a word count

Structural: repeated information with different wording, sections that exist only to contain a keyword, H2s that don't describe what the section covers

AI formatting: applying direct-answer openings, Q&A structure, or self-contained chunk framing to every section regardless of intent — this destroys narrative flow and is worse than no optimization. Image-of-table: describing tabular data in prose when a `<table>` would be more precise and machine-readable

## 7. Production Notes — Flag for Human Editor
At the end of every file, produce a production notes comment block that includes:
- List of all [PLACEHOLDER: x] items requiring human completion before publish
- Internal link count and confirmation all brief links are implemented
- Keyword usage summary (primary keyword appearances, any density concerns)
- Any flags: sections where competitor coverage significantly exceeds this page, PAA questions from brief that weren't addressed and why, schema fields that need client verification
- Word count

## 8. Validation Checklist
- AI patterns applied conditionally (not uniformly) — verify each direct-answer opening and Q&A structure has a question-intent or [OPPORTUNITY]/[AI CITATION GAP] basis in the brief
- Schema-to-prose consistency check — verify every schema attribute value matches its prose equivalent
- Citation signal check — verify at least one specific attributable claim per commercial/informational section; flag gaps in production notes
- Figure/table markup — verify `<figure>` + `<figcaption>` stub present for every `<!-- IMAGE: -->` placeholder; verify HTML `<table>` used for any comparative or structured data

## 9. HTML Markup for AI Retrievability

- Tables: use `<table>` with `<thead>` and `<tbody>` for comparative or structured data (program costs, certification levels, scheduling options, step comparisons). Never describe tabular data in prose when a table would be more precise.
- Image placeholders: every `<!-- IMAGE: [description] -->` comment must be immediately followed by a `<figure>` + `<figcaption>` stub:
  ```html
  <!-- IMAGE: [description including topic context and what the figure would show] -->
  <figure>
    <figcaption>[PLACEHOLDER: caption describing the image above]</figcaption>
  </figure>
  ```
  This preserves the semantic relationship for when the human editor inserts the actual image. Do not use bare `<!-- IMAGE: -->` comments without the figure wrapper.
- Alt text guidance: in the `<!-- IMAGE: -->` comment description, include the topic context and what the visual would show — this gives the human editor the information they need to write accurate alt text. Format: `<!-- IMAGE: [what it shows] — [why it's here / what it supports] -->`
