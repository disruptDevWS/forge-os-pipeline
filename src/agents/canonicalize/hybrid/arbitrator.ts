/**
 * arbitrator.ts — Stage 2: Sonnet arbitration for ambiguous and new-topic cases.
 *
 * Receives only the cases Stage 1 couldn't resolve (ambiguous band 0.75-0.85,
 * multi-match above 0.85, new-topic candidates, embedding failures).
 * Sonnet's job is judgment on the hard cases, not re-clustering.
 *
 * Stage 1's classifications are INPUTS, not suggestions to second-guess.
 */

import type {
  ArbitrationInput,
  ArbitrationDecision,
  CanonicalTopic,
  ClassificationMethod,
} from './types.js';

/**
 * callClaude is in scripts/ (outside rootDir). Inject at runtime via _setCallClaude().
 * pipeline-generate.ts sets this before calling runHybridCanonicalize.
 */
export type CallClaudeFn = (prompt: string, opts: { model: string; phase: string }) => Promise<string>;
let _callClaude: CallClaudeFn | null = null;

async function getCallClaude(): Promise<CallClaudeFn> {
  if (!_callClaude) {
    throw new Error('[hybrid/arbitrator] callClaude not injected — call _setCallClaude() before running hybrid mode');
  }
  return _callClaude;
}

/** Inject callClaude at runtime (from pipeline-generate.ts) or for testing. */
export function _setCallClaude(fn: CallClaudeFn | null): void {
  _callClaude = fn;
}

/**
 * Build the arbitration prompt for Sonnet.
 * Designed to be surgical: present Stage 1's analysis as input,
 * not as context for Sonnet to re-derive.
 */
function buildArbitrationPrompt(
  cases: ArbitrationInput[],
  existingTopics: CanonicalTopic[],
  serviceKey: string,
  locationCtx: string,
): string {
  const topicList = existingTopics
    .map((t) => `  - ${t.canonicalKey} ("${t.canonicalTopic}", ${t.memberContentIds.length} members)`)
    .join('\n');

  const caseList = cases
    .map((c, i) => {
      const matchInfo =
        c.topMatches.length > 0
          ? c.topMatches
              .map((m) => `    ${m.canonicalKey} (${m.similarity.toFixed(4)})`)
              .join('\n')
          : '    (no vector matches above threshold)';
      return `Case ${i + 1}: "${c.keyword}" [hash: ${c.contentHash.slice(0, 8)}]
  Stage 1 decision: ${c.decision}
  Vector matches:\n${matchInfo}`;
    })
    .join('\n\n');

  return `You are an SEO keyword arbitrator for a ${serviceKey || 'local service'} business${locationCtx ? ` in ${locationCtx}` : ''}.

Stage 1 (vector pre-clustering) has automatically assigned most keywords to canonical topics. The cases below are the ones Stage 1 could NOT resolve — they need your judgment.

EXISTING CANONICAL TOPICS:
${topicList || '  (none yet — this may be the first run)'}

UNRESOLVED CASES:
${caseList}

For each case, decide ONE of:
- "assign_existing": assign to an existing canonical topic (specify which)
- "create_new": create a new canonical topic (specify canonical_key and canonical_topic)
- "merge_candidate": this keyword should be grouped with another unresolved case (specify which case number to merge with, and provide the canonical_key/topic for the merged group)

RULES:
- Canonical keys: lowercase_with_underscores, geography-agnostic
- Canonical topics: Title Case, geography-agnostic
- Stage 1's vector similarity scores are signal — a 0.82 match is likely correct, a 0.76 match is borderline
- Do not create new topics if an existing topic is a reasonable fit
- Do not merge semantically distinct services just to reduce topic count

Respond with raw JSON only. No markdown code fences.

JSON schema:
{
  "decisions": [
    {
      "case_index": 1,
      "action": "assign_existing",
      "canonical_key": "ac_repair",
      "canonical_topic": "AC Repair",
      "reason": "brief explanation"
    }
  ]
}

YOUR ENTIRE RESPONSE IS THE JSON OBJECT.`;
}

/**
 * Parse Sonnet's arbitration response into structured decisions.
 */
function parseArbitrationResponse(
  raw: string,
  cases: ArbitrationInput[],
): ArbitrationDecision[] {
  // Strip code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.warn('  [hybrid/arbitrator] Failed to parse Sonnet response, attempting repair');
    // Try to extract JSON object
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      parsed = JSON.parse(match[0]);
    } else {
      throw new Error('Could not parse arbitration response');
    }
  }

  const decisions: ArbitrationDecision[] = [];
  const rawDecisions = parsed.decisions ?? [];

  for (const d of rawDecisions) {
    const caseIdx = (d.case_index ?? d.caseIndex ?? 0) - 1; // 1-indexed → 0-indexed
    if (caseIdx < 0 || caseIdx >= cases.length) continue;

    const sourceCase = cases[caseIdx];
    let method: ClassificationMethod;
    switch (d.action) {
      case 'assign_existing':
        method = 'sonnet_arbitration_assigned';
        break;
      case 'create_new':
        method = 'sonnet_arbitration_new_topic';
        break;
      case 'merge_candidate':
        method = 'sonnet_arbitration_merged';
        break;
      default:
        method = 'sonnet_arbitration_assigned';
    }

    decisions.push({
      contentHash: sourceCase.contentHash,
      action: d.action,
      canonicalKey: d.canonical_key ?? d.canonicalKey,
      canonicalTopic: d.canonical_topic ?? d.canonicalTopic,
      classificationMethod: method,
      arbitrationReason: d.reason ?? '',
    });
  }

  return decisions;
}

/**
 * Run Sonnet arbitration on the ambiguous and new-topic cases from Stage 1.
 */
export async function arbitrate(
  cases: ArbitrationInput[],
  existingTopics: CanonicalTopic[],
  serviceKey: string,
  locationCtx: string,
): Promise<ArbitrationDecision[]> {
  if (cases.length === 0) return [];

  console.log(`  [hybrid/arbitrator] Arbitrating ${cases.length} cases via Sonnet`);

  const callClaude = await getCallClaude();
  const prompt = buildArbitrationPrompt(cases, existingTopics, serviceKey, locationCtx);

  let response: string;
  try {
    response = await callClaude(prompt, { model: 'sonnet', phase: 'canonicalize-arbitration' });
  } catch (err: any) {
    console.error(`  [hybrid/arbitrator] Sonnet call failed: ${err.message}`);
    throw err;
  }

  const decisions = parseArbitrationResponse(response, cases);
  console.log(`  [hybrid/arbitrator] Resolved ${decisions.length}/${cases.length} cases`);

  return decisions;
}

// Export for testing
export { buildArbitrationPrompt, parseArbitrationResponse };
