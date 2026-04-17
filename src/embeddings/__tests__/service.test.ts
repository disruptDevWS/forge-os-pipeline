import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── Mock OpenAI ───────────────────────────────────────────────

const mockCreate = vi.fn();

vi.mock('openai', () => {
  return {
    default: class {
      embeddings = { create: mockCreate };
    },
  };
});

// ── Mock Supabase ─────────────────────────────────────────────

function buildMockQuery(resolveWith: { data: unknown; error: unknown }) {
  const chain: Record<string, Mock> = {};
  const terminalMethods = ['single', 'then'];
  const chainMethods = ['from', 'select', 'insert', 'upsert', 'eq', 'neq', 'in', 'limit'];

  const handler = {
    get(_target: unknown, prop: string) {
      if (prop === 'then') {
        // Make it thenable so await resolves
        return (resolve: (v: unknown) => void) => resolve(resolveWith);
      }
      if (!chain[prop]) {
        chain[prop] = vi.fn(() => new Proxy({}, handler));
      }
      return chain[prop];
    },
  };

  return new Proxy({}, handler);
}

let mockSupabaseData: { data: unknown; error: unknown } = { data: null, error: null };
let mockRpcData: { data: unknown; error: unknown } = { data: null, error: null };
let mockUpsertData: { data: unknown; error: unknown } = { data: null, error: null };

const mockRpc = vi.fn(() => Promise.resolve(mockRpcData));

vi.mock('../../supabase.js', () => ({
  getSupabaseAdmin: () => {
    const handler = {
      get(_target: unknown, prop: string) {
        if (prop === 'rpc') return mockRpc;
        if (prop === 'from') {
          return (table: string) => {
            const queryHandler = {
              get(_t: unknown, method: string) {
                if (method === 'select') {
                  return () => {
                    const selectHandler = {
                      get(_t2: unknown, m2: string) {
                        if (m2 === 'eq') {
                          return () => new Proxy({}, selectHandler);
                        }
                        if (m2 === 'in') {
                          return () => new Proxy({}, selectHandler);
                        }
                        if (m2 === 'limit') {
                          return () => new Proxy({}, selectHandler);
                        }
                        if (m2 === 'single') {
                          return () => Promise.resolve(mockSupabaseData);
                        }
                        if (m2 === 'then') {
                          return (resolve: (v: unknown) => void) =>
                            resolve(mockSupabaseData);
                        }
                        return () => new Proxy({}, selectHandler);
                      },
                    };
                    return new Proxy({}, selectHandler);
                  };
                }
                if (method === 'upsert') {
                  return () => Promise.resolve(mockUpsertData);
                }
                return () => new Proxy({}, queryHandler);
              },
            };
            return new Proxy({}, queryHandler);
          };
        }
        return () => {};
      },
    };
    return new Proxy({}, handler);
  },
}));

// ── Import service after mocks ────────────────────────────────

import {
  embed,
  embedBatch,
  getEmbedding,
  getEmbeddingsBatch,
  findSimilar,
  similarityBatch,
  cosineSimilarity,
  _resetOpenAI,
} from '../service.js';

// ── Helpers ───────────────────────────────────────────────────

/** Generate a deterministic unit vector with a non-zero value at the given index. */
function unitVector(dim: number, index: number): number[] {
  const v = new Array(dim).fill(0);
  v[index % dim] = 1.0;
  return v;
}

/** Generate a vector at 45 degrees between two basis vectors. */
function midVector(dim: number, i: number, j: number): number[] {
  const v = new Array(dim).fill(0);
  v[i % dim] = Math.SQRT1_2;
  v[j % dim] = Math.SQRT1_2;
  return v;
}

const DIMS = 1536;

// ── Tests ─────────────────────────────────────────────────────

describe('embed()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetOpenAI();
    mockSupabaseData = { data: null, error: null };
    mockUpsertData = { data: null, error: null };
  });

  it('stores a new embedding and returns fromCache: false', async () => {
    const vec = unitVector(DIMS, 0);
    mockCreate.mockResolvedValueOnce({
      data: [{ embedding: vec }],
    });

    const result = await embed('EMT training', 'keyword', 'kw-1');

    expect(result).not.toBeNull();
    expect(result!.fromCache).toBe(false);
    expect(result!.embedding).toEqual(vec);
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  it('returns fromCache: true when cache has matching content_hash', async () => {
    const vec = unitVector(DIMS, 1);
    mockSupabaseData = { data: { embedding: vec }, error: null };

    const result = await embed('EMT training', 'keyword', 'kw-1');

    expect(result).not.toBeNull();
    expect(result!.fromCache).toBe(true);
    expect(result!.embedding).toEqual(vec);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('hits cache with slightly different whitespace/casing', async () => {
    const vec = unitVector(DIMS, 2);
    mockSupabaseData = { data: { embedding: vec }, error: null };

    const result = await embed('  EMT   Training  ', 'keyword', 'kw-1');

    expect(result).not.toBeNull();
    expect(result!.fromCache).toBe(true);
    // contentHash normalizes, so the same hash goes to Supabase
  });

  it('creates separate embeddings for different contentType on same text', async () => {
    // First call: cache miss for keyword type
    const vec = unitVector(DIMS, 3);
    mockCreate.mockResolvedValueOnce({
      data: [{ embedding: vec }],
    });

    const r1 = await embed('EMT training', 'keyword', 'kw-1');
    expect(r1!.fromCache).toBe(false);

    // Second call: same text, different contentType — still hits cache via content_hash
    mockSupabaseData = { data: { embedding: vec }, error: null };
    const r2 = await embed('EMT training', 'cluster_seed', 'cs-1');
    expect(r2!.fromCache).toBe(true);
    // The upsert ensures a separate row for (cluster_seed, cs-1, model_version)
  });

  it('returns null on simulated API failure', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API rate limit'));

    const result = await embed('EMT training', 'keyword', 'kw-1');
    expect(result).toBeNull();
  });
});

describe('embedBatch()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetOpenAI();
    mockSupabaseData = { data: [], error: null };
    mockUpsertData = { data: null, error: null };
  });

  it('with 10 inputs where 5 are cached, calls API only for 5 misses', async () => {
    const cachedVec = unitVector(DIMS, 0);
    const newVec = unitVector(DIMS, 1);

    // 5 cached hashes
    const items = Array.from({ length: 10 }, (_, i) => ({
      text: `keyword ${i}`,
      contentType: 'keyword' as const,
      contentId: `kw-${i}`,
    }));

    // Mock: first 5 items have cached embeddings
    const { contentHash } = await import('../hash.js');
    const cachedHashes = items.slice(0, 5).map((item) => contentHash(item.text));

    mockSupabaseData = {
      data: cachedHashes.map((h) => ({ content_hash: h, embedding: cachedVec })),
      error: null,
    };

    // API returns vectors for the 5 misses
    mockCreate.mockResolvedValueOnce({
      data: Array.from({ length: 5 }, () => ({ embedding: newVec })),
    });

    const results = await embedBatch(items);

    expect(results).toHaveLength(10);
    expect(mockCreate).toHaveBeenCalledOnce();
    // API was called with exactly 5 texts
    expect(mockCreate.mock.calls[0][0].input).toHaveLength(5);
    // First 5 are cache hits
    for (let i = 0; i < 5; i++) {
      expect(results[i]!.fromCache).toBe(true);
    }
    // Last 5 are fresh
    for (let i = 5; i < 10; i++) {
      expect(results[i]!.fromCache).toBe(false);
    }
  });
});

describe('findSimilar()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpcData = { data: null, error: null };
  });

  it('returns matches above threshold sorted by similarity', async () => {
    mockRpcData = {
      data: [
        { content_id: 'kw-1', similarity: 0.95, text_input: 'EMT training' },
        { content_id: 'kw-2', similarity: 0.82, text_input: 'EMT certification' },
      ],
      error: null,
    };

    const matches = await findSimilar(unitVector(DIMS, 0), 'keyword');

    expect(matches).toHaveLength(2);
    expect(matches[0].similarity).toBeGreaterThan(matches[1].similarity);
    expect(mockRpc).toHaveBeenCalledOnce();
  });

  it('passes excludeContentId to the RPC', async () => {
    mockRpcData = { data: [], error: null };

    await findSimilar(unitVector(DIMS, 0), 'keyword', {
      excludeContentId: 'kw-1',
    });

    expect(mockRpc).toHaveBeenCalledWith(
      'find_similar_embeddings',
      expect.objectContaining({ exclude_content_id: 'kw-1' }),
    );
  });

  it('filters by model_version (passes active version to RPC)', async () => {
    mockRpcData = { data: [], error: null };

    await findSimilar(unitVector(DIMS, 0), 'keyword');

    expect(mockRpc).toHaveBeenCalledWith(
      'find_similar_embeddings',
      expect.objectContaining({
        match_model_version: 'openai/text-embedding-3-small@2024-01',
      }),
    );
  });
});

describe('similarityBatch()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetOpenAI();
    mockSupabaseData = { data: [], error: null };
    mockUpsertData = { data: null, error: null };
  });

  it('produces correct NxM dimensions', async () => {
    // 3 texts A, 2 texts B
    const textsA = [0, 1, 2].map((i) => ({
      text: `a-${i}`,
      contentType: 'keyword' as const,
      contentId: `a-${i}`,
    }));
    const textsB = [0, 1].map((i) => ({
      text: `b-${i}`,
      contentType: 'keyword' as const,
      contentId: `b-${i}`,
    }));

    // First batch call (textsA): return 3 vectors
    mockCreate.mockResolvedValueOnce({
      data: [
        { embedding: unitVector(DIMS, 0) },
        { embedding: unitVector(DIMS, 1) },
        { embedding: unitVector(DIMS, 2) },
      ],
    });
    // Second batch call (textsB): return 2 vectors
    mockCreate.mockResolvedValueOnce({
      data: [
        { embedding: unitVector(DIMS, 0) },
        { embedding: unitVector(DIMS, 1) },
      ],
    });

    const matrix = await similarityBatch(textsA, textsB);

    expect(matrix).toHaveLength(3); // N rows
    expect(matrix[0]).toHaveLength(2); // M columns
    expect(matrix[1]).toHaveLength(2);
    expect(matrix[2]).toHaveLength(2);
  });

  it('produces expected similarity for known vectors', async () => {
    // A[0] = basis vector at index 0, B[0] = same → similarity ≈ 1.0
    // A[0] = basis vector at index 0, B[1] = basis vector at index 1 → similarity ≈ 0.0
    const textsA = [{ text: 'identical', contentType: 'keyword' as const, contentId: 'a-0' }];
    const textsB = [
      { text: 'identical-match', contentType: 'keyword' as const, contentId: 'b-0' },
      { text: 'orthogonal', contentType: 'keyword' as const, contentId: 'b-1' },
    ];

    mockCreate.mockResolvedValueOnce({
      data: [{ embedding: unitVector(DIMS, 0) }],
    });
    mockCreate.mockResolvedValueOnce({
      data: [
        { embedding: unitVector(DIMS, 0) }, // same direction → dot product = 1.0
        { embedding: unitVector(DIMS, 1) }, // orthogonal → dot product = 0.0
      ],
    });

    const matrix = await similarityBatch(textsA, textsB);

    expect(matrix[0][0]).toBeCloseTo(1.0, 5); // identical direction
    expect(matrix[0][1]).toBeCloseTo(0.0, 5); // orthogonal
  });
});

describe('getEmbedding()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabaseData = { data: null, error: null };
  });

  it('returns parsed vector when found', async () => {
    const vec = unitVector(DIMS, 5);
    mockSupabaseData = { data: { embedding: vec }, error: null };

    const result = await getEmbedding('keyword', 'kw-1');
    expect(result).toEqual(vec);
  });

  it('returns null when not found', async () => {
    mockSupabaseData = { data: null, error: null };

    const result = await getEmbedding('keyword', 'nonexistent');
    expect(result).toBeNull();
  });

  it('parses string-format vectors from pgvector', async () => {
    const vec = unitVector(DIMS, 3);
    mockSupabaseData = { data: { embedding: JSON.stringify(vec) }, error: null };

    const result = await getEmbedding('keyword', 'kw-1');
    expect(result).toEqual(vec);
  });
});

describe('getEmbeddingsBatch()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabaseData = { data: [], error: null };
  });

  it('returns array aligned with input order', async () => {
    const vec0 = unitVector(DIMS, 0);
    const vec2 = unitVector(DIMS, 2);
    mockSupabaseData = {
      data: [
        { content_id: 'kw-0', embedding: vec0 },
        { content_id: 'kw-2', embedding: vec2 },
      ],
      error: null,
    };

    const results = await getEmbeddingsBatch([
      { contentType: 'keyword', contentId: 'kw-0' },
      { contentType: 'keyword', contentId: 'kw-1' },  // miss
      { contentType: 'keyword', contentId: 'kw-2' },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual(vec0);
    expect(results[1]).toBeNull();
    expect(results[2]).toEqual(vec2);
  });

  it('returns empty array for empty input', async () => {
    const results = await getEmbeddingsBatch([]);
    expect(results).toEqual([]);
  });
});

describe('findSimilar() — excludeContentHash', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpcData = { data: [], error: null };
  });

  it('passes excludeContentHash to the RPC', async () => {
    await findSimilar(unitVector(DIMS, 0), 'keyword', {
      excludeContentHash: 'abc123',
    });

    expect(mockRpc).toHaveBeenCalledWith(
      'find_similar_embeddings',
      expect.objectContaining({ exclude_content_hash: 'abc123' }),
    );
  });

  it('passes null for both exclude params when not provided', async () => {
    await findSimilar(unitVector(DIMS, 0), 'keyword');

    expect(mockRpc).toHaveBeenCalledWith(
      'find_similar_embeddings',
      expect.objectContaining({
        exclude_content_id: null,
        exclude_content_hash: null,
      }),
    );
  });
});

describe('cosineSimilarity()', () => {
  it('returns 1.0 for identical normalized vectors', () => {
    const v = unitVector(DIMS, 0);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const a = unitVector(DIMS, 0);
    const b = unitVector(DIMS, 1);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 10);
  });

  it('returns ~0.707 for 45-degree vectors', () => {
    const a = unitVector(DIMS, 0);
    const b = midVector(DIMS, 0, 1);
    expect(cosineSimilarity(a, b)).toBeCloseTo(Math.SQRT1_2, 5);
  });
});
