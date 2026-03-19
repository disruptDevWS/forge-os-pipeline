/**
 * client-context.ts — Shared client context utilities.
 *
 * Extracted from pipeline-generate.ts so generate-cluster-strategy.ts
 * and other scripts can load prospect-config.json client_context.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';

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
 * Map dashboard JSONB (audits.client_context) field names to ClientContext interface.
 */
function mapDashboardContext(raw: Record<string, any>): ClientContext {
  const ctx: ClientContext = {};
  if (raw.business_model) ctx.business_model = raw.business_model;
  if (raw.target_audience) ctx.target_audience = raw.target_audience;
  if (raw.core_services) {
    ctx.services = raw.core_services.split(',').map((s: string) => s.trim()).filter(Boolean);
  }
  if (raw.out_of_scope) {
    ctx.out_of_scope = raw.out_of_scope.split(',').map((s: string) => s.trim()).filter(Boolean);
  }
  if (raw.differentiators) ctx.competitive_advantage = raw.differentiators;
  return ctx;
}

/**
 * Dashboard-only fields that don't map to ClientContext but are useful for
 * strategic framing (Phase 1b). Returned separately by loadClientContextAsync.
 */
export interface DashboardExtras {
  service_area?: string;
  notes?: string;
}

/**
 * Load client context with async DB fallback.
 * Tries disk first (prospect-config.json), falls back to audits.client_context JSONB.
 * Returns { context, extras } where extras contains dashboard-only fields.
 */
export async function loadClientContextAsync(
  domain: string,
  sb: SupabaseClient,
  auditId: string,
): Promise<{ context: ClientContext | null; extras: DashboardExtras }> {
  // 1. Try disk first (Scout path)
  const diskCtx = loadClientContext(domain);
  if (diskCtx) {
    return { context: diskCtx, extras: {} };
  }

  // 2. Fall back to Supabase audits.client_context
  try {
    const { data } = await sb
      .from('audits')
      .select('client_context')
      .eq('id', auditId)
      .maybeSingle();

    const raw = data?.client_context;
    if (!raw || typeof raw !== 'object') {
      return { context: null, extras: {} };
    }

    // Check if any meaningful field is populated
    const hasContent = Object.values(raw).some(
      (v) => typeof v === 'string' && v.trim().length > 0,
    );
    if (!hasContent) {
      return { context: null, extras: {} };
    }

    const context = mapDashboardContext(raw as Record<string, any>);
    const extras: DashboardExtras = {};
    if ((raw as any).service_area) extras.service_area = (raw as any).service_area;
    if ((raw as any).notes) extras.notes = (raw as any).notes;

    return { context, extras };
  } catch {
    return { context: null, extras: {} };
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
