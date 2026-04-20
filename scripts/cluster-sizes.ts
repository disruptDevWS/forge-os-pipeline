/**
 * cluster-sizes.ts — Report cluster size distribution for an audit.
 * Usage: npx tsx scripts/cluster-sizes.ts --audit-id <uuid>
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

const { data, error } = await (sb as any)
  .from('audit_keywords')
  .select('canonical_key, canonical_topic')
  .eq('audit_id', auditId)
  .not('canonical_key', 'is', null);

if (error) { console.error(error.message); process.exit(1); }

const counts = new Map<string, { topic: string; count: number }>();
for (const row of data as any[]) {
  const existing = counts.get(row.canonical_key);
  if (existing) existing.count++;
  else counts.set(row.canonical_key, { topic: row.canonical_topic, count: 1 });
}

const sorted = [...counts.entries()].sort((a, b) => a[1].count - b[1].count);
let s1 = 0, s2 = 0, s3plus = 0;
for (const [, v] of sorted) {
  if (v.count === 1) s1++;
  else if (v.count === 2) s2++;
  else s3plus++;
}

console.log(`Cluster size distribution: 1-member: ${s1}, 2-member: ${s2}, 3+member: ${s3plus}`);
console.log(`\nClusters with <3 members:`);
for (const [key, v] of sorted) {
  if (v.count < 3) console.log(`  ${key} ("${v.topic}"): ${v.count} member(s)`);
}
