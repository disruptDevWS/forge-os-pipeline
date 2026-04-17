import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the exported parse function directly — no need to mock callClaude for parsing tests
import { parseArbitrationResponse, _setCallClaude } from '../arbitrator.js';
import { arbitrate } from '../arbitrator.js';
import type { ArbitrationInput, CanonicalTopic } from '../types.js';

describe('parseArbitrationResponse()', () => {
  const cases: ArbitrationInput[] = [
    {
      contentHash: 'hash_emt_course',
      contentIds: ['kw-1'],
      keyword: 'emt course',
      decision: 'ambiguous',
      topMatches: [
        { canonicalKey: 'emt_training', canonicalTopic: 'EMT Training', similarity: 0.82 },
      ],
    },
    {
      contentHash: 'hash_restaurant',
      contentIds: ['kw-2'],
      keyword: 'restaurant reviews',
      decision: 'new_topic_candidate',
      topMatches: [],
    },
  ];

  it('parses a well-formed JSON response', () => {
    const raw = JSON.stringify({
      decisions: [
        {
          case_index: 1,
          action: 'assign_existing',
          canonical_key: 'emt_training',
          canonical_topic: 'EMT Training',
          reason: 'Close semantic match to EMT Training cluster',
        },
        {
          case_index: 2,
          action: 'create_new',
          canonical_key: 'restaurant_reviews',
          canonical_topic: 'Restaurant Reviews',
          reason: 'No existing topic matches',
        },
      ],
    });

    const decisions = parseArbitrationResponse(raw, cases);

    expect(decisions).toHaveLength(2);
    expect(decisions[0].contentHash).toBe('hash_emt_course');
    expect(decisions[0].action).toBe('assign_existing');
    expect(decisions[0].classificationMethod).toBe('sonnet_arbitration_assigned');
    expect(decisions[0].canonicalKey).toBe('emt_training');
    expect(decisions[1].action).toBe('create_new');
    expect(decisions[1].classificationMethod).toBe('sonnet_arbitration_new_topic');
  });

  it('handles code-fenced JSON', () => {
    const raw = '```json\n{"decisions": [{"case_index": 1, "action": "assign_existing", "canonical_key": "emt_training", "canonical_topic": "EMT Training", "reason": "match"}]}\n```';

    const decisions = parseArbitrationResponse(raw, cases);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].canonicalKey).toBe('emt_training');
  });

  it('handles merge_candidate action', () => {
    const raw = JSON.stringify({
      decisions: [
        {
          case_index: 1,
          action: 'merge_candidate',
          canonical_key: 'emt_education',
          canonical_topic: 'EMT Education',
          reason: 'Merge with case 2',
        },
      ],
    });

    const decisions = parseArbitrationResponse(raw, cases);
    expect(decisions[0].classificationMethod).toBe('sonnet_arbitration_merged');
  });

  it('skips decisions with invalid case_index', () => {
    const raw = JSON.stringify({
      decisions: [
        { case_index: 99, action: 'assign_existing', canonical_key: 'x', canonical_topic: 'X', reason: 'invalid' },
        { case_index: 1, action: 'assign_existing', canonical_key: 'emt_training', canonical_topic: 'EMT Training', reason: 'valid' },
      ],
    });

    const decisions = parseArbitrationResponse(raw, cases);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].canonicalKey).toBe('emt_training');
  });
});

describe('arbitrate()', () => {
  beforeEach(() => {
    _setCallClaude(null);
  });

  it('returns empty array for empty input', async () => {
    const result = await arbitrate([], [], 'plumbing', 'Boise, ID');
    expect(result).toEqual([]);
  });

  it('calls Sonnet and returns parsed decisions', async () => {
    const mockCallClaude = vi.fn().mockResolvedValueOnce(
      JSON.stringify({
        decisions: [
          {
            case_index: 1,
            action: 'assign_existing',
            canonical_key: 'emt_training',
            canonical_topic: 'EMT Training',
            reason: 'Close match',
          },
        ],
      }),
    );
    _setCallClaude(mockCallClaude);

    const cases: ArbitrationInput[] = [
      {
        contentHash: 'hash_emt',
        contentIds: ['kw-1'],
        keyword: 'emt course',
        decision: 'ambiguous',
        topMatches: [{ canonicalKey: 'emt_training', canonicalTopic: 'EMT Training', similarity: 0.82 }],
      },
    ];
    const topics: CanonicalTopic[] = [
      { canonicalKey: 'emt_training', canonicalTopic: 'EMT Training', memberContentIds: ['kw-a'] },
    ];

    const result = await arbitrate(cases, topics, 'medical training', 'Boise, ID');

    expect(result).toHaveLength(1);
    expect(result[0].canonicalKey).toBe('emt_training');
    expect(mockCallClaude).toHaveBeenCalledOnce();
    expect(mockCallClaude.mock.calls[0][1]).toEqual({
      model: 'sonnet',
      phase: 'canonicalize-arbitration',
    });
  });
});
