import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, ADMIN_LOGIN_FAIL_LIMIT } from '../src/index.ts';
import { issueAdminSession, verifyAdminSession } from '../src/admin-login.ts';
import { openSeededDb } from './helpers.ts';

const base = 'https://afr.im';
const env = { ADMIN_LOGIN_EMAIL: 'operator@example.com', ADMIN_LOGIN_SECRET: 'ab'.repeat(32) };

function request(path: string, cookie?: string) {
  return new Request(base + path, { headers: cookie ? { Cookie: cookie } : {} });
}

test('local admin login protects the board and queue, and sets a secure cookie', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const app = createApp({ db });
  const get = (path: string, cookie?: string) => app.request(request(path, cookie), undefined, env);
  const post = (path: string, password: string, origin = base) => app.request(base + path, {
    method: 'POST', headers: { Origin: origin },
    body: new URLSearchParams({ email: env.ADMIN_LOGIN_EMAIL, password }),
  }, env);
  const form = await get('/admin/');
  assert.match(await form.text(), /管理员登录/);
  assert.equal(form.headers.get('cache-control'), 'no-store');
  // Native form POSTs need a same-origin Origin header, not Origin: null.
  assert.equal(form.headers.get('referrer-policy'), 'same-origin');
  assert.equal((await get('/admin/queue')).status, 401);
  for (const response of [await post('/admin/login', 'cd'.repeat(32)), await post('/admin/login', 'x'.repeat(2100))]) {
    assert.equal(response.status, 401);
    assert.equal(response.headers.has('set-cookie'), false);
  }
  assert.equal((await post('/admin/login', env.ADMIN_LOGIN_SECRET, 'https://other.example')).status, 403);
  assert.equal((await post('/admin/login', env.ADMIN_LOGIN_SECRET, 'null')).status, 403);
  const loggedIn = await post('/admin/login', env.ADMIN_LOGIN_SECRET);
  assert.equal(loggedIn.status, 303);
  const cookie = loggedIn.headers.get('set-cookie')!;
  assert.match(cookie, /^__Host-afr-admin=.*; Path=\/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict$/);
  assert.match(await (await get('/admin/', cookie.split(';')[0])).text(), /扫描队列/);
  assert.equal((await get('/admin/queue', cookie.split(';')[0])).status, 200);
  assert.match((await post('/admin/logout', '')).headers.get('set-cookie')!, /Max-Age=0/);
});

test('failed admin logins are capped per IP and logged, and blocking is fail-safe', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const app = createApp({ db });
  const ip = '198.51.100.44';
  const post = (password: string, forwardedIp = ip) => app.request(base + '/admin/login', {
    method: 'POST',
    headers: { Origin: base, 'x-forwarded-for': forwardedIp },
    body: new URLSearchParams({ email: env.ADMIN_LOGIN_EMAIL, password }),
  }, env);

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  t.after(() => { console.warn = originalWarn; });

  for (let i = 0; i < ADMIN_LOGIN_FAIL_LIMIT; i++) {
    const res = await post('cd'.repeat(32));
    assert.equal(res.status, 401, `failure ${i + 1} renders the login page`);
    assert.equal(res.headers.has('set-cookie'), false);
  }
  assert.equal(
    warnings.filter(line => line.includes('admin login failed')).length,
    ADMIN_LOGIN_FAIL_LIMIT,
    'every failed attempt is warned on the console',
  );

  const blocked = await post('cd'.repeat(32));
  assert.equal(blocked.status, 401, 'the next attempt is refused before the credential check');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'Retry-After header present');
  assert.match(await blocked.text(), /尝试过于频繁/);

  const correct = await post(env.ADMIN_LOGIN_SECRET);
  assert.equal(correct.status, 401, 'a correct password is also refused while blocked');
  assert.equal(correct.headers.has('set-cookie'), false);

  const otherIp = await post(env.ADMIN_LOGIN_SECRET, '198.51.100.45');
  assert.equal(otherIp.status, 303, 'another IP is unaffected');

  // The origin gate still runs first: no Origin header → 403, quota untouched.
  const noOrigin = await app.request(base + '/admin/login', {
    method: 'POST',
    body: new URLSearchParams({ email: env.ADMIN_LOGIN_EMAIL, password: env.ADMIN_LOGIN_SECRET }),
  }, env);
  assert.equal(noOrigin.status, 403, 'a request without Origin is still forbidden');
});

test('expired, altered and rotated local credentials reject prior sessions', async () => {
  const now = 1_800_000_000_000;
  const header = await issueAdminSession(env, env.ADMIN_LOGIN_EMAIL, env.ADMIN_LOGIN_SECRET, now);
  const cookie = header!.split(';')[0]!;
  const session = request('/admin/queue', cookie);
  assert.ok(await verifyAdminSession(session, env, now));
  assert.equal(await verifyAdminSession(session, env, now + 3_600_000), null);
  assert.equal(await verifyAdminSession(request('/admin/queue', cookie + 'a'), env, now), null);
  assert.equal(await verifyAdminSession(session, { ...env, ADMIN_LOGIN_SECRET: 'cd'.repeat(32) }, now), null);
});
