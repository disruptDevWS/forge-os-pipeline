import { describe, it, expect } from 'vitest';
import { contentHash } from '../hash.js';

describe('contentHash', () => {
  it('returns consistent hash for same input', () => {
    const h1 = contentHash('EMT training Boise');
    const h2 = contentHash('EMT training Boise');
    expect(h1).toBe(h2);
  });

  it('normalizes whitespace', () => {
    const h1 = contentHash('EMT  training   Boise');
    const h2 = contentHash('EMT training Boise');
    expect(h1).toBe(h2);
  });

  it('normalizes casing', () => {
    const h1 = contentHash('EMT Training BOISE');
    const h2 = contentHash('emt training boise');
    expect(h1).toBe(h2);
  });

  it('normalizes leading/trailing whitespace', () => {
    const h1 = contentHash('  EMT training Boise  ');
    const h2 = contentHash('EMT training Boise');
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different content', () => {
    const h1 = contentHash('EMT training Boise');
    const h2 = contentHash('restaurant reviews Seattle');
    expect(h1).not.toBe(h2);
  });

  it('returns a 64-char hex string (SHA-256)', () => {
    const h = contentHash('test');
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });
});
