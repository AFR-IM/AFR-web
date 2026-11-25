// test/commercial.test.ts — the paid side of afr.im.
//
// Covered here:
//   * the Pro order (created in the ledger first, then at AIPAY);
//   * the failure paths of the order (no credentials, unknown domain, an
//     order that is already open, an unreachable payment provider);
//   * the webhook that confirms an order and grants the Pro term, and the
//     replay that must not extend the term twice;
//   * the Pro status and the machine key (issued once, rotated, revoked);
//   * the daily quota of a machine key.
//
// The score is never touched: a paid site is not a better-scored site.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { API_KEY_QUOTA_LIMITS, apiKeyQuotaKey, hashApiKey } from '../src/api-key.ts';
import { hashToken } from '../src/email.ts';
import { DEFAULT_PRO_TERM_DAYS } from '../src/entitlements.ts';
import { createApp } from '../src/index.ts';
import type { KvLike } from '../src/rate-limit.ts';
import { openSeededDb, SCHEMA_SQL } from './helpers.ts';

const WEBHOOK_SECRET = 'test-hook-secret';
const MERCHANT_KEY = 'test-merchant-key';
const ENV = { AIPAY_API_KEY: MERCHANT_KEY, AIPAY_WEBHOOK_SECRET: WEBHOOK_SECRET };
const CHECKOUT = 'https://aipay.im/en/pay?intent=commercial-test';
const REFERENCE = 'ap_commercialorder1234';
const MANAGE_TOKEN = 'manage-token-example-com';
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  app: ReturnType<typeof createApp>;
  raw: ReturnType<typeof openSeededDb>['raw'];
  token: string;
}

async function fixture(t: TestContext, extraDomains: string[] = []): Promise<Fixture> {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const insert = raw.prepare(
    `INSERT INTO owner_emails
       (domain, email_cipher, email_hash, manage_token_hash, verified_at, created_at, updated_at)
     VALUES (?, 'fixture-cipher', 'fixture-hash', ?, '2026-11-11', '2026-11-11', '2026-11-11')`,
  );
  insert.run('example.com', await hashToken(MANAGE_TOKEN));
  for (const domain of extraDomains) insert.run(domain, await hashToken(`token-${domain}`));
  return { app: createApp({ db }), raw, token: MANAGE_TOKEN };
}

interface SeenRequest {
  url: string;
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  redirect?: string;
}

/** Mock the payment provider. `handler` answers every call. */
function mockAipay(t: TestContext, handler: (seen: SeenRequest) => Response): SeenRequest[] {
  const seen: SeenRequest[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const record: SeenRequest = {
      url,
      method: init?.method ?? 'GET',
      body,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]),
      ),
      redirect: init?.redirect,
    };
    seen.push(record);
    return handler(record);
  });
  return seen;
}

/** The provider's answer to a new order. */
function createdOrder(merchantOrderId: string): Response {
  return Response.json({
    order: {
      reference: REFERENCE,
      status: 'pending',
      merchantOrderId,
      amount: '12',
      asset: 'USDC',
      chainKey: 'base',
      checkoutUrl: CHECKOUT,
      expiresAt: Date.now() + 900_000,
    },
  });
}

/** The provider's answer to a confirmed order. */
function confirmedOrder(merchantOrderId: string): Response {
  return Response.json({
    order: {
      reference: REFERENCE,
      status: 'confirmed',
      merchantOrderId,
      amount: '12',
      asset: 'USDC',
      chainKey: 'base',
      checkoutUrl: CHECKOUT,
      expiresAt: Date.now() + 900_000,
      confirmedAt: Date.now(),
      txHash: '0x' + 'a'.repeat(64),
    },
  });
}

/** The provider: a new order is pending, the same order is confirmed when
 * it is read back (this is what the webhook verifies the payment with). */
function mockProvider(t: TestContext): SeenRequest[] {
  let merchantOrderId = '';
  return mockAipay(t, request => {
    if (request.method === 'POST') {
      merchantOrderId = String(request.body.merchantOrderId ?? '');
      return createdOrder(merchantOrderId);
    }
    return confirmedOrder(merchantOrderId);
  });
}

function order(app: Fixture['app'], body: unknown, token: string | null = MANAGE_TOKEN): Promise<Response> {
  return app.request('/api/v1/billing/pro/orders', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }, ENV);
}

/** A signed webhook that confirms the order. */
function signedWebhook(merchantOrderId: string, now = Date.now()): { body: string; headers: Headers } {
  const event = 'order.confirmed';
  const payload = {
    event,
    delivery: { id: 7 },
    order: {
      reference: REFERENCE,
      status: 'confirmed',
      merchantOrderId,
      amount: '12',
      asset: 'USDC',
      chainKey: 'base',
      checkoutUrl: CHECKOUT,
      confirmedAt: now,
      txHash: '0x' + 'b'.repeat(64),
    },
  };
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(now / 1000));
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.`).update(body).digest('hex');
  const headers = new Headers({
    'content-type': 'application/json',
    'x-aipay-event': event,
    'x-aipay-delivery': '7',
    'x-aipay-timestamp': timestamp,
    'x-aipay-signature': `sha256=${signature}`,
  });
  return { body, headers };
}

function postWebhook(app: Fixture['app'], merchantOrderId: string): Promise<Response> {
  const { body, headers } = signedWebhook(merchantOrderId);
  return app.request('/api/v1/_aipay/webhook', { method: 'POST', headers, body }, ENV);
}

/** A KV namespace that keeps its counters in memory. */
function fakeKv(): KvLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

// ---------------------------------------------------------------------------
// POST /api/v1/billing/pro/orders
// ---------------------------------------------------------------------------

test('the product sells 30 days of Pro for 12 USDC', async (t) => {
  const { app, raw } = await fixture(t);
  mockAipay(t, request => createdOrder(String(request.body.merchantOrderId)));
  assert.equal(DEFAULT_PRO_TERM_DAYS, 30);
  assert.equal((await order(app, { domain: 'example.com' })).status, 201);
  const row = raw.prepare('SELECT amount, asset, chain_key, term_days FROM billing_orders').get() as {
    amount: string; asset: string; chain_key: string; term_days: number;
  };
  assert.equal(row.amount, '12');
  assert.equal(row.asset, 'USDC');
  assert.equal(row.chain_key, 'base');
  assert.equal(row.term_days, 30);
});

test('a Pro order is written to the ledger first and answers with the checkout', async (t) => {
  const { app, raw, token } = await fixture(t);
  const seen = mockAipay(t, request => createdOrder(String(request.body.merchantOrderId)));

  const res = await order(app, { domain: 'example.com' }, token);
  assert.equal(res.status, 201);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.amount, '12');
  assert.equal(body.asset, 'USDC');
  assert.equal(body.chainKey, 'base');
  assert.equal(body.reference, REFERENCE);
  assert.equal(body.checkoutUrl, CHECKOUT);
  assert.ok(Date.parse(String(body.expiresAt)) > 0);
  assert.match(String(body.orderId), /^pro-example\.com-/);

  // What the merchant was asked for.
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.method, 'POST');
  assert.equal(seen[0]!.body.amount, '12');
  assert.equal(seen[0]!.body.asset, 'USDC');
  assert.equal(seen[0]!.body.chainKey, 'base');
  assert.equal(seen[0]!.body.ttlSeconds, 900);
  assert.equal(seen[0]!.body.description, 'AFR Pro · example.com');
  assert.equal(seen[0]!.body.returnUrl, 'https://afr.im/owner/example.com/');
  // A Worker sends no User-Agent by default and the provider's edge
  // rejects such a request (403 / Cloudflare 1010) — the order would die
  // before the ledger ever saw a reference.
  assert.ok(seen[0]!.headers['user-agent'], 'the provider call must carry a User-Agent');
  // `'error'` is a Node option and not implemented at the edge: a Worker
  // throws before the request is sent, so the order never reaches the
  // provider. `'manual'` is the Workers equivalent of "do not follow".
  assert.notEqual(seen[0]!.redirect, 'error');
  assert.equal(seen[0]!.redirect, 'manual');
  assert.equal(seen[0]!.body.merchantOrderId, body.orderId);

  // The ledger row: pending, with the term of the product (30 days).
  const row = raw.prepare('SELECT * FROM billing_orders').get() as Record<string, unknown>;
  assert.equal(row.merchant_order_id, body.orderId);
  assert.equal(row.purpose, 'pro');
  assert.equal(row.subject_id, 'example.com');
  assert.equal(row.amount, '12');
  assert.equal(row.asset, 'USDC');
  assert.equal(row.chain_key, 'base');
  assert.equal(row.term_days, 30);
  assert.equal(row.status, 'pending');
  assert.equal(row.aipay_reference, REFERENCE);
  assert.equal(row.checkout_url, CHECKOUT);
});

test('an order without credentials, without a body or without a domain is refused', async (t) => {
  const { app, token } = await fixture(t);
  mockAipay(t, () => assert.fail('no payment provider call expected'));

  const malformed = await app.request('/api/v1/billing/pro/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{not json',
  }, ENV);
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'invalid_json' });

  const noDomain = await order(app, { domain: 42 });
  assert.equal(noDomain.status, 400);
  assert.deepEqual(await noDomain.json(), { error: 'invalid_domain' });

  const badDomain = await order(app, { domain: 'not_a_domain' });
  assert.equal(badDomain.status, 400);
  assert.deepEqual(await badDomain.json(), { error: 'invalid_domain' });

  // No credentials: the billing service is not configured.
  const unconfigured = await app.request('/api/v1/billing/pro/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ domain: 'example.com' }),
  }, { AIPAY_WEBHOOK_SECRET: WEBHOOK_SECRET });
  assert.equal(unconfigured.status, 503);
  assert.deepEqual(await unconfigured.json(), { error: 'billing_not_configured' });
});

test('a request without the management token is refused', async (t) => {
  const { app } = await fixture(t);
  mockAipay(t, () => assert.fail('no payment provider call expected'));
  const anonymous = await order(app, { domain: 'example.com' }, null);
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: 'unauthorized' });
  const stranger = await order(app, { domain: 'example.com' }, 'not-the-token');
  assert.equal(stranger.status, 401);
});

test('a domain AFR does not list cannot buy Pro', async (t) => {
  const { app } = await fixture(t, ['ghost.example']);
  mockAipay(t, () => assert.fail('no payment provider call expected'));
  const res = await app.request('/api/v1/billing/pro/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token-ghost.example' },
    body: JSON.stringify({ domain: 'ghost.example' }),
  }, ENV);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'unknown_domain' });
});

test('a domain with an open order cannot open a second one', async (t) => {
  const { app } = await fixture(t);
  mockAipay(t, request => createdOrder(String(request.body.merchantOrderId)));
  assert.equal((await order(app, { domain: 'example.com' })).status, 201);
  const second = await order(app, { domain: 'example.com' });
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: 'order_pending' });
});

test('an unreachable payment provider cancels the ledger row', async (t) => {
  const { app, raw } = await fixture(t);
  mockAipay(t, () => Response.json({ error: { code: 'upstream_down' } }, { status: 502 }));
  const res = await order(app, { domain: 'example.com' });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'billing_unavailable' });
  const row = raw.prepare('SELECT status FROM billing_orders').get() as { status: string };
  assert.equal(row.status, 'cancelled', 'an order nobody can pay for leaves the ledger');
});

// ---------------------------------------------------------------------------
// The webhook grants the term
// ---------------------------------------------------------------------------

test('a confirmed webhook grants a 30-day Pro term and a replay cannot extend it', async (t) => {
  const { app, raw } = await fixture(t);
  mockProvider(t);

  const created = await (await order(app, { domain: 'example.com' })).json() as { orderId: string };
  const before = raw.prepare('SELECT count(*) AS n FROM pro_entitlement_events').get() as { n: number };
  assert.equal(before.n, 0, 'an unpaid order grants nothing');

  const hook = await postWebhook(app, created.orderId);
  assert.equal(hook.status, 200);
  assert.deepEqual(await hook.json(), { ok: true, result: 'applied' });

  const ledger = raw.prepare('SELECT status FROM billing_orders').get() as { status: string };
  assert.equal(ledger.status, 'confirmed');

  const status = await (await app.request('/api/v1/pro/status?domain=example.com', {
    headers: { authorization: `Bearer ${MANAGE_TOKEN}` },
  }, ENV)).json() as { pro: { active: boolean; expiresAt: string; termDays: number; source: string } };
  assert.equal(status.pro.active, true);
  assert.equal(status.pro.termDays, 30);
  assert.equal(status.pro.source, created.orderId);
  const expiresAt = Date.parse(status.pro.expiresAt);
  assert.ok(expiresAt > Date.now() + 29 * DAY_MS, 'the term is about 30 days long');
  assert.ok(expiresAt < Date.now() + 31 * DAY_MS);

  // The replay of the same delivery must not extend the term.
  const replay = await postWebhook(app, created.orderId);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { ok: true, result: 'duplicate' });
  const again = await (await app.request('/api/v1/pro/status?domain=example.com', {
    headers: { authorization: `Bearer ${MANAGE_TOKEN}` },
  }, ENV)).json() as { pro: { expiresAt: string } };
  assert.equal(again.pro.expiresAt, status.pro.expiresAt, 'the replay did not extend the term');
  const events = raw.prepare('SELECT count(*) AS n FROM pro_entitlement_events').get() as { n: number };
  assert.equal(events.n, 1, 'one grant event per order');
});

// ---------------------------------------------------------------------------
// The order and the Pro status
// ---------------------------------------------------------------------------

test('the order page answers with the state of the order and of the Pro term', async (t) => {
  const { app } = await fixture(t);
  mockProvider(t);
  const created = await (await order(app, { domain: 'example.com' })).json() as {
    orderId: string; reference: string; checkoutUrl: string;
  };

  const byReference = await app.request(`/api/v1/billing/pro/orders/${created.reference}`, {
    headers: { authorization: `Bearer ${MANAGE_TOKEN}` },
  }, ENV);
  assert.equal(byReference.status, 200);
  const body = await byReference.json() as Record<string, unknown>;
  assert.equal(body.status, 'pending');
  assert.equal(body.paid, false);
  assert.equal(body.amount, '12');
  assert.equal(body.asset, 'USDC');
  assert.equal(body.chainKey, 'base');
  assert.equal(body.checkoutUrl, created.checkoutUrl);
  assert.deepEqual(body.pro, { active: false, expiresAt: null });

  // The merchant order id addresses the same order.
  const byOrderId = await app.request(`/api/v1/billing/pro/orders/${created.orderId}`, {
    headers: { authorization: `Bearer ${MANAGE_TOKEN}` },
  }, ENV);
  assert.equal(byOrderId.status, 200);

  // A stranger gets nothing.
  const stranger = await app.request(`/api/v1/billing/pro/orders/${created.reference}`, {
    headers: { authorization: 'Bearer not-the-token' },
  }, ENV);
  assert.equal(stranger.status, 401);
  const anonymous = await app.request(`/api/v1/billing/pro/orders/${created.reference}`, undefined, ENV);
  assert.equal(anonymous.status, 401);

  const missing = await app.request('/api/v1/billing/pro/orders/ap_nothinghere00000', {
    headers: { authorization: `Bearer ${MANAGE_TOKEN}` },
  }, ENV);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'not_found' });
});

test('an open order can be cancelled, a paid one cannot', async (t) => {
  const { app, raw } = await fixture(t);
  mockAipay(t, request => createdOrder(String(request.body.merchantOrderId)));
  const created = await (await order(app, { domain: 'example.com' })).json() as { reference: string };

  const cancel = await app.request(`/api/v1/billing/pro/orders/${created.reference}/cancel`, {
    method: 'POST', headers: { authorization: `Bearer ${MANAGE_TOKEN}` },
  }, ENV);
  assert.equal(cancel.status, 200);
  assert.deepEqual(await cancel.json(), { cancelled: true });
  const row = raw.prepare('SELECT status FROM billing_orders').get() as { status: string };
  assert.equal(row.status, 'cancelled');
  const event = raw.prepare('SELECT source, event_type FROM billing_events').get() as {
    source: string; event_type: string;
  };
  assert.equal(event.source, 'local');
  assert.equal(event.event_type, 'order.cancelled');

  // Cancelling again is idempotent.
  const again = await app.request(`/api/v1/billing/pro/orders/${created.reference}/cancel`, {
    method: 'POST', headers: { authorization: `Bearer ${MANAGE_TOKEN}` },
  }, ENV);
  assert.equal(again.status, 200);

  const stranger = await app.request(`/api/v1/billing/pro/orders/${created.reference}/cancel`, {
    method: 'POST', headers: { authorization: 'Bearer not-the-token' },
  }, ENV);
  assert.equal(stranger.status, 401);
});

test('the Pro status reports the term and the metadata of the key — never the key itself', async (t) => {
  const { app } = await fixture(t);
  mockAipay(t, request =>
    request.method === 'POST'
      ? createdOrder(String(request.body.merchantOrderId))
      : confirmedOrder(String(request.body.merchantOrderId || '')));

  const empty = await app.request('/api/v1/pro/status?domain=example.com', {
    headers: { authorization: `Bearer ${MANAGE_TOKEN}` },
  }, ENV);
  assert.equal(empty.status, 200);
  const body = await empty.json() as Record<string, unknown>;
  assert.equal(body.domain, 'example.com');
  assert.deepEqual(body.pro, { active: false, expiresAt: null, termDays: 30, source: null });
  assert.equal(body.apiKey, null);

  const anonymous = await app.request('/api/v1/pro/status?domain=example.com', undefined, ENV);
  assert.equal(anonymous.status, 401);
  const bad = await app.request('/api/v1/pro/status?domain=not_a_domain', {
    headers: { authorization: `Bearer ${MANAGE_TOKEN}` },
  }, ENV);
  assert.equal(bad.status, 400);
});

// ---------------------------------------------------------------------------
// The machine key
// ---------------------------------------------------------------------------

test('a machine key is issued once, rotated on the next call and revocable', async (t) => {
  const { app, raw } = await fixture(t);
  mockAipay(t, () => assert.fail('no payment provider call expected'));

  const issued = await app.request('/api/v1/pro/api-key', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${MANAGE_TOKEN}` },
    body: JSON.stringify({ domain: 'example.com' }),
  }, ENV);
  assert.equal(issued.status, 201);
  const first = await issued.json() as { key: string; tier: string; createdAt: string };
  assert.match(first.key, /^afr_[0-9a-f]{32}$/);
  assert.equal(first.tier, 'free');
  assert.ok(Date.parse(first.createdAt) > 0);

  // Only the hash is stored.
  const stored = raw.prepare('SELECT key_hash, domain, tier, revoked_at FROM api_keys').get() as {
    key_hash: string; domain: string; tier: string; revoked_at: string | null;
  };
  assert.equal(stored.key_hash, await hashApiKey(first.key));
  assert.notEqual(stored.key_hash, first.key);
  assert.equal(stored.domain, 'example.com');
  assert.equal(stored.tier, 'free');
  assert.equal(stored.revoked_at, null);

  // The status page shows the metadata, never the plaintext.
  const status = await (await app.request('/api/v1/pro/status?domain=example.com', {
    headers: { authorization: `Bearer ${MANAGE_TOKEN}` },
  }, ENV)).json() as { apiKey: Record<string, unknown> };
  assert.deepEqual(status.apiKey, {
    issued: true,
    createdAt: first.createdAt,
    lastUsedAt: null,
    tier: 'free',
  });
  assert.ok(!JSON.stringify(status).includes(first.key), 'the plaintext never comes back');

  // A second call rotates the key: the old one dies.
  const rotated = await app.request('/api/v1/pro/api-key', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${MANAGE_TOKEN}` },
    body: JSON.stringify({ domain: 'example.com' }),
  }, ENV);
  assert.equal(rotated.status, 201);
  const second = await rotated.json() as { key: string };
  assert.notEqual(second.key, first.key);
  const rows = raw.prepare('SELECT key_hash, revoked_at FROM api_keys ORDER BY created_at').all() as {
    key_hash: string; revoked_at: string | null;
  }[];
  assert.equal(rows.length, 2);
  assert.equal(rows.filter(row => row.revoked_at === null).length, 1, 'exactly one live key');

  // Revoking takes the key away; the status page says so.
  const revoked = await app.request('/api/v1/pro/api-key?domain=example.com', {
    method: 'DELETE', headers: { authorization: `Bearer ${MANAGE_TOKEN}` },
  }, ENV);
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { revoked: true });
  const after = await (await app.request('/api/v1/pro/status?domain=example.com', {
    headers: { authorization: `Bearer ${MANAGE_TOKEN}` },
  }, ENV)).json() as { apiKey: unknown };
  assert.equal(after.apiKey, null);

  const anonymous = await app.request('/api/v1/pro/api-key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ domain: 'example.com' }),
  }, ENV);
  assert.equal(anonymous.status, 401);
});

test('a key of a paying site is a Pro key', async (t) => {
  const { app, raw } = await fixture(t);
  mockProvider(t);
  const created = await (await order(app, { domain: 'example.com' })).json() as { orderId: string };
  await postWebhook(app, created.orderId);

  const issued = await app.request('/api/v1/pro/api-key', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${MANAGE_TOKEN}` },
    body: JSON.stringify({ domain: 'example.com' }),
  }, ENV);
  assert.equal(issued.status, 201);
  const key = await issued.json() as { tier: string };
  assert.equal(key.tier, 'pro');
  const stored = raw.prepare('SELECT tier FROM api_keys').get() as { tier: string };
  assert.equal(stored.tier, 'pro');
});

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

test('the commercial migration adds the columns and the write paths to an old database', async (t) => {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  raw.exec(SCHEMA_SQL);
  // The database as it was before the migration.
  raw.exec('ALTER TABLE billing_orders DROP COLUMN term_days');
  raw.exec('DROP INDEX IF EXISTS idx_api_keys_domain');
  raw.exec('DROP TRIGGER IF EXISTS admin_api_key_revoke_insert');
  raw.exec('ALTER TABLE api_keys DROP COLUMN domain');
  raw.exec('ALTER TABLE api_keys DROP COLUMN last_used_at');
  raw.exec(readFileSync(new URL('../migrations/commercial.sql', import.meta.url), 'utf8'));

  const columns = (table: string) =>
    raw.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>().map(row => row.name);
  assert.ok(columns('billing_orders').includes('term_days'));
  assert.ok(columns('api_keys').includes('domain'));
  assert.ok(columns('api_keys').includes('last_used_at'));

  const objects = raw.prepare(
    `SELECT name, type FROM sqlite_master WHERE name IN
       ('admin_pro_revoke', 'admin_api_key_revoke', 'admin_pro_revoke_insert', 'admin_api_key_revoke_insert')`,
  ).all<{ name: string; type: string }>();
  assert.equal(objects.length, 4);
});

test('schema.sql and the migration carry the same write paths', () => {
  const migration = readFileSync(new URL('../migrations/commercial.sql', import.meta.url), 'utf8');
  const marker = 'CREATE VIEW IF NOT EXISTS admin_pro_revoke';
  const section = (sql: string) => sql.slice(sql.indexOf(marker)).replace(/\s+/g, ' ').trim();
  assert.ok(SCHEMA_SQL.includes(marker), 'schema.sql carries the commercial write paths');
  assert.equal(section(SCHEMA_SQL), section(migration));
});

// ---------------------------------------------------------------------------
// The daily quota of a machine key
// ---------------------------------------------------------------------------

test('a machine key authorises a public endpoint and respects its daily budget', async (t) => {
  const { app } = await fixture(t);
  mockAipay(t, () => assert.fail('no payment provider call expected'));
  const kv = fakeKv();
  const env = { ...ENV, KV: kv };

  const issued = await app.request('/api/v1/pro/api-key', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${MANAGE_TOKEN}` },
    body: JSON.stringify({ domain: 'example.com' }),
  }, env);
  const { key } = await issued.json() as { key: string };

  // The key replaces the human check of the public submit endpoint.
  const submit = await app.request('/api/v1/submissions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-afr-agent-key': key },
    body: JSON.stringify({ domain: 'new-site.example', note: 'from an agent' }),
  }, env);
  assert.equal(submit.status, 201);

  // The counter of the day holds the calls of this key.
  const counterKey = apiKeyQuotaKey(await hashApiKey(key));
  assert.equal(kv.store.get(counterKey), '1');

  // The budget of a free key is 100 calls a day.
  kv.store.set(counterKey, String(API_KEY_QUOTA_LIMITS.free));
  const over = await app.request('/api/v1/submissions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-afr-agent-key': key },
    body: JSON.stringify({ domain: 'another-site.example' }),
  }, env);
  assert.equal(over.status, 429);
  assert.deepEqual(await over.json(), { error: 'quota_exceeded', limit: API_KEY_QUOTA_LIMITS.free });

  // A request without a key is never counted against a key.
  assert.equal(kv.store.has(apiKeyQuotaKey(await hashApiKey('unknown-key'))), false);
});
