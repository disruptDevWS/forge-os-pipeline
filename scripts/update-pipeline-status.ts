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

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        if (!process.env[key]) process.env[key] = match[2].trim();
      }
    }
  } catch {
    // No .env file — fall through to process.env (Railway deployment)
  }
}

async function main() {
  const [domain, email, status] = process.argv.slice(2);
  if (!domain || !email || !status) {
    console.error('Usage: npx tsx scripts/update-pipeline-status.ts <domain> <email> <status>');
    process.exit(1);
  }

  loadEnv();
  const sb = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

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

  // Special: check-review-gate queries the flag and outputs pause/continue (no update)
  if (status === 'check-review-gate') {
    const { data: auditData } = await sb
      .from('audits')
      .select('review_gate_enabled')
      .eq('id', audit.id)
      .single();

    const enabled = auditData?.review_gate_enabled === true;
    console.log(enabled ? 'pause' : 'continue');
    process.exit(0);
  }

  const updateFields: Record<string, any> = { agent_pipeline_status: status };
  if (status === 'complete') {
    updateFields.status = 'completed';
  } else if (status === 'failed') {
    updateFields.status = 'failed';
  } else if (status === 'awaiting_review') {
    updateFields.status = 'awaiting_review';
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
