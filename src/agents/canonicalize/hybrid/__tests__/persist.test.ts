import { describe, it, expect, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({}),
}));

import { persistHybridResults, buildUpdatePayload } from '../persist.js';
import type { PersistRow } from '../types.js';

function createMockSb() {
  const eqFn = vi.fn(() => Promise.resolve({ error: null }));
  const updateFn = vi.fn(() => ({ eq: eqFn }));
  const fromFn = vi.fn(() => ({ update: updateFn }));
  return {
    sb: { from: fromFn } as any,
    fromFn,
    updateFn,
    eqFn,
  };
}

describe('buildUpdatePayload()', () => {
  it('hybrid mode writes to primary columns', () => {
    const row: PersistRow = {
      contentId: 'kw-1',
      canonicalKey: 'emt_training',
      canonicalTopic: 'EMT Training',
      classificationMethod: 'vector_auto_assign',
      similarityScore: 0.92,
      arbitrationReason: null,
      canonicalizeMode: 'hybrid',
    };

    const payload = buildUpdatePayload(row);

    expect(payload).toHaveProperty('canonical_key', 'emt_training');
    expect(payload).toHaveProperty('canonical_topic', 'EMT Training');
    expect(payload).toHaveProperty('cluster', 'EMT Training');
    expect(payload).toHaveProperty('classification_method', 'vector_auto_assign');
    expect(payload).not.toHaveProperty('shadow_canonical_key');
    expect(payload).not.toHaveProperty('shadow_canonical_topic');
  });

  it('shadow_hybrid mode writes to shadow columns only', () => {
    const row: PersistRow = {
      contentId: 'kw-1',
      canonicalKey: 'emt_training',
      canonicalTopic: 'EMT Training',
      classificationMethod: 'prior_assignment_locked',
      similarityScore: null,
      arbitrationReason: null,
      canonicalizeMode: 'shadow_hybrid',
    };

    const payload = buildUpdatePayload(row);

    // Shadow columns populated
    expect(payload).toHaveProperty('shadow_canonical_key', 'emt_training');
    expect(payload).toHaveProperty('shadow_canonical_topic', 'EMT Training');
    expect(payload).toHaveProperty('shadow_classification_method', 'prior_assignment_locked');
    expect(payload).toHaveProperty('shadow_similarity_score', null);
    expect(payload).toHaveProperty('shadow_arbitration_reason', null);
    expect(payload).toHaveProperty('canonicalize_mode', 'shadow_hybrid');

    // Primary columns NOT touched
    expect(payload).not.toHaveProperty('canonical_key');
    expect(payload).not.toHaveProperty('canonical_topic');
    expect(payload).not.toHaveProperty('cluster');
    expect(payload).not.toHaveProperty('classification_method');
  });
});

describe('persistHybridResults()', () => {
  it('writes hybrid results to primary columns', async () => {
    const { sb, fromFn, updateFn, eqFn } = createMockSb();

    const rows: PersistRow[] = [
      {
        contentId: 'kw-1',
        canonicalKey: 'emt_training',
        canonicalTopic: 'EMT Training',
        classificationMethod: 'vector_auto_assign',
        similarityScore: 0.92,
        arbitrationReason: null,
        canonicalizeMode: 'hybrid',
      },
    ];

    const result = await persistHybridResults(sb, rows);

    expect(result.updated).toBe(1);
    expect(result.failed).toBe(0);
    expect(fromFn).toHaveBeenCalledWith('audit_keywords');
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        canonical_key: 'emt_training',
        canonical_topic: 'EMT Training',
        cluster: 'EMT Training',
        classification_method: 'vector_auto_assign',
      }),
    );
    expect(eqFn).toHaveBeenCalledWith('id', 'kw-1');
  });

  it('writes shadow results to shadow columns', async () => {
    const { sb, updateFn } = createMockSb();

    const rows: PersistRow[] = [
      {
        contentId: 'kw-1',
        canonicalKey: 'emt_training',
        canonicalTopic: 'EMT Training',
        classificationMethod: 'prior_assignment_locked',
        similarityScore: null,
        arbitrationReason: null,
        canonicalizeMode: 'shadow_hybrid',
      },
    ];

    await persistHybridResults(sb, rows);

    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        shadow_canonical_key: 'emt_training',
        shadow_canonical_topic: 'EMT Training',
        shadow_classification_method: 'prior_assignment_locked',
        canonicalize_mode: 'shadow_hybrid',
      }),
    );
    // Verify primary columns NOT in the payload
    const payload = (updateFn.mock.calls as any[][])[0][0];
    expect(payload).not.toHaveProperty('canonical_key');
    expect(payload).not.toHaveProperty('canonical_topic');
  });

  it('counts failures from Supabase errors', async () => {
    const eqFn = vi.fn(() => Promise.resolve({ error: { message: 'DB error' } }));
    const updateFn = vi.fn(() => ({ eq: eqFn }));
    const fromFn = vi.fn(() => ({ update: updateFn }));
    const sb = { from: fromFn } as any;

    const rows: PersistRow[] = [
      {
        contentId: 'kw-1',
        canonicalKey: 'test',
        canonicalTopic: 'Test',
        classificationMethod: 'vector_auto_assign',
        similarityScore: 0.90,
        arbitrationReason: null,
        canonicalizeMode: 'hybrid',
      },
    ];

    const result = await persistHybridResults(sb, rows);
    expect(result.failed).toBe(1);
    expect(result.updated).toBe(0);
  });

  it('handles empty input', async () => {
    const { sb } = createMockSb();
    const result = await persistHybridResults(sb, []);
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(0);
  });
});
