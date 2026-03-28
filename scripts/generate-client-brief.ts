/**
 * generate-client-brief.ts — Produce a comprehensive HTML intelligence brief
 * from full pipeline data (post-Phase 6d).
 *
 * Input:  All pipeline artifacts + Supabase data (audit_rollups, audit_clusters,
 *         gbp_snapshots, citation_snapshots)
 * Output: audits/{domain}/reports/client_brief.html
 *
 * Extends the prospect brief design system with: Technical Health, Revenue
 * Opportunity, Architecture Recommendations, Local Presence Assessment.
 *
 * Single Sonnet call for narrative synthesis (~$0.06-0.10).
 * Structured sections (revenue cards, cluster table, citation grid) data-injected.
 *
 * Usage:
 *   npx tsx scripts/generate-client-brief.ts --domain example.com --user-email user@example.com
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { callClaude, initAnthropicClient, PHASE_MAX_TOKENS } from './anthropic-client.js';

PHASE_MAX_TOKENS['client_brief'] = 8192;

const AUDITS_BASE = path.resolve(process.cwd(), 'audits');

// ── CLI parsing ──────────────────────────────────────────────

function parseArgs(): { domain: string; userEmail: string } {
  const args = process.argv.slice(2);
  let domain = '';
  let userEmail = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--domain' && args[i + 1]) domain = args[i + 1];
    if (args[i] === '--user-email' && args[i + 1]) userEmail = args[i + 1];
  }
  if (!domain || !userEmail) {
    console.error('Usage: npx tsx scripts/generate-client-brief.ts --domain <domain> --user-email <email>');
    process.exit(1);
  }
  return { domain, userEmail };
}

// ── .env loader ──────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    const env: Record<string, string> = {};
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
      env[key] = val;
    }
    return { ...env, ...process.env } as Record<string, string>;
  }
  return process.env as Record<string, string>;
}

// ── Helpers ──────────────────────────────────────────────────

function findLatestDatedDir(base: string): string | null {
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base)
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e))
    .sort();
  return dirs.length > 0 ? path.join(base, dirs[dirs.length - 1]) : null;
}

function readOptionalFile(filePath: string): string {
  if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
  return '';
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mdToHtml(md: string): string {
  return md
    .split(/\n\n+/)
    .filter((p) => p.trim())
    .map((p) => {
      let html = escapeHtml(p.trim()).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/`(.*?)`/g, '<code>$1</code>');
      return `<p>${html}</p>`;
    })
    .join('\n');
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtMoney(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

// ── Data loading: Disk artifacts ─────────────────────────────

interface DiskData {
  auditReport: string;       // Dwight AUDIT_REPORT.md
  researchSummary: string;   // Jim research_summary.md
  architectureBlueprint: string; // Michael architecture_blueprint.md
  strategyBrief: string;     // Phase 1b strategy_brief.md
  auditDate: string;
}

function loadDiskArtifacts(domain: string): DiskData {
  const auditorDir = findLatestDatedDir(path.join(AUDITS_BASE, domain, 'auditor'));
  const researchDir = findLatestDatedDir(path.join(AUDITS_BASE, domain, 'research'));
  const archDir = findLatestDatedDir(path.join(AUDITS_BASE, domain, 'architecture'));

  const auditDate = auditorDir ? path.basename(auditorDir) : new Date().toISOString().slice(0, 10);

  const auditReport = auditorDir
    ? readOptionalFile(path.join(auditorDir, 'AUDIT_REPORT.md'))
    : '';
  const researchSummary = researchDir
    ? readOptionalFile(path.join(researchDir, 'research_summary.md'))
    : '';
  const architectureBlueprint = archDir
    ? readOptionalFile(path.join(archDir, 'architecture_blueprint.md'))
    : '';

  // Strategy brief is in research dir
  let strategyBrief = '';
  if (researchDir) {
    strategyBrief = readOptionalFile(path.join(researchDir, 'strategy_brief.md'));
  }

  return { auditReport, researchSummary, architectureBlueprint, strategyBrief, auditDate };
}

// ── Data loading: Supabase ───────────────────────────────────

interface RollupData {
  total_volume_analyzed: number;
  opportunity_topics_count: number;
  total_keyword_count: number;
  near_miss_keyword_count: number;
  monthly_revenue_low: number;
  monthly_revenue_mid: number;
  monthly_revenue_high: number;
}

interface ClusterRow {
  canonical_key: string;
  canonical_topic: string;
  total_volume: number;
  keyword_count: number;
  near_miss_keyword_count: number;
  est_revenue_low: number;
  est_revenue_mid: number;
  est_revenue_high: number;
  status: string;
}

interface GbpSnapshot {
  listing_found: boolean;
  matched_name: string;
  category: string;
  rating: number;
  review_count: number;
  is_claimed: boolean;
  website_url: string;
}

interface CitationRow {
  directory_name: string;
  listing_found: boolean;
  nap_consistent: boolean;
}

interface SupabaseData {
  rollup: RollupData | null;
  clusters: ClusterRow[];
  gbp: GbpSnapshot | null;
  citations: CitationRow[];
}

async function loadSupabaseData(sb: SupabaseClient, domain: string, userEmail: string): Promise<SupabaseData> {
  // Resolve audit
  const { data: userData } = await sb.auth.admin.listUsers();
  const user = userData?.users?.find((u: any) => u.email === userEmail);
  if (!user) throw new Error(`User not found: ${userEmail}`);

  const { data: audit } = await sb
    .from('audits')
    .select('id')
    .eq('domain', domain)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!audit) throw new Error(`No audit found for ${domain} / ${userEmail}`);
  const auditId = (audit as any).id;

  // Rollup
  const { data: rollupRow } = await (sb as any)
    .from('audit_rollups')
    .select('total_volume_analyzed, opportunity_topics_count, total_keyword_count, near_miss_keyword_count, monthly_revenue_low, monthly_revenue_mid, monthly_revenue_high')
    .eq('audit_id', auditId)
    .maybeSingle();

  // Top clusters by revenue
  const { data: clusterRows } = await (sb as any)
    .from('audit_clusters')
    .select('canonical_key, canonical_topic, total_volume, keyword_count, near_miss_keyword_count, est_revenue_low, est_revenue_mid, est_revenue_high, status')
    .eq('audit_id', auditId)
    .order('est_revenue_mid', { ascending: false })
    .limit(15);

  // GBP
  const { data: gbpRows } = await (sb as any)
    .from('gbp_snapshots')
    .select('listing_found, matched_name, category, rating, review_count, is_claimed, website_url')
    .eq('audit_id', auditId)
    .order('snapshot_date', { ascending: false })
    .limit(1);

  // Citations
  const { data: citationRows } = await (sb as any)
    .from('citation_snapshots')
    .select('directory_name, listing_found, nap_consistent')
    .eq('audit_id', auditId)
    .order('snapshot_date', { ascending: false })
    .limit(20);

  return {
    rollup: rollupRow ?? null,
    clusters: clusterRows ?? [],
    gbp: gbpRows?.[0] ?? null,
    citations: citationRows ?? [],
  };
}

// ── Sonnet narrative synthesis ───────────────────────────────

interface NarrativeSections {
  execSummary: string;
  technicalSummary: string;
  revenueSummary: string;
  architectureSummary: string;
  localPresenceSummary: string;
  nextSteps: string;
}

async function generateNarrative(disk: DiskData, supaData: SupabaseData, domain: string): Promise<NarrativeSections> {
  // Build concise data context for the prompt
  const rollup = supaData.rollup;
  const topClusters = supaData.clusters.slice(0, 5);

  // Extract key stats from audit report (first ~2000 chars)
  const auditExcerpt = disk.auditReport.slice(0, 3000);
  const researchExcerpt = disk.researchSummary.slice(0, 2000);
  const archExcerpt = disk.architectureBlueprint.slice(0, 2000);
  const stratExcerpt = disk.strategyBrief.slice(0, 1500);

  const gbp = supaData.gbp;
  const citations = supaData.citations;
  const citationsFound = citations.filter((c) => c.listing_found).length;
  const napConsistent = citations.filter((c) => c.nap_consistent).length;

  const prompt = `You are writing six sections of an HTML intelligence brief for a business owner who has just completed a full SEO audit. Write in clear, professional language — no SEO jargon. The audience is a CEO or business owner.

YOUR ENTIRE RESPONSE IS THE OUTPUT. No preamble.

## Domain: ${domain}

## Strategy Brief (high-level positioning)
${stratExcerpt || '(Not available)'}

## Technical Audit Excerpt (Dwight)
${auditExcerpt || '(Not available)'}

## Research Excerpt (Jim)
${researchExcerpt || '(Not available)'}

## Architecture Excerpt (Michael)
${archExcerpt || '(Not available)'}

## Revenue Data
${rollup ? `- Keywords analyzed: ${rollup.total_keyword_count}
- Near-miss keywords (positions 11-20): ${rollup.near_miss_keyword_count}
- Topic clusters: ${rollup.opportunity_topics_count}
- Monthly revenue opportunity: $${rollup.monthly_revenue_low?.toFixed(0) ?? '0'} – $${rollup.monthly_revenue_high?.toFixed(0) ?? '0'}` : '(Revenue data not available)'}

## Top Clusters by Revenue
${topClusters.length > 0 ? topClusters.map((c) => `- ${c.canonical_topic}: ${c.keyword_count} keywords, ${fmt(c.total_volume)} vol, $${c.est_revenue_mid?.toFixed(0) ?? '0'}/mo`).join('\n') : '(No clusters)'}

## Local Presence
${gbp ? `- GBP: ${gbp.listing_found ? 'Found' : 'NOT FOUND'}, ${gbp.is_claimed ? 'Claimed' : 'Unclaimed'}, Rating: ${gbp.rating}/5 (${gbp.review_count} reviews)` : '- GBP: Not checked'}
- Citations: ${citationsFound}/${citations.length} directories found, ${napConsistent} NAP consistent

## Output Format — write exactly six sections separated by these markers:

---EXEC_SUMMARY---
[3-4 paragraphs. Lead with the most actionable finding. Cover: current visibility state, revenue opportunity size, top priorities. Frame in business terms — "Your business is currently invisible for X searches that represent $Y in monthly revenue." Quantify everything.]

---TECHNICAL_SUMMARY---
[2-3 paragraphs. Translate technical findings into business impact. What's broken and what it costs them. Mention specific issues (broken pages, missing schema, etc.) but explain WHY they matter. End with "The good news: these are fixable."]

---REVENUE_SUMMARY---
[2-3 paragraphs. The revenue story. How many keywords they're close to ranking for. What the realistic monthly revenue opportunity is. Use the mid estimate as the primary number. Mention the top 2-3 clusters by name and their individual opportunity.]

---ARCHITECTURE_SUMMARY---
[2-3 paragraphs. What the recommended site structure looks like. How many silos/sections. What content needs to be created vs restructured. Frame as a growth roadmap — "Phase 1 addresses X, Phase 2 expands into Y."]

---LOCAL_PRESENCE_SUMMARY---
[1-2 paragraphs. GBP status and what it means. Citation coverage across directories. NAP consistency. If GBP is missing, lead with that — it's the highest-impact finding. If present, focus on optimization opportunities.]

---NEXT_STEPS---
[2-3 paragraphs. Concrete next steps in priority order. What to fix first (technical), what to build (content), what to optimize (local). End with a compelling forward-looking statement about their growth trajectory.]

REMINDER: Output the six sections with the exact markers. No other text.`;

  const output = await callClaude(prompt, { model: 'sonnet', phase: 'client_brief' });

  const extract = (start: string, end: string): string => {
    const re = new RegExp(`${start}([\\s\\S]*?)${end}`);
    return output.match(re)?.[1]?.trim() || '';
  };

  return {
    execSummary: extract('---EXEC_SUMMARY---', '---TECHNICAL_SUMMARY---') || 'Executive summary not available.',
    technicalSummary: extract('---TECHNICAL_SUMMARY---', '---REVENUE_SUMMARY---') || 'Technical summary not available.',
    revenueSummary: extract('---REVENUE_SUMMARY---', '---ARCHITECTURE_SUMMARY---') || 'Revenue summary not available.',
    architectureSummary: extract('---ARCHITECTURE_SUMMARY---', '---LOCAL_PRESENCE_SUMMARY---') || 'Architecture summary not available.',
    localPresenceSummary: extract('---LOCAL_PRESENCE_SUMMARY---', '---NEXT_STEPS---') || 'Local presence summary not available.',
    nextSteps: output.match(/---NEXT_STEPS---([\s\S]*?)$/)?.[1]?.trim() || 'Next steps not available.',
  };
}

// ── HTML Generation ──────────────────────────────────────────

function generateHtml(
  domain: string,
  disk: DiskData,
  supaData: SupabaseData,
  narrative: NarrativeSections,
): string {
  const rollup = supaData.rollup;
  const clusters = supaData.clusters;
  const gbp = supaData.gbp;
  const citations = supaData.citations;

  const citationsFound = citations.filter((c) => c.listing_found).length;
  const napConsistent = citations.filter((c) => c.nap_consistent).length;

  // Revenue card states
  const revLow = rollup?.monthly_revenue_low ?? 0;
  const revMid = rollup?.monthly_revenue_mid ?? 0;
  const revHigh = rollup?.monthly_revenue_high ?? 0;
  const kwCount = rollup?.total_keyword_count ?? 0;
  const nearMissCount = rollup?.near_miss_keyword_count ?? 0;
  const topicCount = rollup?.opportunity_topics_count ?? 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(domain)} — Client Intelligence Brief</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

:root{
  --bone:#F5F2EB;--charcoal:#1D1D1D;--orange:#CC4E0E;--steel:#3A5A8F;--graphite:#585858;--white:#FFFFFF;
  --bone-dark:#E8E4D9;--bone-mid:#EEEBe4;--border:#D8D4C9;--border-light:#E4E0D6;
  --red:#9B2C0A;--red-bg:#FDF0EC;--warn-color:#7A5000;--warn-bg:#FDF6E8;--info-bg:#EBF1FA;
  --green:#1A6640;--green-bg:#EBF5F0;
  --shadow-sm:0 1px 3px rgba(29,29,29,0.07);--shadow-md:0 4px 14px rgba(29,29,29,0.10);
}

html{scroll-behavior:smooth}
body{font-family:'Inter',sans-serif;font-size:15px;line-height:1.7;color:var(--charcoal);background:var(--bone);}

.topbar{background:var(--charcoal);height:54px;display:flex;align-items:center;justify-content:space-between;padding:0 40px;position:sticky;top:0;z-index:200;border-bottom:2px solid var(--orange);}
.topbar-brand{font-family:'Oswald',sans-serif;font-size:14px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--white);text-decoration:none;}
.topbar-nav{display:flex;list-style:none;flex-wrap:wrap;}
.topbar-nav a{font-family:'Oswald',sans-serif;font-size:10.5px;font-weight:500;letter-spacing:0.11em;text-transform:uppercase;color:rgba(255,255,255,0.45);text-decoration:none;padding:0 11px;height:54px;line-height:54px;display:block;transition:color .15s;}
.topbar-nav a:hover{color:var(--white);}

.hero{background:var(--charcoal);padding:60px 40px 52px;position:relative;overflow:hidden;}
.hero::after{content:'';position:absolute;bottom:0;left:0;right:0;height:3px;background:linear-gradient(90deg,var(--orange) 0%,transparent 55%);}
.hero-inner{max-width:1040px;display:grid;grid-template-columns:1fr auto;gap:40px;align-items:end;}
.hero-eyebrow{font-family:'JetBrains Mono',monospace;font-size:10.5px;letter-spacing:0.18em;text-transform:uppercase;color:var(--orange);margin-bottom:14px;}
.hero h1{font-family:'Oswald',sans-serif;font-size:clamp(28px,4.5vw,48px);font-weight:700;letter-spacing:0.02em;text-transform:uppercase;color:var(--white);line-height:1.05;margin-bottom:8px;}
.hero-domain{font-family:'JetBrains Mono',monospace;font-size:12px;color:rgba(255,255,255,0.35);margin-bottom:26px;}
.hero-meta{display:flex;gap:28px;flex-wrap:wrap;}
.hero-meta-item .lbl{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:rgba(255,255,255,0.3);display:block;margin-bottom:2px;}
.hero-meta-item .val{font-size:13px;font-weight:500;color:rgba(255,255,255,0.72);}
.hero-stat{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.09);border-radius:6px;padding:20px 24px;text-align:center;min-width:130px;align-self:center;}
.hero-stat-val{font-family:'Oswald',sans-serif;font-size:38px;font-weight:700;color:var(--orange);line-height:1;display:block;}
.hero-stat-lbl{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(255,255,255,0.35);display:block;margin-top:6px;}

.page-body{max-width:1080px;margin:0 auto;padding:52px 40px 80px;}

.section{margin-bottom:60px;}
.section-head{display:flex;align-items:baseline;gap:14px;margin-bottom:26px;padding-bottom:10px;border-bottom:2px solid var(--charcoal);}
.sec-num{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:0.14em;color:var(--orange);flex-shrink:0;}
.sec-title{font-family:'Oswald',sans-serif;font-size:22px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:var(--charcoal);}
.subsection{margin-bottom:36px;}
.sub-head{font-family:'Oswald',sans-serif;font-size:12.5px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--graphite);margin-bottom:14px;display:flex;align-items:center;gap:8px;}
.sub-head::before{content:'';display:block;width:3px;height:13px;background:var(--orange);border-radius:2px;flex-shrink:0;}

.score-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:13px;margin-bottom:26px;}
.score-card{background:var(--white);border:1px solid var(--border);border-radius:5px;padding:17px 19px;box-shadow:var(--shadow-sm);position:relative;overflow:hidden;}
.score-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;}
.score-card.ok::before{background:var(--green);}
.score-card.warn::before{background:var(--warn-color);}
.score-card.fail::before{background:var(--red);}
.score-card.neutral::before{background:var(--steel);}
.c-label{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:0.1em;text-transform:uppercase;color:var(--graphite);margin-bottom:7px;}
.c-val{font-family:'Oswald',sans-serif;font-size:28px;font-weight:700;line-height:1;margin-bottom:5px;}
.score-card.ok .c-val{color:var(--green);}
.score-card.warn .c-val{color:var(--warn-color);}
.score-card.fail .c-val{color:var(--red);}
.score-card.neutral .c-val{color:var(--steel);}
.c-desc{font-size:12px;color:var(--graphite);line-height:1.45;}

.prose-box{background:var(--white);border:1px solid var(--border);border-radius:5px;padding:26px 30px;box-shadow:var(--shadow-sm);margin-bottom:26px;}
.prose-box p{font-size:15px;color:var(--charcoal);margin-bottom:13px;line-height:1.72;}
.prose-box p:last-child{margin-bottom:0;}
.prose-box strong{font-weight:600;}
.prose-box code{font-family:'JetBrains Mono',monospace;font-size:12px;background:var(--bone-mid);padding:1px 5px;border-radius:3px;}

.tbl-wrap{overflow-x:auto;border-radius:5px;border:1px solid var(--border);box-shadow:var(--shadow-sm);margin-bottom:20px;}
table{width:100%;border-collapse:collapse;background:var(--white);font-size:13.5px;}
thead{background:var(--charcoal);}
thead th{font-family:'Oswald',sans-serif;font-size:10.5px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.7);padding:10px 15px;text-align:left;white-space:nowrap;}
tbody tr{border-bottom:1px solid var(--border-light);transition:background .12s;}
tbody tr:last-child{border-bottom:none;}
tbody tr:hover{background:var(--bone);}
td{padding:10px 15px;vertical-align:top;line-height:1.5;color:var(--charcoal);}
td.mono{font-family:'JetBrains Mono',monospace;font-size:11.5px;color:#2a2a2a;}
td.ps{font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:500;color:var(--green);}
td.pm{font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:500;color:var(--warn-color);}
td.pw{font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:500;color:var(--red);}

.tag{display:inline-block;font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;padding:2px 6px;border-radius:3px;white-space:nowrap;}
.t-active{background:#DFF0E8;color:var(--green);}
.t-inactive{background:var(--bone-dark);color:var(--graphite);}
.t-found{background:#DFF0E8;color:var(--green);}
.t-missing{background:#FDEADF;color:var(--red);}
.t-consistent{background:#DFF0E8;color:var(--green);}
.t-inconsistent{background:#FDF1DD;color:var(--warn-color);}

.citation-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:9px;margin-bottom:20px;}
.cit-item{background:var(--white);border:1px solid var(--border);border-radius:5px;padding:12px 14px;box-shadow:var(--shadow-sm);display:flex;align-items:center;gap:10px;}
.cit-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;}
.cit-dot.found{background:var(--green);}
.cit-dot.missing{background:var(--red);}
.cit-name{font-size:13px;font-weight:500;color:var(--charcoal);}
.cit-nap{font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--graphite);margin-top:2px;}

.footer{background:var(--charcoal);padding:30px 40px;text-align:center;}
.footer p{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.3);}

@media(max-width:720px){
  .hero{padding:40px 20px 36px;}
  .hero-inner{grid-template-columns:1fr;gap:20px;}
  .page-body{padding:32px 20px 60px;}
  .score-grid{grid-template-columns:1fr 1fr;}
  .citation-grid{grid-template-columns:1fr 1fr;}
}
</style>
</head>
<body>

<nav class="topbar">
  <a class="topbar-brand" href="#">Forge Growth</a>
  <ul class="topbar-nav">
    <li><a href="#overview">Summary</a></li>
    <li><a href="#technical">Technical</a></li>
    <li><a href="#revenue">Revenue</a></li>
    <li><a href="#clusters">Clusters</a></li>
    <li><a href="#architecture">Architecture</a></li>
    <li><a href="#local">Local</a></li>
    <li><a href="#next">Next Steps</a></li>
  </ul>
</nav>

<header class="hero">
  <div class="hero-inner">
    <div>
      <div class="hero-eyebrow">Client Intelligence Brief</div>
      <h1>${escapeHtml(domain)}</h1>
      <div class="hero-domain">Full Pipeline Audit — ${escapeHtml(disk.auditDate)}</div>
      <div class="hero-meta">
        <div class="hero-meta-item">
          <span class="lbl">Keywords Analyzed</span>
          <span class="val">${fmt(kwCount)}</span>
        </div>
        <div class="hero-meta-item">
          <span class="lbl">Topic Clusters</span>
          <span class="val">${fmt(topicCount)}</span>
        </div>
        <div class="hero-meta-item">
          <span class="lbl">Near-Miss Keywords</span>
          <span class="val">${fmt(nearMissCount)}</span>
        </div>
        <div class="hero-meta-item">
          <span class="lbl">Prepared By</span>
          <span class="val">Forge Growth</span>
        </div>
      </div>
    </div>
    <div class="hero-stat">
      <span class="hero-stat-val">${fmtMoney(revMid)}</span>
      <span class="hero-stat-lbl">Monthly Opportunity</span>
    </div>
  </div>
</header>

<main class="page-body">

<!-- 01 — Executive Summary -->
<section class="section" id="overview">
  <div class="section-head">
    <span class="sec-num">01 —</span>
    <h2 class="sec-title">Executive Summary</h2>
  </div>

  <div class="score-grid">
    <div class="score-card neutral">
      <div class="c-label">Keywords Analyzed</div>
      <div class="c-val">${fmt(kwCount)}</div>
      <div class="c-desc">Total keywords tracked</div>
    </div>
    <div class="score-card ${nearMissCount > 20 ? 'warn' : nearMissCount > 0 ? 'ok' : 'neutral'}">
      <div class="c-label">Near-Miss (11-20)</div>
      <div class="c-val">${fmt(nearMissCount)}</div>
      <div class="c-desc">Quick-win opportunities</div>
    </div>
    <div class="score-card ok">
      <div class="c-label">Revenue (Low)</div>
      <div class="c-val">${fmtMoney(revLow)}</div>
      <div class="c-desc">Conservative monthly est.</div>
    </div>
    <div class="score-card ok">
      <div class="c-label">Revenue (High)</div>
      <div class="c-val">${fmtMoney(revHigh)}</div>
      <div class="c-desc">Optimistic monthly est.</div>
    </div>
  </div>

  <div class="prose-box">
    ${mdToHtml(narrative.execSummary)}
  </div>
</section>

<!-- 02 — Technical Health -->
<section class="section" id="technical">
  <div class="section-head">
    <span class="sec-num">02 —</span>
    <h2 class="sec-title">Technical Health Assessment</h2>
  </div>

  <div class="prose-box">
    ${mdToHtml(narrative.technicalSummary)}
  </div>
</section>

<!-- 03 — Revenue Opportunity -->
<section class="section" id="revenue">
  <div class="section-head">
    <span class="sec-num">03 —</span>
    <h2 class="sec-title">Revenue Opportunity</h2>
  </div>

  <div class="score-grid">
    <div class="score-card warn">
      <div class="c-label">Monthly (Conservative)</div>
      <div class="c-val">${fmtMoney(revLow)}</div>
      <div class="c-desc">Low conversion scenario</div>
    </div>
    <div class="score-card ok">
      <div class="c-label">Monthly (Expected)</div>
      <div class="c-val">${fmtMoney(revMid)}</div>
      <div class="c-desc">Mid-range estimate</div>
    </div>
    <div class="score-card ok">
      <div class="c-label">Monthly (Optimistic)</div>
      <div class="c-val">${fmtMoney(revHigh)}</div>
      <div class="c-desc">High conversion scenario</div>
    </div>
    <div class="score-card neutral">
      <div class="c-label">Topic Clusters</div>
      <div class="c-val">${fmt(topicCount)}</div>
      <div class="c-desc">Addressable market segments</div>
    </div>
  </div>

  <div class="prose-box">
    ${mdToHtml(narrative.revenueSummary)}
  </div>
</section>

<!-- 04 — Cluster Breakdown -->
<section class="section" id="clusters">
  <div class="section-head">
    <span class="sec-num">04 —</span>
    <h2 class="sec-title">Topic Cluster Breakdown</h2>
  </div>

${clusters.length > 0 ? `  <div class="tbl-wrap">
    <table>
      <thead>
        <tr>
          <th>Topic</th>
          <th>Keywords</th>
          <th>Volume</th>
          <th>Revenue/mo (Est.)</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
${clusters.map((c) => {
  const statusTag = c.status === 'active'
    ? '<span class="tag t-active">Active</span>'
    : '<span class="tag t-inactive">Inactive</span>';
  return `        <tr>
          <td>${escapeHtml(c.canonical_topic || c.canonical_key)}</td>
          <td class="mono">${fmt(c.keyword_count)}</td>
          <td class="mono">${fmt(c.total_volume)}</td>
          <td class="mono">${fmtMoney(c.est_revenue_mid ?? 0)}</td>
          <td>${statusTag}</td>
        </tr>`;
}).join('\n')}
      </tbody>
    </table>
  </div>` : `  <div class="prose-box"><p>Cluster data not yet available.</p></div>`}
</section>

<!-- 05 — Architecture -->
<section class="section" id="architecture">
  <div class="section-head">
    <span class="sec-num">05 —</span>
    <h2 class="sec-title">Architecture Recommendations</h2>
  </div>

  <div class="prose-box">
    ${mdToHtml(narrative.architectureSummary)}
  </div>
</section>

<!-- 06 — Local Presence -->
<section class="section" id="local">
  <div class="section-head">
    <span class="sec-num">06 —</span>
    <h2 class="sec-title">Local Presence Assessment</h2>
  </div>

${gbp ? `  <div class="score-grid">
    <div class="score-card ${gbp.listing_found ? 'ok' : 'fail'}">
      <div class="c-label">Google Business</div>
      <div class="c-val">${gbp.listing_found ? 'Found' : 'Missing'}</div>
      <div class="c-desc">${gbp.is_claimed ? 'Claimed' : 'Unclaimed'}</div>
    </div>
${gbp.listing_found ? `    <div class="score-card ${(gbp.rating ?? 0) >= 4 ? 'ok' : (gbp.rating ?? 0) >= 3 ? 'warn' : 'fail'}">
      <div class="c-label">Rating</div>
      <div class="c-val">${gbp.rating ?? 'N/A'}</div>
      <div class="c-desc">${gbp.review_count ?? 0} reviews</div>
    </div>` : ''}
    <div class="score-card ${citationsFound >= 8 ? 'ok' : citationsFound >= 4 ? 'warn' : 'fail'}">
      <div class="c-label">Citations Found</div>
      <div class="c-val">${citationsFound}/${citations.length}</div>
      <div class="c-desc">Directory listings</div>
    </div>
    <div class="score-card ${napConsistent >= citationsFound * 0.8 ? 'ok' : 'warn'}">
      <div class="c-label">NAP Consistent</div>
      <div class="c-val">${napConsistent}</div>
      <div class="c-desc">Name/Address/Phone match</div>
    </div>
  </div>` : ''}

${citations.length > 0 ? `  <div class="subsection">
    <div class="sub-head">Directory Coverage</div>
    <div class="citation-grid">
${citations.map((c) => `      <div class="cit-item">
        <div class="cit-dot ${c.listing_found ? 'found' : 'missing'}"></div>
        <div>
          <div class="cit-name">${escapeHtml(c.directory_name)}</div>
          <div class="cit-nap">${c.listing_found ? (c.nap_consistent ? 'NAP OK' : 'NAP MISMATCH') : 'NOT LISTED'}</div>
        </div>
      </div>`).join('\n')}
    </div>
  </div>` : ''}

  <div class="prose-box">
    ${mdToHtml(narrative.localPresenceSummary)}
  </div>
</section>

<!-- 07 — Next Steps -->
<section class="section" id="next">
  <div class="section-head">
    <span class="sec-num">07 —</span>
    <h2 class="sec-title">Recommended Next Steps</h2>
  </div>

  <div class="prose-box">
    ${mdToHtml(narrative.nextSteps)}
  </div>
</section>

</main>

<footer class="footer">
  <p>Prepared by Forge Growth &middot; ${escapeHtml(disk.auditDate)} &middot; Confidential</p>
</footer>

</body>
</html>`;
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { domain, userEmail } = parseArgs();
  const env = loadEnv();

  const sbUrl = env.SUPABASE_URL;
  const sbKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = env.ANTHROPIC_API_KEY || env.ANTHROPIC_KEY;
  if (!sbUrl || !sbKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not set');

  const sb = createClient(sbUrl, sbKey);
  initAnthropicClient(anthropicKey);

  console.log(`\n=== Client Intelligence Brief: ${domain} ===`);

  // Load disk artifacts
  console.log('\n--- Loading disk artifacts ---');
  const disk = loadDiskArtifacts(domain);
  console.log(`  AUDIT_REPORT.md: ${disk.auditReport ? `${(disk.auditReport.length / 1024).toFixed(1)}KB` : 'not found'}`);
  console.log(`  research_summary.md: ${disk.researchSummary ? `${(disk.researchSummary.length / 1024).toFixed(1)}KB` : 'not found'}`);
  console.log(`  architecture_blueprint.md: ${disk.architectureBlueprint ? `${(disk.architectureBlueprint.length / 1024).toFixed(1)}KB` : 'not found'}`);
  console.log(`  strategy_brief.md: ${disk.strategyBrief ? `${(disk.strategyBrief.length / 1024).toFixed(1)}KB` : 'not found'}`);

  // Load Supabase data
  console.log('\n--- Loading Supabase data ---');
  const supaData = await loadSupabaseData(sb, domain, userEmail);
  console.log(`  rollup: ${supaData.rollup ? 'found' : 'not found'}`);
  console.log(`  clusters: ${supaData.clusters.length}`);
  console.log(`  gbp: ${supaData.gbp ? (supaData.gbp.listing_found ? 'found' : 'not found (checked)') : 'no snapshot'}`);
  console.log(`  citations: ${supaData.citations.length} (${supaData.citations.filter((c) => c.listing_found).length} found)`);

  // Generate narrative sections via Sonnet
  console.log('\n--- Generating narrative sections (Sonnet) ---');
  const narrative = await generateNarrative(disk, supaData, domain);
  console.log(`  exec_summary: ${narrative.execSummary.length} chars`);
  console.log(`  technical: ${narrative.technicalSummary.length} chars`);
  console.log(`  revenue: ${narrative.revenueSummary.length} chars`);
  console.log(`  architecture: ${narrative.architectureSummary.length} chars`);
  console.log(`  local_presence: ${narrative.localPresenceSummary.length} chars`);
  console.log(`  next_steps: ${narrative.nextSteps.length} chars`);

  // Generate HTML
  console.log('\n--- Building HTML brief ---');
  const html = generateHtml(domain, disk, supaData, narrative);

  // Write to disk
  const reportsDir = path.join(AUDITS_BASE, domain, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const outputPath = path.join(reportsDir, 'client_brief.html');
  fs.writeFileSync(outputPath, html, 'utf-8');

  const sizeKB = (fs.statSync(outputPath).size / 1024).toFixed(1);
  console.log(`\n  Output: ${path.relative(process.cwd(), outputPath)} (${sizeKB}KB)`);
  console.log('=== Client Brief Complete ===\n');
}

main().catch((err) => {
  console.error('Client brief failed:', err);
  process.exit(1);
});
