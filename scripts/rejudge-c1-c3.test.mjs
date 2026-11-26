// scripts/rejudge-c1-c3.test.mjs — check-level re-judge of the two L3 checks
// whose evidence rules changed (MCP handshake, API-docs/OpenAPI split).
// Run: node --test scripts/*.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRejudge, main, rejudgeC1, rejudgeC3 } from './rejudge-c1-c3.mjs';
import { detectStyle, jsonDiff } from './rederive-signals.mjs';

const C1_CONFLATED_DETAIL =
  'llms.txt references an API; homepage links API/docs paths; OpenAPI document discovered; ' +
  'API documentation entry point present; OpenAPI: https://example.com/openapi.json';

function check(id, awarded, status, detail, max) {
  return { id, layer: 'L3', name: id, awarded, max, status, evidence: { source: 'fixture', detail } };
}

/** Minimal snapshot with a full L3 layer; score/grade are derived from the layers */
function fixture({ signals = {}, c1, c3, state = 'scored', l1 = 35, l2 = 40, indent = 1, trailingNewline = true } = {}) {
  const checks = [
    c1 ?? check('l3.public-api', 8, 'pass', C1_CONFLATED_DETAIL, 8),
    check('l3.agent-instructions', 4, 'pass', 'agents.md reachable (2xx)', 4),
    c3 ?? check('l3.mcp', 0, 'fail', 'MCP probed; no endpoint found', 6),
    check('l3.site-ai-features', 0, 'fail', 'no in-site chat/assistant', 7),
  ];
  const l3 = checks.reduce((s, c) => s + c.awarded, 0);
  const score = Math.round(l1 + l2 + l3);
  const gradeFor = (s) => (s >= 75 ? 'A' : s >= 60 ? 'B' : s >= 42 ? 'C' : s >= 25 ? 'D' : 'F');
  const snapshot = {
    signals: {
      domain: 'example.com',
      fetchedAt: '2026-11-20T00:00:00.000Z',
      scannerVersion: 'scanner-0.2.0',
      robots: { status: 200, body: 'User-agent: *\nAllow: /\n' },
      llms: { status: 404 },
      homepage: { status: 200, body: '<html></html>' },
      agentsMd: { status: 404 },
      openapi: { probed: true, found: false },
      apiDocs: { found: false, urls: [] },
      mcp: { probed: true, found: false },
      ...signals,
    },
    afr: {
      domain: 'example.com',
      engineVersion: 'afr-1.5.0',
      scannerVersion: 'scanner-0.2.0',
      scannedAt: '2026-11-20T00:00:00.000Z',
      score,
      grade: state === 'pending' ? 'Pending' : gradeFor(score),
      state,
      strategyTag: 'AI-Open',
      layers: [
        { layer: 'L1', name: 'Reachability', awarded: l1, max: 35, checks: [] },
        { layer: 'L2', name: 'Legibility', awarded: l2, max: 40, checks: [] },
        { layer: 'L3', name: 'Actionability', awarded: l3, max: 25, checks },
      ],
      breakdown: Object.fromEntries(checks.map((c) => [c.id, c.awarded])),
    },
  };
  const raw = JSON.stringify(snapshot, null, indent) + (trailingNewline ? '\n' : '');
  return { snapshot, raw };
}

describe('rejudgeC3 (MCP handshake rule)', () => {
  it('discovery without tools → 0/unknown with the discovered detail', () => {
    const r = rejudgeC3({ probed: true, found: true, urls: ['https://example.com/.well-known/mcp'] });
    assert.equal(r.awarded, 0);
    assert.equal(r.status, 'unknown');
    assert.match(r.detail, /no verified tools\/list handshake/);
  });

  it('verified tools → 6/pass; empty tool list → 0/fail; no probe → 0/unknown', () => {
    const ok = rejudgeC3({ probed: true, found: true, urls: ['x'], tools: ['a', 'b'] });
    assert.equal(ok.awarded, 6);
    assert.equal(ok.status, 'pass');
    assert.match(ok.detail, /tools\/list handshake verified: a, b/);

    const empty = rejudgeC3({ probed: true, found: true, urls: ['x'], tools: [] });
    assert.equal(empty.awarded, 0);
    assert.equal(empty.status, 'fail');

    const none = rejudgeC3(undefined);
    assert.equal(none.awarded, 0);
    assert.equal(none.status, 'unknown');
    assert.equal(none.detail, 'MCP not probed');
  });

  it('caps the displayed tool list at 8 names', () => {
    const tools = Array.from({ length: 12 }, (_, i) => `tool${i}`);
    const r = rejudgeC3({ probed: true, found: true, urls: ['x'], tools });
    assert.match(r.detail, /… \(\+4\)$/);
  });
});

describe('rejudgeC1 (OpenAPI/docs split)', () => {
  const openapiSignals = {
    apiDocs: { found: true, urls: [] }, // conflated: found via the OpenAPI hit
    openapi: { probed: true, found: true, urls: ['https://example.com/openapi.json'] },
  };

  it('recomputes the stored award from markers and drops the conflated docs entry', () => {
    const old = check('l3.public-api', 8, 'pass', C1_CONFLATED_DETAIL, 8);
    const r = rejudgeC1(
      {
        ...openapiSignals,
        llms: { status: 200, body: 'Our public API endpoint list lives here. Nothing else.' },
      },
      old,
    );
    assert.equal(r.awarded, 6);
    assert.equal(r.status, 'partial');
    assert.doesNotMatch(r.detail, /homepage links API\/docs paths/);
    assert.match(r.detail, /no API documentation entry point/);
    assert.match(r.detail, /OpenAPI document discovered/);
  });

  it('keeps the docs entry when llms.txt itself names the documentation', () => {
    const old = check('l3.public-api', 8, 'pass', C1_CONFLATED_DETAIL, 8);
    const r = rejudgeC1(
      { ...openapiSignals, llms: { status: 200, body: 'API. See the documentation at /reference.' } },
      old,
    );
    assert.equal(r.awarded, 8);
    assert.equal(r.status, 'pass');
  });

  it('keeps the stored docs entry when the llms.txt body was pruned (benefit of the doubt)', () => {
    const old = check('l3.public-api', 8, 'pass', C1_CONFLATED_DETAIL, 8);
    const r = rejudgeC1({ ...openapiSignals, llms: { status: 200 } }, old);
    assert.equal(r.awarded, 8);
    assert.match(r.detail, /API documentation entry point present/);
  });

  it('keeps the docs entry when the homepage really links API/docs paths', () => {
    const old = check(
      'l3.public-api',
      7,
      'partial',
      'homepage links API/docs paths; API documentation entry point present; OpenAPI not probed',
      8,
    );
    const r = rejudgeC1(
      { apiDocs: { found: true, urls: ['https://example.com/docs'] }, openapi: { probed: true, found: false }, llms: { status: 404 } },
      old,
    );
    assert.equal(r.awarded, 7);
    assert.match(r.detail, /homepage links API\/docs paths/);
  });

  it('refuses to guess when the markers do not decompose back into the stored award', () => {
    const old = check('l3.public-api', 7, 'partial', 'OpenAPI document discovered', 8);
    const r = rejudgeC1(openapiSignals, old);
    assert.ok(r.skip, 'expected a skip');
  });
});

describe('applyRejudge (snapshot level)', () => {
  it('C3 discovery-only: award 6→0, score/grade/breakdown/engineVersion follow', () => {
    const { snapshot } = fixture({
      // C1 must be stable here: conflated flag + pruned llms body → benefit of
      // the doubt keeps its 8, so the delta is exactly the MCP −6.
      signals: {
        apiDocs: { found: true, urls: [] },
        openapi: { probed: true, found: true, urls: ['https://example.com/openapi.json'] },
        llms: { status: 200 },
        mcp: { probed: true, found: true, urls: ['https://example.com/.well-known/mcp'] },
      },
      c3: check('l3.mcp', 6, 'pass', 'MCP endpoint found: https://example.com/.well-known/mcp', 6),
      score: 93,
    });
    const r = applyRejudge(snapshot);
    assert.equal(r.changed, true);
    assert.equal(r.after.c3, 0);
    assert.equal(r.after.score, 87);
    assert.equal(r.after.grade, 'A');
    assert.equal(r.after.engineVersion, 'afr-1.6.0');
    assert.equal(snapshot.afr.breakdown['l3.mcp'], 0);
    assert.equal(snapshot.afr.layers[2].awarded, 12);
    const c3 = snapshot.afr.layers[2].checks.find((c) => c.id === 'l3.mcp');
    assert.equal(c3.status, 'unknown');
    assert.match(c3.evidence.detail, /no verified tools\/list handshake/);
  });

  it('C1 conflated OpenAPI: award 8→6 and signals.apiDocs re-derived from urls', () => {
    const { snapshot } = fixture({
      signals: {
        apiDocs: { found: true, urls: [] },
        openapi: { probed: true, found: true, urls: ['https://example.com/openapi.json'] },
        llms: { status: 200, body: 'Our public API endpoint list lives here. Nothing else.' },
      },
      l1: 30,
      l2: 34, // before 30+34+12=76 (A) → after −2 = 74 (B)
    });
    const r = applyRejudge(snapshot);
    assert.equal(r.changed, true);
    assert.equal(r.after.c1, 6);
    assert.equal(r.after.score, 74);
    assert.equal(r.after.grade, 'B'); // 76 A → 74 B
    assert.equal(r.gradeChanged, true);
    assert.equal(r.signalsPatched, true);
    assert.equal(snapshot.signals.apiDocs.found, false);
    assert.deepEqual(snapshot.signals.apiDocs.urls, []); // raw material untouched
  });

  it('no award movement → the snapshot is left completely alone', () => {
    const { snapshot } = fixture({
      signals: {
        apiDocs: { found: true, urls: [] },
        openapi: { probed: true, found: true, urls: ['https://example.com/openapi.json'] },
        llms: { status: 200 }, // pruned body → benefit of the doubt, C1 stays 8
      },
    });
    const before = JSON.stringify(snapshot);
    const r = applyRejudge(snapshot);
    assert.equal(r.changed, false);
    assert.equal(JSON.stringify(snapshot), before);
  });

  it('a marker/award mismatch is skipped, never guessed', () => {
    const { snapshot } = fixture({
      c1: check('l3.public-api', 7, 'partial', 'OpenAPI document discovered', 8),
    });
    const r = applyRejudge(snapshot);
    assert.ok(r.skip);
    assert.equal(r.changed, undefined);
  });
});

describe('main (corpus walk, --write in a temp tree)', () => {
  it('rewrites only changed snapshots, preserving each file style', () => {
    const root = mkdtempSync(join(tmpdir(), 'afr-rejudge-'));
    const day = join(root, '2026', '11', '20');
    mkdirSync(day, { recursive: true });

    // file A: 1-space + trailing newline, C3 discovery-only → changes
    const a = fixture({
      signals: {
        apiDocs: { found: true, urls: [] },
        openapi: { probed: true, found: true, urls: ['https://example.com/openapi.json'] },
        llms: { status: 200 },
        mcp: { probed: true, found: true, urls: ['https://example.com/.well-known/mcp'] },
      },
      c3: check('l3.mcp', 6, 'pass', 'MCP endpoint found: https://example.com/.well-known/mcp', 6),
      indent: 1,
      trailingNewline: true,
    });
    writeFileSync(join(day, 'a.example.com.json'), a.raw);

    // file B: 2-space, no trailing newline, nothing to change → untouched
    const b = fixture({ l1: 20, l2: 30, indent: 2, trailingNewline: false });
    writeFileSync(join(day, 'b.example.com.json'), b.raw);

    main([root, '--write', '--quiet']);

    const aAfter = readFileSync(join(day, 'a.example.com.json'), 'utf8');
    const bAfter = readFileSync(join(day, 'b.example.com.json'), 'utf8');
    assert.equal(bAfter, b.raw, 'unchanged snapshot must not be rewritten');
    assert.equal(detectStyle(aAfter).indent, 1);
    assert.equal(detectStyle(aAfter).trailingNewline, true);

    const before = JSON.parse(a.raw);
    const after = JSON.parse(aAfter);
    const paths = jsonDiff(before, after);
    const allowed = new Set([
      'afr.score',
      'afr.grade',
      'afr.engineVersion',
      'afr.breakdown.l3.mcp',
      'afr.layers[2].awarded',
      'afr.layers[2].checks[2].awarded',
      'afr.layers[2].checks[2].status',
      'afr.layers[2].checks[2].evidence.detail',
      'afr.layers[2].checks[0].evidence.detail', // C1 detail refreshed on write (conflated line dropped)
      'signals.apiDocs.found', // re-derived from the stored urls (conflation removed)
    ]);
    for (const p of paths) assert.ok(allowed.has(p), `unexpected diff path ${p}`);
    assert.equal(after.afr.score, 87);
  });
});
