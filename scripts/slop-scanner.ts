/**
 * Slop Scanner — post-generation QA gate for Oscar output.
 *
 * Detects banned phrases from system-prompt.md + seo-playbook.md,
 * builds sentence-level rewrite prompts, and applies string-substitution fixes.
 */

// --- Banned phrase registry ---

export interface BannedPhrase {
  pattern: RegExp;
  label: string;
  source: 'system-prompt' | 'seo-playbook';
}

export const BANNED_PHRASES: BannedPhrase[] = [
  // From configs/oscar/system-prompt.md line 50
  { pattern: /\bnavigating\b/gi, label: 'navigating', source: 'system-prompt' },
  { pattern: /\blandscape\b/gi, label: 'landscape', source: 'system-prompt' },
  { pattern: /\bleverage\b/gi, label: 'leverage', source: 'system-prompt' },
  { pattern: /\bdelve\b/gi, label: 'delve', source: 'system-prompt' },
  { pattern: /it[''\u2019]s worth noting/gi, label: "it's worth noting", source: 'system-prompt' },
  { pattern: /in today[''\u2019]s world/gi, label: "in today's world", source: 'system-prompt' },
  // From configs/oscar/seo-playbook.md lines 190-191
  { pattern: /when it comes to/gi, label: 'when it comes to', source: 'seo-playbook' },
  { pattern: /whether you need .{1,40} or /gi, label: 'whether you need X or Y', source: 'seo-playbook' },
  { pattern: /\bin fact,/gi, label: 'In fact,', source: 'seo-playbook' },
  { pattern: /don[''\u2019]t hesitate to/gi, label: "don't hesitate to", source: 'seo-playbook' },
  { pattern: /we understand that/gi, label: 'we understand that', source: 'seo-playbook' },
  { pattern: /contact us today/gi, label: 'contact us today (section ender)', source: 'seo-playbook' },
];

// --- Types ---

export interface SlopViolation {
  id: number;
  phrase: string;
  label: string;
  source: string;
  lineNumber: number;
  context: string;
  originalSentence: string;
}

export interface SlopReplacement {
  id: number;
  replacement_sentence: string;
}

// --- Core functions ---

/**
 * Strip HTML tags to get plain text for matching, preserving line breaks.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|section|article|blockquote|tr|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Extract the sentence containing a match from plain text.
 * Finds the nearest sentence boundaries (period, question mark, exclamation, or newline).
 */
function extractSentence(text: string, matchStart: number, matchEnd: number): string {
  // Look backward for sentence start
  let start = matchStart;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1]!)) {
    start--;
  }
  // Skip leading whitespace
  while (start < matchStart && /\s/.test(text[start]!)) {
    start++;
  }

  // Look forward for sentence end
  let end = matchEnd;
  while (end < text.length && !/[.!?\n]/.test(text[end]!)) {
    end++;
  }
  // Include the punctuation
  if (end < text.length && /[.!?]/.test(text[end]!)) {
    end++;
  }

  return text.slice(start, end).trim();
}

/**
 * Scan HTML content for banned phrases.
 * Returns violations with sentence context for targeted rewrite.
 */
export function scanForSlop(html: string): SlopViolation[] {
  const plainText = stripHtml(html);
  const lines = plainText.split('\n');
  const violations: SlopViolation[] = [];
  let violationId = 0;

  // Track seen sentences to avoid duplicate violations for the same sentence
  const seenSentences = new Set<string>();

  for (const bp of BANNED_PHRASES) {
    // Reset regex lastIndex for global patterns
    bp.pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = bp.pattern.exec(plainText)) !== null) {
      // Calculate line number
      const textBefore = plainText.slice(0, match.index);
      const lineNumber = textBefore.split('\n').length;

      // Extract surrounding context (~40 chars each side)
      const ctxStart = Math.max(0, match.index - 40);
      const ctxEnd = Math.min(plainText.length, match.index + match[0].length + 40);
      const context = plainText.slice(ctxStart, ctxEnd).replace(/\n/g, ' ');

      // Extract full sentence
      const sentence = extractSentence(plainText, match.index, match.index + match[0].length);
      const sentenceKey = `${sentence}::${bp.label}`;

      if (!seenSentences.has(sentenceKey)) {
        seenSentences.add(sentenceKey);
        violations.push({
          id: violationId++,
          phrase: match[0],
          label: bp.label,
          source: bp.source,
          lineNumber,
          context,
          originalSentence: sentence,
        });
      }
    }
  }

  return violations;
}

/**
 * Build a sentence-level rewrite prompt from violations.
 * Sends ONLY the violating sentences — not the full HTML.
 */
export function buildRewritePrompt(violations: SlopViolation[]): string {
  const violationEntries = violations.map((v) => ({
    id: v.id,
    original_sentence: v.originalSentence,
    banned_phrase: v.label,
    instruction: `Replace or rephrase '${v.label}' with a contextually appropriate alternative`,
  }));

  return `YOUR ENTIRE RESPONSE IS THE JSON ARRAY. No preamble, no explanation.

You are replacing banned phrases in content sentences. For each sentence below, provide a replacement that removes the banned phrase while preserving meaning, tone, and surrounding structure.

Rules:
- Replace ONLY the banned phrase — keep the rest of the sentence intact
- Use a natural, non-generic alternative appropriate to the sentence context
- Do not add new AI-isms (no "navigate", "landscape", "leverage", "delve", "harness", "empower")
- Preserve sentence length roughly (±20%)

Violations:
${JSON.stringify(violationEntries, null, 2)}

Return a JSON array of replacements:
[
  { "id": 0, "replacement_sentence": "..." },
  { "id": 1, "replacement_sentence": "..." }
]`;
}

/**
 * Apply sentence-level replacements to HTML content via string substitution.
 * Finds each original sentence in the HTML and replaces with the rewritten version.
 */
export function applySlopFixes(
  html: string,
  violations: SlopViolation[],
  replacements: SlopReplacement[],
): string {
  let result = html;

  // Build a map of id → replacement
  const replacementMap = new Map<number, string>();
  for (const r of replacements) {
    replacementMap.set(r.id, r.replacement_sentence);
  }

  // Group violations by original sentence to handle multiple violations in same sentence
  const sentenceGroups = new Map<string, { violation: SlopViolation; replacement: string | undefined }[]>();
  for (const v of violations) {
    const group = sentenceGroups.get(v.originalSentence) ?? [];
    group.push({ violation: v, replacement: replacementMap.get(v.id) });
    sentenceGroups.set(v.originalSentence, group);
  }

  // For each unique sentence, apply the last replacement (which should cover all fixes)
  for (const [originalSentence, group] of sentenceGroups) {
    // Use the replacement from the highest-id violation (last processed, most complete)
    const finalReplacement = group
      .filter((g) => g.replacement)
      .sort((a, b) => b.violation.id - a.violation.id)[0]?.replacement;

    if (finalReplacement && finalReplacement !== originalSentence) {
      // Escape special regex characters in the original sentence for safe replacement
      const escaped = originalSentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escaped, 'g');
      result = result.replace(pattern, finalReplacement);
    }
  }

  return result;
}
