// scripts/prune-snapshot-bodies.test.mjs — the body-pruning tool must shrink
// the corpus without touching the evidence, the file style, or the meaning of
// a snapshot. Fully offline (no network, no crawl).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreAfr } from '../packages/afr/src/index.ts';
import { collectRows } from './d1-load.mjs';
import {
  parseArgs,
  pruneSnapshot,
  planRetention,
  domainOf,
  snapshotTime,
  PRUNE_MODES,
  UNUSED_BY_ENGINE,
  USED_BY_ENGINE,
} from './prune-snapshot-bodies.mjs';
import { isBodyMissing, missingEngineBodies, isReDerivable } from './rederive-signals.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'prune-snapshot-bodies.mjs');
const REDERIVE = join(here, 'rederive-signals.mjs');

/** A snapshot in the shape AFR-data stores ({ signals, afr }) */
function makeSnapshot(domain, body, { indent = 2, trailingNewline = false, at = '2026-11-17T03:02:15.060Z' } = {}) {
  const signals = {
    domain,
    fetchedAt: at,
    scannerVersion: 'scanner-0.1.0',
    robots: { status: 200, body: 'User-agent: *\nAllow: /', url: `https://${domain}/robots.txt` },
    llms: { status: 404, url: `https://${domain}/llms.txt` },
    homepage: { status: 200, body, url: `https://${domain}/` },
    aiFeatures: { chatWidget: true, aiSearch: false, developerConsole: false },
  };
  const snapshot = { signals, afr: scoreAfr(signals) };
  return JSON.stringify(snapshot, null, indent) + (trailingNewline ? '\n' : '');
}

/** A tiny scans tree: one domain with two snapshots, one with a single one */
function makeTree() {
  const dir = mkdtempSync(join(tmpdir(), 'afr-prune-'));
  mkdirSync(join(dir, '2026', '11', '16'), { recursive: true });
  mkdirSync(join(dir, '2026', '11', '17'), { recursive: true });
  writeFileSync(
    join(dir, '2026', '11', '16', 'old.example.json'),
    makeSnapshot('old.example', '<html><body>old page</body></html>', {
      indent: 1,
      trailingNewline: true,
      at: '2026-11-16T03:02:15.060Z',
    }),
  );
  writeFileSync(
    join(dir, '2026', '11', '17', 'old.example.json'),
    makeSnapshot('old.example', '<html><body>new page</body></html>', { at: '2026-11-17T03:02:15.060Z' }),
  );
  writeFileSync(
    join(dir, '2026', '11', '17', 'only.example.json'),
    makeSnapshot('only.example', '<html><body>only page</body></html>', { at: '2026-11-17T04:02:15.060Z' }),
  );
  return dir;
}

function runScript(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('parseArgs understands the documented flags', () => {
  const opts = parseArgs(['/tmp/x', '--write', '--keep', '3', '--max-age-days', '7', '--prune-text', 'unused']);
  assert.equal(opts.dir, '/tmp/x');
  assert.equal(opts.write, true);
  assert.equal(opts.keep, 3);
  assert.equal(opts.maxAgeDays, 7);
  assert.equal(opts.pruneText, 'unused');
  // dry run is the default
  assert.equal(parseArgs([]).write, false);
  assert.equal(parseArgs([]).keep, 1);
  assert.equal(parseArgs([]).pruneText, 'none');
});

test('parseArgs rejects nonsense', () => {
  assert.throws(() => parseArgs(['--keep', '-1']), /--keep/);
  assert.throws(() => parseArgs(['--keep', 'x']), /--keep/);
  assert.throws(() => parseArgs(['--prune-text', 'everything']), /--prune-text/);
  assert.throws(() => parseArgs(['--max-age-days', '-3']), /--max-age-days/);
  assert.throws(() => parseArgs(['--now', '17-11-2026']), /--now/);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
});

test('pruneSnapshot deletes the body key and leaves everything else alone', () => {
  const snapshot = JSON.parse(makeSnapshot('a.example', '<html></html>'));
  const pruned = pruneSnapshot(snapshot, PRUNE_MODES.none);
  assert.equal('body' in pruned.signals.homepage, false, 'the body key must be gone');
  assert.equal(pruned.signals.homepage.status, 200);
  assert.equal(pruned.signals.homepage.url, 'https://a.example/');
  assert.deepEqual(pruned.signals.robots, snapshot.signals.robots, 'other probes stay');
  assert.deepEqual(pruned.afr, snapshot.afr, 'the evidence block stays');
  assert.deepEqual(Object.keys(pruned.signals.homepage), ['status', 'url'], 'key order is kept');
  // pruning again changes nothing
  assert.deepEqual(pruneSnapshot(pruned, PRUNE_MODES.none), pruned);
});

test('pruneSnapshot only touches the fields of the selected mode', () => {
  const snapshot = JSON.parse(makeSnapshot('a.example', '<html></html>'));
  const unused = pruneSnapshot(snapshot, PRUNE_MODES.unused);
  assert.equal('body' in unused.signals.homepage, false);
  assert.equal('body' in unused.signals.robots, true, 'robots is read by the engine');
  const all = pruneSnapshot(snapshot, PRUNE_MODES.all);
  assert.equal('body' in all.signals.robots, false);
});

test('the prune modes cover every raw body exactly once', () => {
  assert.deepEqual(PRUNE_MODES.none, ['homepage']);
  assert.deepEqual([...PRUNE_MODES.unused].sort(), ['agentsMd', 'aiTxt', 'homepage', 'llmsFull']);
  assert.deepEqual([...PRUNE_MODES.all].sort(), [
    'agentsMd',
    'aiTxt',
    'homepage',
    'llms',
    'llmsFull',
    'robots',
    'sitemap',
  ]);
  // the engine reads exactly the bodies the "all" mode adds on top of "none"
  assert.deepEqual([...PRUNE_MODES.all].filter((f) => !PRUNE_MODES.none.includes(f)).sort(), [
    'agentsMd',
    'aiTxt',
    'llms',
    'llmsFull',
    'robots',
    'sitemap',
  ]);
  assert.deepEqual(UNUSED_BY_ENGINE, ['llmsFull', 'agentsMd', 'aiTxt']);
  assert.deepEqual(USED_BY_ENGINE, ['homepage', 'robots', 'llms', 'sitemap']);
  // every body the engine reads is either "unused" or "used"
  assert.deepEqual([...UNUSED_BY_ENGINE, ...USED_BY_ENGINE].sort(), [...PRUNE_MODES.all].sort());
});

test('planRetention keeps the newest snapshots of every domain', () => {
  const records = [
    { path: '/a', domain: 'x', time: 100, hasBody: true },
    { path: '/b', domain: 'x', time: 200, hasBody: true },
    { path: '/c', domain: 'y', time: 150, hasBody: true },
  ];
  const plan = planRetention(records, { keep: 1, maxAgeDays: null, referenceTime: 200 });
  assert.equal(plan.get('/b').keep, true);
  assert.equal(plan.get('/a').keep, false);
  assert.equal(plan.get('/c').keep, true, 'a domain with one snapshot keeps it');
});

test('planRetention counts the snapshots that carry a body, not the snapshots', () => {
  // the newest snapshot of the domain has no body: the older one that has a
  // body must keep it, otherwise the domain loses its re-derivation ability
  const records = [
    { path: '/a', domain: 'x', time: 100, hasBody: true },
    { path: '/b', domain: 'x', time: 200, hasBody: false },
  ];
  const plan = planRetention(records, { keep: 1, maxAgeDays: null, referenceTime: 200 });
  assert.equal(plan.get('/b').keep, true, 'nothing to prune');
  assert.equal(plan.get('/a').keep, true, 'the only body of the domain stays');
});

test('planRetention honors the age gate even for the newest snapshot', () => {
  const day = 86400000;
  const records = [
    { path: '/a', domain: 'x', time: 0, hasBody: true },
    { path: '/b', domain: 'x', time: 10 * day, hasBody: true },
  ];
  // the reference day is the 10th; the snapshot of the 10th is 0 days old
  const plan = planRetention(records, { keep: 5, maxAgeDays: 2, referenceTime: 10 * day });
  assert.equal(plan.get('/b').keep, true, 'the snapshot of the reference day stays');
  assert.equal(plan.get('/a').keep, false, 'older than the gate');
  assert.match(plan.get('/a').reason, /older than/);
  // one day later the newest snapshot is outside the gate as well
  const later = planRetention(records, { keep: 5, maxAgeDays: 0, referenceTime: 11 * day });
  assert.equal(later.get('/b').keep, false);
});

test('domainOf and snapshotTime fall back gracefully', () => {
  assert.equal(domainOf({ signals: { domain: 'a.example' } }, '/x/y.json'), 'a.example');
  assert.equal(domainOf({ afr: { domain: 'b.example' } }, '/x/y.json'), 'b.example');
  assert.equal(domainOf({}, '/x/c.example.json'), 'c.example');
  assert.equal(snapshotTime({ signals: { fetchedAt: '2026-11-17T00:00:00Z' } }, '/x/y.json'), Date.parse('2026-11-17T00:00:00Z'));
  assert.equal(snapshotTime({}, '/scans/2026/11/17/y.json'), Date.parse('2026-11-17T00:00:00Z'));
});

test('a dry run reports the saving and touches nothing', () => {
  const dir = makeTree();
  try {
    const out = runScript([dir]);
    assert.match(out, /dry run/);
    assert.match(out, /snapshots that lose their raw bodies: 1 of 3/);
    const before = readFileSync(join(dir, '2026', '11', '16', 'old.example.json'), 'utf8');
    assert.match(before, /old page/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--write prunes the superseded snapshot and keeps the evidence and the style', () => {
  const dir = makeTree();
  try {
    const oldPath = join(dir, '2026', '11', '16', 'old.example.json');
    const before = JSON.parse(readFileSync(oldPath, 'utf8'));
    const raw = readFileSync(oldPath, 'utf8');
    runScript([dir, '--write']);

    const after = JSON.parse(readFileSync(oldPath, 'utf8'));
    assert.equal('body' in after.signals.homepage, false, 'the body is gone');
    assert.equal(after.signals.homepage.status, 200);
    assert.deepEqual(after.afr, before.afr, 'the evidence block is untouched');
    assert.deepEqual(after.signals.aiFeatures, before.signals.aiFeatures, 'the verdict is untouched');
    // the file style survives: 1-space indent + trailing newline
    const out = readFileSync(oldPath, 'utf8');
    assert.equal(out.endsWith('\n'), true);
    assert.match(out, /\n {1}"afr"/, 'the 1-space indent is kept');
    assert.equal(out.includes('old page'), false);

    // the newest snapshot of the domain keeps its body
    const newest = readFileSync(join(dir, '2026', '11', '17', 'old.example.json'), 'utf8');
    assert.match(newest, /new page/);

    // a second run changes nothing (idempotent)
    const out2 = runScript([dir, '--write']);
    assert.match(out2, /snapshots that lose their raw bodies: 0 of 3/);
    assert.equal(readFileSync(oldPath, 'utf8'), out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--keep 0 removes every body, --keep 2 keeps two per domain', () => {
  const dir = makeTree();
  try {
    runScript([dir, '--write', '--keep', '0']);
    const files = ['2026/11/16/old.example.json', '2026/11/17/old.example.json', '2026/11/17/only.example.json'];
    for (const f of files) {
      const j = JSON.parse(readFileSync(join(dir, ...f.split('/')), 'utf8'));
      assert.equal('body' in j.signals.homepage, false, `${f} must lose its body`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const dir2 = makeTree();
  try {
    runScript([dir2, '--write', '--keep', '2']);
    const old = JSON.parse(readFileSync(join(dir2, '2026', '11', '16', 'old.example.json'), 'utf8'));
    assert.match(readFileSync(join(dir2, '2026', '11', '16', 'old.example.json'), 'utf8'), /old page/);
    assert.equal('body' in old.signals.homepage, true);
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('--max-age-days drops the body of the newest snapshot too', () => {
  const dir = makeTree();
  try {
    // reference day = the 18th: both snapshots are older than 0 days
    runScript([dir, '--write', '--max-age-days', '0', '--now', '2026-11-18']);
    assert.equal(/new page/.test(readFileSync(join(dir, '2026', '11', '17', 'old.example.json'), 'utf8')), false);
    assert.equal(/old page/.test(readFileSync(join(dir, '2026', '11', '16', 'old.example.json'), 'utf8')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const dir2 = makeTree();
  try {
    // reference day = the 17th: the snapshot of the 17th stays, the 16th goes
    runScript([dir2, '--write', '--max-age-days', '0', '--now', '2026-11-17']);
    assert.match(readFileSync(join(dir2, '2026', '11', '17', 'old.example.json'), 'utf8'), /new page/);
    assert.doesNotMatch(readFileSync(join(dir2, '2026', '11', '16', 'old.example.json'), 'utf8'), /old page/);
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('--prune-text unused also drops the bodies the engine never reads', () => {
  const dir = makeTree();
  try {
    const path = join(dir, '2026', '11', '16', 'old.example.json');
    const snapshot = JSON.parse(readFileSync(path, 'utf8'));
    snapshot.signals.llmsFull = { status: 200, body: '# full docs', url: 'https://old.example/llms-full.txt' };
    snapshot.signals.agentsMd = { status: 200, body: '# agents', url: 'https://old.example/agents.md' };
    snapshot.signals.aiTxt = { status: 200, body: '# ai', url: 'https://old.example/ai.txt' };
    writeFileSync(path, JSON.stringify(snapshot, null, 1) + '\n');

    runScript([dir, '--write', '--prune-text', 'unused']);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal('body' in after.signals.llmsFull, false);
    assert.equal('body' in after.signals.agentsMd, false);
    assert.equal('body' in after.signals.aiTxt, false);
    assert.equal('body' in after.signals.robots, true, 'robots is read by the engine');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the re-derivation skips a pruned snapshot and keeps its verdict', () => {
  const dir = makeTree();
  try {
    const path = join(dir, '2026', '11', '16', 'old.example.json');
    const before = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(before.signals.aiFeatures.chatWidget, true, 'the fixture starts positive');

    runScript([dir, '--write']);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(after.signals.aiFeatures.chatWidget, true, 'the stored verdict is kept');

    // the re-derivation must skip it, not judge it as "no chat widget"
    const out = execFileSync(process.execPath, [REDERIVE, dir], { encoding: 'utf8' });
    assert.match(out, /raw body pruned \(homepage 2xx but the body is gone — verdict kept as stored\): 1/);
    const again = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(again.signals.aiFeatures, before.signals.aiFeatures);
    assert.deepEqual(again.afr, before.afr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the re-derivation does not treat a pruned snapshot as engine drift', () => {
  const dir = makeTree();
  try {
    runScript([dir, '--write']);
    const out = execFileSync(process.execPath, [REDERIVE, dir], { encoding: 'utf8' });
    assert.match(out, /snapshots left out of the comparison because a body the engine reads is gone: 1/);
    assert.doesNotMatch(out, /snapshots whose stored score is behind the engine: 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isBodyMissing tells "the body is gone" from "not probed"', () => {
  assert.equal(isBodyMissing({ status: 200, url: 'https://x/' }), true);
  assert.equal(isBodyMissing({ status: 200, body: '<html></html>' }), false);
  assert.equal(isBodyMissing({ status: 404 }), false, 'a 404 was never probed');
  assert.equal(isBodyMissing({ status: 403, body: 'blocked' }), false);
  assert.equal(isBodyMissing(undefined), false);
  assert.equal(isReDerivable({ status: 200, url: 'https://x/' }), false);
  assert.deepEqual(missingEngineBodies({ homepage: { status: 200 }, robots: { status: 200, body: 'x' } }), [
    'homepage',
  ]);
});

test('the D1 loader still reads a pruned snapshot', () => {
  const dir = makeTree();
  try {
    runScript([dir, '--write']);
    const dayDir = join(dir, '2026', '11', '16');
    const files = readdirSync(dayDir).filter((f) => f.endsWith('.json'));
    const { siteRows, scanRows } = collectRows(dayDir, '2026/11/16', files);
    assert.equal(siteRows.length, 1);
    assert.equal(scanRows.length, 1);
    // the title is gone with the body — the loader must not crash and must not
    // invent a title
    assert.match(siteRows[0][2], /^NULL$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the report names the volume composition', () => {
  const dir = makeTree();
  try {
    const out = runScript([dir]);
    assert.match(out, /## Where the bytes are/);
    assert.match(out, /`signals\.homepage\.body`/);
    assert.match(out, /## Per day/);
    assert.match(out, /bytes saved:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
