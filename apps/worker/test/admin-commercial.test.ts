// test/admin-commercial.test.ts — the commercial board of the administrator
// console (M9, domain C).
//
// The two writes of the board (revoke a Pro term, revoke a machine key) must
// leave exactly one audit row each, and the audit row must exist exactly
// because the change landed. The board is server-rendered plain HTML: a
// fragment that was escaped twice would show the markup as text, so the page
// is checked for real markup too.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { hashToken } from '../src/email.ts';
import { syncEntitlementFromBilling } from '../src/entitlements.ts';
import { createApp } from '../src/index.ts';
import { openSeededDb } from './helpers.ts';

const base = 'https://afr.im';
const env = {
  ADMIN_LOGIN_EMAIL: 'operator@example.com',
  ADMIN_LOGIN_SECRET: 'ab'.repeat(32),
};
const MANAGE_TOKEN = 'manage-token-example-com';

async function login(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request(base + '/admin/login', {
    method: 'POST',
    headers: { Origin: base },
    body: new URLSearchParams({ email: env.ADMIN_LOGIN_EMAIL, password: env.ADMIN_LOGIN_SECRET }),
  }, env);
  assert.equal(response.status, 303);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}

interface Fixture {
  app: ReturnType<typeof createApp>;
  raw: ReturnType<typeof openSeededDb>['raw'];
  cookie: string;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  raw.prepare(
    `INSERT INTO owner_emails
       (domain, email_cipher, email_hash, manage_token_hash, verified_at, created_at, updated_at)
     VALUES ('example.com', 'cipher', 'hash', ?, '2026-11-11', '2026-11-11', '2026-11-11')`,
  ).run(await hashToken(MANAGE_TOKEN));
  // A paid order and the term it bought.
  raw.prepare(
    `INSERT INTO billing_orders
       (merchant_order_id, purpose, subject_id, amount, asset, chain_key, term_days, status, created_at, updated_at)
     VALUES ('pro-example.com-paid', 'pro', 'example.com', '12', 'USDT', 'base', 30, 'confirmed', '2026-11-11', '2026-11-11')`,
  ).run();
  assert.equal(await syncEntitlementFromBilling(db, 'pro-example.com-paid'), true);
  // A machine key of the same site.
  raw.prepare(
    `INSERT INTO api_keys (key_hash, domain, tier, created_at, revoked_at, last_used_at)
     VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'example.com', 'free', '2026-11-11', NULL, NULL)`,
  ).run();
  const app = createApp({ db });
  return { app, raw, cookie: await login(app) };
}

test('the commercial board renders for an authenticated operator', async (t) => {
  const { app, cookie } = await fixture(t);
  const response = await app.request(base + '/admin/commercial', { headers: { Cookie: cookie } }, env);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /商业化/);
  assert.match(html, /Pro 订阅/);
  assert.match(html, /机器密钥/);
  // Real markup, not escaped text.
  assert.match(html, /<table/);
  assert.ok(!html.includes('&lt;table'), 'the page is not escaped twice');
  assert.match(html, /example\.com/);
});

test('revoking a Pro term writes the term end and one audit row', async (t) => {
  const { app, raw, cookie } = await fixture(t);
  const requestId = crypto.randomUUID();
  const response = await app.request(base + '/admin/commercial/pro/revoke', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base },
    body: new URLSearchParams({ request_id: requestId, domain: 'example.com' }),
  }, env);
  assert.equal(response.status, 303);

  // The revocation is an event of the append-only entitlement log.
  const event = raw.prepare(
    `SELECT source_merchant_order_id, subject_id, kind FROM pro_entitlement_events
     WHERE kind = 'revoke'`,
  ).get() as { source_merchant_order_id: string; subject_id: string; kind: string };
  assert.equal(event.subject_id, 'example.com');
  assert.equal(event.source_merchant_order_id, `admin:${requestId}`);

  // ... and it leaves exactly one audit row.
  const audit = raw.prepare(
    `SELECT request_id, action, subject, target, before_json, after_json FROM admin_audit
     WHERE action = 'pro.revoke'`,
  ).all() as { request_id: string; action: string; target: string; before_json: string; after_json: string }[];
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.request_id, requestId);
  assert.equal(audit[0]!.target, 'pro:example.com');
  assert.match(audit[0]!.before_json, /term_days/);
  assert.match(audit[0]!.after_json, /revoked_at/);

  // The request id is claimed: the same form cannot act twice.
  const replay = await app.request(base + '/admin/commercial/pro/revoke', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base },
    body: new URLSearchParams({ request_id: requestId, domain: 'example.com' }),
  }, env);
  assert.equal(replay.status, 303);
  assert.equal(replay.headers.get('location'), '/admin/commercial?notice=replayed');
  const again = raw.prepare(
    `SELECT count(*) AS n FROM pro_entitlement_events WHERE kind = 'revoke'`,
  ).get() as { n: number };
  assert.equal(again.n, 1, 'the replay did not revoke twice');
});

test('revoking a machine key writes the revocation and one audit row', async (t) => {
  const { app, raw, cookie } = await fixture(t);
  const keyHash = 'a'.repeat(64);
  const requestId = crypto.randomUUID();
  const response = await app.request(base + '/admin/commercial/api-key/revoke', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base },
    body: new URLSearchParams({ request_id: requestId, domain: 'example.com', key_hash: keyHash }),
  }, env);
  assert.equal(response.status, 303);

  const key = raw.prepare('SELECT revoked_at FROM api_keys WHERE key_hash = ?').get(keyHash) as {
    revoked_at: string | null;
  };
  assert.ok(key.revoked_at, 'the key is revoked');

  const audit = raw.prepare(
    `SELECT request_id, action, target, before_json, after_json FROM admin_audit WHERE action = 'apikey.revoke'`,
  ).all() as { request_id: string; target: string; before_json: string; after_json: string }[];
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.request_id, requestId);
  assert.equal(audit[0]!.target, `apikey:${keyHash}`);
  assert.match(audit[0]!.before_json, /"revoked_at":null/);
  assert.match(audit[0]!.after_json, /revoked_at/);
});

test('a write without a session, from another origin or for an unknown key is refused', async (t) => {
  const { app, raw, cookie } = await fixture(t);
  const keyHash = 'a'.repeat(64);
  const anonymous = await app.request(base + '/admin/commercial/api-key/revoke', {
    method: 'POST',
    headers: { Origin: base },
    body: new URLSearchParams({ request_id: crypto.randomUUID(), domain: 'example.com', key_hash: keyHash }),
  }, env);
  assert.equal(anonymous.status, 401);

  const crossOrigin = await app.request(base + '/admin/commercial/api-key/revoke', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://other.example' },
    body: new URLSearchParams({ request_id: crypto.randomUUID(), domain: 'example.com', key_hash: keyHash }),
  }, env);
  assert.equal(crossOrigin.status, 403);

  const unknown = await app.request(base + '/admin/commercial/api-key/revoke', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base },
    body: new URLSearchParams({
      request_id: crypto.randomUUID(),
      domain: 'example.com',
      key_hash: 'b'.repeat(64),
    }),
  }, env);
  assert.equal(unknown.status, 400, 'nothing to revoke is a conflict, not a crash');

  const key = raw.prepare('SELECT revoked_at FROM api_keys WHERE key_hash = ?').get(keyHash) as {
    revoked_at: string | null;
  };
  assert.equal(key.revoked_at, null, 'the key is untouched');
  const audit = raw.prepare('SELECT count(*) AS n FROM admin_audit').get() as { n: number };
  assert.equal(audit.n, 0, 'no audit row for a refused write');
});
