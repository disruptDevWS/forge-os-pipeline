/**
 * Builds the legacy canonicalize update payload for a single keyword.
 *
 * Lock determinism fix (Phase 2.3c, 2026-04-20):
 * In hybrid mode, canonical_key/canonical_topic/cluster are written exclusively by
 * the hybrid persist step. Legacy must NOT write them because if hybrid fails after
 * legacy writes, the DB is left with legacy's stochastic output. Any retry's
 * priorHybridSnapshot then captures this contaminated state instead of the true prior
 * hybrid values. This caused 16.5% canonical_key drift on SMA's Phase 2.3b promotion.
 * Test: __tests__/build-legacy-payload.test.ts
 */

export interface LegacyPayloadInput {
  isBrand: boolean;
  intentType: string;
  isNearMe: boolean;
  primaryEntityType: string;
  canonicalKey: string;
  canonicalTopic: string;
}

export function buildLegacyUpdatePayload(
  input: LegacyPayloadInput,
  canonicalizeMode: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    is_brand: input.isBrand,
    intent_type: input.intentType,
    intent: input.intentType, // backfill intent for dashboard display
    is_near_me: input.isNearMe,
    primary_entity_type: input.primaryEntityType,
  };
  if (canonicalizeMode !== 'hybrid') {
    payload.canonical_key = input.canonicalKey;
    payload.canonical_topic = input.canonicalTopic;
    payload.cluster = input.canonicalTopic;
  }
  return payload;
}
