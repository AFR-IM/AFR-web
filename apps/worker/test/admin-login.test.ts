import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/index.ts';
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
  assert.equal((await get('/admin/queue')).status, 401);
  for (const response of [await post('/admin/login', 'cd'.repeat(32)), await post('/admin/login', 'x'.repeat(2100))]) {
    assert.equal(response.status, 401);
    assert.equal(response.headers.has('set-cookie'), false);
  }
  assert.equal((await post('/admin/login', env.ADMIN_LOGIN_SECRET, 'https://other.example')).status, 403);
  const loggedIn = await post('/admin/login', env.ADMIN_LOGIN_SECRET);
  assert.equal(loggedIn.status, 303);
  const cookie = loggedIn.headers.get('set-cookie')!;
  assert.match(cookie, /^__Host-afr-admin=.*; Path=\/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict$/);
  assert.match(await (await get('/admin/', cookie.split(';')[0])).text(), /扫描队列/);
  assert.equal((await get('/admin/queue', cookie.split(';')[0])).status, 200);
  assert.match((await post('/admin/logout', '')).headers.get('set-cookie')!, /Max-Age=0/);
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
