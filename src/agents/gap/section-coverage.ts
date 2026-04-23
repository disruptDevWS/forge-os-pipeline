/**
 * section-coverage.ts — Compute frequency-weighted section coverage scores.
 *
 * Compares competitor H2/H3 headings against client page headings via
 * embedding cosine similarity. Weights each subtopic by how many competitors
 * cover it (table-stakes vs fringe detection).
 *
 * Coverage formula: Σ(competitor_frequency × covered) / Σ(competitor_frequency)
 * where covered = 1 if best client match ≥ COVERAGE_THRESHOLD, else 0.
 */

import { embedBatch, cosineSimilarity } from '../../embeddings/index.js';

// ── Thresholds ──
export const COVERAGE_THRESHOLD = 0.85;
export const BORDERLINE_LOW = 0.78;
export const BORDERLINE_HIGH = 0.88;

// ── Types ──

export interface HeadingSection {
  domain: string;
  heading_text: string;
  heading_level: 'h2' | 'h3';
  heading_position: number;
}

export interface SubtopicGap {
  heading: string;
  heading_level: string;
  competitor_frequency: number;
  best_client_match: string | null;
  best_similarity: number;
}

export interface BorderlineMatch {
  competitor_heading: string;
  client_heading: string;
  similarity: number;
  competitor_frequency: number;
}

export type CoverageStatus = 'scored' | 'no_client_pages' | 'insufficient_competitors';

export interface SectionCoverageResult {
  coverage_score: number;
  coverage_status: CoverageStatus;
  competitor_count: number;
  total_subtopics_weighted: number;
  covered_subtopics_weighted: number;
  core_gaps: SubtopicGap[];
  borderline_matches: BorderlineMatch[];
}

/**
 * Compute section coverage for a single canonical topic.
 *
 * @param canonicalKey   Topic key for embedding content IDs
 * @param competitorSections  Competitor page headings (all domains for this topic)
 * @param clientSections      Client page headings for this topic
 * @param threshold           Cosine similarity threshold for "covered" (default 0.85)
 */
export async function computeSectionCoverage(
  canonicalKey: string,
  competitorSections: HeadingSection[],
  clientSections: HeadingSection[],
  threshold: number = COVERAGE_THRESHOLD,
): Promise<SectionCoverageResult> {
  // Guard: insufficient competitors
  const competitorDomains = new Set(competitorSections.map((s) => s.domain));
  if (competitorDomains.size < 2) {
    return {
      coverage_score: 0,
      coverage_status: 'insufficient_competitors',
      competitor_count: competitorDomains.size,
      total_subtopics_weighted: 0,
      covered_subtopics_weighted: 0,
      core_gaps: [],
      borderline_matches: [],
    };
  }

  // Guard: no client pages
  if (clientSections.length === 0) {
    // Still compute competitor subtopics for core_gaps
    const subtopics = deduplicateCompetitorSubtopics(competitorSections);
    const coreGaps = subtopics
      .filter((s) => s.frequency >= 2)
      .map((s) => ({
        heading: s.heading,
        heading_level: s.heading_level,
        competitor_frequency: s.frequency,
        best_client_match: null,
        best_similarity: 0,
      }));

    return {
      coverage_score: 0,
      coverage_status: 'no_client_pages',
      competitor_count: competitorDomains.size,
      total_subtopics_weighted: subtopics.reduce((sum, s) => sum + s.frequency, 0),
      covered_subtopics_weighted: 0,
      core_gaps: coreGaps,
      borderline_matches: [],
    };
  }

  // 1. Deduplicate competitor headings, count frequency
  const subtopics = deduplicateCompetitorSubtopics(competitorSections);

  // 2. Embed all headings
  const competitorTexts = subtopics.map((s) => ({
    text: s.heading,
    contentType: 'page_section' as const,
    contentId: `comp:${canonicalKey}:${s.heading.toLowerCase().trim().replace(/\s+/g, '_').slice(0, 80)}`,
  }));

  const clientTexts = clientSections.map((s) => ({
    text: s.heading_text,
    contentType: 'page_section' as const,
    contentId: `client:${canonicalKey}:${s.heading_text.toLowerCase().trim().replace(/\s+/g, '_').slice(0, 80)}`,
  }));

  const [compEmbeddings, clientEmbeddings] = await Promise.all([
    embedBatch(competitorTexts),
    embedBatch(clientTexts),
  ]);

  // 3. For each competitor subtopic, find best client match
  const core_gaps: SubtopicGap[] = [];
  const borderline_matches: BorderlineMatch[] = [];
  let totalWeighted = 0;
  let coveredWeighted = 0;

  for (let i = 0; i < subtopics.length; i++) {
    const compEmb = compEmbeddings[i]?.embedding;
    if (!compEmb) continue;

    const freq = subtopics[i].frequency;
    totalWeighted += freq;

    let bestSim = 0;
    let bestClientHeading: string | null = null;

    for (let j = 0; j < clientSections.length; j++) {
      const clientEmb = clientEmbeddings[j]?.embedding;
      if (!clientEmb) continue;

      const sim = cosineSimilarity(compEmb, clientEmb);
      if (sim > bestSim) {
        bestSim = sim;
        bestClientHeading = clientSections[j].heading_text;
      }
    }

    const isCovered = bestSim >= threshold;
    if (isCovered) {
      coveredWeighted += freq;
    }

    // Log borderline matches for threshold tuning
    if (bestSim >= BORDERLINE_LOW && bestSim <= BORDERLINE_HIGH) {
      borderline_matches.push({
        competitor_heading: subtopics[i].heading,
        client_heading: bestClientHeading ?? '',
        similarity: Math.round(bestSim * 1000) / 1000,
        competitor_frequency: freq,
      });
    }

    // Core gaps: uncovered + frequency >= 2 (table stakes, not fringe)
    if (!isCovered && freq >= 2) {
      core_gaps.push({
        heading: subtopics[i].heading,
        heading_level: subtopics[i].heading_level,
        competitor_frequency: freq,
        best_client_match: bestClientHeading,
        best_similarity: Math.round(bestSim * 1000) / 1000,
      });
    }
  }

  const coverage_score = totalWeighted > 0
    ? Math.round((coveredWeighted / totalWeighted) * 100)
    : 0;

  return {
    coverage_score,
    coverage_status: 'scored',
    competitor_count: competitorDomains.size,
    total_subtopics_weighted: totalWeighted,
    covered_subtopics_weighted: coveredWeighted,
    core_gaps: core_gaps.sort((a, b) => b.competitor_frequency - a.competitor_frequency),
    borderline_matches,
  };
}

// ── Helpers ──

interface DeduplicatedSubtopic {
  heading: string;
  heading_level: string;
  frequency: number;
}

/**
 * Deduplicate competitor headings across domains.
 * "AC Repair" from 3 different competitors → frequency 3.
 * Normalization: lowercase + trim + collapse whitespace.
 */
function deduplicateCompetitorSubtopics(sections: HeadingSection[]): DeduplicatedSubtopic[] {
  const map = new Map<string, { heading: string; heading_level: string; domains: Set<string> }>();

  for (const s of sections) {
    const key = s.heading_text.toLowerCase().trim().replace(/\s+/g, ' ');
    const existing = map.get(key);
    if (existing) {
      existing.domains.add(s.domain);
    } else {
      map.set(key, {
        heading: s.heading_text,
        heading_level: s.heading_level,
        domains: new Set([s.domain]),
      });
    }
  }

  return [...map.values()].map((v) => ({
    heading: v.heading,
    heading_level: v.heading_level,
    frequency: v.domains.size,
  }));
}
