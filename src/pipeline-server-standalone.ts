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

const PORT = parseInt(process.env.PORT || process.env.PIPELINE_SERVER_PORT || '3847', 10);
const TRIGGER_SECRET = process.env.PIPELINE_TRIGGER_SECRET || '';
const AUDITS_BASE = path.resolve(process.cwd(), 'audits');

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

  console.log(`Scout report served: ${domain} (${latestDate})`);
  json(res, 200, { markdown, scope, date: latestDate });
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
  } else {
    json(res, 404, { error: 'Not found' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pipeline server listening on port ${PORT}`);
  console.log(`Health: http://0.0.0.0:${PORT}/health`);
});
