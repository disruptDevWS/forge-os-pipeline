import http from 'http';
import { spawn } from 'child_process';
import path from 'path';

import {
  PIPELINE_SERVER_PORT,
  PIPELINE_TRIGGER_SECRET,
} from './config.js';
import { logger } from './logger.js';

let server: http.Server | null = null;
const inFlight = new Set<string>();

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function handleTrigger(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Auth check
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!PIPELINE_TRIGGER_SECRET || token !== PIPELINE_TRIGGER_SECRET) {
    json(res, 401, { error: 'Unauthorized' });
    return;
  }

  // Read body
  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on('end', () => {
    let payload: { domain?: string; email?: string };
    try {
      payload = JSON.parse(body);
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

    if (inFlight.has(domain)) {
      json(res, 409, { error: `Pipeline already running for ${domain}` });
      return;
    }

    inFlight.add(domain);
    logger.info({ domain, email }, 'Pipeline triggered');

    const scriptPath = path.resolve(process.cwd(), 'scripts/run-pipeline.sh');
    const child = spawn(scriptPath, [domain, email], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    child.on('close', (code) => {
      inFlight.delete(domain);
      logger.info({ domain, code }, 'Pipeline finished');
    });

    child.on('error', (err) => {
      inFlight.delete(domain);
      logger.error({ domain, err }, 'Pipeline spawn error');
    });

    json(res, 202, { status: 'accepted', domain });
  });
}

export function startPipelineServer(): void {
  if (!PIPELINE_TRIGGER_SECRET) {
    logger.warn('PIPELINE_TRIGGER_SECRET not set, pipeline server disabled');
    return;
  }

  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/trigger-pipeline') {
      handleTrigger(req, res);
    } else {
      json(res, 404, { error: 'Not found' });
    }
  });

  server.listen(PIPELINE_SERVER_PORT, '0.0.0.0', () => {
    logger.info(
      { port: PIPELINE_SERVER_PORT },
      'Pipeline trigger server listening',
    );
  });
}

export function stopPipelineServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => {
      logger.info('Pipeline trigger server stopped');
      server = null;
      resolve();
    });
  });
}
