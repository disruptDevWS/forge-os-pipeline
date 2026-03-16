/**
 * dataforseo-onpage.ts — DataForSEO OnPage API client
 *
 * Replaces Screaming Frog CLI crawl with DataForSEO's OnPage API.
 * Provides: createOnPageTask, pollTaskReady, getPages, getSummary,
 * getMicrodata, getResources.
 *
 * Auth: Basic auth from DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD.
 * Cost tracking: appends to audits/.dataforseo_cost.log.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const DATAFORSEO_API = 'https://api.dataforseo.com/v3';
const COST_LOG = path.resolve(process.cwd(), 'audits/.dataforseo_cost.log');

// Default budget cap per crawl in USD
const DEFAULT_CRAWL_BUDGET = 0.50;

export interface OnPageCredentials {
  login: string;
  password: string;
}

export interface OnPageTaskOptions {
  maxPages?: number;          // max_crawl_pages (default: 500)
  enableJsRendering?: boolean; // default: true
  customUserAgent?: string;
  budgetCap?: number;         // USD limit per crawl (default: $0.50)
}

export interface OnPagePage {
  url: string;
  resource_type: string;
  status_code: number;
  location?: string | null;
  size: number;
  meta: {
    title?: string | null;
    description?: string | null;
    canonical?: string | null;
    follow?: boolean | null;
    htags?: Record<string, string[]> | null;
    content?: string | null;
  };
  page_timing: {
    duration_time?: number | null;
    time_to_interactive?: number | null;
    dom_complete?: number | null;
    depth?: number | null;
  };
  onpage_score: number | null;
  content?: {
    plain_text_word_count?: number | null;
    plain_text_rate?: number | null;
    automated_readability_index?: number | null;
  } | null;
  checks: Record<string, boolean>;
  internal_links_count: number;
  external_links_count: number;
  images_count?: number | null;
  total_dom_size?: number | null;
  custom_js_response?: any;
  redirect_url?: string | null;
  // OnPage pages have many more fields; we only type what we use
  [key: string]: any;
}

export interface OnPageSummary {
  crawl_progress: string;
  crawl_status: {
    max_crawl_pages: number;
    pages_in_queue: number;
    pages_crawled: number;
  };
  domain_info: {
    name: string;
    cms?: string | null;
    ip?: string | null;
    server?: string | null;
    crawl_start?: string | null;
    crawl_end?: string | null;
    checks: Record<string, boolean>;
  };
  page_metrics: {
    links_external: number;
    links_internal: number;
    duplicate_title: number;
    duplicate_description: number;
    duplicate_content: number;
    broken_links: number;
    broken_resources: number;
    pages_with_redirect: number;
    is_https: number;
    is_http: number;
    onpage_score: number;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface OnPageMicrodataItem {
  url: string;
  types: string[];
  properties: Record<string, any>;
  [key: string]: any;
}

export interface OnPageResource {
  url: string;
  resource_type: string;
  status_code: number;
  size: number;
  total_count?: number | null;
  [key: string]: any;
}

// ── Auth helper ───────────────────────────────────────────────

function makeAuthHeader(creds: OnPageCredentials): string {
  return `Basic ${Buffer.from(`${creds.login}:${creds.password}`).toString('base64')}`;
}

function getCredentials(env: Record<string, string>): OnPageCredentials {
  const login = env.DATAFORSEO_LOGIN;
  const password = env.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set');
  }
  return { login, password };
}

// ── Cost tracking ─────────────────────────────────────────────

function logCost(domain: string, operation: string, cost: number): void {
  const line = `${new Date().toISOString()} | onpage | ${domain} | ${operation} | $${cost.toFixed(4)}\n`;
  try {
    fs.mkdirSync(path.dirname(COST_LOG), { recursive: true });
    fs.appendFileSync(COST_LOG, line);
  } catch {
    // Non-fatal — don't break the pipeline for cost logging
  }
}

// ── API call helper ───────────────────────────────────────────

async function apiCall(
  endpoint: string,
  creds: OnPageCredentials,
  body?: any,
  method: 'GET' | 'POST' = 'POST',
): Promise<any> {
  const url = `${DATAFORSEO_API}${endpoint}`;
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: makeAuthHeader(creds),
      'Content-Type': 'application/json',
    },
  };
  if (body && method === 'POST') {
    opts.body = JSON.stringify(body);
  }

  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`DataForSEO OnPage ${endpoint} HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

// ── Create OnPage task ────────────────────────────────────────

export async function createOnPageTask(
  env: Record<string, string>,
  domain: string,
  options: OnPageTaskOptions = {},
): Promise<string> {
  const creds = getCredentials(env);
  const maxPages = options.maxPages ?? 500;
  const enableJs = options.enableJsRendering ?? true;

  const taskPayload = [
    {
      target: domain,
      max_crawl_pages: maxPages,
      load_resources: true,
      enable_javascript: enableJs,
      enable_browser_rendering: enableJs,
      // Store microdata for structured data analysis
      store_raw_html: false,
      enable_microformats: true,
      // Custom settings
      ...(options.customUserAgent ? { custom_user_agent: options.customUserAgent } : {}),
    },
  ];

  console.log(`  Creating OnPage crawl task for ${domain} (max ${maxPages} pages, JS=${enableJs})...`);
  const data = await apiCall('/on_page/task_post', creds, taskPayload);

  const task = data?.tasks?.[0];
  if (!task || task.status_code !== 20100) {
    throw new Error(
      `OnPage task creation failed: ${task?.status_message ?? JSON.stringify(data).slice(0, 300)}`,
    );
  }

  const taskId = task.id;
  const cost = task.cost ?? 0;
  logCost(domain, 'task_post', cost);
  console.log(`  Task created: ${taskId} (cost: $${cost.toFixed(4)})`);

  return taskId;
}

// ── Poll task ready ───────────────────────────────────────────

export async function pollTaskReady(
  env: Record<string, string>,
  taskId: string,
  maxWaitMs = 30 * 60 * 1000, // 30 minutes default
  pollIntervalMs = 15_000,     // 15 seconds
): Promise<void> {
  const creds = getCredentials(env);
  const startTime = Date.now();

  console.log(`  Polling task ${taskId} (timeout: ${(maxWaitMs / 60000).toFixed(0)}min)...`);

  while (Date.now() - startTime < maxWaitMs) {
    const data = await apiCall('/on_page/tasks_ready', creds, undefined, 'GET');
    const readyTasks = data?.tasks?.[0]?.result ?? [];
    const found = readyTasks.find((t: any) => t.id === taskId);

    if (found) {
      console.log(`  Task ${taskId} is ready (${((Date.now() - startTime) / 1000).toFixed(0)}s elapsed)`);
      return;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stdout.write(`  Waiting... (${elapsed}s elapsed)\r`);
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(`OnPage task ${taskId} did not complete within ${(maxWaitMs / 60000).toFixed(0)} minutes`);
}

// ── Get pages ─────────────────────────────────────────────────

export async function getPages(
  env: Record<string, string>,
  taskId: string,
  filters?: string[][],
  limit = 1000,
): Promise<OnPagePage[]> {
  const creds = getCredentials(env);
  const allPages: OnPagePage[] = [];
  let offset = 0;

  while (true) {
    const body: any = { id: taskId, limit, offset };
    if (filters && filters.length > 0) {
      body.filters = filters;
    }

    const data = await apiCall('/on_page/pages', creds, [body]);
    const task = data?.tasks?.[0];
    const cost = task?.cost ?? 0;
    if (cost > 0) logCost('', 'pages', cost);

    const items = task?.result?.[0]?.items ?? [];
    allPages.push(...items);

    const totalCount = task?.result?.[0]?.total_count ?? 0;
    if (allPages.length >= totalCount || items.length < limit) break;
    offset += limit;
  }

  console.log(`  Retrieved ${allPages.length} pages from OnPage API`);
  return allPages;
}

// ── Get summary ───────────────────────────────────────────────

export async function getSummary(
  env: Record<string, string>,
  taskId: string,
): Promise<OnPageSummary> {
  const creds = getCredentials(env);
  const data = await apiCall('/on_page/summary/' + taskId, creds, undefined, 'GET');
  const task = data?.tasks?.[0];
  const cost = task?.cost ?? 0;
  if (cost > 0) logCost('', 'summary', cost);

  const result = task?.result?.[0];
  if (!result) {
    throw new Error('OnPage summary returned no result');
  }

  return result as OnPageSummary;
}

// ── Get microdata (structured data) ───────────────────────────

export async function getMicrodata(
  env: Record<string, string>,
  taskId: string,
  limit = 1000,
): Promise<OnPageMicrodataItem[]> {
  const creds = getCredentials(env);
  const allItems: OnPageMicrodataItem[] = [];
  let offset = 0;

  while (true) {
    const body = [{ id: taskId, limit, offset }];
    const data = await apiCall('/on_page/microdata', creds, body);
    const task = data?.tasks?.[0];
    const cost = task?.cost ?? 0;
    if (cost > 0) logCost('', 'microdata', cost);

    const items = task?.result?.[0]?.items ?? [];
    allItems.push(...items);

    const totalCount = task?.result?.[0]?.total_count ?? 0;
    if (allItems.length >= totalCount || items.length < limit) break;
    offset += limit;
  }

  console.log(`  Retrieved ${allItems.length} microdata items`);
  return allItems;
}

// ── Get resources (images, CSS, JS) ───────────────────────────

export async function getResources(
  env: Record<string, string>,
  taskId: string,
  resourceType?: string,
  limit = 1000,
): Promise<OnPageResource[]> {
  const creds = getCredentials(env);
  const allItems: OnPageResource[] = [];
  let offset = 0;

  while (true) {
    const body: any = { id: taskId, limit, offset };
    if (resourceType) {
      body.filters = [['resource_type', '=', resourceType]];
    }

    const data = await apiCall('/on_page/resources', creds, [body]);
    const task = data?.tasks?.[0];
    const cost = task?.cost ?? 0;
    if (cost > 0) logCost('', 'resources', cost);

    const items = task?.result?.[0]?.items ?? [];
    allItems.push(...items);

    const totalCount = task?.result?.[0]?.total_count ?? 0;
    if (allItems.length >= totalCount || items.length < limit) break;
    offset += limit;
  }

  console.log(`  Retrieved ${allItems.length} resources${resourceType ? ` (type: ${resourceType})` : ''}`);
  return allItems;
}

// ── Full crawl convenience function ───────────────────────────

export interface CrawlResult {
  taskId: string;
  pages: OnPagePage[];
  summary: OnPageSummary;
  microdata: OnPageMicrodataItem[];
  imageResources: OnPageResource[];
}

export async function runFullCrawl(
  env: Record<string, string>,
  domain: string,
  options: OnPageTaskOptions = {},
): Promise<CrawlResult> {
  // Check budget
  const budgetCap = options.budgetCap ?? (parseFloat(env.ONPAGE_CRAWL_BUDGET || '') || DEFAULT_CRAWL_BUDGET);
  console.log(`  Budget cap: $${budgetCap.toFixed(2)}`);

  // Step 1: Create task
  const taskId = await createOnPageTask(env, domain, options);

  // Step 2: Poll until ready
  await pollTaskReady(env, taskId);

  // Step 3: Fetch all data in parallel
  const [pages, summary, microdata, imageResources] = await Promise.all([
    getPages(env, taskId),
    getSummary(env, taskId),
    getMicrodata(env, taskId),
    getResources(env, taskId, 'image'),
  ]);

  return { taskId, pages, summary, microdata, imageResources };
}
