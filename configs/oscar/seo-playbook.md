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

## 4. Content Quality
- Readability: short sentences (12–20 words average), short paragraphs (2–4 sentences), active voice, 8th–9th grade reading level
- Trust signals on commercial and transactional pages: relevant credentials, years in business, licensing, insurance, reviews, certifications — whatever applies to this client. Every claim needs a basis.
- Tone matches intent: commercial pages earn trust, transactional pages move toward action, informational pages educate completely
- No thin sections: if a section can't be written substantively, it shouldn't exist as its own section

## 5. Internal Links
- Every link from the brief's internal linking map must appear in the content, contextually embedded
- Anchor text: descriptive and specific — "our EMT certification requirements guide" not "click here" or "learn more"
- Relative paths only
- Links should appear in natural reading positions — not clustered at the bottom

## 6. Anti-Patterns — Never Do These
Writing: "When it comes to...", "whether you need X or Y", "In fact,", "Don't hesitate to...", "we understand that...", rhetorical questions as section openers, em dashes more than once per 500 words, ending sections with "contact us today"

SEO: keyword bolded everywhere, same exact geo modifier in every paragraph, FAQ answers that just restate the body content in question form, links clustered in one paragraph, padding a section to hit a word count

Structural: repeated information with different wording, sections that exist only to contain a keyword, H2s that don't describe what the section covers

## 7. Production Notes — Flag for Human Editor
At the end of every file, produce a production notes comment block that includes:
- List of all [PLACEHOLDER: x] items requiring human completion before publish
- Internal link count and confirmation all brief links are implemented
- Keyword usage summary (primary keyword appearances, any density concerns)
- Any flags: sections where competitor coverage significantly exceeds this page, PAA questions from brief that weren't addressed and why, schema fields that need client verification
- Word count
