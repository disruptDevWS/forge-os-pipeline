/**
 * compare-threshold-change.ts — Pre-vs-post threshold comparison.
 *
 * Loads a pre-change JSON snapshot and queries current shadow columns from DB.
 * Produces per-client metrics focused on the 0.82-0.85 band behavior.
 *
 * Usage:
 *   npx tsx scripts/compare-threshold-change.ts \
 *     --audit-id <uuid> \
 *     --snapshot <path-to-pre-change-json>
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

// ── Args ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) {
    console.error(`Missing required argument: --${name}`);
    process.exit(1);
  }
  return args[idx + 1];
}

const auditId = getArg('audit-id');
const snapshotPath = getArg('snapshot');

// ── Supabase ─────────────────────────────────────────────────

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!supabaseUrl || !supabaseKey) {
  // Try loading from .env
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^(\w+)=(.*)$/);
      if (match) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  }
}

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ── Types ────────────────────────────────────────────────────

interface SnapshotRow {
  id: string;
  keyword: string;
  canonical_key: string | null;
  canonical_topic: string | null;
  shadow_canonical_key: string | null;
  shadow_canonical_topic: string | null;
  shadow_classification_method: string | null;
  shadow_similarity_score: number | null;
  shadow_arbitration_reason: string | null;
  classification_method: string | null;
  similarity_score: number | null;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  // 1. Load pre-change snapshot
  console.log(`Loading pre-change snapshot: ${snapshotPath}`);
  const preData: SnapshotRow[] = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  console.log(`  ${preData.length} rows in snapshot`);

  // Build lookup by keyword ID
  const preMap = new Map<string, SnapshotRow>();
  for (const row of preData) {
    preMap.set(row.id, row);
  }

  // 2. Fetch current shadow columns from DB
  console.log(`Fetching current shadow data for audit ${auditId}...`);
  const { data: postData, error } = await (sb as any)
    .from('audit_keywords')
    .select('id, keyword, canonical_key, canonical_topic, shadow_canonical_key, shadow_canonical_topic, shadow_classification_method, shadow_similarity_score, shadow_arbitration_reason, classification_method, similarity_score')
    .eq('audit_id', auditId);

  if (error) {
    console.error('Failed to fetch keywords:', error.message);
    process.exit(1);
  }

  const postRows = postData as SnapshotRow[];
  console.log(`  ${postRows.length} rows in DB`);

  const postMap = new Map<string, SnapshotRow>();
  for (const row of postRows) {
    postMap.set(row.id, row);
  }

  // 3. Compare pre-change shadow vs post-change shadow
  let totalCompared = 0;
  let sameCluster = 0;
  let differentCluster = 0;
  let preHadShadow = 0;
  let postHadShadow = 0;
  let bothHadShadow = 0;

  // Track method transitions
  const methodTransitions = new Map<string, number>();

  // Track the critical cases: previously Sonnet-arbitrated, now auto-assigned
  const sonnetToAutoAssign: Array<{
    keyword: string;
    preKey: string;
    preTopic: string;
    postKey: string;
    postTopic: string;
    postScore: number | null;
    sameCluster: boolean;
  }> = [];

  // Track all cluster movements
  const clusterMovements: Array<{
    keyword: string;
    preKey: string;
    preTopic: string;
    postKey: string;
    postTopic: string;
    preMethod: string;
    postMethod: string;
  }> = [];

  // Band analysis: similarity scores in 0.82-0.85 range
  const bandAnalysis = {
    inBand: 0,
    autoAssigned: 0,
    sameAsPreSonnet: 0,
    differentFromPreSonnet: 0,
  };

  for (const [id, pre] of preMap) {
    const post = postMap.get(id);
    if (!post) continue;

    totalCompared++;

    const preShadowKey = pre.shadow_canonical_key;
    const postShadowKey = post.shadow_canonical_key;
    const preMethod = pre.shadow_classification_method ?? 'none';
    const postMethod = post.shadow_classification_method ?? 'none';

    if (preShadowKey) preHadShadow++;
    if (postShadowKey) postHadShadow++;

    if (preShadowKey && postShadowKey) {
      bothHadShadow++;

      if (preShadowKey === postShadowKey) {
        sameCluster++;
      } else {
        differentCluster++;
        clusterMovements.push({
          keyword: pre.keyword,
          preKey: preShadowKey,
          preTopic: pre.shadow_canonical_topic ?? '',
          postKey: postShadowKey,
          postTopic: post.shadow_canonical_topic ?? '',
          preMethod,
          postMethod,
        });
      }

      // Method transition tracking
      const transition = `${preMethod} → ${postMethod}`;
      methodTransitions.set(transition, (methodTransitions.get(transition) ?? 0) + 1);

      // Critical case: Sonnet-arbitrated → auto-assigned
      if (
        (preMethod === 'sonnet_arbitration_assigned' || preMethod === 'sonnet_arbitration_new_topic' || preMethod === 'sonnet_arbitration_merged') &&
        postMethod === 'vector_auto_assign'
      ) {
        const same = preShadowKey === postShadowKey;
        sonnetToAutoAssign.push({
          keyword: pre.keyword,
          preKey: preShadowKey,
          preTopic: pre.shadow_canonical_topic ?? '',
          postKey: postShadowKey,
          postTopic: post.shadow_canonical_topic ?? '',
          postScore: post.shadow_similarity_score,
          sameCluster: same,
        });
      }

      // Band analysis: post-change similarity in 0.82-0.85 range
      const postScore = post.shadow_similarity_score;
      if (postScore !== null && postScore >= 0.82 && postScore < 0.85) {
        bandAnalysis.inBand++;
        if (postMethod === 'vector_auto_assign') {
          bandAnalysis.autoAssigned++;
          if (preShadowKey === postShadowKey) {
            bandAnalysis.sameAsPreSonnet++;
          } else {
            bandAnalysis.differentFromPreSonnet++;
          }
        }
      }
    }
  }

  // 4. Compute summary metrics
  const agreementRate = bothHadShadow > 0 ? ((sameCluster / bothHadShadow) * 100).toFixed(1) : 'N/A';
  const sonnetToAutoSame = sonnetToAutoAssign.filter((s) => s.sameCluster).length;
  const sonnetToAutoDiff = sonnetToAutoAssign.filter((s) => !s.sameCluster).length;
  const sonnetToAutoSameRate = sonnetToAutoAssign.length > 0
    ? ((sonnetToAutoSame / sonnetToAutoAssign.length) * 100).toFixed(1)
    : 'N/A';

  // Count methods pre and post
  const preMethodCounts = new Map<string, number>();
  const postMethodCounts = new Map<string, number>();
  for (const [id, pre] of preMap) {
    const post = postMap.get(id);
    if (!post) continue;
    const pm = pre.shadow_classification_method ?? 'none';
    const qm = post.shadow_classification_method ?? 'none';
    preMethodCounts.set(pm, (preMethodCounts.get(pm) ?? 0) + 1);
    postMethodCounts.set(qm, (postMethodCounts.get(qm) ?? 0) + 1);
  }

  // 5. Output report
  console.log('\n' + '='.repeat(70));
  console.log('PRE-vs-POST THRESHOLD COMPARISON');
  console.log('='.repeat(70));

  console.log(`\n## Overview`);
  console.log(`Total keywords compared: ${totalCompared}`);
  console.log(`Pre-change had shadow data: ${preHadShadow}`);
  console.log(`Post-change had shadow data: ${postHadShadow}`);
  console.log(`Both had shadow data: ${bothHadShadow}`);
  console.log(`\nSame cluster (pre vs post): ${sameCluster} (${agreementRate}%)`);
  console.log(`Different cluster: ${differentCluster}`);

  console.log(`\n## Classification Method Counts`);
  console.log(`\n### Pre-change:`);
  for (const [method, count] of [...preMethodCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = ((count / totalCompared) * 100).toFixed(1);
    console.log(`  ${method}: ${count} (${pct}%)`);
  }
  console.log(`\n### Post-change:`);
  for (const [method, count] of [...postMethodCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = ((count / totalCompared) * 100).toFixed(1);
    console.log(`  ${method}: ${count} (${pct}%)`);
  }

  console.log(`\n## Method Transitions`);
  for (const [transition, count] of [...methodTransitions.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${transition}: ${count}`);
  }

  console.log(`\n## Critical Metric: Sonnet → Auto-Assign Transitions`);
  console.log(`Total keywords that moved from Sonnet arbitration to vector auto-assign: ${sonnetToAutoAssign.length}`);
  console.log(`  Same cluster as Sonnet chose: ${sonnetToAutoSame} (${sonnetToAutoSameRate}%)`);
  console.log(`  Different cluster: ${sonnetToAutoDiff}`);

  if (sonnetToAutoDiff > 0) {
    console.log(`\n### Sonnet → Auto-Assign DISAGREEMENTS (different cluster):`);
    for (const s of sonnetToAutoAssign.filter((s) => !s.sameCluster)) {
      console.log(`  "${s.keyword}"`);
      console.log(`    Pre (Sonnet): ${s.preTopic} [${s.preKey}]`);
      console.log(`    Post (Vector): ${s.postTopic} [${s.postKey}] (score: ${s.postScore?.toFixed(4) ?? 'N/A'})`);
    }
  }

  console.log(`\n## 0.82–0.85 Band Analysis`);
  console.log(`Keywords with post-change similarity in 0.82–0.85: ${bandAnalysis.inBand}`);
  console.log(`  Auto-assigned: ${bandAnalysis.autoAssigned}`);
  console.log(`  Same cluster as pre-change Sonnet: ${bandAnalysis.sameAsPreSonnet}`);
  console.log(`  Different cluster from pre-change Sonnet: ${bandAnalysis.differentFromPreSonnet}`);

  if (clusterMovements.length > 0 && clusterMovements.length <= 50) {
    console.log(`\n## All Cluster Movements (${clusterMovements.length})`);
    for (const m of clusterMovements) {
      console.log(`  "${m.keyword}"`);
      console.log(`    Pre: ${m.preTopic} [${m.preKey}] (${m.preMethod})`);
      console.log(`    Post: ${m.postTopic} [${m.postKey}] (${m.postMethod})`);
    }
  } else if (clusterMovements.length > 50) {
    console.log(`\n## Cluster Movements (showing first 50 of ${clusterMovements.length})`);
    for (const m of clusterMovements.slice(0, 50)) {
      console.log(`  "${m.keyword}"`);
      console.log(`    Pre: ${m.preTopic} [${m.preKey}] (${m.preMethod})`);
      console.log(`    Post: ${m.postTopic} [${m.postKey}] (${m.postMethod})`);
    }
  }

  // 6. Write markdown report
  const timestamp = new Date().toISOString().split('T')[0];
  const reportDir = path.resolve(process.cwd(), 'scratch/shadow-reports');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  return {
    totalCompared,
    bothHadShadow,
    sameCluster,
    differentCluster,
    agreementRate,
    sonnetToAutoAssign: sonnetToAutoAssign.length,
    sonnetToAutoSame,
    sonnetToAutoDiff,
    sonnetToAutoSameRate,
    bandAnalysis,
    preMethodCounts: Object.fromEntries(preMethodCounts),
    postMethodCounts: Object.fromEntries(postMethodCounts),
    methodTransitions: Object.fromEntries(methodTransitions),
    clusterMovements,
    sonnetToAutoDetails: sonnetToAutoAssign,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
