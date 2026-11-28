// test/admin-console.test.ts — the administrator console over HTTP: the four
// pages render, a batch reclassification reaches D1 and the audit trail, the
// charity settings are public, and a scheduled job can report its outcome.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/index.ts';
import { AFR_METHOD } from '../../../packages/afr/src/method.ts';
import { openSeededDb } from './helpers.ts';

const base = 'https://afr.im';
const env = {
  ADMIN_LOGIN_EMAIL: 'operator@example.com',
  ADMIN_LOGIN_SECRET: 'ab'.repeat(32),
  QUEUE_TOKEN: 'queue-token-value',
};

async function login(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request(base + '/admin/login', {
    method: 'POST',
    headers: { Origin: base },
    body: new URLSearchParams({ email: env.ADMIN_LOGIN_EMAIL, password: env.ADMIN_LOGIN_SECRET }),
  }, env);
  assert.equal(response.status, 303);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}

function form(body: Record<string, string>): URLSearchParams {
  return new URLSearchParams(body);
}

test('the console renders its pages for an authenticated operator', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const app = createApp({ db });
  const cookie = await login(app);
  const get = (path: string) => app.request(base + path, { headers: { Cookie: cookie } }, env);

  const queue = await get('/admin/');
  assert.equal(queue.status, 200);
  assert.match(await queue.text(), /扫描队列/);

  const content = await get('/admin/content');
  assert.equal(content.status, 200);
  const contentHtml = await content.text();
  assert.match(contentHtml, /待审声明/);
  assert.match(contentHtml, /批量重分类/);
  assert.match(contentHtml, /纠错工单/);

  const monitor = await get('/admin/monitor');
  assert.equal(monitor.status, 200);
  const monitorHtml = await monitor.text();
  assert.match(monitorHtml, /监控/);
  assert.match(monitorHtml, /收录/);

  const settings = await get('/admin/settings');
  assert.equal(settings.status, 200);
  const settingsHtml = await settings.text();
  assert.match(settingsHtml, /PROMO_WALLET/);
  assert.match(settingsHtml, /CHARITY_POOL/);

  const scoring = await get('/admin/scoring');
  assert.equal(scoring.status, 200);
  const scoringHtml = await scoring.text();
  assert.match(scoringHtml, /评分规则版本发布/);
  assert.match(scoringHtml, /<form method="post" action="\/admin\/scoring">/);

  const commercial = await get('/admin/commercial');
  assert.equal(commercial.status, 200);
  const commercialHtml = await commercial.text();
  assert.match(commercialHtml, /广告位规格/);
  assert.match(commercialHtml, /广告审核与排期/);
  assert.match(commercialHtml, /站长自助购买已关闭/);

  // The console is never indexed and never cached.
  assert.equal(queue.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(queue.headers.get('cache-control'), 'no-store');
});

test('an unauthenticated request gets no console page at all', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const app = createApp({ db });
  // The board itself answers with the login form; every other console page
  // refuses without a session.
  const board = await app.request(base + '/admin/', undefined, env);
  assert.equal(board.status, 200);
  assert.match(await board.text(), /管理员登录/);
  for (const path of ['/admin/content', '/admin/monitor', '/admin/settings', '/admin/queue', '/admin/scoring', '/admin/commercial']) {
    const response = await app.request(base + path, undefined, env);
    assert.equal(response.status, 401);
  }
});

test('a cross-origin or unauthenticated write is refused', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const app = createApp({ db });
  const cookie = await login(app);
  const cross = await app.request(base + '/admin/content/reclassify', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://other.example' },
    body: form({ request_id: crypto.randomUUID(), category: 'news', domains: 'example.com' }),
  }, env);
  assert.equal(cross.status, 403);
  const anonymous = await app.request(base + '/admin/content/reclassify', {
    method: 'POST',
    headers: { Origin: base },
    body: form({ request_id: crypto.randomUUID(), category: 'news', domains: 'example.com' }),
  }, env);
  assert.equal(anonymous.status, 401);
  // Nothing was written.
  const row = await db.prepare('SELECT category_override FROM sites WHERE domain = ?').get<{ category_override: number | null }>('example.com');
  assert.equal(row?.category_override, null);
});

test('a batch reclassification moves the sites and leaves an audit trail', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const app = createApp({ db });
  const cookie = await login(app);
  const requestId = crypto.randomUUID();
  const response = await app.request(base + '/admin/content/reclassify', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base },
    body: form({
      request_id: requestId,
      category: 'news',
      domains: 'example.com',
      domains_text: 'coolsite.io',
    }),
  }, env);
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location') ?? '', /^\/admin\/content\?notice=reclassified$/);

  const moved = await db.prepare('SELECT category_override FROM sites WHERE domain = ?').get<{ category_override: number | null }>('example.com');
  assert.equal(moved?.category_override, 3);
  const audit = await db
    .prepare('SELECT action, subject, target, before_json, after_json FROM admin_audit WHERE request_id = ?')
    .all<{ action: string; subject: string; target: string; before_json: string; after_json: string }>(requestId);
  assert.equal(audit.length, 2);
  assert.deepEqual(audit.map(row => row.target).sort(), ['site:coolsite.io', 'site:example.com']);
  assert.equal(audit[0].action, 'reclassify');
  assert.equal(audit[0].subject, `local:${env.ADMIN_LOGIN_EMAIL}`);
  assert.equal(JSON.parse(audit[0].after_json).category_slug, 'news');

  // The same request id does not classify twice.
  const replay = await app.request(base + '/admin/content/reclassify', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base },
    body: form({ request_id: requestId, category: 'news', domains: 'example.com' }),
  }, env);
  assert.equal(replay.status, 303);
  assert.match(replay.headers.get('location') ?? '', /notice=replayed$/);
  const auditCount = await db.prepare('SELECT COUNT(*) AS n FROM admin_audit').get<{ n: number }>();
  assert.equal(auditCount?.n, 2);
});

test('the settings page saves the charity list and the public endpoint publishes it', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const app = createApp({ db });
  const cookie = await login(app);
  const response = await app.request(base + '/admin/settings', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base },
    body: form({
      request_id: crypto.randomUUID(),
      beneficiary_name_1: '公益组织',
      beneficiary_website_1: 'https://example.org',
      beneficiary_direction_1: '开源教育',
      promo_wallet: '0x1111111111111111111111111111111111111111',
      charity_pool: '0x2222222222222222222222222222222222222222',
    }),
  }, env);
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location') ?? '', /notice=settings_updated$/);

  const charity = await app.request(base + '/api/v1/charity', undefined, env);
  assert.equal(charity.status, 200);
  const payload = await charity.json() as {
    beneficiaries: { name: string; website: string; direction: string }[];
    promoWallet: string;
    charityPool: string;
    fingerprint: string | null;
    history: { address: string; fingerprint: string }[];
  };
  assert.equal(payload.beneficiaries.length, 1);
  assert.equal(payload.beneficiaries[0].name, '公益组织');
  assert.equal(payload.promoWallet, '0x1111111111111111111111111111111111111111');
  assert.equal(payload.charityPool, '0x2222222222222222222222222222222222222222');
  assert.match(payload.fingerprint ?? '', /^[0-9a-f]{64}$/);
  assert.equal(payload.history.length, 1);
  assert.equal(payload.history[0].address, '0x2222222222222222222222222222222222222222');
  // The public payload must not leak the operator or the request id.
  assert.ok(!JSON.stringify(payload).includes(env.ADMIN_LOGIN_EMAIL));
});

test('a scheduled job reports its outcome and the board shows it', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const app = createApp({ db });

  const unauthorized = await app.request(base + '/api/v1/ops/cron-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job: 'scan', status: 'ok' }),
  }, env);
  assert.equal(unauthorized.status, 401);

  const invalid = await app.request(base + '/api/v1/ops/cron-report', {
    method: 'POST',
    headers: { 'X-Queue-Token': env.QUEUE_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ job: 'not a job', status: 'maybe' }),
  }, env);
  assert.equal(invalid.status, 400);

  const reported = await app.request(base + '/api/v1/ops/cron-report', {
    method: 'POST',
    headers: { 'X-Queue-Token': env.QUEUE_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ job: 'scan', status: 'failed', detail: 'boom', runId: '42' }),
  }, env);
  assert.equal(reported.status, 200);

  const cookie = await login(app);
  const board = await app.request(base + '/admin/monitor', { headers: { Cookie: cookie } }, env);
  const html = await board.text();
  assert.match(html, /scan/);
  assert.match(html, /失败/);
});

test('a successful pipeline report reconciles the published retirement list', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  // The pipelines report after their deploy, so this hook is the first
  // moment the published delisted.json carries the run's changes — the
  // reconcile has to happen right here, not a day later on the cron.
  const publishedFetch = (() =>
    Response.json({ 'example.com': { noteEn: 'Retired', noteZh: '已下线' } })) as unknown as typeof fetch;
  const app = createApp({ db, fetchImpl: publishedFetch });

  const reported = await app.request(base + '/api/v1/ops/cron-report', {
    method: 'POST',
    headers: { 'X-Queue-Token': env.QUEUE_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ job: 'sync-site', status: 'ok' }),
  }, env);
  assert.equal(reported.status, 200);
  const row = raw.prepare('SELECT status FROM sites WHERE domain = ?').get('example.com') as
    | { status: string }
    | undefined;
  assert.equal(row?.status, 'delisted', 'the publish that reports its outcome also applies it');

  // A failed run must not touch the directory: its deploy may never have
  // happened, and its fetch would read the previous release's list.
  const other = createApp({
    db,
    fetchImpl: (() => Response.json({})) as unknown as typeof fetch,
  });
  raw.prepare("UPDATE sites SET status = 'active' WHERE domain = 'example.com'").run();
  const failed = await other.request(base + '/api/v1/ops/cron-report', {
    method: 'POST',
    headers: { 'X-Queue-Token': env.QUEUE_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ job: 'scan', status: 'failed', detail: 'boom' }),
  }, env);
  assert.equal(failed.status, 200);
  const after = raw.prepare('SELECT status FROM sites WHERE domain = ?').get('example.com') as
    | { status: string }
    | undefined;
  assert.equal(after?.status, 'active', 'a failed report never flips the directory');
});

test('a badge request counts its referrer', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const app = createApp({ db });
  const response = await app.request(base + '/badge/example.com.svg', {
    headers: { Referer: 'https://blog.example.org/post' },
  }, env);
  assert.equal(response.status, 200);
  // The counter write runs behind the response; give it a tick.
  await new Promise(resolve => setTimeout(resolve, 20));
  const rows = await db.prepare('SELECT day, host, hits FROM badge_referrers').all<{ day: string; host: string; hits: number }>();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].host, 'blog.example.org');
  assert.equal(rows[0].hits, 1);
});

test('the console serves real markup, not escaped text', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  raw.exec(`INSERT INTO claims (domain, statement, status, created_at) VALUES ('a.test', 'first', 'pending', '2026-11-01')`);
  const app = createApp({ db });
  const cookie = await login(app);
  const get = (path: string) => app.request(base + path, { headers: { Cookie: cookie } }, env);

  // A page that escapes its own markup shows the tags as text; the browser
  // cannot submit anything then. These assertions look at the raw bytes.
  const loginPage = await app.request(base + '/admin/', undefined, env);
  const loginHtml = await loginPage.text();
  assert.ok(loginHtml.includes('<form method="post" action="/admin/login">'), 'the login form must be markup');
  assert.ok(!loginHtml.includes('&lt;form'), 'the login form must not be escaped');

  const content = await get('/admin/content');
  const contentHtml = await content.text();
  assert.ok(contentHtml.includes('action="/admin/content/reclassify"'), 'the reclassification form must be markup');
  assert.ok(contentHtml.includes('action="/admin/content/claims"'), 'the claim form must be markup');
  assert.ok(!contentHtml.includes('&lt;form'), 'the console forms must not be escaped');
  assert.ok(contentHtml.includes('name="publish_id"'), 'a claim row button must name its claim');

  const settings = await get('/admin/settings');
  const settingsHtml = await settings.text();
  assert.ok(settingsHtml.includes('name="charity_pool"'), 'the settings form must be markup');
  assert.ok(!settingsHtml.includes('&lt;input'), 'the settings inputs must not be escaped');
});

test('the console never prints the operator login address', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const app = createApp({ db });
  const cookie = await login(app);
  await app.request(base + '/admin/content/reclassify', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base },
    body: form({
      request_id: crypto.randomUUID(),
      category: 'news',
      domains: 'example.com',
    }),
  }, env);
  const content = await app.request(base + '/admin/content', { headers: { Cookie: cookie } }, env);
  const html = await content.text();
  assert.ok(!html.includes(env.ADMIN_LOGIN_EMAIL), 'the operator address must not be rendered');
  const queue = await app.request(base + '/admin/queue', { headers: { Cookie: cookie } }, env);
  const projection = await queue.json() as { audit: { subject: string }[] };
  assert.ok(!JSON.stringify(projection).includes(env.ADMIN_LOGIN_EMAIL), 'the projection must not carry the address');
});

test('the published fingerprint matches the address it belongs to', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const app = createApp({ db });
  const cookie = await login(app);
  const address = '0x2222222222222222222222222222222222222222';
  await app.request(base + '/admin/settings', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base },
    body: form({
      request_id: crypto.randomUUID(),
      beneficiary_name_1: '公益组织',
      beneficiary_website_1: 'https://example.org',
      beneficiary_direction_1: '开源教育',
      promo_wallet: '0x1111111111111111111111111111111111111111',
      charity_pool: address,
    }),
  }, env);
  const charity = await app.request(base + '/api/v1/charity', undefined, env);
  const payload = await charity.json() as { charityPool: string; fingerprint: string; history: { address: string }[] };
  const expected = createHash('sha256').update(address.toLowerCase(), 'utf8').digest('hex');
  assert.equal(payload.fingerprint, expected);
  assert.equal(payload.history[0]!.address, address);
});

test('a settings form without the expected fields cannot clear the stored values', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const app = createApp({ db });
  const cookie = await login(app);
  const save = (body: Record<string, string>) => app.request(base + '/admin/settings', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base },
    body: form(body),
  }, env);

  assert.equal((await save({
    request_id: crypto.randomUUID(),
    beneficiary_name_1: '公益组织',
    beneficiary_website_1: 'https://example.org',
    beneficiary_direction_1: '开源教育',
    promo_wallet: '0x1111111111111111111111111111111111111111',
    charity_pool: '0x2222222222222222222222222222222222222222',
  })).status, 303);

  // A form that lost its fields must not be read as "clear everything".
  const empty = await save({ request_id: crypto.randomUUID() });
  assert.equal(empty.status, 400);
  const charity = await app.request(base + '/api/v1/charity', undefined, env);
  const payload = await charity.json() as { beneficiaries: unknown[]; charityPool: string };
  assert.equal(payload.beneficiaries.length, 1);
  assert.equal(payload.charityPool, '0x2222222222222222222222222222222222222222');
});

test('a claim row button decides only that claim', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  raw.exec(`INSERT INTO claims (domain, statement, status, created_at) VALUES ('a.test', 'first', 'pending', '2026-11-01')`);
  raw.exec(`INSERT INTO claims (domain, statement, status, created_at) VALUES ('b.test', 'second', 'pending', '2026-11-01')`);
  const app = createApp({ db });
  const cookie = await login(app);
  const response = await app.request(base + '/admin/content/claims', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base },
    body: form({ request_id: crypto.randomUUID(), reject_id: '2' }),
  }, env);
  assert.equal(response.status, 303);
  const rows = (raw.prepare('SELECT domain, status FROM claims ORDER BY id').all() as unknown as { domain: string; status: string }[])
    .map(row => ({ domain: row.domain, status: row.status }));
  assert.deepEqual(rows, [
    { domain: 'a.test', status: 'pending' },
    { domain: 'b.test', status: 'rejected' },
  ]);
});

test('an operator publishes a scoring release that the public standard carries', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const app = createApp({ db });
  const cookie = await login(app);

  // Before any release the public standard carries none.
  const before = await (await app.request(base + '/api/v1/method')).json() as { release: unknown };
  assert.equal(before.release, null);

  const requestId = crypto.randomUUID();
  const response = await app.request(base + '/admin/scoring', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base },
    body: form({
      request_id: requestId,
      engine_version: AFR_METHOD.engineVersion,
      notes: 'Clarified the MCP check wording.',
    }),
  }, env);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/admin/scoring?notice=scoring_published');

  const after = await (await app.request(base + '/api/v1/method')).json() as {
    release: { engineVersion: string; notes: string } | null;
  };
  assert.deepEqual(after.release, {
    engineVersion: AFR_METHOD.engineVersion,
    notes: 'Clarified the MCP check wording.',
    publishedAt: (after.release as { publishedAt: string }).publishedAt,
  });

  // The publish is an audited console action, attributed to the operator.
  const audit = await db.prepare(
    'SELECT action, target, subject FROM admin_audit WHERE request_id = ?',
  ).get<{ action: string; target: string; subject: string }>(requestId);
  assert.equal(audit?.action, 'scoring.publish');
  assert.equal(audit?.target, `scoring:${AFR_METHOD.engineVersion}`);
  assert.ok(audit?.subject);

  // A replay of the same request id publishes nothing twice.
  const replay = await app.request(base + '/admin/scoring', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base },
    body: form({
      request_id: requestId,
      engine_version: AFR_METHOD.engineVersion,
      notes: 'Different wording.',
    }),
  }, env);
  assert.equal(replay.headers.get('location'), '/admin/scoring?notice=replayed');
  const releases = await db.prepare('SELECT COUNT(*) AS n FROM scoring_releases').get<{ n: number }>();
  assert.equal(releases?.n, 1, 'a replay must not publish a second release');
});

test('a sponsorship moderation form is routed to the commercial ledger', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const app = createApp({ db });
  const cookie = await login(app);

  // No placement with that id exists: the console answers with its own error
  // page (the route is wired), not with a JSON 404 from an unknown path.
  const response = await app.request(base + '/admin/commercial/ads', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base },
    body: form({
      request_id: crypto.randomUUID(),
      id: '999999',
      decision: 'approve',
      starts_at: '2099-01-01T00:00:00.000Z',
      note: 'not a real placement',
    }),
  }, env);
  assert.equal(response.status, 400);
  assert.match(String(response.headers.get('content-type')), /text\/html/);
  const html = await response.text();
  assert.match(html, /广告操作未执行/);
  assert.match(html, /返回/, 'the console answers with a page, not JSON');

  // And nothing was written: no audit row, no placement.
  const audit = await db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action LIKE 'ads.%'").get<{ n: number }>();
  assert.equal(audit?.n, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM ads WHERE id = 999999').get<{ n: number }>()?.n, 0);
});
