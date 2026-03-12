import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read .env manually
const envPath = path.join(__dirname, '..', '.env');
const env = Object.fromEntries(
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split('=').map(s => s.trim()))
    .filter(([k, v]) => k && v)
);

const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0];

// Try multiple connection approaches
const connectionOptions = [
  {
    name: 'Pooler (transaction mode, service role as password)',
    config: {
      host: `aws-0-us-east-1.pooler.supabase.com`,
      port: 6543,
      database: 'postgres',
      user: `postgres.${projectRef}`,
      password: SERVICE_ROLE_KEY,
      ssl: { rejectUnauthorized: false },
    },
  },
  {
    name: 'Pooler (session mode, service role as password)',
    config: {
      host: `aws-0-us-east-1.pooler.supabase.com`,
      port: 5432,
      database: 'postgres',
      user: `postgres.${projectRef}`,
      password: SERVICE_ROLE_KEY,
      ssl: { rejectUnauthorized: false },
    },
  },
  {
    name: 'Direct (service role as password)',
    config: {
      host: `db.${projectRef}.supabase.co`,
      port: 5432,
      database: 'postgres',
      user: 'postgres',
      password: SERVICE_ROLE_KEY,
      ssl: { rejectUnauthorized: false },
    },
  },
];

async function tryConnect(opt) {
  const client = new pg.Client({ ...opt.config, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    const res = await client.query('SELECT 1 AS ok');
    console.log(`[OK] ${opt.name} — connected`);
    return client;
  } catch (err) {
    console.log(`[FAIL] ${opt.name} — ${err.message}`);
    try { await client.end(); } catch {}
    return null;
  }
}

async function main() {
  console.log(`Project ref: ${projectRef}`);

  let client = null;
  for (const opt of connectionOptions) {
    client = await tryConnect(opt);
    if (client) break;
  }

  if (!client) {
    console.error('\nCould not connect with any method. You may need to provide the database password.');
    console.error('Set SUPABASE_DB_PASSWORD in .env and try again.');
    process.exit(1);
  }

  // Read and execute migration SQL
  const sqlFile = process.argv[2] || 'forge-os-migration.sql';
  const sqlPath = path.resolve(__dirname, sqlFile);
  console.log(`\nMigration file: ${path.basename(sqlPath)}`);
  const sql = fs.readFileSync(sqlPath, 'utf8');

  // If SQL contains $$ blocks (PL/pgSQL), execute as single query to avoid
  // the semicolon splitter breaking inside DO/FUNCTION bodies.
  if (sql.includes('$$')) {
    console.log('Detected $$ blocks — executing as single query...\n');
    try {
      await client.query(sql);
      console.log('  ✓ Migration executed successfully');
    } catch (err) {
      if (err.message.includes('already exists') || err.message.includes('duplicate')) {
        console.log(`  ~ Migration completed (some objects already exist)`);
      } else {
        console.error(`  ✗ Migration failed: ${err.message}`);
        await client.end();
        process.exit(1);
      }
    }
    console.log('\nDone');
  } else {
    // Split into individual statements (on semicolons at end of line)
    const statements = sql
      .split(/;\s*$/m)
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('--'));

    console.log(`Executing ${statements.length} statements...\n`);

    let success = 0;
    let failed = 0;

    for (const stmt of statements) {
      const preview = stmt.split('\n').find(l => l.trim() && !l.trim().startsWith('--'))?.trim().substring(0, 80) || stmt.substring(0, 80);
      try {
        await client.query(stmt);
        console.log(`  ✓ ${preview}`);
        success++;
      } catch (err) {
        // Some errors are expected (e.g., "already exists")
        if (err.message.includes('already exists') || err.message.includes('duplicate')) {
          console.log(`  ~ ${preview} (already exists, skipping)`);
          success++;
        } else {
          console.error(`  ✗ ${preview}`);
          console.error(`    Error: ${err.message}`);
          failed++;
        }
      }
    }

    console.log(`\nDone: ${success} succeeded, ${failed} failed`);
  }
  await client.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
