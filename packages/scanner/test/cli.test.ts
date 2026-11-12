// CLI argument parsing tests (offline — no network, temp files only)
// Run: node --test packages/scanner/test/*.test.ts

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseArgs } from '../src/cli.ts';

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
