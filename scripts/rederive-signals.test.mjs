// scripts/rederive-signals.test.mjs — the offline re-derivation must change
// only what the judgement changed: the signals and the re-scored block, in
// the file's own style, and nothing else. Fully offline (no network, no crawl).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreAfr } from '../packages/afr/src/index.ts';
import {
  detectStyle,
  serialize,
  isReDerivable,
  isTruncated,
  featuresEqual,
  featureTransitions,
  jsonDiff,
  parseArgs,
  DEFAULT_SCANS_DIR,
} from './rederive-signals.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'rederive-signals.mjs');

/** A snapshot in the shape AFR-data stores ({ signals, afr }) */
function makeSnapshot(domain, body, features, { indent = 2, trailingNewline = false } = {}) {
  const signals = {
    domain,
    fetchedAt: '2026-11-17T03:02:15.060Z',
    scannerVersion: 'scanner-0.1.0',
    homepage: { status: 200, body, url: `https://${domain}/` },
    robots: { status: 200, body: 'User-agent: *\nAllow: /', url: `https://${domain}/robots.txt` },
    aiFeatures: features,
  };
  const snapshot = { signals, afr: scoreAfr(signals) };
  return JSON.stringify(snapshot, null, indent) + (trailingNewline ? '\n' : '');
}

function runScript(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('detectStyle / serialize keep the file style byte for byte', () => {
  for (const [indent, trailingNewline] of [
    [2, false],
    [1, true],
  ]) {
    const raw = makeSnapshot('a.example', '<html></html>', { chatWidget: false }, { indent, trailingNewline });
    const style = detectStyle(raw);
    assert.equal(style.indent, indent);
    assert.equal(style.trailingNewline, trailingNewline);
    assert.equal(serialize(JSON.parse(raw), style), raw);
  }
});

test('isReDerivable gates on a 2xx homepage with a body', () => {
  assert.equal(isReDerivable({ status: 200, body: '<html></html>' }), true);
  assert.equal(isReDerivable({ status: 202, body: '<html></html>' }), true);
  // a challenged homepage is not a homepage
  assert.equal(isReDerivable({ status: 403, body: '<html>blocked</html>' }), false);
  assert.equal(isReDerivable({ status: 200, body: '' }), false);
  assert.equal(isReDerivable({ status: undefined, body: '<html></html>' }), false);
  assert.equal(isReDerivable(undefined), false);
  // a body at the scanner cap was truncated
  assert.equal(isTruncated({ body: 'x'.repeat(1024 * 1024) }), true);
  assert.equal(isTruncated({ body: 'x'.repeat(10) }), false);
});

test('feature comparison reports the transition, not the whole object', () => {
  assert.equal(featuresEqual({ chatWidget: true }, { chatWidget: true }), true);
  assert.equal(featuresEqual({ chatWidget: true }, { chatWidget: false }), false);
  assert.deepEqual(featureTransitions({ chatWidget: true, aiSearch: false }, { chatWidget: false, aiSearch: true }), [
    'chatWidget:true->false',
    'aiSearch:false->true',
  ]);
});

test('jsonDiff points at the changed paths only', () => {
  const a = { signals: { aiFeatures: { chatWidget: true } }, afr: { score: 10 } };
  const b = { signals: { aiFeatures: { chatWidget: false } }, afr: { score: 6 } };
  assert.deepEqual(jsonDiff(a, b).sort(), ['afr.score', 'signals.aiFeatures.chatWidget']);
});

test('parseArgs understands the documented flags', () => {
  const opts = parseArgs(['/tmp/x', '--write', '--date', '2026/11/17', '--out', '/tmp/y']);
  assert.equal(opts.dir, '/tmp/x');
  assert.equal(opts.write, true);
  assert.deepEqual(opts.dates, ['2026/11/17']);
  assert.equal(opts.out, '/tmp/y');
  // dry run is the default
  assert.equal(parseArgs([]).write, false);
  assert.equal(parseArgs([]).dir, DEFAULT_SCANS_DIR);
});

test('a dry run reports without touching a snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afr-rederive-'));
  try {
    mkdirSync(join(dir, '2026', '11', '17'), { recursive: true });
    const body = '<html><body><script type="application/json">{"x":"Discord - Group Chat"}</script></body></html>';
    const file = join(dir, '2026', '11', '17', 'chat.example.json');
    const raw = makeSnapshot('chat.example', body, { chatWidget: true, aiSearch: false, developerConsole: false });
    writeFileSync(file, raw);

    const out = runScript([dir]);
    assert.match(out, /signals changed: 1/);
    assert.match(out, /chatWidget:true->false: 1/);
    assert.equal(readFileSync(file, 'utf8'), raw, 'a dry run must not write');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--write changes the signals and the score, and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afr-rederive-'));
  try {
    mkdirSync(join(dir, '2026', '11', '17'), { recursive: true });
    const body = '<html><body><script type="application/json">{"x":"Discord - Group Chat"}</script></body></html>';
    const file = join(dir, '2026', '11', '17', 'chat.example.json');
    const raw = makeSnapshot('chat.example', body, { chatWidget: true, aiSearch: false, developerConsole: false });
    writeFileSync(file, raw);
    const before = JSON.parse(raw);

    runScript([dir, '--write']);
    const afterRaw = readFileSync(file, 'utf8');
    const after = JSON.parse(afterRaw);

    // the verdict follows the markup, the score follows the verdict
    assert.equal(after.signals.aiFeatures.chatWidget, false);
    assert.equal(after.afr.score, before.afr.score - 4);
    // the style of the file survives
    assert.equal(detectStyle(afterRaw).indent, 2);
    assert.equal(afterRaw.endsWith('\n'), false);
    // no other signal moved
    assert.deepEqual(
      { ...after.signals, aiFeatures: before.signals.aiFeatures },
      before.signals,
    );
    // the write touched the signals and the re-scored block only
    const changed = jsonDiff(before, after);
    assert.ok(changed.includes('signals.aiFeatures.chatWidget'));
    assert.ok(changed.every((p) => p.startsWith('signals.aiFeatures.') || p.startsWith('afr.')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a snapshot whose markup really carries a chat widget keeps its points', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afr-rederive-'));
  try {
    mkdirSync(join(dir, '2026', '11', '17'), { recursive: true });
    const body =
      '<html><body><script src="https://widget.intercom.io/widget/abc123.js"></script></body></html>';
    const file = join(dir, '2026', '11', '17', 'real.example.json');
    const raw = makeSnapshot('real.example', body, { chatWidget: true, aiSearch: false, developerConsole: false });
    writeFileSync(file, raw);

    const out = runScript([dir, '--write']);
    assert.match(out, /signals changed: 0/);
    assert.equal(readFileSync(file, 'utf8'), raw, 'an unchanged verdict must not rewrite the file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a challenged homepage keeps "not probed" instead of gaining a verdict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afr-rederive-'));
  try {
    mkdirSync(join(dir, '2026', '11', '17'), { recursive: true });
    const signals = {
      domain: 'blocked.example',
      fetchedAt: '2026-11-17T03:02:15.060Z',
      scannerVersion: 'scanner-0.1.0',
      homepage: { status: 403, body: '<html>blocked</html>' },
    };
    const snapshot = { signals, afr: scoreAfr(signals) };
    const file = join(dir, '2026', '11', '17', 'blocked.example.json');
    writeFileSync(file, JSON.stringify(snapshot, null, 2));

    const out = runScript([dir, '--write']);
    assert.match(out, /re-derivable \(homepage 2xx with body\): 0/);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).signals.aiFeatures, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
