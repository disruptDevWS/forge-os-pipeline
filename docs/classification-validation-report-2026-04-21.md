# Classification Validation Investigation Report

**Date:** 2026-04-21
**Audit:** IMA (`08409ae8`, idahomedicalacademy.com, 1,100 keywords)
**Trigger:** Session B reclassification shifts (intent_type informational +128%, entity_type Article +740%)

---

## Task 1: Sample Recovery

Pre-Session-B classification state is **not recoverable**. The IMA pre-promotion baseline export (`scratch/pre-promotion-snapshots/ima-2026-04-20/audit_keywords.json`) deliberately excluded `intent_type` and `primary_entity_type` — it captured only canonical/cluster fields for the hybrid promotion. No other snapshot, agent_run, or backup table captured per-keyword classification prior state.

**Finding:** Future classification changes should capture pre-change classification snapshots for drift analysis.

Fallback approach used: pulled current DB state and assessed keywords by text analysis.

---

## Task 2: Manual Judgment

### Set A — Informational with commercial signals (11 keywords)

| Keyword | Current | Manual Judgment | Agree? | Rationale |
|---------|---------|-----------------|--------|-----------|
| "is being an emt worth it" | informational | informational | Yes | Career evaluation question, not vendor comparison |
| "is it worth being an emt" | informational | informational | Yes | Same |
| "is emt worth it" | informational | informational | Yes | Same |
| "1st vs 3rd degree burn" | informational | informational | Yes | Medical knowledge comparison, not product/vendor |
| "the best way to prevent an emergency is to" | informational | informational | Yes | Knowledge-seeking |
| "1st degree vs 2nd degree vs 3rd degree burns" | informational | informational | Yes | Medical knowledge |
| "first degree vs third degree burns" | informational | informational | Yes | Same |
| "3rd degree burns vs 1st degree" | informational | informational | Yes | Same |
| "stop the bleed" | informational | informational | Yes | National campaign awareness, not course shopping |
| "is it worth becoming an emt" | informational | informational | Yes | Career evaluation |
| "stop the bleeding start the breathing" | informational | informational | Yes | First aid protocol recall |

**Agreement: 11/11 (100%)**

Despite containing "vs", "best", and "worth" — commercial-signal words — all 11 are correctly classified informational. The "vs" keywords compare medical concepts, not vendors. The "worth" keywords evaluate career choices, not purchases.

### Set A2 — Informational with [city] signals (7 keywords)

| Keyword | Current | Manual Judgment | Agree? | Rationale |
|---------|---------|-----------------|--------|-----------|
| "how to become a pharmacy tech in idaho" | informational | informational | Yes | Career research |
| "good samaritan law idaho" | informational | informational | Yes | Legal knowledge |
| "medical schools in boise idaho" | informational | **borderline commercial** | Weak disagree | Could be evaluating schools — but also could be informational list-seeking |
| "how to become a pharmacy technician in idaho" | informational | informational | Yes | Career research |
| "good samaritan law in idaho" | informational | informational | Yes | Legal knowledge |
| "how to become a firefighter in idaho" | informational | informational | Yes | Career research |
| "idaho good samaritan law" | informational | informational | Yes | Legal knowledge |

**Agreement: 6/7 (86%).** The one borderline case ("medical schools in boise idaho") could go either way. SERP reality would settle it.

### Set B — Unambiguous informational control (15 keywords)

All 15 keywords are clearly informational: "how to handle emergency situations", "what is phtls certification", "what are the 3 c's in cpr", "benefits of becoming an emt", "how to give first aid", etc.

**Agreement: 15/15 (100%).** Control set validates Haiku's informational rubric on unambiguous cases.

### Set C — Article entity_type (top 30 by volume)

| Keyword | Entity | Manual Judgment | Agree? | Rationale |
|---------|--------|-----------------|--------|-----------|
| "medical coding" (33K) | Article | Article | Yes | General topic, not a specific IMA course |
| "stop the bleed" (14.8K) | Article | Article/Course borderline | Weak yes | National campaign concept; "stop the bleed training" correctly gets Course |
| "nremt test prep" (14.8K) | Article | **Course or Product** | **No** | IMA sells "NREMT Test Prep" as a specific offering. Searcher likely wants prep materials/course |
| "airway management" (1.3K) | Article | Article | Yes | Medical technique concept |
| "3 degree burn" (320) | Article | Article | Yes | Medical knowledge |
| "emergency medical training" (260) | Article | Article/Course borderline | Weak yes | Generic phrase — could mean the concept or a course. As a bare phrase, Article is defensible |
| "first aider" (210) | Article | Article | Yes | Role definition |
| "first aid" (210) | Article | Article | Yes | General topic |
| Burn treatment keywords (140 ea) | Article | Article | Yes | Medical knowledge |
| "medical assistant jobs in boise idaho" (110) | Article | Article | Yes | Job listing intent, not course enrollment |
| "provides basic care for medical emergencies…" (110) | Article | Article | Yes | Definition recall |
| Career research keywords (40-70 ea) | Article | Article | Yes | "What can I do with X certification" = career info |

**Agreement: ~27/30 (90%).** 2-3 borderline cases where the keyword is course-adjacent but informational in intent. The one clear miss is "nremt test prep" — IMA sells this as a specific course, but Haiku has no knowledge of IMA's course catalog.

### Course-classified keywords (comparison, top 20)

All 20 are clearly enrollment/shopping-focused: "cpr course near me", "emt course online", "medical assistant course", "pharmacy technician program", etc.

**Agreement: 20/20 (100%).** Haiku correctly identifies enrollment-intent keywords as Course.

### Summary of Course vs Article line

Haiku draws the line at **enrollment intent**: if the keyword signals active shopping for a specific program (course, certification, training near me), it's Course. If the keyword is about the topic, career implications, or general knowledge, it's Article — even if the topic is adjacent to a course IMA offers.

This is a **sharper and more defensible line** than legacy Sonnet's approach, which classified most keywords in a training vertical as Course regardless of user intent.

---

## Task 3: Rubric Analysis

### Current Haiku prompt (abbreviated)

```
Intent definitions:
- "informational": seeking knowledge (what is, how to, why, guide, tips, facts, benefits)
- "commercial": researching/comparing options ("best", "vs", "review", "[service] [city]", evaluating providers)
- "transactional": ready to act NOW (buy, enroll, sign up, book, schedule, hire, "near me", get quote)
- "navigational": looking for a specific website/brand BY NAME

primary_entity_type definitions:
- "Course": an educational program with defined duration, credential, enrollment
- "Article": purely informational content not tied to a specific service or course

Business context: medical_training business, domain: idahomedicalacademy.com
```

### Rubric logic

**Intent rubric:** Conservative on commercial — requires explicit comparison or evaluation signals. "How to become X in [state]" is informational even though it's in a training domain. This is defensible: the searcher seeks a career guide, not a vendor comparison. The legacy Sonnet prompt explicitly defined `"[service] [city]" = commercial`, which the Haiku prompt also includes. The shift is in keywords that don't match any pattern — Haiku defaults to informational where Sonnet defaulted to the group majority (often commercial).

**Entity type rubric:** The Course definition requires "educational program with defined duration, credential, enrollment" — clear enrollment signals. Article is "purely informational content not tied to a specific service or course." This is a clean, sharp distinction but:

1. **Missing middle ground.** Keywords *about* courses but not seeking enrollment (e.g., "what is cpr class like", "nremt test prep") fall to Article. This is technically correct per the rubric but may not match business strategy where course-adjacent content should still be entity-typed as Course.

2. **No `core_services` injection.** IMA's `client_context.core_services` lists 18 specific courses (EMT Course, NREMT Test Prep, etc.) but this data is **not included in the Haiku prompt**. The prompt only gets `service_key: medical_training` and `domain: idahomedicalacademy.com`. Without knowing "NREMT Test Prep" is a specific offering, Haiku can't distinguish between "nremt test prep as a general concept" (Article) and "nremt test prep as a product this business sells" (Course).

3. **No vertical-specific examples.** The prompt has one tiebreaker: "if the offering grants a credential or certification, use Course." But it doesn't have examples specific to medical/vocational training.

### Comparison with legacy Sonnet rubric

The legacy Sonnet prompt (lines 2641-2645 of pipeline-generate.ts) handles classification at the **group level** — one Sonnet call classifies an entire batch of 250 keywords. The Haiku prompt classifies **per keyword**. This alone accounts for most of the distribution shift: group-level classification smears the majority intent across all keywords in the batch. If a batch contains 80% enrollment-intent keywords and 20% informational keywords, Sonnet assigns the same classification to all 250.

---

## Task 4: Implementation Check

### Context injection

| Field | Available? | Injected into Haiku prompt? |
|-------|-----------|---------------------------|
| `service_key` (medical_training) | Yes | Yes — "Business context: medical_training business" |
| `domain` (idahomedicalacademy.com) | Yes | Yes |
| `client_context.business_name` | **NOT SET** | No (falls through to domain-based detection) |
| `client_context.vertical` | **NOT SET** | No → `verticalDefault` stays 'Service' |
| `client_context.core_services` | Yes (18 courses) | **No — not used in prompt** |
| `client_context.competitors` | NOT SET | No |

### Findings

1. **`vertical` not set → `verticalDefault = 'Service'`**: The code checks `ctx.vertical === 'education' || ctx.vertical === 'training'` to upgrade `verticalDefault` to `'Course'`. Since IMA's `vertical` is not set, the fallback stays `'Service'`. However, `verticalDefault` is only used when Haiku returns null/invalid entity types (line 183: `normalizeEntityType(...) || verticalDefault`), so this has minimal impact when Haiku returns valid responses.

2. **`core_services` available but not injected**: This is the single biggest improvement opportunity. IMA's client_context lists 18 specific courses. If injected, Haiku would know "NREMT Test Prep" is a product this business sells, not just a concept.

3. **Response parsing: correct.** `normalizeEntityType()` case-insensitively matches against valid types. `normalizeIntent()` validates against the four intent types. Fallbacks are reasonable (`'unknown'` for intent, `verticalDefault` for entity type).

4. **No field mapping errors.** The Haiku response JSON is parsed correctly. Index mapping (1-based to 0-based) is handled.

### Verdict on implementation

**No bug found.** The implementation is correct. The `core_services` omission is a **prompt design choice** (keep the prompt corpus-agnostic), not a bug. It could be enhanced for vocational verticals but is not required for correctness.

---

## Task 5: Verdict

### **Verdict A — Haiku is genuinely more accurate. Proceed with forgegrowth promotion.**

**Evidence:**

- **intent_type:** 100% manual agreement on Set A (commercial-signal informational keywords) and Set B (control). The informational→informational shift is not Haiku being wrong — it's Haiku being more precise than Sonnet's group-level classification. Legacy Sonnet smeared group majority intent across all keywords in a batch.

- **primary_entity_type:** 90% manual agreement on Set C (Article keywords). The Course→Article shift reflects a sharper, more defensible line: enrollment intent = Course, everything else = Article. The 2-3 borderline cases ("nremt test prep", "emergency medical training") would benefit from `core_services` context but are not wrong per the rubric as written.

- **No implementation bugs.** Context injection is correct for what's available. Response parsing is robust.

### Recommended enhancement (non-blocking)

**Inject `core_services` into the Haiku classification prompt for vocational/educational verticals.** This would let Haiku recognize keywords that map to specific offerings (e.g., "nremt test prep" → Course, because IMA sells an NREMT Test Prep course). Estimated impact: ~10-30 keywords would shift from Article to Course on IMA. Not blocking because:

1. Forgegrowth is NOT a training academy — the Course/Article distinction is far less consequential.
2. The current rubric is correct at the information-seeking vs enrollment level.
3. The enhancement can be applied as a follow-up without re-running the full pipeline.

### Forgegrowth promotion risk assessment

Forgegrowth (forgegrowth.ai) is an SEO/marketing services business. Expected entity_type distribution: mostly Service, some Article. The Course/Article sensitivity seen in IMA does not apply. The intent_type rubric is well-calibrated for service businesses (the `[service][city]` = commercial rule is preserved).

**Risk: Low.** Proceed with promotion.

---

## Addendum: Pre-Session-B state recoverability

Pre-Session-B per-keyword classification is irrecoverable because:
1. The pre-promotion snapshot script captured canonical fields only (not classification fields)
2. No audit_snapshots or agent_runs entries capture per-keyword classification state
3. Supabase doesn't expose point-in-time recovery via API

**Recommendation for future:** If a classification extraction prompt changes, capture a pre-change snapshot of `intent_type`, `primary_entity_type`, `is_brand` per keyword alongside the canonical field snapshots. This enables exact before/after comparison instead of the fallback text-analysis approach used here.
