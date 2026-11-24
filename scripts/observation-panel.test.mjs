import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { transform } from '@astrojs/compiler';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { buildDetail } from '../apps/web/src/data/detail.ts';

const source = readFileSync(new URL('../apps/web/src/components/detail/ObservationPanel.astro', import.meta.url), 'utf8');
const { code, diagnostics } = await transform(source, {
  filename: 'ObservationPanel.astro',
  internalURL: import.meta.resolve('astro/compiler-runtime'),
  resultScopedSlot: true,
  renderScript: true,
});
assert.deepEqual(diagnostics, []);
// Vite normally drops compiler metadata and resolves the style module; neither is needed for a standalone component render.
const js = stripTypeScriptTypes(code
  .replace(/^import "[^"]*\?astro&type=style[^"]*";$/gm, '')
  .replace(/,\s+createMetadata as \$\$createMetadata/, '')
  .replace(/^export const \$\$metadata = .*;$/gm, ''));
const { default: Panel } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const container = await AstroContainer.create();
const snapshot = {
  afr: {
    domain: 'fixture.example',
    score: 42,
    grade: 'D',
    scannedAt: '2026-11-10T12:00:00.000Z',
    engineVersion: 'afr-1.4',
    layers: [{
      layer: 'L2',
      checks: [{
        id: 'l2.llms-family',
        status: 'fail',
        evidence: { source: 'GET /llms.txt', detail: 'GET /llms.txt returned HTTP 404' },
      }],
    }],
  },
};
const site = buildDetail(snapshot, 'fixture.example');
assert.ok(site);
const check = (detail) => detail.layers.find((l) => l.layer === 'L2').checks.find((c) => c.id === 'l2.llms-family');
const render = (detail, locale = 'en') => container.renderToString(Panel, { props: { site: detail, locale } });

for (const [locale, labels] of [
  ['en', ['What the scan observed', 'Possible action', 'How to verify', 'Scanned', 'Rule version']],
  ['zh-CN', ['本次观察', '可尝试的改进', '如何验证', '扫描时间', '规则版本']],
]) {
  test(`renders actionable snapshot evidence in ${locale}`, async () => {
    const html = await render(site, locale);
    for (const label of labels) assert.ok(html.includes(label), label);
    assert.ok(html.includes('data-check-id="l2.llms-family"'));
    assert.ok(html.includes(check(site).evidence.detail));
    assert.ok(html.includes(`datetime="${snapshot.afr.scannedAt}"`));
    assert.ok(html.includes(snapshot.afr.engineVersion));
    assert.ok(html.includes('HTTP 2xx'));
  });
}

test('omits advice for non-fail, missing evidence, Pending, delisted or unversioned snapshots', async () => {
  for (const mutate of [
    (s) => { check(s).status = 'pass'; },
    (s) => { check(s).status = 'partial'; },
    (s) => { check(s).status = 'unknown'; },
    (s) => { check(s).evidence = undefined; },
    (s) => { s.grade = 'Pending'; },
    (s) => { s.delistedNote = { noteEn: 'Retired', noteZh: '退录' }; },
    (s) => { s.scannedAt = 'invalid'; },
    (s) => { s.engineVersion = ''; },
    (s) => { check(s).id = 'l2.other'; },
  ]) {
    const detail = structuredClone(site);
    mutate(detail);
    assert.doesNotMatch(await render(detail), /data-check-id=/);
  }
});

test('escapes raw evidence as text', async () => {
  const detail = structuredClone(site);
  check(detail).evidence.detail = '<b>raw snapshot evidence</b>';
  const html = await render(detail);
  assert.match(html, /&lt;b&gt;raw snapshot evidence&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>/);
});
