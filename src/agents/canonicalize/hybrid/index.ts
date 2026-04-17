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

/**
 * Run the hybrid canonicalize pipeline.
 *
 * @param sb Supabase client
 * @param auditId The audit ID
 * @param domain The domain
 * @param mode 'hybrid' (authoritative output) or 'shadow' (comparison only)
 */
export async function runHybridCanonicalize(
  sb: SupabaseClient,
  auditId: string,
  domain: string,
  mode: 'hybrid' | 'shadow',
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

  // 2. Fetch all keywords for this audit
  const { data: kwData, error: kwErr } = await (sb as any)
    .from('audit_keywords')
    .select('id, keyword, canonical_key, canonical_topic, classification_method')
    .eq('audit_id', auditId);

  if (kwErr) throw new Error(`Failed to fetch keywords: ${kwErr.message}`);
  const keywords = (kwData ?? []) as Array<{
    id: string;
    keyword: string;
    canonical_key: string | null;
    canonical_topic: string | null;
    classification_method: string | null;
  }>;

  if (keywords.length === 0) {
    console.log('  [hybrid] No keywords found, skipping');
    return { autoAssigned: 0, arbitrated: 0, priorLocked: 0, newTopics: 0, totalVariants: 0 };
  }

  console.log(`  [hybrid] Processing ${keywords.length} keywords`);

  // 3. Build variant inputs with content hashes
  const variants: VariantInput[] = keywords.map((kw) => ({
    contentId: kw.id,
    keyword: kw.keyword,
    contentHash: contentHash(kw.keyword),
    existingCanonicalKey: kw.canonical_key,
    existingCanonicalTopic: kw.canonical_topic,
    existingClassificationMethod: kw.classification_method,
  }));

  // 4. Build existing canonical topics from current keyword assignments
  // (These are the topics from the legacy run that just completed, or prior hybrid runs)
  const topicMap = new Map<string, CanonicalTopic>();
  for (const kw of keywords) {
    if (kw.canonical_key && kw.canonical_topic) {
      const existing = topicMap.get(kw.canonical_key);
      if (existing) {
        existing.memberContentIds.push(kw.id);
      } else {
        topicMap.set(kw.canonical_key, {
          canonicalKey: kw.canonical_key,
          canonicalTopic: kw.canonical_topic,
          memberContentIds: [kw.id],
        });
      }
    }
  }
  const existingTopics = [...topicMap.values()];
  console.log(`  [hybrid] ${existingTopics.length} existing canonical topics`);

  // 5. Stage 1: Vector pre-clustering
  const decisions = await preCluster(variants, existingTopics);

  // 6. Collect cases needing arbitration
  const arbitrationCases: ArbitrationInput[] = decisions
    .filter((d) => d.decision === 'ambiguous' || d.decision === 'new_topic_candidate')
    .map((d) => ({
      contentHash: d.contentHash,
      contentIds: d.contentIds,
      keyword: d.keyword,
      decision: d.decision as 'ambiguous' | 'new_topic_candidate',
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
        classificationMethod = arbResult.classificationMethod as any;
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
