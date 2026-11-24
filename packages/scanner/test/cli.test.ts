// CLI argument parsing tests (offline — no network, temp files only)
// Run: node --test packages/scanner/test/*.test.ts

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseArgs, scanBatch } from '../src/cli.ts';

async function withDomainFile(lines: string[], fn: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cli-args-'));
  const file = path.join(dir, 'domains.txt');
  await writeFile(file, lines.join('\n') + '\n');
  try {
    await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it('reports success only after each snapshot is durably named', async () => {
  await withDomainFile([], async (file) => {
    const out = path.dirname(file);
    await mkdir(path.join(out, 'blocked.example.json'));
    const scan = async (domain: string) => ({
      domain, fetchedAt: '2026-11-24T00:00:00Z', scannerVersion: 'fixture',
    });
    const { reports, results } = await scanBatch(['ok.example', 'blocked.example'], { scan, out });
    assert.deepEqual(results.map((r) => r.domain), ['ok.example']);
    assert.deepEqual(Object.fromEntries(reports.map((r) => [r.domain, r.ok])), {
      'ok.example': true, 'blocked.example': false,
    });
    assert.equal(JSON.parse(await readFile(path.join(out, 'ok.example.json'), 'utf8')).signals.domain, 'ok.example');
  });
});

describe('parseArgs --file/--offset/--limit', () => {
  it('reads a domain file without offset/limit (defaults keep the full list)', async () => {
    await withDomainFile(['a.example', 'b.example', 'c.example'], async (file) => {
      const opts = await parseArgs(['--file', file]);
      assert.deepEqual(opts.domains, ['a.example', 'b.example', 'c.example']);
      assert.equal(opts.offset, 0);
      assert.equal(opts.limit, Infinity);
    });
  });

  it('--offset skips the first N lines of the file', async () => {
    await withDomainFile(['a.example', 'b.example', 'c.example'], async (file) => {
      const opts = await parseArgs(['--file', file, '--offset', '2']);
      assert.deepEqual(opts.domains, ['c.example']);
    });
  });

  it('--limit keeps at most N domains after the offset', async () => {
    await withDomainFile(['a.example', 'b.example', 'c.example'], async (file) => {
      const opts = await parseArgs(['--file', file, '--limit', '2']);
      assert.deepEqual(opts.domains, ['a.example', 'b.example']);
      const sliced = await parseArgs(['--file', file, '--offset', '1', '--limit', '1']);
      assert.deepEqual(sliced.domains, ['b.example']);
    });
  });

  it('flag order does not matter and invalid values degrade safely', async () => {
    await withDomainFile(['a.example', 'b.example', 'c.example'], async (file) => {
      const opts = await parseArgs(['--offset', '1', '--file', file, '--limit', '5']);
      assert.deepEqual(opts.domains, ['b.example', 'c.example']);
      const bad = await parseArgs(['--file', file, '--offset', 'abc']);
      assert.equal(bad.offset, 0);
      assert.deepEqual(bad.domains, ['a.example', 'b.example', 'c.example']);
      const past = await parseArgs(['--file', file, '--offset', '10']);
      assert.deepEqual(past.domains, []);
    });
  });
});
