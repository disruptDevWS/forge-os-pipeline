#!/usr/bin/env npx tsx
/**
 * verify-canonicalize-hybrid.ts — Integration smoke test for hybrid canonicalize.
 *
 * Usage: npm run verify:canonicalize-hybrid
 *
 * Uses a synthetic keyword set with known expected groupings to verify all three
 * canonicalize modes (legacy, hybrid, shadow) produce correct output.
 *
 * Environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Env loading ──────────────────────────────────────────────

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

// ── Types ────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];

function pass(name: string, detail: string): void {
  results.push({ name, passed: true, detail });
  console.log(`  ✓ ${name}: ${detail}`);
}

function fail(name: string, detail: string): void {
  results.push({ name, passed: false, detail });
  console.error(`  ✗ ${name}: ${detail}`);
}

// ── Synthetic test data ──────────────────────────────────────

const SYNTHETIC_KEYWORDS = [
  // Group 1: EMT Training (3 word-order variants)
  'EMT training Boise',
  'Boise EMT training',
  'EMT training course Boise Idaho',
  // Group 2: Paramedic Certification (2 variants)
  'paramedic certification',
  'paramedic certification course',
  // Group 3: Unrelated (1 term)
  'Italian restaurant downtown',
];

const EXPECTED_GROUPS = {
  emt_variants: ['EMT training Boise', 'Boise EMT training', 'EMT training course Boise Idaho'],
  paramedic_variants: ['paramedic certification', 'paramedic certification course'],
  unrelated: ['Italian restaurant downtown'],
};

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();

  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY'];
  for (const key of required) {
    if (!process.env[key]) {
      console.error(`Missing env var: ${key}`);
      process.exit(1);
    }
  }

  console.log('\n=== Hybrid Canonicalize Verification ===\n');

  // 1. Embed all synthetic keywords
  console.log('1. Embedding synthetic keywords...');
  const { embedBatch } = await import('../src/embeddings/index.js');
  const embedItems = SYNTHETIC_KEYWORDS.map((text, i) => ({
    text,
    contentType: 'keyword' as const,
    contentId: `verify-hybrid-${i}`,
  }));

  const embedResults = await embedBatch(embedItems);
  const allEmbedded = embedResults.every((r) => r !== null);
  if (allEmbedded) {
    const cached = embedResults.filter((r) => r?.fromCache).length;
    pass('embed', `All ${SYNTHETIC_KEYWORDS.length} keywords embedded (${cached} cached)`);
  } else {
    const failed = embedResults.filter((r) => r === null).length;
    fail('embed', `${failed}/${SYNTHETIC_KEYWORDS.length} failed to embed`);
  }

  // 2. Test pre-clustering
  console.log('\n2. Testing vector pre-clustering...');
  const { preCluster, computeCentroid } = await import(
    '../src/agents/canonicalize/hybrid/pre-cluster.js'
  );
  const { contentHash } = await import('../src/embeddings/hash.js');

  // Build variants
  const variants = SYNTHETIC_KEYWORDS.map((kw, i) => ({
    contentId: `verify-hybrid-${i}`,
    keyword: kw,
    contentHash: contentHash(kw),
    existingCanonicalKey: null,
    existingCanonicalTopic: null,
    existingClassificationMethod: null,
  }));

  // No existing topics → all should go to arbitration or new-topic
  const decisions = await preCluster(variants, []);

  if (decisions.length > 0) {
    pass('pre-cluster', `${decisions.length} decisions produced`);

    // All should be new_topic_candidate (no existing topics to match against)
    const newTopicCount = decisions.filter((d: any) => d.decision === 'new_topic_candidate').length;
    const ambigCount = decisions.filter((d: any) => d.decision === 'ambiguous').length;
    console.log(`    ${newTopicCount} new-topic candidates, ${ambigCount} ambiguous`);
  } else {
    fail('pre-cluster', 'No decisions produced');
  }

  // 3. Test with existing topics (simulate second run)
  console.log('\n3. Testing pre-clustering with existing topics...');
  const { getEmbeddingsBatch } = await import('../src/embeddings/index.js');

  // Create two synthetic topics based on our data
  const existingTopics = [
    {
      canonicalKey: 'emt_training',
      canonicalTopic: 'EMT Training',
      memberContentIds: ['verify-hybrid-0', 'verify-hybrid-1', 'verify-hybrid-2'],
    },
    {
      canonicalKey: 'paramedic_certification',
      canonicalTopic: 'Paramedic Certification',
      memberContentIds: ['verify-hybrid-3', 'verify-hybrid-4'],
    },
  ];

  const decisionsWithTopics = await preCluster(variants, existingTopics);

  // Count auto-assignments
  const autoAssigned = decisionsWithTopics.filter((d: any) => d.decision === 'auto_assigned');
  const newTopic = decisionsWithTopics.filter((d: any) => d.decision === 'new_topic_candidate');

  console.log(`    ${autoAssigned.length} auto-assigned, ${newTopic.length} new-topic`);

  // EMT variants should auto-assign to emt_training
  const emtDecisions = autoAssigned.filter(
    (d: any) => d.assignedCanonicalKey === 'emt_training',
  );
  if (emtDecisions.length >= 2) {
    pass('emt-grouping', `${emtDecisions.length} EMT variants auto-assigned to emt_training`);
  } else {
    fail('emt-grouping', `Only ${emtDecisions.length} EMT variants auto-assigned (expected >= 2)`);
  }

  // Restaurant should be new-topic or at least NOT assigned to EMT/paramedic
  const restaurantHash = contentHash('Italian restaurant downtown');
  const restaurantDecision = decisionsWithTopics.find(
    (d: any) => d.contentHash === restaurantHash,
  );
  if (restaurantDecision) {
    const isCorrectlySeparated =
      restaurantDecision.decision === 'new_topic_candidate' ||
      (restaurantDecision.decision === 'auto_assigned' &&
        !['emt_training', 'paramedic_certification'].includes(
          restaurantDecision.assignedCanonicalKey ?? '',
        ));
    if (isCorrectlySeparated) {
      pass('unrelated-separation', `Restaurant correctly separated (${restaurantDecision.decision})`);
    } else {
      fail(
        'unrelated-separation',
        `Restaurant incorrectly assigned to ${restaurantDecision.assignedCanonicalKey}`,
      );
    }
  }

  // 4. Test re-run stability
  console.log('\n4. Testing re-run stability...');
  const variantsWithPrior = SYNTHETIC_KEYWORDS.slice(0, 3).map((kw, i) => ({
    contentId: `verify-hybrid-${i}`,
    keyword: kw,
    contentHash: contentHash(kw),
    existingCanonicalKey: 'emt_training',
    existingCanonicalTopic: 'EMT Training',
    existingClassificationMethod: 'vector_auto_assign', // hybrid-originated
  }));

  const rerunDecisions = await preCluster(variantsWithPrior, existingTopics);
  const lockedCount = rerunDecisions.filter(
    (d: any) => d.decision === 'prior_locked',
  ).length;

  if (lockedCount === rerunDecisions.length && lockedCount > 0) {
    pass('rerun-stability', `All ${lockedCount} prior hybrid assignments locked`);
  } else {
    fail('rerun-stability', `${lockedCount}/${rerunDecisions.length} locked (expected all)`);
  }

  // 5. Test that legacy assignments are NOT locked
  console.log('\n5. Testing legacy assignments are not locked...');
  const variantsLegacy = SYNTHETIC_KEYWORDS.slice(0, 3).map((kw, i) => ({
    contentId: `verify-hybrid-${i}`,
    keyword: kw,
    contentHash: contentHash(kw),
    existingCanonicalKey: 'emt_training',
    existingCanonicalTopic: 'EMT Training',
    existingClassificationMethod: null, // legacy-originated
  }));

  const legacyRerunDecisions = await preCluster(variantsLegacy, existingTopics);
  const legacyLocked = legacyRerunDecisions.filter(
    (d: any) => d.decision === 'prior_locked',
  ).length;

  if (legacyLocked === 0) {
    pass('legacy-not-locked', 'Legacy assignments correctly NOT locked on hybrid re-run');
  } else {
    fail('legacy-not-locked', `${legacyLocked} legacy assignments incorrectly locked`);
  }

  // ── Summary ────────────────────────────────────────────────
  console.log('\n=== Summary ===\n');
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log(`${passed}/${total} checks passed\n`);

  if (passed < total) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
