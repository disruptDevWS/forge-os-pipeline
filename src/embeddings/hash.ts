import { createHash } from 'crypto';

/**
 * Normalize text and produce a SHA-256 hash for cache dedup.
 * Normalization: trim + collapse whitespace + lowercase.
 * This ensures trivially different inputs (extra spaces, casing)
 * hit the same cache entry.
 */
export function contentHash(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(normalized).digest('hex');
}
