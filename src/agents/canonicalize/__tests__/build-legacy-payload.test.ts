import { describe, it, expect } from 'vitest';
import { buildLegacyUpdatePayload, type LegacyPayloadInput } from '../build-legacy-payload.js';

const BASE_INPUT: LegacyPayloadInput = {
  isBrand: false,
  intentType: 'commercial',
  isNearMe: false,
  primaryEntityType: 'Service',
  canonicalKey: 'emt_basic_course',
  canonicalTopic: 'EMT Basic Course',
};

describe('buildLegacyUpdatePayload', () => {
  describe('hybrid mode — canonical fields excluded', () => {
    it('does NOT include canonical_key, canonical_topic, or cluster', () => {
      const payload = buildLegacyUpdatePayload(BASE_INPUT, 'hybrid');

      expect(payload).not.toHaveProperty('canonical_key');
      expect(payload).not.toHaveProperty('canonical_topic');
      expect(payload).not.toHaveProperty('cluster');
    });

    it('still includes classification fields (is_brand, intent_type, etc.)', () => {
      const payload = buildLegacyUpdatePayload(BASE_INPUT, 'hybrid');

      expect(payload).toEqual({
        is_brand: false,
        intent_type: 'commercial',
        intent: 'commercial',
        is_near_me: false,
        primary_entity_type: 'Service',
      });
    });
  });

  describe('legacy mode — canonical fields included', () => {
    it('includes canonical_key, canonical_topic, and cluster', () => {
      const payload = buildLegacyUpdatePayload(BASE_INPUT, 'legacy');

      expect(payload).toHaveProperty('canonical_key', 'emt_basic_course');
      expect(payload).toHaveProperty('canonical_topic', 'EMT Basic Course');
      expect(payload).toHaveProperty('cluster', 'EMT Basic Course');
    });

    it('includes all fields', () => {
      const payload = buildLegacyUpdatePayload(BASE_INPUT, 'legacy');

      expect(payload).toEqual({
        is_brand: false,
        intent_type: 'commercial',
        intent: 'commercial',
        is_near_me: false,
        primary_entity_type: 'Service',
        canonical_key: 'emt_basic_course',
        canonical_topic: 'EMT Basic Course',
        cluster: 'EMT Basic Course',
      });
    });
  });

  describe('shadow mode — canonical fields included', () => {
    it('includes canonical_key, canonical_topic, and cluster in shadow mode', () => {
      const payload = buildLegacyUpdatePayload(BASE_INPUT, 'shadow');

      expect(payload).toHaveProperty('canonical_key', 'emt_basic_course');
      expect(payload).toHaveProperty('canonical_topic', 'EMT Basic Course');
      expect(payload).toHaveProperty('cluster', 'EMT Basic Course');
    });
  });

  describe('lock determinism with legacy contamination', () => {
    it('hybrid mode prevents legacy canonical values from reaching the DB', () => {
      // Scenario: Prior hybrid state has keywords locked to hk_* keys.
      // Legacy Sonnet runs first and produces DIFFERENT canonical values (lk_*).
      // In hybrid mode, the legacy update must NOT write these different values
      // to canonical_key/canonical_topic/cluster — otherwise a retry would
      // capture the contaminated state via priorHybridSnapshot.

      const legacyOutput: LegacyPayloadInput = {
        isBrand: false,
        intentType: 'informational',
        isNearMe: false,
        primaryEntityType: 'Service',
        canonicalKey: 'legacy_different_key',       // Sonnet's fresh assignment
        canonicalTopic: 'Legacy Different Topic',   // differs from prior hybrid
      };

      const payload = buildLegacyUpdatePayload(legacyOutput, 'hybrid');

      // The contaminated canonical values must NOT be in the payload
      expect(payload).not.toHaveProperty('canonical_key');
      expect(payload).not.toHaveProperty('canonical_topic');
      expect(payload).not.toHaveProperty('cluster');

      // But classification fields still written (these are legacy-owned, not hybrid)
      expect(payload.is_brand).toBe(false);
      expect(payload.intent_type).toBe('informational');
      expect(payload.primary_entity_type).toBe('Service');
    });

    it('legacy mode DOES write canonical values (no protection needed)', () => {
      const legacyOutput: LegacyPayloadInput = {
        isBrand: true,
        intentType: 'navigational',
        isNearMe: true,
        primaryEntityType: 'Organization',
        canonicalKey: 'legacy_key',
        canonicalTopic: 'Legacy Topic',
      };

      const payload = buildLegacyUpdatePayload(legacyOutput, 'legacy');

      expect(payload.canonical_key).toBe('legacy_key');
      expect(payload.canonical_topic).toBe('Legacy Topic');
      expect(payload.cluster).toBe('Legacy Topic');
      expect(payload.is_brand).toBe(true);
      expect(payload.is_near_me).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('uses primaryEntityType default when provided', () => {
      const input = { ...BASE_INPUT, primaryEntityType: 'Organization' };
      const payload = buildLegacyUpdatePayload(input, 'hybrid');
      expect(payload.primary_entity_type).toBe('Organization');
    });

    it('cluster mirrors canonical_topic (not canonical_key)', () => {
      const input = {
        ...BASE_INPUT,
        canonicalKey: 'snake_case_key',
        canonicalTopic: 'Human Readable Topic',
      };
      const payload = buildLegacyUpdatePayload(input, 'legacy');
      expect(payload.cluster).toBe('Human Readable Topic');
      expect(payload.canonical_key).toBe('snake_case_key');
    });
  });
});
