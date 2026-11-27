// test/ads.test.ts — the public ad surface (GET /api/v1/ads and its siblings).
//
// A placement is only ever served when it was paid through the local ledger,
// approved by an operator and is inside its term. The fixture rows of the seed
// (an 'active' row with no ledger) must therefore never be served: that is the
// rule this suite pins down, together with the click/report surfaces.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/index.ts';
import { openSeededDb } from './helpers.ts';

function app() {
  return createApp({ db: openSeededDb().db });
}

const base = 'https://afr.im';
const env = {
  ADMIN_LOGIN_EMAIL: 'operator@example.com',
  ADMIN_LOGIN_SECRET: 'ab'.repeat(32),
};

/** A logged-in console with one open report against the seeded ad. */
async function adminFixture() {
  const { db, raw } = openSeededDb();
  raw.prepare(`INSERT INTO ad_reports (ad_id, domain, reason, detail, created_at)
    VALUES (1, 'example.com', 'spam', 'bad ad', '2026-11-27T00:00:00.000Z')`).run();
  const reportId = Number((raw.prepare('SELECT id FROM ad_reports').get() as { id: number }).id);
  const application = createApp({ db });
  const login = await application.request(base + '/admin/login', {
    method: 'POST',
    headers: { Origin: base },
    body: new URLSearchParams({ email: env.ADMIN_LOGIN_EMAIL, password: env.ADMIN_LOGIN_SECRET }),
  }, env);
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const close = (body: Record<string, string>) => application.request(base + '/admin/commercial/ad-report/close', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base },
    body: new URLSearchParams(body),
  }, env);
  return { db, raw, application, cookie, reportId, close };
}

describe('GET /api/v1/ads', () => {
  it('serves nothing that has no confirmed payment and no approval', async () => {
    // The seed carries an 'active' ad row (example.com) that was never bought:
    // the old static implementation would have served it.
    const res = await app().request('/api/v1/ads?slot=category-top&key=dev-tools');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { items: [] });
  });

  it('serves nothing at all without a slot, and never lists the search slot blind', async () => {
    for (const path of ['/api/v1/ads', '/api/v1/ads?slot=search-top', '/api/v1/ads?slot=home-supporter']) {
      assert.deepEqual(await (await app().request(path)).json(), { items: [] }, path);
    }
  });

  it('keeps the answer out of every cache', async () => {
    const res = await app().request('/api/v1/ads?slot=category-top&key=dev-tools');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('cloudflare-cdn-cache-control'), 'no-store');
  });
});

describe('the sponsorship surfaces', () => {
  it('closes self-serve sales unless the operator opened them', async () => {
    const res = await app().request('/api/v1/ads/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'example.com' }),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'ads_sales_closed' });
  });

  it('publishes no price list while sales are closed', async () => {
    const body = await (await app().request('/api/v1/ads/offers')).json();
    assert.deepEqual(body, { salesOpen: false, items: [] });
  });

  it('redirects a click only for a placement it can verify, and never to a caller URL', async () => {
    const unknown = await app().request('/api/v1/ads/go?id=1');
    assert.equal(unknown.status, 404);
    const injected = await app().request('/api/v1/ads/go?id=1&url=https://evil.example');
    assert.equal(injected.status, 404);
    const traversal = await app().request('/api/v1/ads/go?id=1/../../');
    assert.equal(traversal.status, 404);
  });

  it('answers an impression report without charging the visitor', async () => {
    const res = await app().request('/api/v1/ads/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1 }),
    });
    // Nothing is counted for an unapproved placement, and the call stays cheap.
    assert.equal(res.status, 204);
    const bad = await app().request('/api/v1/ads/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'https://evil.example' }),
    });
    assert.equal(bad.status, 400);
  });

  it('renders a readable report form and refuses an unknown placement', async () => {
    const form = await app().request('/api/v1/ads/report?id=1&lang=zh-CN');
    assert.equal(form.status, 200);
    assert.match(String(form.headers.get('content-type')), /text\/html/);
    const html = await form.text();
    assert.match(html, /<form method="post" action="\/api\/v1\/ads\/report">/);
    assert.match(html, /举报广告位/);
    assert.equal(form.headers.get('x-robots-tag'), 'noindex, nofollow');

    const unknown = await app().request('/api/v1/ads/report?id=999999');
    assert.equal(unknown.status, 404);

    const missing = await app().request('/api/v1/ads/report');
    assert.equal(missing.status, 404);
  });

  it('accepts a JSON report from a script and answers in JSON', async () => {
    const res = await app().request('/api/v1/ads/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ id: 1, reason: 'spam', detail: 'x' }),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true });

    const unknown = await app().request('/api/v1/ads/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ id: 999999, reason: 'spam' }),
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: 'not_found' });

    const badReason = await app().request('/api/v1/ads/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ id: 1, reason: 'because' }),
    });
    assert.equal(badReason.status, 400);
  });

  it('keeps the report endpoint small', async () => {
    const res = await app().request('/api/v1/ads/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ id: 1, reason: 'spam', detail: 'x'.repeat(5000) }),
    });
    assert.equal(res.status, 413);
  });
});

describe('closing an ad report from the console', () => {
  it('resolves an open report, writes one audit row and replays the same request id', async () => {
    const { raw, cookie, reportId, close } = await adminFixture();
    const requestId = crypto.randomUUID();
    const form = {
      request_id: requestId,
      report_id: String(reportId),
      decision: 'resolve',
      note: '确认违规',
    };

    const res = await close(form);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/admin/commercial?notice=ad_report_closed');
    assert.equal(raw.prepare('SELECT status FROM ad_reports WHERE id = ?').get(reportId)?.status, 'resolved');

    const audit = raw.prepare(
      `SELECT request_id, action, target, before_json, after_json FROM admin_audit
       WHERE action = 'ads.report_resolve'`,
    ).all() as { request_id: string; action: string; target: string; before_json: string; after_json: string }[];    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.request_id, `admin:${requestId}`);
    assert.equal(audit[0]!.target, `ad_report:${reportId}`);
    assert.match(audit[0]!.before_json, /"open"/);
    assert.match(audit[0]!.after_json, /"resolved"/);
    assert.match(audit[0]!.after_json, /确认违规/);

    // The request id is claimed: the same form cannot close anything twice.
    const replay = await close(form);
    assert.equal(replay.status, 303);
    assert.equal(replay.headers.get('location'), '/admin/commercial?notice=replayed');
    const audits = raw.prepare('SELECT count(*) AS n FROM admin_audit').get() as { n: number };
    assert.equal(audits.n, 1, 'a replay must not write a second audit row');
  });

  it('refuses a report that is no longer open', async () => {
    const { raw, reportId, close } = await adminFixture();
    // First close lands (resolve), the second one with a fresh request id must not.
    assert.equal((await close({
      request_id: crypto.randomUUID(), report_id: String(reportId), decision: 'resolve',
    })).status, 303);

    const conflict = await close({
      request_id: crypto.randomUUID(), report_id: String(reportId), decision: 'dismiss',
    });
    assert.equal(conflict.status, 400);
    const html = await conflict.text();
    assert.match(html, /举报结案未执行/);
    assert.equal(raw.prepare('SELECT status FROM ad_reports WHERE id = ?').get(reportId)?.status, 'resolved');
    const audits = raw.prepare('SELECT count(*) AS n FROM admin_audit').get() as { n: number };
    assert.equal(audits.n, 1, 'a refused close must not touch the audit trail');
  });

  it('rejects an unknown decision before anything is written', async () => {
    const { raw, reportId, close } = await adminFixture();
    const requestId = crypto.randomUUID();
    const res = await close({
      request_id: requestId, report_id: String(reportId), decision: 'close',
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /举报处理参数无效/);
    assert.equal(raw.prepare('SELECT status FROM ad_reports WHERE id = ?').get(reportId)?.status, 'open');
    // The bad decision never claimed the request id either.
    const claimed = raw.prepare('SELECT count(*) AS n FROM admin_requests').get() as { n: number };
    assert.equal(claimed.n, 0);
    const audits = raw.prepare('SELECT count(*) AS n FROM admin_audit').get() as { n: number };
    assert.equal(audits.n, 0);
  });

  it('offers the close form only for open reports to a writer', async () => {
    const { raw, application, cookie, reportId, close } = await adminFixture();
    const page = await application.request(base + '/admin/commercial', { headers: { Cookie: cookie } }, env);
    const before = await page.text();
    assert.match(before, /<form method="post" action="\/admin\/commercial\/ad-report\/close">/);
    assert.match(before, /<option value="resolve">结案<\/option>/);

    await close({ request_id: crypto.randomUUID(), report_id: String(reportId), decision: 'dismiss' });
    assert.equal(raw.prepare('SELECT status FROM ad_reports WHERE id = ?').get(reportId)?.status, 'dismissed');
    const after = await (await application.request(base + '/admin/commercial', { headers: { Cookie: cookie } }, env)).text();
    assert.doesNotMatch(after, /action="\/admin\/commercial\/ad-report\/close"/);
  });
});
