/**
 * client-context.ts — Shared client context utilities.
 *
 * Extracted from pipeline-generate.ts so generate-cluster-strategy.ts
 * and other scripts can load prospect-config.json client_context.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const AUDITS_BASE = path.resolve(process.cwd(), 'audits');

export interface ClientContext {
  business_model?: string;
  services?: string[];
  pricing_tier?: 'low' | 'mid' | 'high';
  price_range?: string;
  out_of_scope?: string[];
  competitive_advantage?: string;
  target_audience?: string;
}

/**
 * Load client_context from prospect-config.json for the domain.
 * Returns null if absent (sales mode or no config).
 */
export function loadClientContext(domain: string): ClientContext | null {
  const configPath = path.join(AUDITS_BASE, domain, 'prospect-config.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config.client_context ?? null;
  } catch {
    return null;
  }
}

/**
 * Build a prompt section from ClientContext for injection into agent prompts.
 */
export function buildClientContextPrompt(ctx: ClientContext, phase: 'keyword-research' | 'jim' | 'gap' | 'michael' | 'cluster-strategy'): string {
  const lines: string[] = [];
  lines.push('## Client Business Context');

  if (ctx.business_model) lines.push(`Business model: ${ctx.business_model}`);
  if (ctx.target_audience) lines.push(`Target audience: ${ctx.target_audience}`);
  if (ctx.services?.length) lines.push(`Core services: ${ctx.services.join(', ')}`);
  if (ctx.competitive_advantage) lines.push(`Competitive advantage: ${ctx.competitive_advantage}`);

  if (phase === 'michael' || phase === 'cluster-strategy') {
    if (ctx.pricing_tier) lines.push(`Pricing tier: ${ctx.pricing_tier}`);
    if (ctx.price_range) lines.push(`Price range: ${ctx.price_range}`);
  }

  if (ctx.out_of_scope?.length) {
    lines.push('');
    lines.push('OUT OF SCOPE — do not recommend content or pages for these topics/models:');
    for (const item of ctx.out_of_scope) {
      lines.push(`- ${item}`);
    }
    lines.push('Filter these from your analysis using judgment, not just keyword matching.');
  }

  return lines.join('\n');
}
