/**
 * persist.ts — Write hybrid canonicalize results to audit_keywords.
 *
 * Two write paths:
 * - hybrid mode: writes to canonical_key, canonical_topic, cluster + classification metadata
 * - shadow mode: writes to shadow_* columns ONLY — legacy output is untouched
 *
 * Does NOT touch is_brand, is_near_me, intent_type, primary_entity_type in either mode.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PersistRow } from './types.js';

const BATCH_SIZE = 50;

/**
 * Build the update payload based on canonicalize mode.
 * Shadow mode writes to shadow_* columns; hybrid writes to primary columns.
 */
function buildUpdatePayload(row: PersistRow): Record<string, unknown> {
  if (row.canonicalizeMode === 'shadow_hybrid') {
    // Shadow: write to shadow columns only, never touch legacy output
    return {
      shadow_canonical_key: row.canonicalKey,
      shadow_canonical_topic: row.canonicalTopic,
      shadow_classification_method: row.classificationMethod,
      shadow_similarity_score: row.similarityScore,
      shadow_arbitration_reason: row.arbitrationReason,
      canonicalize_mode: row.canonicalizeMode,
    };
  }

  // Hybrid: write to primary columns (authoritative)
  return {
    canonical_key: row.canonicalKey,
    canonical_topic: row.canonicalTopic,
    cluster: row.canonicalTopic,
    classification_method: row.classificationMethod,
    similarity_score: row.similarityScore,
    arbitration_reason: row.arbitrationReason,
    canonicalize_mode: row.canonicalizeMode,
  };
}

/**
 * Persist hybrid canonicalize results to audit_keywords.
 */
export async function persistHybridResults(
  sb: SupabaseClient,
  rows: PersistRow[],
): Promise<{ updated: number; failed: number }> {
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const promises = chunk.map((row) =>
      (sb as any)
        .from('audit_keywords')
        .update(buildUpdatePayload(row))
        .eq('id', row.contentId),
    );

    const results = await Promise.all(promises);
    for (const r of results) {
      if (r.error) {
        console.warn(`  [hybrid/persist] Update failed: ${r.error.message}`);
        failed++;
      } else {
        updated++;
      }
    }
  }

  const target = rows[0]?.canonicalizeMode === 'shadow_hybrid' ? 'shadow columns' : 'primary columns';
  console.log(`  [hybrid/persist] Updated ${updated}/${rows.length} keywords → ${target} (${failed} failures)`);
  return { updated, failed };
}

// Export for testing
export { buildUpdatePayload };
