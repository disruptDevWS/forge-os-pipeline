/**
 * pre-cluster.ts — Stage 1: Vector-based pre-clustering for hybrid canonicalization.
 *
 * Collapses duplicates by content_hash, embeds unique hashes, computes centroids
 * for existing canonical topics in-memory, and classifies each variant hash against
 * the centroids. Produces auto-assigned, ambiguous, new-topic-candidate, and
 * prior-locked decisions.
 *
 * Handles ONLY canonical_key/canonical_topic clustering. Other fields (is_brand,
 * is_near_me, intent_type, primary_entity_type) remain Sonnet-based.
 */

import { embedBatch, getEmbeddingsBatch, cosineSimilarity } from '../../../embeddings/index.js';
import { contentHash } from '../../../embeddings/hash.js';
import type { ContentType } from '../../../embeddings/index.js';
import type {
  VariantInput,
  CanonicalTopic,
  PreClusterDecision,
} from './types.js';

// ── Thresholds ───────────────────────────────────────────────
// Auto-assign threshold: lowered from 0.85 → 0.82 on 2026-04-20
// Rationale: IMA shadow data showed 82/83 cases in 0.80-0.85 band were
// assign_existing Sonnet arbitrations (98.8% agreement with vector layer).
// Lowering threshold eliminates ~80 redundant Sonnet calls per 1000-kw audit
// while preserving genuine arbitration work in 0.75-0.82 band.
const AUTO_ASSIGN_THRESHOLD = 0.82;
const AMBIGUITY_LOWER_BOUND = 0.75;

// ── Centroid computation ──────────────────────────────────────

/**
 * Compute the centroid (mean vector) of a set of embeddings.
 * Returns null if no valid embeddings are provided.
 */
export function computeCentroid(embeddings: Array<number[] | null>): number[] | null {
  const valid = embeddings.filter((e): e is number[] => e !== null);
  if (valid.length === 0) return null;

  const dim = valid[0].length;
  const sum = new Array(dim).fill(0);
  for (const vec of valid) {
    for (let i = 0; i < dim; i++) {
      sum[i] += vec[i];
    }
  }

  const count = valid.length;
  return sum.map((v) => v / count);
}

// ── Main pre-clustering function ──────────────────────────────

export async function preCluster(
  variants: VariantInput[],
  existingTopics: CanonicalTopic[],
): Promise<PreClusterDecision[]> {
  if (variants.length === 0) return [];

  // 1. Collapse duplicates by content_hash
  const hashToVariants = new Map<string, VariantInput[]>();
  for (const v of variants) {
    const arr = hashToVariants.get(v.contentHash);
    if (arr) arr.push(v);
    else hashToVariants.set(v.contentHash, [v]);
  }

  const uniqueHashes = [...hashToVariants.keys()];
  const uniqueRepresentatives = uniqueHashes.map((h) => hashToVariants.get(h)![0]);

  console.log(`  [hybrid/pre-cluster] ${variants.length} variants → ${uniqueHashes.length} unique hashes`);

  // 2. Embed all unique hashes
  const embedItems = uniqueRepresentatives.map((v) => ({
    text: v.keyword,
    contentType: 'keyword' as ContentType,
    contentId: v.contentId,
  }));
  const embedResults = await embedBatch(embedItems);

  const hashEmbeddings = new Map<string, number[]>();
  for (let i = 0; i < uniqueHashes.length; i++) {
    const emb = embedResults[i];
    if (emb) {
      hashEmbeddings.set(uniqueHashes[i], emb.embedding);
    }
  }

  // 3. Compute centroids for existing canonical topics (in-memory)
  const topicCentroids = new Map<string, number[]>();
  if (existingTopics.length > 0) {
    for (const topic of existingTopics) {
      const memberItems = topic.memberContentIds.map((cid) => ({
        contentType: 'keyword' as ContentType,
        contentId: cid,
      }));
      const memberEmbeddings = await getEmbeddingsBatch(memberItems);
      const centroid = computeCentroid(memberEmbeddings);
      if (centroid) {
        topicCentroids.set(topic.canonicalKey, centroid);
      }
    }
    console.log(`  [hybrid/pre-cluster] Computed centroids for ${topicCentroids.size}/${existingTopics.length} topics`);
  }

  // Build a lookup for topic metadata
  const topicMeta = new Map<string, CanonicalTopic>();
  for (const t of existingTopics) {
    topicMeta.set(t.canonicalKey, t);
  }

  // 4. Classify each unique hash
  const decisions: PreClusterDecision[] = [];

  for (const hash of uniqueHashes) {
    const variantsForHash = hashToVariants.get(hash)!;
    const representative = variantsForHash[0];
    const contentIds = variantsForHash.map((v) => v.contentId);

    // Re-run stability check: prior assignment was hybrid-originated
    // Lock predicate: prior canonical_key exists AND topic still present AND prior was hybrid
    const priorKey = representative.existingCanonicalKey;
    const priorMethod = representative.existingClassificationMethod;
    if (
      priorKey &&
      priorMethod !== null && // hybrid-originated (classification_method IS NOT NULL)
      topicMeta.has(priorKey) // topic still exists in current run
    ) {
      const topic = topicMeta.get(priorKey)!;
      decisions.push({
        contentHash: hash,
        contentIds,
        keyword: representative.keyword,
        decision: 'prior_locked',
        classificationMethod: 'prior_assignment_locked',
        assignedCanonicalKey: priorKey,
        assignedCanonicalTopic: topic.canonicalTopic,
        similarityScore: null,
        topMatches: [],
      });
      continue;
    }

    // Check embedding availability
    const embedding = hashEmbeddings.get(hash);
    if (!embedding) {
      // Embedding failed — route to arbitration
      decisions.push({
        contentHash: hash,
        contentIds,
        keyword: representative.keyword,
        decision: 'ambiguous',
        classificationMethod: 'sonnet_arbitration_assigned', // will be updated by arbitrator
        assignedCanonicalKey: null,
        assignedCanonicalTopic: null,
        similarityScore: null,
        topMatches: [],
      });
      continue;
    }

    // Compute similarity against all topic centroids
    const matches: Array<{ canonicalKey: string; canonicalTopic: string; similarity: number }> = [];
    for (const [key, centroid] of topicCentroids) {
      const sim = cosineSimilarity(embedding, centroid);
      if (sim >= AMBIGUITY_LOWER_BOUND) {
        const topic = topicMeta.get(key)!;
        matches.push({ canonicalKey: key, canonicalTopic: topic.canonicalTopic, similarity: sim });
      }
    }
    matches.sort((a, b) => b.similarity - a.similarity);

    // Classification decision
    const topMatches = matches.slice(0, 5); // keep top 5 for arbitration context

    const aboveAutoThreshold = matches.filter((m) => m.similarity >= AUTO_ASSIGN_THRESHOLD);

    if (aboveAutoThreshold.length === 1) {
      // Single match above auto-assign threshold → auto-assign
      const best = aboveAutoThreshold[0];
      decisions.push({
        contentHash: hash,
        contentIds,
        keyword: representative.keyword,
        decision: 'auto_assigned',
        classificationMethod: 'vector_auto_assign',
        assignedCanonicalKey: best.canonicalKey,
        assignedCanonicalTopic: best.canonicalTopic,
        similarityScore: best.similarity,
        topMatches,
      });
    } else if (aboveAutoThreshold.length > 1) {
      // Multiple matches above auto-assign threshold → ambiguous
      decisions.push({
        contentHash: hash,
        contentIds,
        keyword: representative.keyword,
        decision: 'ambiguous',
        classificationMethod: 'sonnet_arbitration_assigned',
        assignedCanonicalKey: null,
        assignedCanonicalTopic: null,
        similarityScore: aboveAutoThreshold[0].similarity,
        topMatches,
      });
    } else if (matches.length > 0) {
      // Matches in ambiguity band (0.75–0.82) → ambiguous
      decisions.push({
        contentHash: hash,
        contentIds,
        keyword: representative.keyword,
        decision: 'ambiguous',
        classificationMethod: 'sonnet_arbitration_assigned',
        assignedCanonicalKey: null,
        assignedCanonicalTopic: null,
        similarityScore: matches[0].similarity,
        topMatches,
      });
    } else {
      // No matches above 0.75 → new topic candidate
      decisions.push({
        contentHash: hash,
        contentIds,
        keyword: representative.keyword,
        decision: 'new_topic_candidate',
        classificationMethod: 'sonnet_arbitration_new_topic',
        assignedCanonicalKey: null,
        assignedCanonicalTopic: null,
        similarityScore: null,
        topMatches,
      });
    }
  }

  // Summary
  const autoCount = decisions.filter((d) => d.decision === 'auto_assigned').length;
  const ambigCount = decisions.filter((d) => d.decision === 'ambiguous').length;
  const newCount = decisions.filter((d) => d.decision === 'new_topic_candidate').length;
  const lockCount = decisions.filter((d) => d.decision === 'prior_locked').length;
  console.log(`  [hybrid/pre-cluster] Decisions: ${autoCount} auto-assigned, ${ambigCount} ambiguous, ${newCount} new-topic, ${lockCount} prior-locked`);

  return decisions;
}
