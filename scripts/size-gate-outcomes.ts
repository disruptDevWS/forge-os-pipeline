/**
 * size-gate-outcomes.ts — Analyze what Sonnet decided for size-gated cases.
 * Compares pre-gate vector assignment vs post-gate Sonnet decision.
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const auditId = '08409ae8-28ab-4a34-b92c-2c92f73e5af7';
const preGatePath = 'scratch/shadow-snapshots/ima-pre-size-gate-2026-04-20.json';

const sb = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

// Load pre-gate snapshot
const preData = JSON.parse(fs.readFileSync(preGatePath, 'utf8')) as any[];
const preMap = new Map<string, any>();
for (const row of preData) preMap.set(row.id, row);

// Fetch current (post-gate) shadow data
const { data: postData } = await (sb as any)
  .from('audit_keywords')
  .select('id, keyword, shadow_canonical_key, shadow_canonical_topic, shadow_classification_method, shadow_similarity_score')
  .eq('audit_id', auditId)
  .eq('shadow_classification_method', 'sonnet_arbitration_size_gated');

const sizeGated = postData as any[];
console.log(`Size-gated keywords: ${sizeGated.length}\n`);

let sameCluster = 0;
let differentCluster = 0;
let preWasAutoAssign = 0;
let preWasSonnet = 0;

const outcomes: Array<{
  keyword: string;
  preMethod: string;
  preCluster: string;
  postCluster: string;
  same: boolean;
}> = [];

for (const post of sizeGated) {
  const pre = preMap.get(post.id);
  if (!pre) continue;

  const preMethod = pre.shadow_classification_method || 'none';
  const preKey = pre.shadow_canonical_key;
  const postKey = post.shadow_canonical_key;
  const same = preKey === postKey;

  if (same) sameCluster++;
  else differentCluster++;

  if (preMethod === 'vector_auto_assign') preWasAutoAssign++;
  else preWasSonnet++;

  outcomes.push({
    keyword: post.keyword,
    preMethod,
    preCluster: pre.shadow_canonical_topic || '(none)',
    postCluster: post.shadow_canonical_topic || '(none)',
    same,
  });
}

console.log('## Size-gate outcome distribution\n');
console.log(`Total size-gated: ${sizeGated.length}`);
console.log(`  Previously vector_auto_assign: ${preWasAutoAssign}`);
console.log(`  Previously Sonnet-arbitrated: ${preWasSonnet}`);
console.log(`\nOf all size-gated keywords:`);
console.log(`  Sonnet chose SAME cluster as pre-gate: ${sameCluster} (${((sameCluster / sizeGated.length) * 100).toFixed(1)}%)`);
console.log(`  Sonnet chose DIFFERENT cluster: ${differentCluster} (${((differentCluster / sizeGated.length) * 100).toFixed(1)}%)`);

// Break down the previously-auto-assigned subset
const prevAutoAssign = outcomes.filter(o => o.preMethod === 'vector_auto_assign');
const prevAutoSame = prevAutoAssign.filter(o => o.same).length;
const prevAutoDiff = prevAutoAssign.filter(o => !o.same).length;
console.log(`\nPreviously vector_auto_assign (${prevAutoAssign.length}):`);
console.log(`  Sonnet confirmed same cluster: ${prevAutoSame}`);
console.log(`  Sonnet chose different cluster: ${prevAutoDiff}`);

console.log(`\n## Detailed outcomes:\n`);
for (const o of outcomes) {
  const marker = o.same ? '✓' : '✗';
  console.log(`  ${marker} "${o.keyword}"`);
  console.log(`    Pre: ${o.preCluster} (${o.preMethod})`);
  console.log(`    Post: ${o.postCluster} (sonnet_arbitration_size_gated)`);
}
