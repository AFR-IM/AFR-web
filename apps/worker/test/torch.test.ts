// test/torch.test.ts — Torch Boost: gates, the daily cap, the binding code,
// the leaderboard windows and the ledger side effects.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import {
  BINDING_TTL_MS,
  createTorchOrder,
  readTorchDetail,
  readTorchLeaderboard,
  readTorchPool,
  readTorchStatus,
  syncBoardLedgers,
} from '../src/torch.ts';
import { pollBillingOrders } from '../src/aipay.ts';
import { openSeededDb } from './helpers.ts';

const migration = readFileSync(new URL('../migrations/paid-boards.sql', import.meta.url), 'utf8');
const now = new Date('2026-11-26T12:00:00.000Z');
const POOL = '0x1111111111111111111111111111111111111111';
const env = { PAID_SALES_OPEN: 'true', AIPAY_API_KEY: 'main-key', AIPAY_CHARITY_API_KEY: 'charity-key' };
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{8}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface FetchCall { url: string; auth: string | null; body: unknown }

function writeSettings(raw: ReturnType<typeof openSeededDb>['raw'], { pool = POOL, beneficiaries = true } = {}): void {
  raw.prepare(`INSERT INTO admin_settings (key, value_json, updated_at, updated_by)
               VALUES ('charity_pool', ?, ?, 'test')`).run(JSON.stringify(pool), now.toISOString());
  if (beneficiaries) {
    raw.prepare(`INSERT INTO admin_settings (key, value_json, updated_at, updated_by)
                 VALUES ('beneficiaries', ?, ?, 'test')`)
      .run(JSON.stringify([{ name: '开源基金会', website: 'https://example.org', direction: '开源基础设施' }]), now.toISOString());
  }
}

async function fixture(options: { settings?: boolean; pool?: string; beneficiaries?: boolean; recipient?: string } = {}) {
  const { raw, db } = openSeededDb();
  raw.exec(migration);
  raw.exec(migration); // additive and safe to re-apply
  if (options.settings !== false) {
    writeSettings(raw, { pool: options.pool, beneficiaries: options.beneficiaries !== false });
  }
  const calls: FetchCall[] = [];
  const recipient = options.recipient ?? POOL;
  const fetchImpl: typeof fetch = async (url, init) => {
    const target = String(url);
    if (target.includes('/v1/merchants/me')) {
      return Response.json({ merchant: { shopName: 'AFR Charity', recipientAddress: recipient } });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: target, auth: new Headers(init?.headers).get('authorization'), body });
    return Response.json({
      order: {
        ...(body as Record<string, unknown>), status: 'pending', reference: `ap_${String(body.merchantOrderId)}`,
        checkoutUrl: `https://aipay.im/checkout/${String(body.merchantOrderId)}`, expiresAt: +now + 900_000,
      },
    });
  };
  const input = (overrides: Record<string, unknown> = {}) => ({
    domain: 'example.com', amount: 10, requestId: crypto.randomUUID(), ...overrides,
  });
  const create = (overrides: Record<string, unknown> = {}, orderEnv: Record<string, unknown> = env) =>
    createTorchOrder(db, { input: input(overrides), env: orderEnv as typeof env, fetchImpl, now });
  return { raw, db, calls, create, input, fetchImpl };
}

let purchaseSeq = 0;
function seedPurchase(
  raw: ReturnType<typeof openSeededDb>['raw'],
  { domain, amount, status = 'paid', createdAt, paidAt = null, tx = null, source = 'scan' }: {
    domain: string; amount: string; status?: string; createdAt: string;
    paidAt?: string | null; tx?: string | null; source?: string | null;
  },
): string {
  purchaseSeq += 1;
  const code = `CPDE${String(purchaseSeq).padStart(4, '0')}`; // unique, outside the issued charset on purpose
  const orderId = `torch-00000000-0000-4000-8000-${String(purchaseSeq).padStart(12, '0')}`;
  raw.prepare(
    `INSERT INTO torch_purchases (domain, binding_code, merchant_order_id, amount, asset, chain_key,
       status, tx_hash, paid_at, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'USDC', 'base', ?, ?, ?, ?, ?, ?)`,
  ).run(domain, code, orderId, amount, status, tx, paidAt, source, createdAt, createdAt);
  return orderId;
}

function seedBilling(
  raw: ReturnType<typeof openSeededDb>['raw'],
  { orderId, purpose, subject, amount, status, confirmedAt = null, tx = null, createdAt = now.toISOString() }: {
    orderId: string; purpose: string; subject: string; amount: string; status: string;
    confirmedAt?: string | null; tx?: string | null; createdAt?: string;
  },
): void {
  raw.prepare(
    `INSERT INTO billing_orders (merchant_order_id, purpose, subject_id, amount, asset, chain_key,
       status, aipay_confirmed_at, tx_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'USDC', 'base', ?, ?, ?, ?, ?)`,
  ).run(orderId, purpose, subject, amount, status, confirmedAt, tx, createdAt, createdAt);
}

it('keeps everything unreachable while the sales switch is off (default)', async () => {
  const { db, raw, create } = await fixture();
  const result = await create({}, {});
  assert.deepEqual(result, { ok: false, status: 403, error: 'torch_sales_closed' });
  assert.equal(raw.prepare('SELECT count(*) AS n FROM torch_purchases').get<{ n: number }>()?.n, 0);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM billing_orders').get<{ n: number }>()?.n, 0);
  const status = await readTorchStatus(db, { order: 'torch-' + crypto.randomUUID(), code: 'ABCDEFGH', now });
  assert.equal(status.status, 404);
});

it('fails closed on missing keys, settings and a wallet that differs from the published pool', async () => {
  const noKey = await fixture().then(({ create }) => create({}, { PAID_SALES_OPEN: 'true' }));
  assert.deepEqual(noKey, { ok: false, status: 503, error: 'billing_not_configured' });

  const noSettings = await fixture({ settings: false }).then(({ create }) => create());
  assert.deepEqual(noSettings, { ok: false, status: 503, error: 'settings_missing' });

  const noList = await fixture({ beneficiaries: false }).then(({ create }) => create());
  assert.deepEqual(noList, { ok: false, status: 503, error: 'settings_missing' });

  const mismatch = await fixture({ recipient: '0x2222222222222222222222222222222222222222' }).then(({ create }) => create());
  assert.deepEqual(mismatch, { ok: false, status: 503, error: 'wallet_mismatch' });

  const unknown = await fixture().then(({ create }) => create({ domain: 'missing.test' }));
  assert.deepEqual(unknown, { ok: false, status: 404, error: 'unknown_domain' });

  for (const amount of [0, 0.5, 1001, 10.999, 'ten', null]) {
    const bad = await fixture().then(({ create }) => create({ amount }));
    assert.deepEqual(bad, { ok: false, status: 400, error: 'invalid_amount' }, String(amount));
  }
});

it('creates an idempotent order under the charity key with an 8-char binding code', async () => {
  const { db, raw, calls, create } = await fixture();
  const first = await create({ amount: 12.5 });
  assert.ok(first.ok, JSON.stringify(first));
  assert.equal(first.status, 201);
  assert.match(first.order.orderId, /^torch-/);
  assert.match(first.order.bindingCode, CODE_RE);
  assert.equal(first.order.amount, 12.5);
  assert.match(first.order.checkoutUrl, /^https:\/\/aipay\.im\//);
  assert.ok(first.order.expiresAt);
  assert.match(calls[0]?.auth ?? '', /charity-key/);
  assert.equal((calls[0]?.body as { amount?: string }).amount, '12.5');

  // The same request id resumes the same row instead of minting a second one.
  const same = await createTorchOrder(db, {
    input: { domain: 'example.com', amount: 12.5, requestId: first.order.orderId.slice(6) },
    env,
    // The wallet check still runs on a resume; a second checkout must not.
    fetchImpl: async (url) => {
      if (String(url).includes('/v1/merchants/me')) {
        return Response.json({ merchant: { shopName: 'AFR Charity', recipientAddress: POOL } });
      }
      throw new Error('resume must not call AIPAY again');
    },
    now,
  });
  assert.ok(same.ok);
  assert.equal(same.status, 200);
  assert.equal(same.order.bindingCode, first.order.bindingCode);
  assert.equal(calls.length, 1);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM torch_purchases').get<{ n: number }>()?.n, 1);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM billing_orders WHERE purpose='torch'").get<{ n: number }>()?.n, 1);
});

it('holds the single-wallet daily cap of $1,000 per site atomically', async () => {
  const { raw, create } = await fixture();
  // $995 already boosted today, $900 boosted yesterday (outside the window).
  seedPurchase(raw, { domain: 'example.com', amount: '995', createdAt: '2026-11-26T01:00:00.000Z', paidAt: '2026-11-26T01:00:00.000Z', tx: '0x' + 'b'.repeat(64) });
  seedPurchase(raw, { domain: 'example.com', amount: '900', createdAt: '2026-11-25T01:00:00.000Z', paidAt: '2026-11-25T01:00:00.000Z', tx: '0x' + 'c'.repeat(64) });

  const over = await create({ amount: 6 });
  assert.deepEqual(over, { ok: false, status: 409, error: 'torch_cap_reached' });

  const exact = await create({ amount: 5 });
  assert.ok(exact.ok, JSON.stringify(exact));
  assert.equal(raw.prepare("SELECT count(*) AS n FROM torch_purchases WHERE status='pending'").get<{ n: number }>()?.n, 1);
});

it('answers status only with the binding code, and only while the order is pending', async () => {
  const { db, raw, create } = await fixture();
  const order = await create({ amount: 5 });
  assert.ok(order.ok);
  const { orderId, bindingCode } = order.order;

  const pending = await readTorchStatus(db, { order: orderId, code: bindingCode, now });
  assert.ok(pending.ok);
  assert.deepEqual(pending.value, { status: 'pending', amount: 5, paidAt: null });

  assert.equal((await readTorchStatus(db, { order: orderId, code: 'ZZZZZZZZ', now })).status, 404);
  assert.equal((await readTorchStatus(db, { order: orderId, code: 'short', now })).status, 400);
  assert.equal((await readTorchStatus(db, { order: 'torch-nope', code: bindingCode, now })).status, 400);

  const late = new Date(+now + BINDING_TTL_MS + 1000);
  const expired = await readTorchStatus(db, { order: orderId, code: bindingCode, now: late });
  assert.equal(expired.status, 403);

  raw.prepare(`UPDATE billing_orders SET status='confirmed', aipay_confirmed_at=?, tx_hash=? WHERE merchant_order_id=?`)
    .run(now.toISOString(), '0x' + 'a'.repeat(64), orderId);
  const paid = await readTorchStatus(db, { order: orderId, code: bindingCode, now: late });
  assert.ok(paid.ok);
  assert.equal(paid.value.status, 'paid');
  assert.equal(paid.value.paidAt, now.toISOString());
});

it('binds codes to [A-Z2-9] without 0/O/1/I', async () => {
  const { create } = await fixture();
  for (let i = 0; i < 8; i += 1) {
    const result = await create({ amount: 1 });
    assert.ok(result.ok);
    assert.match(result.order.bindingCode, CODE_RE);
    assert.ok(!/[01OI]/.test(result.order.bindingCode));
  }
});

it('ranks the four tabs by boosted amount inside their UTC windows, 30 rows a page', async () => {
  const { db, raw } = await fixture();
  seedPurchase(raw, { domain: 'example.com', amount: '10', createdAt: '2026-11-26T01:00:00.000Z', paidAt: '2026-11-26T01:00:00.000Z', tx: '0x' + '1'.repeat(64) });
  seedPurchase(raw, { domain: 'example.com', amount: '20', createdAt: '2026-11-26T02:00:00.000Z', paidAt: '2026-11-26T02:00:00.000Z', tx: '0x' + '2'.repeat(64) });
  seedPurchase(raw, { domain: 'coolsite.io', amount: '50', createdAt: '2026-11-25T02:00:00.000Z', paidAt: '2026-11-25T02:00:00.000Z', tx: '0x' + '3'.repeat(64) });
  seedPurchase(raw, { domain: 'closed.org', amount: '99', createdAt: '2026-11-20T02:00:00.000Z', paidAt: '2026-11-20T02:00:00.000Z', tx: '0x' + '4'.repeat(64) });
  seedPurchase(raw, { domain: 'ghost.site', amount: '5', status: 'pending', createdAt: '2026-11-26T03:00:00.000Z' });

  const day = await readTorchLeaderboard(db, { tab: 'day', page: 1, now, salesOpen: true });
  assert.ok(day);
  assert.deepEqual(day.items.map((item) => item.domain), ['example.com']);
  assert.equal(day.items[0]?.total, 30);
  assert.equal(day.items[0]?.grade, 'A'); // read-only decoration from sites

  const week = await readTorchLeaderboard(db, { tab: 'week', page: 1, now, salesOpen: false });
  assert.ok(week);
  assert.equal(week.salesOpen, false);
  assert.deepEqual(week.items.map((item) => item.domain), ['coolsite.io', 'example.com']);

  const all = await readTorchLeaderboard(db, { tab: 'all', page: 1, now, salesOpen: true });
  assert.ok(all);
  assert.deepEqual(all.items.map((item) => item.domain), ['closed.org', 'coolsite.io', 'example.com']);
  assert.equal(all.pages, 1);

  for (const tab of ['today', 'ALL', 7, null]) {
    assert.equal(await readTorchLeaderboard(db, { tab, page: 1, now, salesOpen: true }), null);
  }

  // 31 domains → two pages, 30 rows each, page 3 clamps to the last page.
  for (let i = 1; i <= 31; i += 1) {
    seedPurchase(raw, {
      domain: `s${String(i).padStart(2, '0')}.test`, amount: String(i),
      createdAt: '2026-11-26T04:00:00.000Z', paidAt: '2026-11-26T04:00:00.000Z', tx: `0x${String(i).padStart(64, 'a')}`,
    });
  }
  const page1 = await readTorchLeaderboard(db, { tab: 'day', page: 1, now, salesOpen: true });
  assert.ok(page1);
  assert.equal(page1.items.length, 30);
  assert.equal(page1.pages, 2);
  assert.equal(page1.total, 32);
  const page3 = await readTorchLeaderboard(db, { tab: 'day', page: 3, now, salesOpen: true });
  assert.ok(page3);
  assert.equal(page3.page, 2);
  assert.equal(page3.items.length, 2);
});

it('reports a zeroed detail for an unknown site and a ranked one after the sweep', async () => {
  const { db, raw } = await fixture();
  const empty = await readTorchDetail(db, { domain: 'missing.test', salesOpen: true });
  assert.ok(empty);
  assert.deepEqual(
    { domain: empty.domain, total: empty.total, count: empty.count, rank: empty.rank, lastAt: empty.lastAt },
    { domain: 'missing.test', total: 0, count: 0, rank: null, lastAt: null },
  );
  assert.equal(await readTorchDetail(db, { domain: '　', salesOpen: true }), null);

  seedPurchase(raw, { domain: 'example.com', amount: '60', createdAt: '2026-11-26T05:00:00.000Z', paidAt: '2026-11-26T05:00:00.000Z', tx: '0x' + '5'.repeat(64) });
  seedPurchase(raw, { domain: 'coolsite.io', amount: '40', createdAt: '2026-11-26T05:10:00.000Z', paidAt: '2026-11-26T05:10:00.000Z', tx: '0x' + '6'.repeat(64) });
  await syncBoardLedgers(db, 'scan', now);
  const detail = await readTorchDetail(db, { domain: 'example.com', salesOpen: false });
  assert.ok(detail);
  assert.equal(detail.total, 60);
  assert.equal(detail.count, 1);
  assert.equal(detail.rank, 1);
  assert.equal(detail.salesOpen, false);
  assert.equal(detail.raised, 100);
  assert.equal(detail.target, 1000);
});

it('derives the $1,000 trigger and the seven-day publication from the paid rows', async () => {
  const { db, raw } = await fixture();
  seedPurchase(raw, { domain: 'example.com', amount: '400', createdAt: '2026-11-26T09:00:00.000Z', paidAt: '2026-11-26T09:00:00.000Z', tx: '0x' + '7'.repeat(64) });
  seedPurchase(raw, { domain: 'example.com', amount: '400', createdAt: '2026-11-26T10:00:00.000Z', paidAt: '2026-11-26T10:00:00.000Z', tx: '0x' + '8'.repeat(64) });
  let pool = await readTorchPool(db);
  assert.equal(pool.raised, 800);
  assert.equal(pool.crossedAt, null);

  seedPurchase(raw, { domain: 'example.com', amount: '300', createdAt: '2026-11-26T11:00:00.000Z', paidAt: '2026-11-26T11:00:00.000Z', tx: '0x' + '9'.repeat(64) });
  pool = await readTorchPool(db);
  assert.equal(pool.raised, 1100);
  assert.equal(pool.crossedAt, '2026-11-26T11:00:00.000Z'); // the row that crossed
  assert.equal(pool.publishedUntil, '2026-12-03T11:00:00.000Z'); // +7 days
});

it('moves board rows only forward, following their ledger row', async () => {
  const { raw, db } = await fixture();
  // Confirmed → paid with the ledger's tx hash.
  const confirmed = seedPurchase(raw, {
    domain: 'example.com', amount: '10', status: 'pending', source: null,
    createdAt: '2026-11-26T06:00:00.000Z',
  });
  seedBilling(raw, {
    orderId: confirmed, purpose: 'torch', subject: 'example.com',
    amount: '10', status: 'confirmed', confirmedAt: '2026-11-26T06:05:00.000Z', tx: '0x' + 'd'.repeat(64),
    createdAt: '2026-11-26T06:00:00.000Z',
  });
  // Expired → cancelled (the cap is released).
  const expired = seedPurchase(raw, {
    domain: 'example.com', amount: '20', status: 'pending', source: null,
    createdAt: '2026-11-26T06:10:00.000Z',
  });
  seedBilling(raw, {
    orderId: expired, purpose: 'torch', subject: 'example.com',
    amount: '20', status: 'expired', createdAt: '2026-11-26T06:10:00.000Z',
  });
  // Orphan (billing never created) → cancelled only after the grace window.
  seedPurchase(raw, {
    domain: 'example.com', amount: '5', status: 'pending', source: null,
    createdAt: '2026-11-26T11:50:00.000Z',
  });
  seedPurchase(raw, {
    domain: 'example.com', amount: '7', status: 'pending', source: null,
    createdAt: '2026-11-26T10:00:00.000Z',
  });

  await syncBoardLedgers(db, 'webhook', now);
  const rows = raw.prepare('SELECT amount, status, tx_hash, source FROM torch_purchases ORDER BY amount').all<{
    amount: string; status: string; tx_hash: string | null; source: string | null;
  }>();
  assert.deepEqual(rows.map((row) => [row.amount, row.status, row.source]), [
    ['10', 'paid', 'webhook'],
    ['20', 'cancelled', null],
    ['5', 'pending', null],
    ['7', 'cancelled', null],
  ]);
  assert.equal(rows[0]?.tx_hash, '0x' + 'd'.repeat(64));

  const totals = raw.prepare('SELECT domain, total_amount, total_count FROM torch_totals').all<{
    domain: string; total_amount: number; total_count: number;
  }>();
  assert.equal(totals.length, 1);
  assert.equal(totals[0]?.domain, 'example.com');
  assert.equal(totals[0]?.total_amount, 10);
  assert.equal(totals[0]?.total_count, 1);

  // Idempotent: a second sweep changes nothing.
  await syncBoardLedgers(db, 'reconcile', now);
  await syncBoardLedgers(db, 'reconcile', now);
  const again = raw.prepare('SELECT count(*) AS n FROM torch_totals').get<{ n: number }>();
  assert.equal(again?.n, 1);
});

it('never writes a score or an ordering field', async () => {
  const { raw } = await fixture();
  const before = raw.prepare('SELECT grade, score_total FROM sites WHERE domain = ?').get('example.com');
  seedPurchase(raw, { domain: 'example.com', amount: '999', createdAt: '2026-11-26T07:00:00.000Z', paidAt: '2026-11-26T07:00:00.000Z', tx: '0x' + 'e'.repeat(64) });
  const after = raw.prepare('SELECT grade, score_total FROM sites WHERE domain = ?').get('example.com');
  assert.deepEqual(after, before);
});

it('polls the board merchants every ten minutes as the second confirmation channel', async () => {
  const { raw, db } = await fixture();
  const purchase = seedPurchase(raw, {
    domain: 'example.com', amount: '10', status: 'pending', source: null,
    createdAt: '2026-11-26T11:00:00.000Z',
  });
  seedBilling(raw, {
    orderId: purchase, purpose: 'torch', subject: 'example.com', amount: '10',
    status: 'pending', createdAt: '2026-11-26T11:00:00.000Z',
  });
  raw.prepare('UPDATE billing_orders SET aipay_reference = ? WHERE merchant_order_id = ?')
    .run('ap_torchpoll0000000000000', purchase);
  // A promo order under the promo merchant must not be touched by the torch key.
  seedBilling(raw, {
    orderId: 'promo-00000000-0000-4000-8000-000000000050', purpose: 'promo', subject: 'example.com',
    amount: '19', status: 'pending', createdAt: '2026-11-26T11:00:00.000Z',
  });

  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    seen.push(String(url));
    return Response.json({ order: {
      reference: 'ap_torchpoll0000000000000', status: 'confirmed', merchantOrderId: purchase,
      amount: '10', asset: 'USDC', chainKey: 'base', confirmedAt: +now, txHash: '0x' + 'f'.repeat(64),
    } });
  };
  const result = await pollBillingOrders(db, { torch: { ...env, AIPAY_API_KEY: 'charity-key' } },
    { fetchImpl, now: now.getTime() });
  assert.deepEqual(result, { checked: 1, applied: 1 });
  assert.equal(seen.length, 1);
  assert.ok(seen[0]?.includes('/v1/orders/ap_torchpoll0000000000000'));

  await syncBoardLedgers(db, 'scan', now);
  const paid = raw.prepare('SELECT status, tx_hash, source FROM torch_purchases WHERE merchant_order_id = ?')
    .get<{ status: string; tx_hash: string; source: string }>(purchase);
  assert.equal(paid?.status, 'paid');
  assert.equal(paid?.tx_hash, '0x' + 'f'.repeat(64));
  assert.equal(paid?.source, 'scan');
  assert.equal(raw.prepare('SELECT status FROM billing_orders WHERE merchant_order_id = ?')
    .get<{ status: string }>('promo-00000000-0000-4000-8000-000000000050')?.status, 'pending');
});
