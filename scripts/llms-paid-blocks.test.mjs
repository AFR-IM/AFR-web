// scripts/llms-paid-blocks.test.mjs — the public machine-readable documents must keep
// their advertising-vs-assessment disclaimers in sync, and the sitemap
// contract must keep the charity page.
//
// Agents read llms.txt / llms-full.txt to decide what is citable; if the
// "paid blocks are not assessment output" line drops the promotion card or
// the boost surfaces, an agent can mistake an ad for a rating.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TOP } from '../apps/web/scripts/sitemap-contract.mjs';

const read = (rel) => readFileSync(new URL(`../apps/web/public/${rel}`, import.meta.url), 'utf8');

const PHRASES = [
  'data-promo="promo"',
  'not assessment output',
  'Torch Boost leaderboard',
  'Torch Boost badges',
  'none of them affect a score, a grade or a ranking',
];

test('llms.txt names every paid surface and denies it assessment status', () => {
  const txt = read('llms.txt');
  for (const phrase of PHRASES) {
    assert.ok(txt.includes(phrase), `llms.txt must mention: ${phrase}`);
  }
  assert.ok(txt.includes('data-promo="owner-ad"'), 'the owner-ad marker stays documented');
  assert.ok(txt.includes('Cite ratings only from `GET /api/v1/sites/:domain`'), 'the citation rule stays');
});

test('llms-full.txt carries the same disclaimer as llms.txt', () => {
  const txt = read('llms-full.txt');
  for (const phrase of PHRASES) {
    assert.ok(txt.includes(phrase), `llms-full.txt must mention: ${phrase}`);
  }
});

test('the sitemap contract keeps the charity page', () => {
  assert.ok(TOP.includes('/charity'), 'TOP must contain /charity');
  // one entry per top-level route, no duplicates
  assert.equal(new Set(TOP).size, TOP.length);
});

test('the OpenAPI documents describe the five charity/boost/promo reads', () => {
  const json = JSON.parse(read('openapi.json'));
  for (const path of [
    '/api/v1/torch/leaderboard',
    '/api/v1/torch/detail',
    '/api/v1/charity',
    '/api/v1/charity/ledger',
    '/api/v1/promos',
  ]) {
    assert.ok(json.paths[path], `openapi.json must document ${path}`);
    assert.ok(json.paths[path].get, `${path} must be a GET`);
  }
  // advertising caveat present on the ad-like reads
  for (const path of ['/api/v1/torch/leaderboard', '/api/v1/promos']) {
    assert.match(json.paths[path].get.description, /[Aa]dvertising/);
  }
  // CharitySettings historically lives under components.responses in both
  // files (the $ref points at schemas — a pre-existing quirk); assert the
  // torch field where the object actually is.
  const charitySettings =
    json.components.schemas.CharitySettings ?? json.components.responses.CharitySettings;
  assert.ok(charitySettings, 'CharitySettings must exist');
  assert.ok(charitySettings.properties.torch, 'CharitySettings must describe the torch field');

  const yaml = read('.well-known/openapi.yaml');
  for (const path of [
    '/api/v1/torch/leaderboard:',
    '/api/v1/torch/detail:',
    '/api/v1/charity/ledger:',
    '/api/v1/promos:',
  ]) {
    assert.ok(yaml.includes(`  ${path}`), `openapi.yaml must document ${path.replace(':', '')}`);
  }
  assert.ok(yaml.includes('torch:'), 'openapi.yaml must describe the torch field');
});

test('the human docs page lists the new endpoints with the advertising caveat', () => {
  const docs = readFileSync(
    new URL('../apps/web/src/pages/[...locale]/docs.astro', import.meta.url),
    'utf8',
  );
  for (const path of [
    '/api/v1/charity/ledger',
    '/api/v1/torch/leaderboard',
    '/api/v1/torch/detail',
    '/api/v1/promos',
  ]) {
    assert.ok(docs.includes(`path: '${path}'`), `docs must list ${path}`);
  }
  assert.match(docs, /never part of the score, grade or natural ranking/i);
  assert.match(docs, /不参与分数、等级或自然排名/);
});
