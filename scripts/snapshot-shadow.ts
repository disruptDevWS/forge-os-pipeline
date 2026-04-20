/**
 * snapshot-shadow.ts — Capture current shadow column state for comparison.
 * Usage: npx tsx scripts/snapshot-shadow.ts --audit-id <uuid> --label <name>
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
function getArg(name: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) {
    console.error(`Missing --${name}`);
    process.exit(1);
  }
  return args[idx + 1];
}

const auditId = getArg('audit-id');
const label = getArg('label');

const sb = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

const { data, error } = await (sb as any)
  .from('audit_keywords')
  .select('id, keyword, canonical_key, canonical_topic, shadow_canonical_key, shadow_canonical_topic, shadow_classification_method, shadow_similarity_score, classification_method, similarity_score')
  .eq('audit_id', auditId);

if (error) {
  console.error('Error:', error.message);
  process.exit(1);
}

const dir = 'scratch/shadow-snapshots';
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${label}.json`);
fs.writeFileSync(file, JSON.stringify(data, null, 2));
console.log(`${label}: ${data.length} rows → ${file}`);
