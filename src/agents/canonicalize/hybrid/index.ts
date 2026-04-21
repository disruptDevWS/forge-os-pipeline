/**
 * Hybrid Canonicalize — Vector pre-clustering + Sonnet arbitration.
 *
 * Entry point matching the legacy canonicalize signature pattern.
 * Called from runCanonicalize() in pipeline-generate.ts when mode is
 * 'hybrid' or 'shadow'.
 *
 * Hybrid mode handles ONLY canonical_key and canonical_topic clustering.
 * is_brand, is_near_me, intent_type, primary_entity_type remain Sonnet-based.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { contentHash } from '../../../embeddings/hash.js';
import { preCluster } from './pre-cluster.js';
import { arbitrate } from './arbitrator.js';
import { persistHybridResults } from './persist.js';
import type {
  VariantInput,
  CanonicalTopic,
  ArbitrationInput,
  HybridResult,
  PersistRow,
} from './types.js';

/**
 * Resolve the geo scope label from audit metadata.
 * Simplified version — just for arbitration context.
 */
function resolveLocationLabel(auditRow: any): string {
  if (!auditRow) return '';
  if (auditRow.geo_mode === 'national') return 'national';
  const parts: string[] = [];
  if (auditRow.market_city) parts.push(auditRow.market_city);
  if (auditRow.market_state) parts.push(auditRow.market_state);
  return parts.join(', ');
}

/** Prior hybrid assignment snapshot, keyed by keyword id. */
export type PriorHybridSnapshot = Map<string, { canonicalKey: string; canonicalTopic: string }>;

/**
 * Run the hybrid canonicalize pipeline.
 *
 * @param sb Supabase client
 * @param auditId The audit ID
 * @param domain The domain
 * @param mode 'hybrid' (authoritative output) or 'shadow' (comparison only)
 * @param priorSnapshot Snapshot of hybrid-origin assignments taken BEFORE legacy runs.
 *   Legacy overwrites canonical_key — this snapshot preserves the hybrid values
 *   so the lock predicate locks the correct (hybrid) assignment, not legacy's overwrite.
 */
export async function runHybridCanonicalize(
  sb: SupabaseClient,
  auditId: string,
  domain: string,
  mode: 'hybrid' | 'shadow',
  priorSnapshot?: PriorHybridSnapshot,
): Promise<HybridResult> {
  const canonicalizeMode = mode === 'shadow' ? 'shadow_hybrid' : 'hybrid';

  // 1. Fetch audit metadata
  const { data: auditRow } = await sb
    .from('audits')
    .select('id, domain, service_key, geo_mode, market_geos, market_city, market_state')
    .eq('id', auditId)
    .single();

  const serviceKey = auditRow?.service_key ?? '';
  const locationCtx = resolveLocationLabel(auditRow);

  // 2. Fetch all keywords for this audit (paginated — Supabase PostgREST max-rows=1000)
  const keywords: Array<{
    id: string;
    keyword: string;
    canonical_key: string | null;
    canonical_topic: string | null;
    classification_method: string | null;
  }> = [];
  {
    const PAGE_SIZE = 1000;
    let offset = 0;
    while (true) {
      const { data: page, error: pageErr } = await (sb as any)
        .from('audit_keywords')
        .select('id, keyword, canonical_key, canonical_topic, classification_method')
        .eq('audit_id', auditId)
        .range(offset, offset + PAGE_SIZE - 1);
      if (pageErr) throw new Error(`Failed to fetch keywords: ${pageErr.message}`);
      if (!page || page.length === 0) break;
      keywords.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }

  if (keywords.length === 0) {
    console.log('  [hybrid] No keywords found, skipping');
    return { autoAssigned: 0, arbitrated: 0, priorLocked: 0, newTopics: 0, totalVariants: 0 };
  }

  console.log(`  [hybrid] Processing ${keywords.length} keywords`);

  // 3. Build variant inputs with content hashes.
  // If a prior hybrid snapshot exists, use its canonical_key/topic (not the DB's
  // current values which legacy may have overwritten). The classification_method
  // in the DB is still the hybrid-origin value (legacy doesn't touch it).
  const variants: VariantInput[] = keywords.map((kw) => {
    const prior = priorSnapshot?.get(kw.id);
    const isHybridOrigin = kw.classification_method !== null && prior;
    return {
      contentId: kw.id,
      keyword: kw.keyword,
      contentHash: contentHash(kw.keyword),
      existingCanonicalKey: isHybridOrigin ? prior.canonicalKey : kw.canonical_key,
      existingCanonicalTopic: isHybridOrigin ? prior.canonicalTopic : kw.canonical_topic,
      existingClassificationMethod: kw.classification_method,
    };
  });

  // 4. Build existing canonical topics from current keyword assignments.
  // Use snapshot values for hybrid-origin keywords so centroids reflect
  // the hybrid clustering, not legacy's overwritten assignments.
  const topicMap = new Map<string, CanonicalTopic>();
  for (const kw of keywords) {
    const prior = priorSnapshot?.get(kw.id);
    const isHybridOrigin = kw.classification_method !== null && prior;
    const ck = isHybridOrigin ? prior.canonicalKey : kw.canonical_key;
    const ct = isHybridOrigin ? prior.canonicalTopic : kw.canonical_topic;
    if (ck && ct) {
      const existing = topicMap.get(ck);
      if (existing) {
        existing.memberContentIds.push(kw.id);
      } else {
        topicMap.set(ck, {
          canonicalKey: ck,
          canonicalTopic: ct,
          memberContentIds: [kw.id],
        });
      }
    }
  }
  const existingTopics = [...topicMap.values()];
  console.log(`  [hybrid] ${existingTopics.length} existing canonical topics`);

  // 5. Stage 1: Vector pre-clustering
  const decisions = await preCluster(variants, existingTopics);

  // 6. Collect cases needing arbitration (ambiguous, new-topic, and size-gated)
  const arbitrationCases: ArbitrationInput[] = decisions
    .filter((d) => d.decision === 'ambiguous' || d.decision === 'new_topic_candidate' || d.decision === 'size_gated')
    .map((d) => ({
      contentHash: d.contentHash,
      contentIds: d.contentIds,
      keyword: d.keyword,
      decision: d.decision as 'ambiguous' | 'new_topic_candidate' | 'size_gated',
      topMatches: d.topMatches,
    }));

  // 7. Stage 2: Sonnet arbitration (only if there are unresolved cases)
  const arbitrationDecisionMap = new Map<string, { canonicalKey: string; canonicalTopic: string; classificationMethod: string; arbitrationReason: string }>();

  if (arbitrationCases.length > 0) {
    const arbDecisions = await arbitrate(arbitrationCases, existingTopics, serviceKey, locationCtx);
    for (const d of arbDecisions) {
      arbitrationDecisionMap.set(d.contentHash, {
        canonicalKey: d.canonicalKey,
        canonicalTopic: d.canonicalTopic,
        classificationMethod: d.classificationMethod,
        arbitrationReason: d.arbitrationReason,
      });
    }
  }

  // 8. Build persist rows
  const persistRows: PersistRow[] = [];
  let autoAssigned = 0;
  let arbitrated = 0;
  let priorLocked = 0;
  let newTopics = 0;

  for (const decision of decisions) {
    let canonicalKey: string;
    let canonicalTopic: string;
    let classificationMethod = decision.classificationMethod;
    let similarityScore = decision.similarityScore;
    let arbitrationReason: string | null = null;

    if (decision.decision === 'auto_assigned' || decision.decision === 'prior_locked') {
      canonicalKey = decision.assignedCanonicalKey!;
      canonicalTopic = decision.assignedCanonicalTopic!;
      if (decision.decision === 'auto_assigned') autoAssigned++;
      else priorLocked++;
    } else {
      // Arbitrated case — look up Sonnet's decision
      const arbResult = arbitrationDecisionMap.get(decision.contentHash);
      if (arbResult) {
        canonicalKey = arbResult.canonicalKey;
        canonicalTopic = arbResult.canonicalTopic;
        // Size-gated cases preserve their routing reason as the classification method
        // even though Sonnet makes the final decision. This allows audit trail analysis
        // of size gate behavior.
        classificationMethod = decision.decision === 'size_gated'
          ? 'sonnet_arbitration_size_gated'
          : arbResult.classificationMethod as any;
        arbitrationReason = arbResult.arbitrationReason;
        arbitrated++;
        if (arbResult.classificationMethod === 'sonnet_arbitration_new_topic') newTopics++;
      } else {
        // Sonnet didn't return a decision for this case — skip
        console.warn(`  [hybrid] No arbitration decision for hash ${decision.contentHash.slice(0, 8)}, skipping`);
        continue;
      }
    }

    // Expand to all content_ids sharing this hash
    for (const contentId of decision.contentIds) {
      persistRows.push({
        contentId,
        canonicalKey,
        canonicalTopic,
        classificationMethod: classificationMethod as any,
        similarityScore,
        arbitrationReason,
        canonicalizeMode,
      });
    }
  }

  // 9. Persist
  if (mode === 'hybrid') {
    // Hybrid mode: authoritative — write to primary columns
    await persistHybridResults(sb, persistRows);
  } else {
    // Shadow mode: write with canonicalize_mode='shadow_hybrid'
    // Legacy output is authoritative, hybrid is for comparison only
    await persistHybridResults(sb, persistRows);
  }

  return { autoAssigned, arbitrated, priorLocked, newTopics, totalVariants: persistRows.length };
}
