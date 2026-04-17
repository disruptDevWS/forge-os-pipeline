#!/usr/bin/env npx tsx
/**
 * verify-embeddings.ts — Integration smoke test for embedding infrastructure.
 *
 * Usage: npm run verify:embeddings
 *
 * Runs against live Supabase + OpenAI to confirm:
 * 1. embed() stores and retrieves correctly
 * 2. Cache hits work on second run
 * 3. findSimilar() returns sensible results
 * 4. similarityBatch() produces expected semantic similarity values
 *
 * Environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { embed, embedBatch, findSimilar, similarityBatch } from '../src/embeddings/index.js';
import type { ContentType } from '../src/embeddings/index.js';

// ── Env loading (same pattern as other scripts) ───────────────

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

// ── Test runner ───────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];

function pass(name: string, detail: string): void {
  results.push({ name, passed: true, detail });
  console.log(`  ✓ ${name}: ${detail}`);
}

function fail(name: string, detail: string): void {
  results.push({ name, passed: false, detail });
  console.error(`  ✗ ${name}: ${detail}`);
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();

  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY'];
  for (const key of required) {
    if (!process.env[key]) {
      console.error(`Missing env var: ${key}`);
      process.exit(1);
    }
  }

  console.log('\n=== Embedding Infrastructure Verification ===\n');

  // ── Test 1: Embed 10 keyword variants ─────────────────────
  console.log('1. Embedding 10 keyword variants...');

  const keywords = [
    'EMT training Boise',
    'Boise EMT training',
    'EMT certification',
    'emergency medical technician training',
    'EMT course Boise Idaho',
    'paramedic training program',
    'first responder certification',
    'CPR certification Boise',
    'restaurant reviews',
    'Italian restaurants downtown',
  ];

  const contentType: ContentType = 'keyword';
  const batchItems = keywords.map((text, i) => ({
    text,
    contentType,
    contentId: `verify-${i}`,
  }));

  const batchResults = await embedBatch(batchItems);

  let embedded = 0;
  let cached = 0;
  let failed = 0;
  for (let i = 0; i < batchResults.length; i++) {
    const r = batchResults[i];
    if (!r) {
      fail(`embed[${i}]`, `"${keywords[i]}" → null (API failure)`);
      failed++;
    } else {
      const status = r.fromCache ? 'CACHE' : 'NEW';
      console.log(`    [${status}] "${keywords[i]}" → ${r.embedding.length}d vector`);
      if (r.fromCache) cached++;
      else embedded++;
    }
  }

  const total = embedded + cached;
  if (total === 10) {
    pass('embedBatch', `${embedded} new, ${cached} cached, ${failed} failed`);
  } else {
    fail('embedBatch', `Only ${total}/10 succeeded (${failed} failures)`);
  }

  // ── Test 2: Re-embed same inputs → should all be cache hits ─
  console.log('\n2. Re-embedding same inputs (cache verification)...');

  const reResults = await embedBatch(batchItems);
  const allCached = reResults.every((r) => r?.fromCache === true);
  if (allCached) {
    pass('cache-hit', 'All 10 re-embeddings returned fromCache: true');
  } else {
    const misses = reResults.filter((r) => r && !r.fromCache).length;
    fail('cache-hit', `${misses}/10 were cache misses (expected 0)`);
  }

  // ── Test 3: findSimilar() ─────────────────────────────────
  console.log('\n3. Finding similar embeddings to "EMT training Boise"...');

  const queryResult = batchResults[0];
  if (queryResult) {
    const similar = await findSimilar(queryResult.embedding, 'keyword', {
      threshold: 0.5,
      limit: 5,
      excludeContentId: 'verify-0',
    });

    console.log(`    Found ${similar.length} matches:`);
    for (const match of similar) {
      console.log(`      ${match.similarity.toFixed(4)} — "${match.text_input}"`);
    }

    if (similar.length > 0) {
      pass('findSimilar', `${similar.length} matches, top: ${similar[0].similarity.toFixed(4)}`);
    } else {
      fail('findSimilar', 'No matches returned (expected at least 1)');
    }
  } else {
    fail('findSimilar', 'Skipped — no embedding for query text');
  }

  // ── Test 4: similarityBatch() with known pairs ────────────
  console.log('\n4. Similarity matrix for known pairs...');

  const setA = [
    { text: 'EMT training Boise', contentType, contentId: 'sim-a0' },
    { text: 'EMT training', contentType, contentId: 'sim-a1' },
    { text: 'EMT training', contentType, contentId: 'sim-a2' },
  ];
  const setB = [
    { text: 'Boise EMT training', contentType, contentId: 'sim-b0' },
    { text: 'EMT certification', contentType, contentId: 'sim-b1' },
    { text: 'restaurant reviews', contentType, contentId: 'sim-b2' },
  ];

  const matrix = await similarityBatch(setA, setB);

  console.log('    Matrix (rows=A, cols=B):');
  const bLabels = ['Boise EMT trn', 'EMT cert', 'restaurant'];
  const aLabels = ['EMT trn Boise', 'EMT trn', 'EMT trn'];
  console.log(`    ${''.padEnd(16)}${bLabels.map((l) => l.padEnd(16)).join('')}`);
  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i].map((v) => v.toFixed(4).padEnd(16)).join('');
    console.log(`    ${aLabels[i].padEnd(16)}${row}`);
  }

  // Known-value checks (loose ranges for model stability)
  const wordOrderSim = matrix[0][0]; // "EMT training Boise" vs "Boise EMT training"
  const relatedSim = matrix[1][1]; // "EMT training" vs "EMT certification"
  const unrelatedSim = matrix[1][2]; // "EMT training" vs "restaurant reviews"

  if (wordOrderSim > 0.90) {
    pass('word-order', `"EMT training Boise" vs "Boise EMT training" = ${wordOrderSim.toFixed(4)} (> 0.90)`);
  } else {
    fail('word-order', `${wordOrderSim.toFixed(4)} (expected > 0.90)`);
  }

  if (relatedSim > 0.75 && relatedSim < 0.95) {
    pass('related', `"EMT training" vs "EMT certification" = ${relatedSim.toFixed(4)} (0.75–0.95)`);
  } else {
    fail('related', `${relatedSim.toFixed(4)} (expected 0.75–0.95)`);
  }

  if (unrelatedSim < 0.35) {
    pass('unrelated', `"EMT training" vs "restaurant reviews" = ${unrelatedSim.toFixed(4)} (< 0.35)`);
  } else {
    fail('unrelated', `${unrelatedSim.toFixed(4)} (expected < 0.35)`);
  }

  // ── Summary ───────────────────────────────────────────────
  console.log('\n=== Summary ===\n');
  const passed = results.filter((r) => r.passed).length;
  const totalTests = results.length;
  console.log(`${passed}/${totalTests} checks passed\n`);

  if (passed < totalTests) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
