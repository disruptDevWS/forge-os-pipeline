/**
 * Updates agent_pipeline_status for an audit.
 *
 * Usage:
 *   npx tsx scripts/update-pipeline-status.ts <domain> <email> <status>
 *
 * Statuses: queued, research, audit, architecture, complete, failed
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

function readEnv(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), '.env');
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  const env: Record<string, string> = {};
  for (const line of lines) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) env[match[1].trim()] = match[2].trim();
  }
  return env;
}

async function main() {
  const [domain, email, status] = process.argv.slice(2);
  if (!domain || !email || !status) {
    console.error('Usage: npx tsx scripts/update-pipeline-status.ts <domain> <email> <status>');
    process.exit(1);
  }

  const env = readEnv();
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  // Resolve user
  const { data: userData } = await sb.auth.admin.listUsers();
  const user = userData?.users?.find((u: any) => u.email === email);
  if (!user) {
    console.error(`User not found: ${email}`);
    process.exit(1);
  }

  // Find latest audit for this domain
  const { data: audit } = await sb
    .from('audits')
    .select('id')
    .eq('domain', domain)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!audit) {
    console.error(`No audit found for ${domain}`);
    process.exit(1);
  }

  const updateFields: Record<string, any> = { agent_pipeline_status: status };
  if (status === 'complete') {
    updateFields.status = 'completed';
  } else if (status === 'failed') {
    updateFields.status = 'failed';
  } else {
    updateFields.status = 'running';
  }

  const { error } = await sb
    .from('audits')
    .update(updateFields)
    .eq('id', audit.id);

  if (error) {
    console.error(`Failed to update status: ${error.message}`);
    process.exit(1);
  }

  console.log(`Pipeline status → ${status} (audit ${audit.id})`);
}

main();
