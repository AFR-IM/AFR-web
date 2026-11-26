// scripts/paid-boards-redlines.test.mjs — the five standing rules of the two paid boards,
// checked against the source that ships. The llms/sitemap half of the same
// checklist lives in llms-paid-blocks.test.mjs; this file covers the code half:
// the scoring engine stays untouched, the caps stay written down, and the
// sales switch stays off unless somebody turns it on.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const workerSrc = (name) => read(`apps/worker/src/${name}`);
const BOARD_FILES = ['torch.ts', 'promo.ts', 'charity.ts'];

test('rule 1: the scoring engine and the paid boards never meet', () => {
  const engineDir = new URL('../packages/afr/src/', import.meta.url);
  for (const file of readdirSync(engineDir).filter((name) => name.endsWith('.ts'))) {
    const src = readFileSync(new URL(file, engineDir), 'utf8');
    assert.ok(!/torch|promo|charity/i.test(src), `engine file ${file} must not mention the paid boards`);
  }
  // The board modules never import the engine and never write a listing,
  // scan or score row. (Reading `sites.grade` for display is allowed —
  // the ordering of the boards is money, never a score.)
  for (const file of BOARD_FILES) {
    const src = workerSrc(file);
    assert.ok(!src.includes("packages/afr"), `${file} must not import the engine`);
    assert.ok(
      !/\b(UPDATE|INSERT|DELETE)\s+(sites|scans|evidence|pro_entitlement_events)\b/i.test(src),
      `${file} must not write listing or score rows`,
    );
  }
});

test('rules 2 and 3: the $1,000 cap and the seven-day publication are written down', () => {
  const torch = workerSrc('torch.ts');
  assert.match(torch, /export const TORCH_DAILY_CAP = 1000/, 'the per-site daily cap is 1,000');
  assert.match(torch, /export const TORCH_TARGET = 1000/, 'the pool target is 1,000');
  assert.match(torch, /export const PUBLICATION_WINDOW_MS = 7 \* 86_400_000/, 'the publication lasts seven days');
  // The cap is enforced in the insert itself (atomic INSERT…SELECT), not in
  // a read-then-write race.
  assert.match(torch, /INSERT INTO torch_purchases[\s\S]*WHERE \(SELECT COALESCE\(SUM\(CAST\(amount AS REAL\)\)/,
    'the daily cap is decided inside the insert');
  // Behaviour: the worker suite proves the boundary and the trigger.
  const torchTest = read('apps/worker/test/torch.test.ts');
  assert.ok(torchTest.includes('torch_cap_reached'), 'the cap has a failing test');
  assert.ok(torchTest.includes('2026-12-03T11:00:00.000Z'), 'the seven-day publication has a failing test');
});

test('rule 5: the sales switch is off by default and stops both boards', () => {
  for (const file of ['torch.ts', 'promo.ts']) {
    assert.match(workerSrc(file), /PAID_SALES_OPEN !== 'true'/, `${file} refuses to sell without the switch`);
  }
  // No variable turns it on: a deployment that says nothing sells nothing,
  // and flipping the same switch off is the one-click stop-sale.
  const wrangler = read('apps/worker/wrangler.toml');
  assert.ok(!wrangler.includes('PAID_SALES_OPEN'), 'the switch must not be set in wrangler.toml');
  assert.ok(!/PAID_SALES_OPEN\s*=\s*"true"/.test(wrangler), 'the switch must never default to true');
  // The ten-minute confirmation channel exists as its own trigger.
  assert.ok(wrangler.includes('"*/10 * * * *"'), 'the board poll runs every ten minutes');
});

test('the webhook endpoint verifies against every board merchant secret', () => {
  const index = workerSrc('index.ts');
  assert.ok(index.includes('AIPAY_CHARITY_WEBHOOK_SECRET'), 'the charity merchant has a webhook secret');
  assert.ok(index.includes('AIPAY_PROMO_WEBHOOK_SECRET'), 'the promo merchant has a webhook secret');
  assert.match(index, /applyAipayWebhook\(\s*db, raw\.subarray\(0, size\), request\.headers, secrets/,
    'the webhook hands the whole candidate list to the verifier');
  // Board orders are verified with their own merchant key, never the main one.
  assert.match(index, /AIPAY_API_KEY: env\?\.AIPAY_CHARITY_API_KEY/);
  assert.match(index, /AIPAY_API_KEY: env\?\.AIPAY_PROMO_API_KEY/);
});
