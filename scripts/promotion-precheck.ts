/**
 * promotion-precheck.ts — Pre-promotion checks for hybrid canonicalize.
 * Usage: npx tsx scripts/promotion-precheck.ts --audit-id <uuid>
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

const args = process.argv.slice(2);
const idx = args.indexOf('--audit-id');
const auditId = idx !== -1 ? args[idx + 1] : '';
if (!auditId) { console.error('Missing --audit-id'); process.exit(1); }

const sb = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

// 1. Check if canonicalize_mode column exists on audits
console.log('=== Pre-check 1: SMA audit record ===');
const { data: audit, error: auditErr } = await (sb as any)
  .from('audits')
  .select('id, domain, status, canonicalize_mode')
  .eq('id', auditId)
  .single();

if (auditErr) {
  console.log('Error fetching audit:', auditErr.message);
  // Try without canonicalize_mode
  const { data: auditFallback } = await (sb as any)
    .from('audits')
    .select('id, domain, status')
    .eq('id', auditId)
    .single();
  console.log('Audit (no canonicalize_mode column):', JSON.stringify(auditFallback, null, 2));
  console.log('NOTE: canonicalize_mode column may not exist on audits table');
} else {
  console.log('Audit:', JSON.stringify(audit, null, 2));
  console.log(`Current canonicalize_mode: ${audit?.canonicalize_mode ?? 'NOT SET (null)'}`);
}

// 2. Baseline metrics
console.log('\n=== Pre-check 2: SMA baseline metrics ===');

const { count: kwCount } = await (sb as any)
  .from('audit_keywords')
  .select('id', { count: 'exact', head: true })
  .eq('audit_id', auditId)
  .not('canonical_key', 'is', null);
console.log(`Keywords with canonical_key: ${kwCount}`);

const { data: distinctKeys } = await (sb as any)
  .from('audit_keywords')
  .select('canonical_key')
  .eq('audit_id', auditId)
  .not('canonical_key', 'is', null);
const uniqueKeys = new Set((distinctKeys || []).map((r: any) => r.canonical_key));
console.log(`Distinct canonical_keys: ${uniqueKeys.size}`);

const uniqueTopics = new Set((distinctKeys || []).map((r: any) => r.canonical_topic));
// Need to re-query for topics
const { data: topicData } = await (sb as any)
  .from('audit_keywords')
  .select('canonical_topic')
  .eq('audit_id', auditId)
  .not('canonical_topic', 'is', null);
const uniqueTopicsSet = new Set((topicData || []).map((r: any) => r.canonical_topic));
console.log(`Distinct canonical_topics: ${uniqueTopicsSet.size}`);

const { data: clusters } = await (sb as any)
  .from('audit_clusters')
  .select('canonical_key, status')
  .eq('audit_id', auditId);
const activeClusterCount = (clusters || []).filter((c: any) => c.status === 'active').length;
console.log(`audit_clusters: ${(clusters || []).length} total, ${activeClusterCount} active`);

const { data: execPages } = await (sb as any)
  .from('execution_pages')
  .select('status')
  .eq('audit_id', auditId);
const statusDist: Record<string, number> = {};
for (const p of execPages || []) {
  statusDist[p.status] = (statusDist[p.status] || 0) + 1;
}
console.log(`execution_pages: ${(execPages || []).length} total`);
console.log(`  Status distribution:`, JSON.stringify(statusDist));

const { data: strategies } = await (sb as any)
  .from('cluster_strategy')
  .select('canonical_key, status')
  .eq('audit_id', auditId);
const stratDist: Record<string, number> = {};
for (const s of strategies || []) {
  stratDist[s.status || 'active'] = (stratDist[s.status || 'active'] || 0) + 1;
}
console.log(`cluster_strategy: ${(strategies || []).length} total`);
console.log(`  Status distribution:`, JSON.stringify(stratDist));

const { count: perfCount } = await (sb as any)
  .from('cluster_performance_snapshots')
  .select('id', { count: 'exact', head: true })
  .eq('audit_id', auditId);
console.log(`cluster_performance_snapshots: ${perfCount}`);

// 3. Shadow columns state
console.log('\n=== Pre-check 3: Shadow columns state ===');
const { count: shadowCount } = await (sb as any)
  .from('audit_keywords')
  .select('id', { count: 'exact', head: true })
  .eq('audit_id', auditId)
  .not('shadow_canonical_key', 'is', null);
const { count: totalKwCount } = await (sb as any)
  .from('audit_keywords')
  .select('id', { count: 'exact', head: true })
  .eq('audit_id', auditId);
console.log(`Shadow columns populated: ${shadowCount} / ${totalKwCount} keywords`);

// Classification method distribution
const { data: cmData } = await (sb as any)
  .from('audit_keywords')
  .select('classification_method')
  .eq('audit_id', auditId)
  .not('classification_method', 'is', null);
const cmDist: Record<string, number> = {};
for (const row of cmData || []) {
  cmDist[row.classification_method] = (cmDist[row.classification_method] || 0) + 1;
}
console.log(`Classification method distribution:`, JSON.stringify(cmDist));

// 6. Check in-progress runs
console.log('\n=== Pre-check 6: In-progress runs ===');
const { data: recentRuns } = await (sb as any)
  .from('agent_runs')
  .select('agent_name, status, created_at')
  .eq('audit_id', auditId)
  .in('status', ['in_progress', 'pending'])
  .order('created_at', { ascending: false })
  .limit(5);
if ((recentRuns || []).length === 0) {
  console.log('No in-progress or pending runs found.');
} else {
  console.log('WARNING: In-progress/pending runs:', JSON.stringify(recentRuns, null, 2));
}

console.log('\n=== Pre-check complete ===');
