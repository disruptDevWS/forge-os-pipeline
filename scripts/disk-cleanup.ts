#!/usr/bin/env npx tsx
/**
 * disk-cleanup.ts — Retain only the N most recent date directories per category.
 *
 * For each domain in audits/, each subdirectory (auditor, research, architecture,
 * scout, content) keeps only the `--keep` most recent date dirs (default: 3).
 * Older directories are removed.
 *
 * Usage:
 *   npx tsx scripts/disk-cleanup.ts              # dry-run (default)
 *   npx tsx scripts/disk-cleanup.ts --apply       # actually delete
 *   npx tsx scripts/disk-cleanup.ts --keep 5      # keep 5 most recent
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const AUDITS_BASE = path.resolve(process.cwd(), 'audits');
const CATEGORIES = ['auditor', 'research', 'architecture', 'scout', 'content'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface CliOpts {
  keep: number;
  apply: boolean;
}

function parseOpts(): CliOpts {
  const args = process.argv.slice(2);
  let keep = 3;
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keep' && args[i + 1]) {
      keep = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--apply') {
      apply = true;
    }
  }
  return { keep, apply };
}

function rmDir(dirPath: string): void {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function main() {
  const opts = parseOpts();
  if (!fs.existsSync(AUDITS_BASE)) {
    console.log('No audits/ directory found.');
    return;
  }

  console.log(`Disk cleanup: keep=${opts.keep}, mode=${opts.apply ? 'APPLY' : 'DRY-RUN'}\n`);

  const domains = fs.readdirSync(AUDITS_BASE).filter((d) => {
    const full = path.join(AUDITS_BASE, d);
    return !d.startsWith('.') && fs.statSync(full).isDirectory();
  });

  let totalRemoved = 0;

  for (const domain of domains) {
    const domainPath = path.join(AUDITS_BASE, domain);
    for (const category of CATEGORIES) {
      const catPath = path.join(domainPath, category);
      if (!fs.existsSync(catPath) || !fs.statSync(catPath).isDirectory()) continue;

      const dateDirs = fs.readdirSync(catPath)
        .filter((d) => DATE_RE.test(d) && fs.statSync(path.join(catPath, d)).isDirectory())
        .sort()
        .reverse(); // newest first

      if (dateDirs.length <= opts.keep) continue;

      const toRemove = dateDirs.slice(opts.keep);
      for (const dir of toRemove) {
        const fullPath = path.join(catPath, dir);
        console.log(`  ${opts.apply ? 'DELETE' : 'would delete'}: ${domain}/${category}/${dir}`);
        if (opts.apply) {
          rmDir(fullPath);
        }
        totalRemoved++;
      }
    }
  }

  console.log(`\n${opts.apply ? 'Removed' : 'Would remove'} ${totalRemoved} directories across ${domains.length} domains.`);
  if (!opts.apply && totalRemoved > 0) {
    console.log('Run with --apply to actually delete.');
  }
}

main();
