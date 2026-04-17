import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock embeddings service ──────────────────────────────────

const mockEmbedBatch = vi.fn();
const mockGetEmbeddingsBatch = vi.fn();
const mockCosineSimilarity = vi.fn();

vi.mock('../../../../embeddings/index.js', () => ({
  embedBatch: (...args: any[]) => mockEmbedBatch(...args),
  getEmbeddingsBatch: (...args: any[]) => mockGetEmbeddingsBatch(...args),
  cosineSimilarity: (...args: any[]) => mockCosineSimilarity(...args),
}));

vi.mock('../../../../embeddings/hash.js', () => ({
  contentHash: (text: string) => `hash_${text.toLowerCase().replace(/\s+/g, '_')}`,
}));

import { preCluster, computeCentroid } from '../pre-cluster.js';
import type { VariantInput, CanonicalTopic } from '../types.js';

// ── Helpers ──────────────────────────────────────────────────

function makeVariant(overrides: Partial<VariantInput> & { keyword: string }): VariantInput {
  return {
    contentId: `kw-${overrides.keyword}`,
    contentHash: `hash_${overrides.keyword.toLowerCase().replace(/\s+/g, '_')}`,
    existingCanonicalKey: null,
    existingCanonicalTopic: null,
    existingClassificationMethod: null,
    ...overrides,
  };
}

function makeTopic(key: string, topic: string, members: string[]): CanonicalTopic {
  return { canonicalKey: key, canonicalTopic: topic, memberContentIds: members };
}

const DIMS = 1536;
function unitVector(index: number): number[] {
  const v = new Array(DIMS).fill(0);
  v[index % DIMS] = 1.0;
  return v;
}

// ── Tests ────────────────────────────────────────────────────

describe('computeCentroid()', () => {
  it('returns null for empty input', () => {
    expect(computeCentroid([])).toBeNull();
  });

  it('returns null for all-null input', () => {
    expect(computeCentroid([null, null])).toBeNull();
  });

  it('returns the vector itself for single input', () => {
    const v = [1, 2, 3];
    expect(computeCentroid([v])).toEqual([1, 2, 3]);
  });

  it('computes mean of two vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    const result = computeCentroid([a, b])!;
    expect(result[0]).toBeCloseTo(0.5);
    expect(result[1]).toBeCloseTo(0.5);
    expect(result[2]).toBeCloseTo(0);
  });

  it('skips nulls in the average', () => {
    const a = [2, 4];
    const result = computeCentroid([a, null])!;
    expect(result).toEqual([2, 4]); // only one valid vector
  });
});

describe('preCluster()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty for empty input', async () => {
    const result = await preCluster([], []);
    expect(result).toEqual([]);
  });

  it('auto-assigns when single match above 0.85', async () => {
    const variant = makeVariant({ keyword: 'emt training boise' });
    const topic = makeTopic('emt_training', 'EMT Training', ['kw-existing']);

    // embedBatch returns embedding for our variant
    mockEmbedBatch.mockResolvedValueOnce([{ embedding: unitVector(0), fromCache: false }]);
    // getEmbeddingsBatch for topic centroid
    mockGetEmbeddingsBatch.mockResolvedValueOnce([unitVector(1)]);
    // cosineSimilarity: variant vs centroid = 0.90 (above 0.85)
    mockCosineSimilarity.mockReturnValue(0.90);

    const decisions = await preCluster([variant], [topic]);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('auto_assigned');
    expect(decisions[0].classificationMethod).toBe('vector_auto_assign');
    expect(decisions[0].assignedCanonicalKey).toBe('emt_training');
    expect(decisions[0].similarityScore).toBe(0.90);
  });

  it('marks ambiguous when multiple matches above 0.85', async () => {
    const variant = makeVariant({ keyword: 'emt course' });
    const topicA = makeTopic('emt_training', 'EMT Training', ['kw-a']);
    const topicB = makeTopic('emt_certification', 'EMT Certification', ['kw-b']);

    mockEmbedBatch.mockResolvedValueOnce([{ embedding: unitVector(0), fromCache: false }]);
    mockGetEmbeddingsBatch
      .mockResolvedValueOnce([unitVector(1)]) // topicA centroid
      .mockResolvedValueOnce([unitVector(2)]); // topicB centroid
    // Both above 0.85
    mockCosineSimilarity.mockReturnValueOnce(0.88).mockReturnValueOnce(0.86);

    const decisions = await preCluster([variant], [topicA, topicB]);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('ambiguous');
  });

  it('marks new_topic_candidate when below 0.75', async () => {
    const variant = makeVariant({ keyword: 'restaurant reviews' });
    const topic = makeTopic('emt_training', 'EMT Training', ['kw-a']);

    mockEmbedBatch.mockResolvedValueOnce([{ embedding: unitVector(0), fromCache: false }]);
    mockGetEmbeddingsBatch.mockResolvedValueOnce([unitVector(1)]);
    mockCosineSimilarity.mockReturnValue(0.20); // far below threshold

    const decisions = await preCluster([variant], [topic]);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('new_topic_candidate');
  });

  it('locks prior assignment when classification_method is NOT NULL and topic exists', async () => {
    const variant = makeVariant({
      keyword: 'emt training',
      existingCanonicalKey: 'emt_training',
      existingCanonicalTopic: 'EMT Training',
      existingClassificationMethod: 'vector_auto_assign', // hybrid-originated
    });
    const topic = makeTopic('emt_training', 'EMT Training', ['kw-existing']);

    // embedBatch still called (for all unique hashes), returns empty since only one variant and it's locked early
    mockEmbedBatch.mockResolvedValueOnce([{ embedding: unitVector(0), fromCache: true }]);
    // getEmbeddingsBatch for topic centroid computation
    mockGetEmbeddingsBatch.mockResolvedValueOnce([unitVector(1)]);

    const decisions = await preCluster([variant], [topic]);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('prior_locked');
    expect(decisions[0].classificationMethod).toBe('prior_assignment_locked');
    expect(decisions[0].assignedCanonicalKey).toBe('emt_training');
  });

  it('does NOT lock prior assignment from legacy mode (classification_method IS NULL)', async () => {
    const variant = makeVariant({
      keyword: 'emt training',
      existingCanonicalKey: 'emt_training',
      existingCanonicalTopic: 'EMT Training',
      existingClassificationMethod: null, // legacy-originated
    });
    const topic = makeTopic('emt_training', 'EMT Training', ['kw-existing']);

    mockEmbedBatch.mockResolvedValueOnce([{ embedding: unitVector(0), fromCache: false }]);
    mockGetEmbeddingsBatch.mockResolvedValueOnce([unitVector(1)]);
    mockCosineSimilarity.mockReturnValue(0.92);

    const decisions = await preCluster([variant], [topic]);

    expect(decisions).toHaveLength(1);
    // Should be classified normally, NOT prior_locked
    expect(decisions[0].decision).toBe('auto_assigned');
  });

  it('routes embedding failures to arbitration', async () => {
    const variant = makeVariant({ keyword: 'failed embed' });
    const topic = makeTopic('emt_training', 'EMT Training', ['kw-a']);

    // embedBatch returns null for this variant
    mockEmbedBatch.mockResolvedValueOnce([null]);
    mockGetEmbeddingsBatch.mockResolvedValueOnce([unitVector(1)]);

    const decisions = await preCluster([variant], [topic]);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('ambiguous');
  });

  it('collapses duplicate content hashes', async () => {
    // Two variants with same keyword text → same content_hash
    const v1 = makeVariant({ keyword: 'emt training', contentId: 'kw-1' });
    const v2 = makeVariant({ keyword: 'emt training', contentId: 'kw-2' });
    // Make their hashes match
    v2.contentHash = v1.contentHash;

    const topic = makeTopic('emt_training', 'EMT Training', ['kw-existing']);

    mockEmbedBatch.mockResolvedValueOnce([{ embedding: unitVector(0), fromCache: false }]);
    mockGetEmbeddingsBatch.mockResolvedValueOnce([unitVector(1)]);
    mockCosineSimilarity.mockReturnValue(0.90);

    const decisions = await preCluster([v1, v2], [topic]);

    // Only one decision for the shared hash, but with both content_ids
    expect(decisions).toHaveLength(1);
    expect(decisions[0].contentIds).toContain('kw-1');
    expect(decisions[0].contentIds).toContain('kw-2');
  });
});
