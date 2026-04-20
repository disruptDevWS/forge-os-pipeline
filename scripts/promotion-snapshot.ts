/**
 * promotion-snapshot.ts — Capture full pre-promotion data snapshot.
 * Usage: npx tsx scripts/promotion-snapshot.ts --audit-id <uuid> --output-dir <path>
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
const outputDir = getArg('output-dir');

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const sb = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

async function dump(table: string, filter: any = {}) {
  let query = (sb as any).from(table).select('*').eq('audit_id', auditId);
  const { data, error } = await query;
  if (error) {
    console.error(`Error fetching ${table}: ${error.message}`);
    return [];
  }
  const file = path.join(outputDir, `${table}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`  ${table}: ${data.length} rows → ${file}`);
  return data;
}

console.log(`Snapshotting audit ${auditId} → ${outputDir}\n`);

await dump('audit_keywords');
await dump('audit_clusters');
await dump('execution_pages');
await dump('cluster_strategy');
await dump('cluster_performance_snapshots');
await dump('agent_architecture_pages');
await dump('agent_architecture_blueprint');

console.log('\nSnapshot complete.');
