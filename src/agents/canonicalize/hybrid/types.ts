/**
 * Types for the hybrid canonicalize module.
 *
 * Hybrid mode handles ONLY canonical_key and canonical_topic clustering.
 * is_brand, is_near_me, intent_type, primary_entity_type remain Sonnet-based
 * and are unchanged in both legacy and hybrid modes.
 */

export type ClassificationMethod =
  | 'vector_auto_assign'
  | 'sonnet_arbitration_assigned'
  | 'sonnet_arbitration_new_topic'
  | 'sonnet_arbitration_merged'
  | 'prior_assignment_locked';

export interface VariantInput {
  contentId: string; // audit_keywords.id
  keyword: string;
  contentHash: string;
  existingCanonicalKey: string | null;
  existingCanonicalTopic: string | null;
  existingClassificationMethod: string | null; // for re-run lock predicate
}

export interface CanonicalTopic {
  canonicalKey: string;
  canonicalTopic: string;
  /** Content IDs of variants currently assigned to this topic */
  memberContentIds: string[];
}

export interface PreClusterDecision {
  contentHash: string;
  contentIds: string[]; // all content_ids sharing this hash
  keyword: string;
  decision: 'auto_assigned' | 'ambiguous' | 'new_topic_candidate' | 'prior_locked';
  classificationMethod: ClassificationMethod;
  assignedCanonicalKey: string | null;
  assignedCanonicalTopic: string | null;
  similarityScore: number | null;
  /** Top matches for context in arbitration */
  topMatches: Array<{ canonicalKey: string; canonicalTopic: string; similarity: number }>;
}

export interface ArbitrationInput {
  contentHash: string;
  contentIds: string[];
  keyword: string;
  decision: 'ambiguous' | 'new_topic_candidate';
  topMatches: Array<{ canonicalKey: string; canonicalTopic: string; similarity: number }>;
}

export interface ArbitrationDecision {
  contentHash: string;
  action: 'assign_existing' | 'create_new' | 'merge_candidate';
  canonicalKey: string;
  canonicalTopic: string;
  classificationMethod: ClassificationMethod;
  arbitrationReason: string;
}

export interface HybridResult {
  autoAssigned: number;
  arbitrated: number;
  priorLocked: number;
  newTopics: number;
  totalVariants: number;
}

export interface PersistRow {
  contentId: string;
  canonicalKey: string;
  canonicalTopic: string;
  classificationMethod: ClassificationMethod;
  similarityScore: number | null;
  arbitrationReason: string | null;
  canonicalizeMode: string;
}
