/**
 * pipeline-server-standalone.ts — Standalone pipeline server for Railway deployment.
 *
 * Runs only the pipeline HTTP server (no WhatsApp, no container runner).
 * Env vars loaded from process.env (set in Railway dashboard).
 */

import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const PORT = parseInt(process.env.PORT || process.env.PIPELINE_SERVER_PORT || '3847', 10);
const TRIGGER_SECRET = process.env.PIPELINE_TRIGGER_SECRET || '';
const AUDITS_BASE = path.resolve(process.cwd(), 'audits');

// Lightweight Supabase client for deactivation endpoint (direct DB updates, no script spawn)
let sbClient: SupabaseClient | null = null;
function getSb(): SupabaseClient | null {
  if (sbClient) return sbClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    sbClient = createClient(url, key);
  }
  return sbClient;
}

const inFlight = new Set<string>();
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
  });
}

function checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!TRIGGER_SECRET || token !== TRIGGER_SECRET) {
    json(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

async function handleTrigger(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!checkAuth(req, res)) return;

  let payload: { domain?: string; email?: string; mode?: string; prospect_config?: string; start_from?: string };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const { domain, email } = payload;
  const mode = payload.mode || 'full';
  const prospectConfig = payload.prospect_config || '';

  if (!domain || !email) {
    json(res, 400, { error: 'domain and email are required' });
    return;
  }
  if (!DOMAIN_RE.test(domain)) {
    json(res, 400, { error: 'Invalid domain format' });
    return;
  }
  if (!EMAIL_RE.test(email)) {
    json(res, 400, { error: 'Invalid email format' });
    return;
  }

  if (inFlight.has(domain)) {
    json(res, 409, { error: `Pipeline already running for ${domain}` });
    return;
  }

  inFlight.add(domain);
  console.log(`Pipeline triggered: ${domain} (${email}) [mode=${mode}]`);

  const scriptPath = path.resolve(process.cwd(), 'scripts/run-pipeline.sh');
  const args = [domain, email];
  if (mode === 'prospect' && prospectConfig) {
    args.push('--mode', 'prospect', '--prospect-config', prospectConfig);
  } else if (mode !== 'full') {
    args.push('--mode', mode);
  }

  const startFrom = payload.start_from || '';
  if (startFrom) {
    args.push('--start-from', startFrom);
    console.log(`  Resuming from Phase ${startFrom}`);
  }

  const child = spawn(scriptPath, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.unref();

  const logLines: string[] = [];
  const collect = (stream: NodeJS.ReadableStream | null, prefix: string) => {
    if (!stream) return;
    let buf = '';
    stream.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        console.log(`[${domain}] ${prefix}: ${line}`);
        logLines.push(`${prefix}: ${line}`);
      }
    });
    stream.on('end', () => {
      if (buf) {
        console.log(`[${domain}] ${prefix}: ${buf}`);
        logLines.push(`${prefix}: ${buf}`);
      }
    });
  };
  collect(child.stdout, 'OUT');
  collect(child.stderr, 'ERR');

  child.on('close', (code) => {
    inFlight.delete(domain);
    console.log(`Pipeline finished: ${domain} (exit ${code})`);
    if (code !== 0) {
      console.error(`Pipeline failed: ${domain} — last 20 lines:\n${logLines.slice(-20).join('\n')}`);
    }
  });

  child.on('error', (err) => {
    inFlight.delete(domain);
    console.error(`Pipeline spawn error: ${domain}`, err);
  });

  json(res, 202, { status: 'accepted', domain, mode });
}

async function handleScoutConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!checkAuth(req, res)) return;

  let payload: { domain?: string; config?: Record<string, unknown> };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const { domain, config } = payload;
  if (!domain || !config) {
    json(res, 400, { error: 'domain and config are required' });
    return;
  }
  if (!DOMAIN_RE.test(domain)) {
    json(res, 400, { error: 'Invalid domain format' });
    return;
  }

  const domainDir = path.join(AUDITS_BASE, domain);
  fs.mkdirSync(domainDir, { recursive: true });

  const configPath = path.join(domainDir, 'prospect-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  console.log(`Prospect config written: ${domain}`);
  json(res, 200, { status: 'written', path: path.relative(process.cwd(), configPath) });
}

async function handleScoutReport(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!checkAuth(req, res)) return;

  let payload: { domain?: string; file?: string };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const { domain, file: requestedFile } = payload;
  if (!domain) {
    json(res, 400, { error: 'domain is required' });
    return;
  }
  if (!DOMAIN_RE.test(domain)) {
    json(res, 400, { error: 'Invalid domain format' });
    return;
  }

  const scoutBase = path.join(AUDITS_BASE, domain, 'scout');
  if (!fs.existsSync(scoutBase)) {
    json(res, 404, { error: 'No scout directory found' });
    return;
  }

  const dateDirs = fs.readdirSync(scoutBase)
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e))
    .sort();
  if (dateDirs.length === 0) {
    json(res, 404, { error: 'No scout runs found' });
    return;
  }

  const latestDate = dateDirs[dateDirs.length - 1];
  const latestDir = path.join(scoutBase, latestDate);

  // If a specific file is requested, serve it directly
  if (requestedFile) {
    if (requestedFile.includes('/') || requestedFile.includes('\\') || requestedFile.startsWith('.')) {
      json(res, 400, { error: 'Invalid file name' });
      return;
    }
    const filePath = path.join(latestDir, requestedFile);
    if (!fs.existsSync(filePath)) {
      json(res, 404, { error: `File not found: ${requestedFile}` });
      return;
    }
    console.log(`Scout file served: ${domain}/${requestedFile} (${latestDate})`);
    json(res, 200, { content: fs.readFileSync(filePath, 'utf-8') });
    return;
  }

  // Default: return full scout report + scope
  const mdFiles = fs.readdirSync(latestDir).filter((f) => f.startsWith('scout-') && f.endsWith('.md'));
  let markdown = '';
  if (mdFiles.length > 0) {
    markdown = fs.readFileSync(path.join(latestDir, mdFiles[0]), 'utf-8');
  }

  let scope: Record<string, unknown> = {};
  const scopePath = path.join(latestDir, 'scope.json');
  if (fs.existsSync(scopePath)) {
    try {
      scope = JSON.parse(fs.readFileSync(scopePath, 'utf-8'));
    } catch {}
  }

  // Include narrative if it exists (avoids edge function needing a second request)
  let narrative = '';
  const narrativePath = path.join(latestDir, 'prospect-narrative.md');
  if (fs.existsSync(narrativePath)) {
    narrative = fs.readFileSync(narrativePath, 'utf-8');
  }

  console.log(`Scout report served: ${domain} (${latestDate})`);
  json(res, 200, { markdown, scope, date: latestDate, narrative });
}

async function handleTrackRankings(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!checkAuth(req, res)) return;

  let payload: { domain?: string; email?: string; force?: boolean };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const { domain, email, force } = payload;
  if (!domain || !email) {
    json(res, 400, { error: 'domain and email are required' });
    return;
  }
  if (!DOMAIN_RE.test(domain)) {
    json(res, 400, { error: 'Invalid domain format' });
    return;
  }
  if (!EMAIL_RE.test(email)) {
    json(res, 400, { error: 'Invalid email format' });
    return;
  }

  const trackKey = `track:${domain}`;
  if (inFlight.has(trackKey)) {
    json(res, 409, { error: `Tracking already running for ${domain}` });
    return;
  }

  inFlight.add(trackKey);
  console.log(`Track rankings triggered: ${domain} (${email})${force ? ' [force]' : ''}`);

  const args = ['tsx', 'scripts/track-rankings.ts', '--domain', domain, '--user-email', email];
  if (force) args.push('--force');

  const child = spawn('npx', args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
  });
  child.unref();

  const logLines: string[] = [];
  const collect = (stream: NodeJS.ReadableStream | null, prefix: string) => {
    if (!stream) return;
    let buf = '';
    stream.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        console.log(`[track:${domain}] ${prefix}: ${line}`);
        logLines.push(`${prefix}: ${line}`);
      }
    });
    stream.on('end', () => {
      if (buf) {
        console.log(`[track:${domain}] ${prefix}: ${buf}`);
        logLines.push(`${prefix}: ${buf}`);
      }
    });
  };
  collect(child.stdout, 'OUT');
  collect(child.stderr, 'ERR');

  child.on('close', (code) => {
    inFlight.delete(trackKey);
    console.log(`Track rankings finished: ${domain} (exit ${code})`);
    if (code !== 0) {
      console.error(`Track rankings failed: ${domain} — last 10 lines:\n${logLines.slice(-10).join('\n')}`);
    }
  });

  child.on('error', (err) => {
    inFlight.delete(trackKey);
    console.error(`Track rankings spawn error: ${domain}`, err);
  });

  json(res, 202, { status: 'tracking_started', domain });
}

async function handleRecanonicalize(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!checkAuth(req, res)) return;

  let payload: { domain?: string; email?: string };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const { domain, email } = payload;
  if (!domain || !email) {
    json(res, 400, { error: 'domain and email are required' });
    return;
  }
  if (!DOMAIN_RE.test(domain)) {
    json(res, 400, { error: 'Invalid domain format' });
    return;
  }
  if (!EMAIL_RE.test(email)) {
    json(res, 400, { error: 'Invalid email format' });
    return;
  }

  const recanonKey = `recanonicalize:${domain}`;
  if (inFlight.has(recanonKey)) {
    json(res, 409, { error: `Re-canonicalize already running for ${domain}` });
    return;
  }

  inFlight.add(recanonKey);
  console.log(`Re-canonicalize triggered: ${domain} (${email})`);

  const child = spawn('npx', ['tsx', 'scripts/run-canonicalize.ts', '--domain', domain, '--user-email', email], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
  });
  child.unref();

  const logLines: string[] = [];
  const collect = (stream: NodeJS.ReadableStream | null, prefix: string) => {
    if (!stream) return;
    let buf = '';
    stream.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        console.log(`[recanon:${domain}] ${prefix}: ${line}`);
        logLines.push(`${prefix}: ${line}`);
      }
    });
    stream.on('end', () => {
      if (buf) {
        console.log(`[recanon:${domain}] ${prefix}: ${buf}`);
        logLines.push(`${prefix}: ${buf}`);
      }
    });
  };
  collect(child.stdout, 'OUT');
  collect(child.stderr, 'ERR');

  child.on('close', (code) => {
    inFlight.delete(recanonKey);
    console.log(`Re-canonicalize finished: ${domain} (exit ${code})`);
    if (code !== 0) {
      console.error(`Re-canonicalize failed: ${domain} — last 10 lines:\n${logLines.slice(-10).join('\n')}`);
    }
  });

  child.on('error', (err) => {
    inFlight.delete(recanonKey);
    console.error(`Re-canonicalize spawn error: ${domain}`, err);
  });

  json(res, 202, { status: 'recanonicalize_started', domain });
}

async function handleActivateCluster(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!checkAuth(req, res)) return;

  let payload: { domain?: string; canonical_key?: string; email?: string };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const { domain, canonical_key, email } = payload;
  if (!domain || !canonical_key || !email) {
    json(res, 400, { error: 'domain, canonical_key, and email are required' });
    return;
  }
  if (!DOMAIN_RE.test(domain)) {
    json(res, 400, { error: 'Invalid domain format' });
    return;
  }
  if (!EMAIL_RE.test(email)) {
    json(res, 400, { error: 'Invalid email format' });
    return;
  }

  const activateKey = `activate:${domain}:${canonical_key}`;
  if (inFlight.has(activateKey)) {
    json(res, 409, { error: `Cluster activation already running for ${domain}/${canonical_key}` });
    return;
  }

  inFlight.add(activateKey);
  console.log(`Cluster activation triggered: ${domain} / ${canonical_key} (${email})`);

  const child = spawn('npx', ['tsx', 'scripts/generate-cluster-strategy.ts', '--domain', domain, '--canonical-key', canonical_key, '--user-email', email], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
  });
  child.unref();

  const logLines: string[] = [];
  const collect = (stream: NodeJS.ReadableStream | null, prefix: string) => {
    if (!stream) return;
    let buf = '';
    stream.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        console.log(`[activate:${domain}:${canonical_key}] ${prefix}: ${line}`);
        logLines.push(`${prefix}: ${line}`);
      }
    });
    stream.on('end', () => {
      if (buf) {
        console.log(`[activate:${domain}:${canonical_key}] ${prefix}: ${buf}`);
        logLines.push(`${prefix}: ${buf}`);
      }
    });
  };
  collect(child.stdout, 'OUT');
  collect(child.stderr, 'ERR');

  child.on('close', (code) => {
    inFlight.delete(activateKey);
    console.log(`Cluster activation finished: ${domain}/${canonical_key} (exit ${code})`);
    if (code !== 0) {
      console.error(`Cluster activation failed: ${domain}/${canonical_key} — last 10 lines:\n${logLines.slice(-10).join('\n')}`);
    }
  });

  child.on('error', (err) => {
    inFlight.delete(activateKey);
    console.error(`Cluster activation spawn error: ${domain}/${canonical_key}`, err);
  });

  json(res, 202, { status: 'activation_started', domain, canonical_key });
}

async function handleDeactivateCluster(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!checkAuth(req, res)) return;

  let payload: { domain?: string; canonical_key?: string; email?: string };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const { domain, canonical_key, email } = payload;
  if (!domain || !canonical_key || !email) {
    json(res, 400, { error: 'domain, canonical_key, and email are required' });
    return;
  }
  if (!DOMAIN_RE.test(domain)) {
    json(res, 400, { error: 'Invalid domain format' });
    return;
  }
  if (!EMAIL_RE.test(email)) {
    json(res, 400, { error: 'Invalid email format' });
    return;
  }

  const sb = getSb();
  if (!sb) {
    json(res, 500, { error: 'Supabase not configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)' });
    return;
  }

  // Resolve audit
  const { data: userData } = await sb.auth.admin.listUsers();
  const user = userData?.users?.find((u: any) => u.email === email);
  if (!user) {
    json(res, 404, { error: `User not found: ${email}` });
    return;
  }

  const { data: audit } = await sb
    .from('audits')
    .select('id')
    .eq('domain', domain)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!audit) {
    json(res, 404, { error: `No audit found for ${domain} / ${email}` });
    return;
  }

  const auditId = (audit as any).id;

  // Deactivate cluster
  const { error: clusterErr } = await sb
    .from('audit_clusters')
    .update({ status: 'inactive', activated_at: null, activated_by: null })
    .eq('audit_id', auditId)
    .eq('canonical_key', canonical_key);

  if (clusterErr) {
    json(res, 500, { error: `Cluster update failed: ${clusterErr.message}` });
    return;
  }

  // Unflag execution_pages
  const { error: pageErr } = await sb
    .from('execution_pages')
    .update({ cluster_active: false })
    .eq('audit_id', auditId)
    .eq('canonical_key', canonical_key);

  if (pageErr) {
    console.warn(`Deactivate: execution_pages update failed: ${pageErr.message}`);
  }

  console.log(`Cluster deactivated: ${domain} / ${canonical_key}`);
  json(res, 200, { status: 'deactivated', domain, canonical_key });
}

async function handleStrategyBrief(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!checkAuth(req, res)) return;

  let payload: { domain?: string };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const { domain } = payload;
  if (!domain) {
    json(res, 400, { error: 'domain is required' });
    return;
  }
  if (!DOMAIN_RE.test(domain)) {
    json(res, 400, { error: 'Invalid domain format' });
    return;
  }

  const researchBase = path.join(AUDITS_BASE, domain, 'research');
  if (!fs.existsSync(researchBase)) {
    json(res, 404, { error: 'No research directory found' });
    return;
  }

  const dateDirs = fs.readdirSync(researchBase)
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e))
    .sort();
  if (dateDirs.length === 0) {
    json(res, 404, { error: 'No research runs found' });
    return;
  }

  // Scan from latest date backward to find strategy_brief.md
  for (let i = dateDirs.length - 1; i >= 0; i--) {
    const briefPath = path.join(researchBase, dateDirs[i], 'strategy_brief.md');
    if (fs.existsSync(briefPath)) {
      const content = fs.readFileSync(briefPath, 'utf-8');
      console.log(`Strategy brief served: ${domain} (${dateDirs[i]})`);
      json(res, 200, { content, date: dateDirs[i] });
      return;
    }
  }

  json(res, 404, { error: 'Strategy brief not found' });
}

async function handleArtifact(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!checkAuth(req, res)) return;

  let payload: { domain?: string; file?: string };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const { domain, file: filename } = payload;
  if (!domain || !filename) {
    json(res, 400, { error: 'domain and file are required' });
    return;
  }
  if (!DOMAIN_RE.test(domain)) {
    json(res, 400, { error: 'Invalid domain format' });
    return;
  }

  // Prevent path traversal
  if (filename.includes('..') || filename.startsWith('/')) {
    json(res, 400, { error: 'Invalid file path' });
    return;
  }

  const domainDir = path.join(AUDITS_BASE, domain);
  if (!fs.existsSync(domainDir)) {
    json(res, 404, { error: 'Domain directory not found' });
    return;
  }

  // If filename is '*', list all .md files
  if (filename === '*') {
    const files: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else if (entry.name.endsWith('.md') || entry.name.endsWith('.json') || entry.name.endsWith('.csv')) {
          files.push(rel);
        }
      }
    };
    walk(domainDir, '');
    json(res, 200, { domain, files });
    return;
  }

  const filePath = path.join(domainDir, filename);
  if (!filePath.startsWith(domainDir)) {
    json(res, 400, { error: 'Invalid file path' });
    return;
  }
  if (!fs.existsSync(filePath)) {
    json(res, 404, { error: `File not found: ${filename}` });
    return;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  json(res, 200, { domain, file: filename, content });
}

async function handleExportAudit(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!checkAuth(req, res)) return;

  let payload: { domain?: string };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const { domain } = payload;
  if (!domain) {
    json(res, 400, { error: 'domain is required' });
    return;
  }
  if (!DOMAIN_RE.test(domain)) {
    json(res, 400, { error: 'Invalid domain format' });
    return;
  }

  const domainDir = path.join(AUDITS_BASE, domain);
  if (!fs.existsSync(domainDir)) {
    json(res, 404, { error: 'Domain directory not found' });
    return;
  }

  // Walk directory recursively, collect all files
  const files: { abs: string; rel: string }[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else files.push({ abs: path.join(dir, entry.name), rel });
    }
  };
  walk(domainDir, '');

  if (files.length === 0) {
    json(res, 404, { error: 'No artifacts found' });
    return;
  }

  console.log(`Export audit: ${domain} — ${files.length} files`);

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${domain}-audit-export.zip"`,
  });

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);

  for (const file of files) {
    archive.file(file.abs, { name: file.rel });
  }

  archive.finalize();
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, {
      status: 'ok',
      uptime: process.uptime(),
      inFlight: [...inFlight],
      envCheck: {
        ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
        ANTHROPIC_KEY: !!process.env.ANTHROPIC_KEY,
        DATAFORSEO_LOGIN: !!process.env.DATAFORSEO_LOGIN,
        SUPABASE_URL: !!process.env.SUPABASE_URL,
        PIPELINE_TRIGGER_SECRET: !!process.env.PIPELINE_TRIGGER_SECRET,
      },
    });
  } else if (req.method === 'POST' && req.url === '/trigger-pipeline') {
    handleTrigger(req, res);
  } else if (req.method === 'POST' && req.url === '/scout-config') {
    handleScoutConfig(req, res);
  } else if (req.method === 'POST' && req.url === '/scout-report') {
    handleScoutReport(req, res);
  } else if (req.method === 'POST' && req.url === '/artifact') {
    handleArtifact(req, res);
  } else if (req.method === 'POST' && req.url === '/track-rankings') {
    handleTrackRankings(req, res);
  } else if (req.method === 'POST' && req.url === '/recanonicalize') {
    handleRecanonicalize(req, res);
  } else if (req.method === 'POST' && req.url === '/activate-cluster') {
    handleActivateCluster(req, res);
  } else if (req.method === 'POST' && req.url === '/deactivate-cluster') {
    handleDeactivateCluster(req, res);
  } else if (req.method === 'POST' && req.url === '/strategy-brief') {
    handleStrategyBrief(req, res);
  } else if (req.method === 'POST' && req.url === '/export-audit') {
    handleExportAudit(req, res);
  } else {
    json(res, 404, { error: 'Not found' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pipeline server listening on port ${PORT}`);
  console.log(`Health: http://0.0.0.0:${PORT}/health`);
});
