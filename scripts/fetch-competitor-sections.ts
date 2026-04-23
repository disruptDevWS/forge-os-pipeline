#!/usr/bin/env npx tsx
/**
 * fetch-competitor-sections.ts — Phase 4b: Competitor Section Extraction
 *
 * Fetches competitor + client page HTML via DataForSEO /on_page/instant_pages,
 * extracts H2/H3 headings, computes frequency-weighted semantic coverage scores,
 * and writes results to competitor_sections + cluster_section_coverage tables.
 *
 * Runs between Phase 4 (Competitors) and Phase 5 (Gap) in the pipeline.
 *
 * Usage:
 *   npx tsx scripts/fetch-competitor-sections.ts --domain <domain> --user-email <email>
 *
 * Environment:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD,
 *   OPENAI_API_KEY (for embeddings)
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  computeSectionCoverage,
  type HeadingSection,
  type SectionCoverageResult,
} from '../src/agents/gap/section-coverage.js';

// ── CLI parsing ──

function parseArgs(): { domain: string; userEmail: string } {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    }
  }
  if (!flags.domain || !flags['user-email']) {
    console.error('Usage: npx tsx scripts/fetch-competitor-sections.ts --domain <domain> --user-email <email>');
    process.exit(1);
  }
  return { domain: flags.domain, userEmail: flags['user-email'] };
}

// ── Environment ──

function loadEnv(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    const vars: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      vars[key] = val;
    }
    // Merge with process.env (process.env takes precedence for Railway)
    return { ...vars, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v != null) as [string, string][]) };
  }
  return Object.fromEntries(Object.entries(process.env).filter(([, v]) => v != null)) as Record<string, string>;
}

// ── DataForSEO instant_pages ──

const DATAFORSEO_API = 'https://api.dataforseo.com/v3';

interface HtagsResult {
  url: string;
  htags: Record<string, string[]> | null;
}

/**
 * Fetch a single page via DataForSEO /on_page/instant_pages.
 * Returns structured htags (H1-H6 arrays).
 */
async function fetchInstantPage(
  url: string,
  login: string,
  password: string,
): Promise<HtagsResult | null> {
  const authHeader = 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');

  try {
    const resp = await fetch(`${DATAFORSEO_API}/on_page/instant_pages`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{
        url,
        load_resources: false,
        enable_javascript: false,
        enable_browser_rendering: false,
      }]),
    });

    if (!resp.ok) {
      console.log(`    DataForSEO HTTP ${resp.status} for ${url}`);
      return null;
    }

    const data = await resp.json();
    const items = data?.tasks?.[0]?.result?.[0]?.items;
    if (!items || items.length === 0) {
      return null;
    }

    return {
      url,
      htags: items[0]?.meta?.htags ?? null,
    };
  } catch (err: any) {
    console.log(`    DataForSEO fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Extract H2/H3 headings from htags response.
 */
function extractHeadings(
  htags: Record<string, string[]>,
  domain: string,
  isClient: boolean,
): Array<{ domain: string; heading_level: 'h2' | 'h3'; heading_text: string; heading_position: number; is_client: boolean }> {
  const headings: Array<{ domain: string; heading_level: 'h2' | 'h3'; heading_text: string; heading_position: number; is_client: boolean }> = [];
  let position = 0;

  for (const level of ['h2', 'h3'] as const) {
    const items = htags[level] ?? [];
    for (const text of items) {
      const cleaned = text.trim();
      if (!cleaned || cleaned.length < 3 || cleaned.length > 200) continue;
      headings.push({
        domain,
        heading_level: level,
        heading_text: cleaned,
        heading_position: position++,
        is_client: isClient,
      });
    }
  }

  return headings;
}

// ── Main ──

async function main() {
  const { domain, userEmail } = parseArgs();
  const env = loadEnv();

  // Propagate env for embeddings service
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || env.SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY;

  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const dfseLogin = env.DATAFORSEO_LOGIN;
  const dfsePassword = env.DATAFORSEO_PASSWORD;

  if (!supabaseUrl || !supabaseKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  if (!dfseLogin || !dfsePassword) throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set');

  const sb = createClient(supabaseUrl, supabaseKey);

  // 1. Find the audit
  const { data: audit } = await sb
    .from('audits')
    .select('id, domain')
    .eq('domain', domain)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!audit) {
    console.error(`No audit found for domain ${domain}`);
    process.exit(1);
  }

  const auditId = audit.id;
  console.log(`\n=== Phase 4b: Competitor Section Extraction ===`);
  console.log(`  Audit: ${auditId} (${domain})`);

  // 2. Re-run safety: delete existing sections for this audit
  const { error: delSectionsErr } = await sb
    .from('competitor_sections')
    .delete()
    .eq('audit_id', auditId);
  if (delSectionsErr) console.log(`  Warning: Failed to clear competitor_sections: ${delSectionsErr.message}`);

  const { error: delCoverageErr } = await sb
    .from('cluster_section_coverage')
    .delete()
    .eq('audit_id', auditId);
  if (delCoverageErr) console.log(`  Warning: Failed to clear cluster_section_coverage: ${delCoverageErr.message}`);

  // 3. Load competitor URLs from audit_topic_competitors
  const { data: competitors } = await sb
    .from('audit_topic_competitors')
    .select('canonical_key, competitor_domain, representative_url')
    .eq('audit_id', auditId)
    .not('representative_url', 'is', null);

  if (!competitors || competitors.length === 0) {
    console.log('  No competitor URLs found (representative_url not populated). Skipping Phase 4b.');
    return;
  }

  // Group by canonical_key
  const topicCompetitors = new Map<string, Array<{ domain: string; url: string }>>();
  for (const c of competitors) {
    if (!c.representative_url) continue;
    const key = c.canonical_key;
    if (!topicCompetitors.has(key)) topicCompetitors.set(key, []);
    topicCompetitors.get(key)!.push({
      domain: c.competitor_domain,
      url: c.representative_url,
    });
  }

  console.log(`  ${topicCompetitors.size} topics with competitor URLs`);

  // 4. Load client URLs from agent_technical_pages (Dwight crawl)
  const { data: clientPages } = await sb
    .from('agent_technical_pages')
    .select('url, canonical_key')
    .eq('audit_id', auditId)
    .eq('status_code', 200);

  // Also try execution_pages for canonical_key matching
  const { data: execPages } = await sb
    .from('execution_pages')
    .select('target_url, canonical_key')
    .eq('audit_id', auditId)
    .not('target_url', 'is', null);

  // Also try ranking URLs from audit_keywords
  const { data: rankingUrls } = await sb
    .from('audit_keywords')
    .select('canonical_key, ranking_url')
    .eq('audit_id', auditId)
    .not('ranking_url', 'is', null)
    .not('canonical_key', 'is', null);

  // Build client URL map: canonical_key → URL
  const clientUrlMap = new Map<string, string>();

  // Priority 1: execution_pages (most reliable mapping)
  for (const ep of execPages ?? []) {
    if (ep.target_url && ep.canonical_key) {
      clientUrlMap.set(ep.canonical_key, ep.target_url);
    }
  }

  // Priority 2: ranking_url from audit_keywords (first match per canonical_key)
  for (const rk of rankingUrls ?? []) {
    if (rk.ranking_url && rk.canonical_key && !clientUrlMap.has(rk.canonical_key)) {
      clientUrlMap.set(rk.canonical_key, rk.ranking_url);
    }
  }

  // Priority 3: agent_technical_pages via canonical_key column
  for (const tp of clientPages ?? []) {
    const key = (tp as any).canonical_key;
    if (key && tp.url && !clientUrlMap.has(key)) {
      clientUrlMap.set(key, tp.url);
    }
  }

  console.log(`  ${clientUrlMap.size} topics with client URLs`);

  // 5. Fetch competitor pages + extract headings
  const allSectionRows: Array<{
    audit_id: string;
    domain: string;
    canonical_key: string;
    url: string;
    heading_level: string;
    heading_text: string;
    heading_position: number;
    is_client: boolean;
  }> = [];

  let fetchedUrls = 0;
  let failedUrls = 0;

  for (const [canonicalKey, comps] of topicCompetitors) {
    // Limit to 5 competitors per topic
    const limited = comps.slice(0, 5);

    for (const comp of limited) {
      const result = await fetchInstantPage(comp.url, dfseLogin, dfsePassword);
      fetchedUrls++;

      if (!result?.htags) {
        failedUrls++;
        continue;
      }

      const headings = extractHeadings(result.htags, comp.domain, false);
      for (const h of headings) {
        allSectionRows.push({
          audit_id: auditId,
          domain: h.domain,
          canonical_key: canonicalKey,
          url: comp.url,
          heading_level: h.heading_level,
          heading_text: h.heading_text,
          heading_position: h.heading_position,
          is_client: false,
        });
      }

      // Rate limit: 200ms between requests
      await new Promise((r) => setTimeout(r, 200));
    }

    // Fetch client page for this topic
    const clientUrl = clientUrlMap.get(canonicalKey);
    if (clientUrl) {
      const result = await fetchInstantPage(clientUrl, dfseLogin, dfsePassword);
      fetchedUrls++;

      if (result?.htags) {
        const headings = extractHeadings(result.htags, domain, true);
        for (const h of headings) {
          allSectionRows.push({
            audit_id: auditId,
            domain: h.domain,
            canonical_key: canonicalKey,
            url: clientUrl,
            heading_level: h.heading_level,
            heading_text: h.heading_text,
            heading_position: h.heading_position,
            is_client: true,
          });
        }
      } else {
        failedUrls++;
      }

      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log(`  Fetched ${fetchedUrls} URLs (${failedUrls} failed), extracted ${allSectionRows.length} headings`);

  // 6. Write competitor_sections to Supabase (batch insert)
  if (allSectionRows.length > 0) {
    const BATCH_SIZE = 500;
    for (let i = 0; i < allSectionRows.length; i += BATCH_SIZE) {
      const batch = allSectionRows.slice(i, i + BATCH_SIZE);
      const { error } = await sb.from('competitor_sections').insert(batch);
      if (error) {
        console.log(`  Warning: competitor_sections insert batch ${i / BATCH_SIZE + 1} failed: ${error.message}`);
      }
    }
    console.log(`  Wrote ${allSectionRows.length} headings to competitor_sections`);
  }

  // 7. Compute coverage scores per topic
  console.log('\n  Computing coverage scores...');
  const coverageResults: Array<{
    audit_id: string;
    canonical_key: string;
    canonical_topic: string | null;
  } & SectionCoverageResult> = [];

  // Get canonical_topic mapping from audit_clusters
  const { data: clusters } = await sb
    .from('audit_clusters')
    .select('canonical_key, canonical_topic')
    .eq('audit_id', auditId);

  const topicNameMap = new Map<string, string>();
  for (const c of clusters ?? []) {
    if (c.canonical_key && c.canonical_topic) {
      topicNameMap.set(c.canonical_key, c.canonical_topic);
    }
  }

  for (const canonicalKey of topicCompetitors.keys()) {
    // Build competitor sections for this topic
    const competitorSections: HeadingSection[] = allSectionRows
      .filter((r) => r.canonical_key === canonicalKey && !r.is_client)
      .map((r) => ({
        domain: r.domain,
        heading_text: r.heading_text,
        heading_level: r.heading_level as 'h2' | 'h3',
        heading_position: r.heading_position,
      }));

    // Build client sections for this topic
    const clientSections: HeadingSection[] = allSectionRows
      .filter((r) => r.canonical_key === canonicalKey && r.is_client)
      .map((r) => ({
        domain: r.domain,
        heading_text: r.heading_text,
        heading_level: r.heading_level as 'h2' | 'h3',
        heading_position: r.heading_position,
      }));

    const result = await computeSectionCoverage(canonicalKey, competitorSections, clientSections);

    coverageResults.push({
      audit_id: auditId,
      canonical_key: canonicalKey,
      canonical_topic: topicNameMap.get(canonicalKey) ?? null,
      ...result,
    });

    const statusLabel = result.coverage_status === 'scored'
      ? `${result.coverage_score}%`
      : result.coverage_status;
    console.log(`    ${canonicalKey}: ${statusLabel} (${result.competitor_count} competitors, ${result.core_gaps.length} gaps)`);
  }

  // 8. Write cluster_section_coverage to Supabase
  if (coverageResults.length > 0) {
    const rows = coverageResults.map((r) => ({
      audit_id: r.audit_id,
      canonical_key: r.canonical_key,
      canonical_topic: r.canonical_topic,
      coverage_score: r.coverage_score,
      coverage_status: r.coverage_status,
      competitor_count: r.competitor_count,
      total_subtopics_weighted: r.total_subtopics_weighted,
      covered_subtopics_weighted: r.covered_subtopics_weighted,
      core_gaps: r.core_gaps,
      borderline_matches: r.borderline_matches,
    }));

    const { error } = await sb
      .from('cluster_section_coverage')
      .upsert(rows, { onConflict: 'audit_id,canonical_key,snapshot_date' });

    if (error) {
      console.log(`  Warning: cluster_section_coverage upsert failed: ${error.message}`);
    } else {
      console.log(`  Wrote ${rows.length} coverage scores to cluster_section_coverage`);
    }
  }

  // 9. Update audit_clusters with coverage scores (denormalized for dashboard)
  for (const r of coverageResults) {
    if (r.coverage_status !== 'scored') continue;

    const { error } = await (sb as any)
      .from('audit_clusters')
      .update({
        coverage_score: r.coverage_score,
        coverage_competitor_count: r.competitor_count,
        coverage_score_updated_at: new Date().toISOString(),
      })
      .eq('audit_id', r.audit_id)
      .eq('canonical_key', r.canonical_key);

    if (error) {
      console.log(`  Warning: audit_clusters coverage update failed for ${r.canonical_key}: ${error.message}`);
    }
  }

  console.log(`\n  Phase 4b complete: ${coverageResults.length} topics scored`);
}

main().catch((err) => {
  console.error('Phase 4b failed:', err);
  process.exit(1);
});
