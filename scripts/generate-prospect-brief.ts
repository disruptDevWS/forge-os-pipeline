/**
 * generate-prospect-brief.ts — Produce an HTML intelligence brief from Scout data.
 *
 * Input:  Scout artifacts (scope.json, prospect-narrative.md, ranked_keywords.json)
 * Output: audits/{domain}/reports/prospect_brief.html
 *
 * A single Sonnet call generates the executive summary + opportunity analysis.
 * Structured sections (keyword tables, gap grids, score cards) are data-injected.
 * Template matches the SMA/IMA intelligence brief design system.
 *
 * Usage:
 *   npx tsx scripts/generate-prospect-brief.ts --domain example.com
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { callClaude, PHASE_MAX_TOKENS } from './anthropic-client.js';

// Register the phase max tokens
PHASE_MAX_TOKENS['prospect_brief'] = 4096;

const AUDITS_BASE = path.resolve(process.cwd(), 'audits');

// ── CLI parsing ──────────────────────────────────────────────

interface BriefRequest {
  domain: string;
}

function parseArgs(): BriefRequest {
  const args = process.argv.slice(2);
  let domain = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--domain' && args[i + 1]) domain = args[i + 1];
  }
  if (!domain) {
    console.error('Usage: npx tsx scripts/generate-prospect-brief.ts --domain <domain>');
    process.exit(1);
  }
  return { domain };
}

// ── Data loading ─────────────────────────────────────────────

function findLatestDatedDir(base: string): string | null {
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base)
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e))
    .sort();
  return dirs.length > 0 ? path.join(base, dirs[dirs.length - 1]) : null;
}

interface ScopeData {
  business_type: string;
  domain: string;
  services: string[];
  locales: string[];
  state: string;
  topics: Array<{ key: string; label: string }>;
  gap_summary: {
    total: number;
    defending: number;
    weak: number;
    gaps: number;
    top_opportunities: Array<{ keyword: string; topic: string; volume: number; cpc: number }>;
  };
  total_opportunity_volume: number;
  generated_at: string;
}

interface RankedKeyword {
  keyword: string;
  position: number;
  volume: number;
  cpc: number;
  url: string;
}

function loadScoutData(domain: string): {
  scope: ScopeData;
  narrative: string;
  keywords: RankedKeyword[];
  scoutDate: string;
} {
  const scoutDir = findLatestDatedDir(path.join(AUDITS_BASE, domain, 'scout'));
  if (!scoutDir) throw new Error(`No scout directory found for ${domain}`);

  const scoutDate = path.basename(scoutDir);

  // scope.json (required)
  const scopePath = path.join(scoutDir, 'scope.json');
  if (!fs.existsSync(scopePath)) throw new Error(`scope.json not found at ${scopePath}`);
  const scope: ScopeData = JSON.parse(fs.readFileSync(scopePath, 'utf-8'));

  // prospect-narrative.md (optional — we'll generate exec summary from scope if missing)
  let narrative = '';
  const narrativePath = path.join(scoutDir, 'prospect-narrative.md');
  if (fs.existsSync(narrativePath)) {
    narrative = fs.readFileSync(narrativePath, 'utf-8');
  }

  // ranked_keywords.json (optional — from research dir)
  const keywords: RankedKeyword[] = [];
  const researchDir = findLatestDatedDir(path.join(AUDITS_BASE, domain, 'research'));
  if (researchDir) {
    const rankedPath = path.join(researchDir, 'ranked_keywords.json');
    if (fs.existsSync(rankedPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(rankedPath, 'utf-8'));
        for (const task of data?.tasks ?? []) {
          for (const result of task?.result ?? []) {
            for (const item of result?.items ?? []) {
              const kd = item.keyword_data;
              const se = item.ranked_serp_element?.serp_item;
              if (kd?.keyword) {
                keywords.push({
                  keyword: kd.keyword,
                  position: se?.rank_group ?? 0,
                  volume: kd.keyword_info?.search_volume ?? 0,
                  cpc: kd.keyword_info?.cpc ?? 0,
                  url: se?.url ?? '',
                });
              }
            }
          }
        }
      } catch {
        console.warn('  Warning: ranked_keywords.json parse failed');
      }
    }
  }

  return { scope, narrative, keywords, scoutDate };
}

// ── Sonnet call for narrative sections ───────────────────────

async function generateNarrativeSections(
  scope: ScopeData,
  narrative: string,
  keywords: RankedKeyword[],
): Promise<{ execSummary: string; opportunityAnalysis: string; nextSteps: string }> {
  const topKeywords = keywords
    .filter((k) => k.position > 0)
    .sort((a, b) => a.position - b.position)
    .slice(0, 20);

  const topGaps = scope.gap_summary.top_opportunities.slice(0, 10);
  const businessName = scope.business_type || scope.domain;

  const prompt = `You are writing three sections of an HTML intelligence brief for a business owner. Write in clear, professional language — no SEO jargon. Output ONLY the three sections in the exact format below.

YOUR ENTIRE RESPONSE IS THE OUTPUT. No preamble.

## Business Context
- Business: ${businessName}
- Domain: ${scope.domain}
- Services: ${scope.services.slice(0, 8).join(', ')}
- Markets: ${scope.locales.slice(0, 5).join(', ')}
- Keywords defending (page 1): ${scope.gap_summary.defending}
- Keywords at risk (page 2-3): ${scope.gap_summary.weak}
- Not ranking: ${scope.gap_summary.gaps}
- Total untapped monthly searches: ${scope.total_opportunity_volume.toLocaleString()}

## Top Current Rankings
${topKeywords.length > 0 ? topKeywords.map((k) => `- "${k.keyword}" → position ${k.position} (${k.volume.toLocaleString()} searches/mo)`).join('\n') : '(No current rankings found)'}

## Top Gap Opportunities
${topGaps.length > 0 ? topGaps.map((g) => `- "${g.keyword}" — ${g.volume.toLocaleString()} searches/mo, $${g.cpc.toFixed(2)} CPC`).join('\n') : '(No gaps identified)'}

${narrative ? `## Existing Narrative (for tone reference)\n${narrative.slice(0, 2000)}` : ''}

## Output Format — write exactly three sections separated by these markers:

---EXEC_SUMMARY---
[2-3 paragraphs. Lead with the most important finding. Quantify the opportunity. Frame what they're doing well and what they're missing. Write for a CEO, not an SEO specialist.]

---OPPORTUNITY_ANALYSIS---
[2-3 paragraphs. Translate keyword gaps into business language — "people searching for X in Y aren't finding you." Name specific services and locations. Quantify monthly search volume they're missing. Focus on the revenue implication.]

---NEXT_STEPS---
[2-3 paragraphs. What a full audit would reveal. What actions would follow. End with a forward-looking statement about their growth opportunity. Be specific but not overselling.]

STYLE RULES:
- Avoid em dashes (—). Use periods, commas, or restructure sentences instead. One em dash per section maximum.
- Write short, direct sentences. Vary sentence length naturally.
- No filler phrases like "it's worth noting" or "the reality is."

REMINDER: Output the three sections with the exact markers. No other text.`;

  const output = await callClaude(prompt, { model: 'sonnet', phase: 'prospect_brief' });

  const execMatch = output.match(/---EXEC_SUMMARY---([\s\S]*?)---OPPORTUNITY_ANALYSIS---/);
  const oppMatch = output.match(/---OPPORTUNITY_ANALYSIS---([\s\S]*?)---NEXT_STEPS---/);
  const nextMatch = output.match(/---NEXT_STEPS---([\s\S]*?)$/);

  return {
    execSummary: execMatch?.[1]?.trim() || 'Executive summary not available.',
    opportunityAnalysis: oppMatch?.[1]?.trim() || 'Opportunity analysis not available.',
    nextSteps: nextMatch?.[1]?.trim() || 'Next steps not available.',
  };
}

// ── HTML Generation ──────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function markdownParagraphsToHtml(md: string): string {
  return md
    .split(/\n\n+/)
    .filter((p) => p.trim())
    .map((p) => {
      // Bold
      let html = escapeHtml(p.trim()).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      // Inline code
      html = html.replace(/`(.*?)`/g, '<code>$1</code>');
      return `<p>${html}</p>`;
    })
    .join('\n');
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function scoreCardClass(defending: number, weak: number, gaps: number): string {
  const total = defending + weak + gaps;
  if (total === 0) return 'warn';
  const ratio = defending / total;
  if (ratio >= 0.4) return 'ok';
  if (ratio >= 0.15) return 'warn';
  return 'fail';
}

function generateHtml(
  scope: ScopeData,
  keywords: RankedKeyword[],
  narrativeSections: { execSummary: string; opportunityAnalysis: string; nextSteps: string },
  scoutDate: string,
): string {
  const businessName = scope.business_type || scope.domain;
  const { defending, weak, gaps, top_opportunities } = scope.gap_summary;
  const totalTracked = defending + weak + gaps;

  // Top rankings for table
  const topRanked = keywords
    .filter((k) => k.position > 0 && k.position <= 30)
    .sort((a, b) => a.position - b.position)
    .slice(0, 15);

  // Gap opportunities for table
  const topGaps = top_opportunities.slice(0, 15);

  // Service topics
  const topics = scope.topics.slice(0, 12);

  // Score card status
  const overallClass = scoreCardClass(defending, weak, gaps);
  const gapClass = gaps > defending ? 'fail' : gaps > weak ? 'warn' : 'ok';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(businessName)} — Search Intelligence Brief</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

:root{
  --bone:#F5F2EB;
  --charcoal:#1D1D1D;
  --orange:#CC4E0E;
  --steel:#3A5A8F;
  --graphite:#585858;
  --white:#FFFFFF;
  --bone-dark:#E8E4D9;
  --bone-mid:#EEEBe4;
  --border:#D8D4C9;
  --border-light:#E4E0D6;
  --red:#9B2C0A;
  --red-bg:#FDF0EC;
  --warn-color:#7A5000;
  --warn-bg:#FDF6E8;
  --info-bg:#EBF1FA;
  --green:#1A6640;
  --green-bg:#EBF5F0;
  --shadow-sm:0 1px 3px rgba(29,29,29,0.07);
  --shadow-md:0 4px 14px rgba(29,29,29,0.10);
}

html{scroll-behavior:smooth}
body{font-family:'Inter',sans-serif;font-size:15px;line-height:1.7;color:var(--charcoal);background:var(--bone);}

.topbar{background:var(--charcoal);height:54px;display:flex;align-items:center;justify-content:space-between;padding:0 40px;position:sticky;top:0;z-index:200;border-bottom:2px solid var(--orange);}
.topbar-brand{font-family:'Oswald',sans-serif;font-size:14px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--white);text-decoration:none;}
.topbar-nav{display:flex;list-style:none;}
.topbar-nav a{font-family:'Oswald',sans-serif;font-size:10.5px;font-weight:500;letter-spacing:0.11em;text-transform:uppercase;color:rgba(255,255,255,0.45);text-decoration:none;padding:0 13px;height:54px;line-height:54px;display:block;transition:color .15s,background .15s;}
.topbar-nav a:hover{color:var(--white);background:rgba(255,255,255,0.05);}

.hero{background:var(--charcoal);padding:60px 40px 52px;position:relative;overflow:hidden;}
.hero::after{content:'';position:absolute;bottom:0;left:0;right:0;height:3px;background:linear-gradient(90deg,var(--orange) 0%,transparent 55%);}
.hero-inner{max-width:1040px;display:grid;grid-template-columns:1fr auto;gap:40px;align-items:end;}
.hero-eyebrow{font-family:'JetBrains Mono',monospace;font-size:10.5px;letter-spacing:0.18em;text-transform:uppercase;color:var(--orange);margin-bottom:14px;}
.hero h1{font-family:'Oswald',sans-serif;font-size:clamp(30px,4.5vw,50px);font-weight:700;letter-spacing:0.02em;text-transform:uppercase;color:var(--white);line-height:1.05;margin-bottom:8px;}
.hero-domain{font-family:'JetBrains Mono',monospace;font-size:12px;color:rgba(255,255,255,0.35);margin-bottom:26px;}
.hero-meta{display:flex;gap:28px;flex-wrap:wrap;}
.hero-meta-item .lbl{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:rgba(255,255,255,0.3);display:block;margin-bottom:2px;}
.hero-meta-item .val{font-size:13px;font-weight:500;color:rgba(255,255,255,0.72);}
.hero-stat{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.09);border-radius:6px;padding:20px 24px;text-align:center;min-width:130px;align-self:center;}
.hero-stat-val{font-family:'Oswald',sans-serif;font-size:40px;font-weight:700;color:var(--orange);line-height:1;display:block;}
.hero-stat-lbl{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(255,255,255,0.35);display:block;margin-top:6px;}

.page-body{max-width:1080px;margin:0 auto;padding:52px 40px 80px;}

.section{margin-bottom:60px;}
.section-head{display:flex;align-items:baseline;gap:14px;margin-bottom:26px;padding-bottom:10px;border-bottom:2px solid var(--charcoal);}
.sec-num{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:0.14em;color:var(--orange);flex-shrink:0;}
.sec-title{font-family:'Oswald',sans-serif;font-size:22px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:var(--charcoal);}
.subsection{margin-bottom:36px;}
.sub-head{font-family:'Oswald',sans-serif;font-size:12.5px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--graphite);margin-bottom:14px;display:flex;align-items:center;gap:8px;}
.sub-head::before{content:'';display:block;width:3px;height:13px;background:var(--orange);border-radius:2px;flex-shrink:0;}

.score-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:13px;margin-bottom:26px;}
.score-card{background:var(--white);border:1px solid var(--border);border-radius:5px;padding:17px 19px;box-shadow:var(--shadow-sm);position:relative;overflow:hidden;}
.score-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;}
.score-card.ok::before{background:var(--green);}
.score-card.warn::before{background:var(--warn-color);}
.score-card.fail::before{background:var(--red);}
.c-label{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:0.1em;text-transform:uppercase;color:var(--graphite);margin-bottom:7px;}
.c-val{font-family:'Oswald',sans-serif;font-size:28px;font-weight:700;line-height:1;margin-bottom:5px;}
.score-card.ok .c-val{color:var(--green);}
.score-card.warn .c-val{color:var(--warn-color);}
.score-card.fail .c-val{color:var(--red);}
.c-desc{font-size:12px;color:var(--graphite);line-height:1.45;}

.prose-box{background:var(--white);border:1px solid var(--border);border-radius:5px;padding:26px 30px;box-shadow:var(--shadow-sm);margin-bottom:26px;}
.prose-box p{font-size:15px;color:var(--charcoal);margin-bottom:13px;line-height:1.72;}
.prose-box p:last-child{margin-bottom:0;}
.prose-box strong{font-weight:600;}

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
.t-defend{background:#DFF0E8;color:var(--green);}
.t-weak{background:#FDF1DD;color:var(--warn-color);}
.t-gap{background:#FDEADF;color:var(--red);}

.topic-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:9px;margin-bottom:20px;}
.topic-item{background:var(--white);border:1px solid var(--border);border-radius:5px;padding:11px 14px;box-shadow:var(--shadow-sm);font-size:13.5px;font-weight:500;color:var(--charcoal);}
.topic-key{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--graphite);margin-top:3px;}

.footer{background:var(--charcoal);padding:30px 40px;text-align:center;}
.footer p{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.3);}

@media(max-width:720px){
  .hero{padding:40px 20px 36px;}
  .hero-inner{grid-template-columns:1fr;gap:20px;}
  .page-body{padding:32px 20px 60px;}
  .score-grid{grid-template-columns:1fr 1fr;}
  .topic-grid{grid-template-columns:1fr;}
}
</style>
</head>
<body>

<nav class="topbar">
  <a class="topbar-brand" href="#">Forge Growth</a>
  <ul class="topbar-nav">
    <li><a href="#overview">Summary</a></li>
    <li><a href="#rankings">Rankings</a></li>
    <li><a href="#opportunities">Gaps</a></li>
    <li><a href="#topics">Topics</a></li>
    <li><a href="#next">Next Steps</a></li>
  </ul>
</nav>

<header class="hero">
  <div class="hero-inner">
    <div>
      <div class="hero-eyebrow">Search Intelligence Brief</div>
      <h1>${escapeHtml(businessName)}</h1>
      <div class="hero-domain">${escapeHtml(scope.domain)}</div>
      <div class="hero-meta">
        <div class="hero-meta-item">
          <span class="lbl">Scout Date</span>
          <span class="val">${escapeHtml(scoutDate)}</span>
        </div>
        <div class="hero-meta-item">
          <span class="lbl">Markets</span>
          <span class="val">${escapeHtml(scope.locales.slice(0, 3).join(', ') || 'National')}</span>
        </div>
        <div class="hero-meta-item">
          <span class="lbl">Service Topics</span>
          <span class="val">${topics.length}</span>
        </div>
        <div class="hero-meta-item">
          <span class="lbl">Prepared By</span>
          <span class="val">Forge Growth</span>
        </div>
      </div>
    </div>
    <div class="hero-stat">
      <span class="hero-stat-val">${formatNumber(scope.total_opportunity_volume)}</span>
      <span class="hero-stat-lbl">Untapped Searches/mo</span>
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
    <div class="score-card ${overallClass}">
      <div class="c-label">Keywords Tracked</div>
      <div class="c-val">${formatNumber(totalTracked)}</div>
      <div class="c-desc">Total keywords analyzed</div>
    </div>
    <div class="score-card ok">
      <div class="c-label">Defending (Page 1)</div>
      <div class="c-val">${formatNumber(defending)}</div>
      <div class="c-desc">Ranking in top 10 positions</div>
    </div>
    <div class="score-card warn">
      <div class="c-label">At Risk (Page 2-3)</div>
      <div class="c-val">${formatNumber(weak)}</div>
      <div class="c-desc">Positions 11–30</div>
    </div>
    <div class="score-card ${gapClass}">
      <div class="c-label">Not Ranking</div>
      <div class="c-val">${formatNumber(gaps)}</div>
      <div class="c-desc">Missing from search results</div>
    </div>
  </div>

  <div class="prose-box">
    ${markdownParagraphsToHtml(narrativeSections.execSummary)}
  </div>
</section>

<!-- 02 — Current Rankings -->
<section class="section" id="rankings">
  <div class="section-head">
    <span class="sec-num">02 —</span>
    <h2 class="sec-title">Current Ranking Profile</h2>
  </div>

${topRanked.length > 0 ? `  <div class="tbl-wrap">
    <table>
      <thead>
        <tr>
          <th>Keyword</th>
          <th>Position</th>
          <th>Monthly Volume</th>
          <th>CPC</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
${topRanked.map((k) => {
  const posClass = k.position <= 3 ? 'ps' : k.position <= 10 ? 'ps' : k.position <= 20 ? 'pm' : 'pw';
  const statusTag = k.position <= 10 ? '<span class="tag t-defend">Defending</span>' : k.position <= 30 ? '<span class="tag t-weak">At Risk</span>' : '<span class="tag t-gap">Gap</span>';
  return `        <tr>
          <td>${escapeHtml(k.keyword)}</td>
          <td class="${posClass}">${k.position}</td>
          <td class="mono">${formatNumber(k.volume)}</td>
          <td class="mono">$${k.cpc.toFixed(2)}</td>
          <td>${statusTag}</td>
        </tr>`;
}).join('\n')}
      </tbody>
    </table>
  </div>` : `  <div class="prose-box"><p>No current rankings detected. This domain may be new or not yet indexed for the target keywords.</p></div>`}
</section>

<!-- 03 — Opportunity Analysis -->
<section class="section" id="opportunities">
  <div class="section-head">
    <span class="sec-num">03 —</span>
    <h2 class="sec-title">Opportunity Analysis</h2>
  </div>

  <div class="prose-box">
    ${markdownParagraphsToHtml(narrativeSections.opportunityAnalysis)}
  </div>

${topGaps.length > 0 ? `  <div class="subsection">
    <div class="sub-head">Top Gap Keywords</div>
    <div class="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>Keyword</th>
            <th>Topic</th>
            <th>Monthly Volume</th>
            <th>CPC</th>
          </tr>
        </thead>
        <tbody>
${topGaps.map((g) => `          <tr>
            <td>${escapeHtml(g.keyword)}</td>
            <td>${escapeHtml(g.topic)}</td>
            <td class="mono">${formatNumber(g.volume)}</td>
            <td class="mono">$${g.cpc.toFixed(2)}</td>
          </tr>`).join('\n')}
        </tbody>
      </table>
    </div>
  </div>` : ''}
</section>

<!-- 04 — Service Topics -->
<section class="section" id="topics">
  <div class="section-head">
    <span class="sec-num">04 —</span>
    <h2 class="sec-title">Service Topic Coverage</h2>
  </div>

  <div class="topic-grid">
${topics.map((t) => `    <div class="topic-item">
      ${escapeHtml(t.label)}
      <div class="topic-key">${escapeHtml(t.key)}</div>
    </div>`).join('\n')}
  </div>
</section>

<!-- 05 — Next Steps -->
<section class="section" id="next">
  <div class="section-head">
    <span class="sec-num">05 —</span>
    <h2 class="sec-title">Recommended Next Steps</h2>
  </div>

  <div class="prose-box">
    ${markdownParagraphsToHtml(narrativeSections.nextSteps)}
  </div>
</section>

</main>

<footer class="footer">
  <p>Prepared by Forge Growth &middot; ${escapeHtml(scoutDate)} &middot; Confidential</p>
</footer>

</body>
</html>`;
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { domain } = parseArgs();
  console.log(`\n=== Prospect Intelligence Brief: ${domain} ===`);

  // Load Scout data
  console.log('\n--- Loading Scout data ---');
  const { scope, narrative, keywords, scoutDate } = loadScoutData(domain);
  console.log(`  scope.json: ${scope.topics.length} topics, ${scope.gap_summary.total} gap entries`);
  console.log(`  narrative: ${narrative ? `${(Buffer.byteLength(narrative) / 1024).toFixed(1)}KB` : 'not found'}`);
  console.log(`  ranked_keywords: ${keywords.length} keywords`);

  // Generate narrative sections via Sonnet
  console.log('\n--- Generating narrative sections (Sonnet) ---');
  const narrativeSections = await generateNarrativeSections(scope, narrative, keywords);
  console.log(`  exec_summary: ${narrativeSections.execSummary.length} chars`);
  console.log(`  opportunity_analysis: ${narrativeSections.opportunityAnalysis.length} chars`);
  console.log(`  next_steps: ${narrativeSections.nextSteps.length} chars`);

  // Generate HTML
  console.log('\n--- Building HTML brief ---');
  const html = generateHtml(scope, keywords, narrativeSections, scoutDate);

  // Write to disk
  const reportsDir = path.join(AUDITS_BASE, domain, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const outputPath = path.join(reportsDir, 'prospect_brief.html');
  fs.writeFileSync(outputPath, html, 'utf-8');

  const sizeKB = (fs.statSync(outputPath).size / 1024).toFixed(1);
  console.log(`\n  Output: ${path.relative(process.cwd(), outputPath)} (${sizeKB}KB)`);
  console.log('=== Prospect Brief Complete ===\n');
}

main().catch((err) => {
  console.error('Prospect brief failed:', err);
  process.exit(1);
});
