// Scan CLI (M1 trial-scan entry point)
// Usage:
//   node packages/scanner/src/cli.ts example.com openai.com ...
//   node packages/scanner/src/cli.ts --file domains.txt --out scans --concurrency 5
// Output: {out}/{domain}.json = { signals, afr } (local version of the spec's scans snapshot structure)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scoreAfr, type AfrResult } from '../../afr/src/index.ts';
import type { ScanSignals } from '../../shared/src/index.ts';
import { normalizeDomain } from './http.ts';
import { scanSite } from './scan.ts';

interface CliOptions {
  domains: string[];
  out: string;
  concurrency: number;
}

export async function parseArgs(argv: string[]): Promise<CliOptions> {
  const opts: CliOptions = { domains: [], out: 'scans', concurrency: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--file') opts.domains.push(...(await readFileLines(argv[++i])));
    else if (a === '--out') opts.out = argv[++i]!;
    else if (a === '--concurrency') opts.concurrency = Math.max(1, Number(argv[++i]));
    else if (!a.startsWith('--')) opts.domains.push(a);
  }
  return opts;
}

async function readFileLines(file?: string): Promise<string[]> {
  if (!file) return [];
  const text = await readFile(file, 'utf8');
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export interface SiteReport {
  domain: string;
  ok: boolean;
  score?: number;
  grade?: string;
  tag?: string;
  requests?: number;
  error?: string;
  ms: number;
}

/** Concurrently scan a batch of domains (concurrency ≤5, spec §4) */
export async function scanBatch(
  domains: string[],
  opts: { concurrency?: number; out?: string; onDone?: (r: SiteReport) => void } = {},
): Promise<{ reports: SiteReport[]; results: { domain: string; signals: ScanSignals; afr: AfrResult }[] }> {
  const concurrency = Math.min(opts.concurrency ?? 5, 5); // hard rule: concurrency never exceeds 5
  const queue = [...new Set(domains.map(normalizeDomain).filter(Boolean))];
  const reports: SiteReport[] = [];
  const results: { domain: string; signals: ScanSignals; afr: AfrResult }[] = [];

  if (opts.out) await mkdir(opts.out, { recursive: true });

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < queue.length) {
      const domain = queue[cursor++]!;
      const t0 = Date.now();
      try {
        const signals = await scanSite(domain);
        const afr = scoreAfr(signals);
        const report: SiteReport = {
          domain,
          ok: true,
          score: afr.score,
          grade: afr.grade,
          tag: afr.strategyTag,
          requests: undefined,
          ms: Date.now() - t0,
        };
        reports.push(report);
        results.push({ domain, signals, afr });
        if (opts.out) {
          await writeFile(path.join(opts.out, `${domain}.json`), JSON.stringify({ signals, afr }, null, 2));
        }
        opts.onDone?.(report);
      } catch (err) {
        const report: SiteReport = { domain, ok: false, error: (err as Error).message, ms: Date.now() - t0 };
        reports.push(report);
        opts.onDone?.(report);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { reports, results };
}

async function main(): Promise<void> {
  const opts = await parseArgs(process.argv.slice(2));
  if (opts.domains.length === 0) {
    console.error('Usage: node packages/scanner/src/cli.ts [--file domains.txt] [--out scans] [--concurrency 5] [domain ...]');
    process.exit(1);
  }

  const { reports } = await scanBatch(opts.domains, {
    concurrency: opts.concurrency,
    out: opts.out,
    onDone: (r) => {
      if (r.ok) {
        console.log(`${r.domain.padEnd(30)} ${String(r.score).padStart(3)} ${r.grade}  ${r.tag}  (${r.ms}ms)`);
      } else {
        console.log(`${r.domain.padEnd(30)} FAIL ${r.error} (${r.ms}ms)`);
      }
    },
  });

  const ok = reports.filter((r) => r.ok);
  console.log('\n── Summary ──');
  console.log(`Succeeded ${ok.length}/${reports.length}`);
  if (ok.length) {
    const scores = ok.map((r) => r.score!).sort((a, b) => a - b);
    const avg = scores.reduce((s, n) => s + n, 0) / scores.length;
    const dist: Record<string, number> = {};
    for (const r of ok) dist[r.grade!] = (dist[r.grade!] ?? 0) + 1;
    console.log(`Score min/avg/max = ${scores[0]}/${avg.toFixed(1)}/${scores[scores.length - 1]}`);
    console.log(`Grade distribution: ${Object.entries(dist).map(([g, n]) => `${g}:${n}`).join('  ')}`);
    const tags: Record<string, number> = {};
    for (const r of ok) tags[r.tag!] = (tags[r.tag!] ?? 0) + 1;
    console.log(`Strategy tags: ${Object.entries(tags).map(([t, n]) => `${t}:${n}`).join('  ')}`);
  }
}

// Run main only when executed as the entry point
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
