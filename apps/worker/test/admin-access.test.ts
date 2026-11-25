import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, type WorkerEnv } from '../src/index.ts';
import { openSeededDb } from './helpers.ts';
import { AdminAccessTemporarilyUnavailable, verifyAdminAccess, type AdminAccessEnv } from '../src/admin-access.ts';

const audience = 'admin-application-audience';
const assertionHeader = 'Cf-Access-Jwt-Assertion';
const reader = 'access-reader-subject';
const operator = 'access-operator-subject';
const rsa = 'RSASSA-PKCS1-v1_5';
const encoder = new TextEncoder();

async function makeKey(kid: string) {
  const { publicKey, privateKey } = await crypto.subtle.generateKey({
    name: rsa, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
  }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', publicKey), kid, use: 'sig' };
  return { kid, jwk, privateKey };
}

const [key, rotated] = await Promise.all([makeKey('initial-key'), makeKey('rotated-key')]);

function envFor(team: string): AdminAccessEnv {
  return {
    ADMIN_ACCESS_ISSUER: `https://${team}.cloudflareaccess.com`,
    ADMIN_ACCESS_AUD: audience,
    ADMIN_ACCESS_READERS: `${reader}, another-reader`,
    ADMIN_ACCESS_OPERATORS: `${operator}\noperator-two`,
  };
}

function jsonPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function tokenFor(
  env: AdminAccessEnv,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  signingKey = key,
): Promise<string> {
  const payload = `${jsonPart({ alg: 'RS256', kid: signingKey.kid, ...header })}.${jsonPart({
    iss: env.ADMIN_ACCESS_ISSUER,
    aud: [audience],
    exp: Math.floor(Date.now() / 1000) + 3600,
    type: 'app',
    sub: reader,
    email: 'admin@example.com',
    ...claims,
  })}`;
  const signature = await crypto.subtle.sign(rsa, signingKey.privateKey, encoder.encode(payload));
  return `${payload}.${Buffer.from(signature).toString('base64url')}`;
}

function request(token: string, headers: Record<string, string> = {}): Request {
  return new Request('https://api.afr.im/api/admin/status', {
    headers: { [assertionHeader]: token, ...headers },
  });
}

test('protects real admin routes and allows only same-origin operator retries', async t => {
  const env = envFor('route-test') as WorkerEnv;
  const { db, raw } = openSeededDb();
  raw.exec("INSERT INTO submissions (domain, status, submitter_note) VALUES ('example.com', 'scanned', 'private note')");
  t.mock.method(globalThis, 'fetch', async () => Response.json({ keys: [key.jwk] }));
  const app = createApp({ db });
  const readerJwt = await tokenFor(env);
  const operatorJwt = await tokenFor(env, { sub: operator });
  const origin = 'https://admin.example.com';
  const retry = `${origin}/admin/retry/1/${crypto.randomUUID()}`;
  const noAccess = await app.request(`${origin}/admin/queue`, undefined, env);
  assert.equal(noAccess.status, 401);
  assert.equal(noAccess.headers.get('Cache-Control'), 'no-store');
  const view = await app.request(`${origin}/admin/`, { headers: { [assertionHeader]: readerJwt } }, env);
  assert.equal(view.status, 200);
  assert.match(view.headers.get('Content-Type') ?? '', /^text\/html/);
  const content = await view.text();
  assert.match(content, /example\.com/);
  assert.doesNotMatch(content, /private note|重新入队/);
  const post = (jwt: string, from?: string) => app.request(retry, { method: 'POST',
    headers: { [assertionHeader]: jwt, ...(from ? { Origin: from } : {}) } }, env);
  assert.equal((await post(readerJwt, origin)).status, 403);
  assert.equal((await post(operatorJwt)).status, 403);
  assert.equal((await post(operatorJwt, 'https://example.net')).status, 403);
  assert.equal((await post(operatorJwt, origin)).status, 201);
  assert.deepEqual(await (await post(operatorJwt, origin)).json(), { result: 'replayed' });
  const data = await app.request(`${origin}/admin/queue`, { headers: { [assertionHeader]: operatorJwt } }, env);
  const board = await data.json() as { audit: { subject: string }[] };
  assert.deepEqual(board.audit.map(entry => entry.subject), [operator]);
});

test('authenticates signed browser sessions and uses only exact subject allowlists', async t => {
  const env = envFor('roles');
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, `${env.ADMIN_ACCESS_ISSUER}/cdn-cgi/access/certs`);
    // 'error' is a Node option and not implemented at the edge: a Worker
    // throws before the request is sent. 'manual' is the Workers
    // equivalent of "do not follow".
    assert.equal(init.redirect, 'manual');
    assert.equal(init.cache, 'no-store');
    assert.ok(init.signal);
    return Response.json({ keys: [key.jwk] });
  });
  assert.deepEqual(await verifyAdminAccess(request(await tokenFor(env)), {
    ...env, ADMIN_ACCESS_ISSUER: `${env.ADMIN_ACCESS_ISSUER}/`,
  }), { subject: reader, canWrite: false });
  assert.deepEqual(await verifyAdminAccess(request(await tokenFor(env, { sub: operator, aud: audience }, { typ: 'JWT' })), {
    ...env, ADMIN_ACCESS_READERS: `${reader} ${operator}`,
  }), { subject: operator, canWrite: true });
  assert.deepEqual(await verifyAdminAccess(request(await tokenFor(env, { sub: 'operator-two' })), env),
    { subject: 'operator-two', canWrite: true });
  assert.equal(await verifyAdminAccess(request(await tokenFor(env, { sub: reader.toUpperCase() })), env), null);
  assert.equal(await verifyAdminAccess(request(await tokenFor(env, { sub: 'operator' }), {
    'Cf-Access-Authenticated-User-Email': operator,
  }), env), null);
  assert.equal(await verifyAdminAccess(request(await tokenFor(env)), {
    ...env, ADMIN_ACCESS_READERS: 'admin@example.com', ADMIN_ACCESS_OPERATORS: '',
  }), null);
  assert.equal(fetch.mock.callCount(), 1);
});

test('rejects missing and malformed credentials or configuration without fetching keys', async t => {
  const env = envFor('config');
  const token = await tokenFor(env);
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ keys: [key.jwk] }));
  assert.equal(await verifyAdminAccess(new Request('https://api.afr.im/api/admin/status', {
    headers: { Cookie: `CF_Authorization=${token}`, Authorization: `Bearer ${token}`,
      'Cf-Access-Authenticated-User-Email': 'admin@example.com' },
  }), env), null);
  for (const invalid of ['', 'invalid', 'test.test.test.test', 'x'.repeat(16385), `${token}, ${token}`]) {
    assert.equal(await verifyAdminAccess(request(invalid), env), null);
  }
  for (const invalid of [undefined, 'http://config.cloudflareaccess.com',
    'https://config.cloudflareaccess.com.evil.test', 'https://config.cloudflareaccess.com@evil.test',
    'https://config.cloudflareaccess.com:443', 'https://config.cloudflareaccess.com/extra']) {
    assert.equal(await verifyAdminAccess(request(token), { ...env, ADMIN_ACCESS_ISSUER: invalid }), null);
  }
  assert.equal(await verifyAdminAccess(request(token), { ...env, ADMIN_ACCESS_AUD: undefined }), null);
  assert.equal(fetch.mock.callCount(), 0);
});

test('requires issuer, audience, time window, application token type and a browser identity', async t => {
  const env = envFor('claims');
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ keys: [key.jwk] }));
  for (const claims of [
    { iss: 'https://other.cloudflareaccess.com' }, { aud: ['other'] }, { aud: [audience, 42] },
    { exp: undefined }, { exp: '4102444800' }, { exp: Math.floor(Date.now() / 1000) },
    { nbf: Math.floor(Date.now() / 1000) + 3600 }, { nbf: null },
    { type: 'org' }, { type: undefined }, { type: 'service' }, { email: undefined }, { email: '' },
    { common_name: 'service.access' }, { sub: '' }, { sub: undefined },
  ]) {
    assert.equal(await verifyAdminAccess(request(await tokenFor(env, claims)), env), null, JSON.stringify(claims));
  }
  for (const header of [{ alg: 'none' }, { alg: 'HS256' }, { typ: 'JWS' },
    { kid: undefined }, { kid: 'k'.repeat(129) }, { crit: ['b64'], b64: false }]) {
    assert.equal(await verifyAdminAccess(request(await tokenFor(env, {}, header)), env), null, JSON.stringify(header));
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('rejects a different signing key and changes to signed claims without refreshing cached keys', async t => {
  const env = envFor('signature');
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ keys: [key.jwk] }));
  const token = await tokenFor(env);
  assert.deepEqual(await verifyAdminAccess(request(token), env), { subject: reader, canWrite: false });
  assert.equal(await verifyAdminAccess(request(await tokenFor(env, {}, { kid: key.kid }, rotated)), env), null);
  const [header, payload, signature] = token.split('.') as [string, string, string];
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(await verifyAdminAccess(request(`${header}.${jsonPart({ ...claims, sub: operator })}.${signature}`), env), null);
  assert.equal(fetch.mock.callCount(), 1);
});

test('rotates on a new kid, rate-limits misses, and never falls back to expired keys', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const env = envFor('rotation');
  let jwks = [key.jwk];
  let offline = false;
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    if (offline) throw new Error('unreachable');
    return Response.json({ keys: jwks });
  });
  const initialRequest = request(await tokenFor(env));
  const rotatedRequest = request(await tokenFor(env, {}, {}, rotated));
  const expected = { subject: reader, canWrite: false };
  assert.deepEqual(await verifyAdminAccess(initialRequest, env), expected);
  jwks = [rotated.jwk];
  assert.deepEqual(await verifyAdminAccess(rotatedRequest, env), expected);
  assert.equal(await verifyAdminAccess(initialRequest, env), null, 'replaced key removed');
  for (const kid of ['missing-one', 'missing-two', 'missing-three']) {
    assert.equal(await verifyAdminAccess(request(await tokenFor(env, {}, { kid })), env), null);
  }
  assert.equal(fetch.mock.callCount(), 2);
  now += 11_000;
  assert.equal(await verifyAdminAccess(initialRequest, env), null, 'removed key remains absent after refresh');
  assert.equal(fetch.mock.callCount(), 3);
  assert.deepEqual(await verifyAdminAccess(rotatedRequest, env), expected);
  now += 5 * 60_000 + 1;
  offline = true;
  assert.equal(await verifyAdminAccess(rotatedRequest, env), null);
  assert.equal(await verifyAdminAccess(rotatedRequest, env), null);
  assert.equal(fetch.mock.callCount(), 4);
  now += 11_000;
  offline = false;
  assert.deepEqual(await verifyAdminAccess(rotatedRequest, env), expected);
  assert.equal(fetch.mock.callCount(), 5);
});

test('isolates issuer caches and discards keys removed by an empty JWKS', async t => {
  const firstEnv = envFor('first-team');
  const secondEnv = envFor('second-team');
  let firstKeys = [key.jwk];
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string) =>
    Response.json({ keys: url === `${firstEnv.ADMIN_ACCESS_ISSUER}/cdn-cgi/access/certs`
      ? firstKeys : [{ ...rotated.jwk, kid: key.kid }] }));
  const first = request(await tokenFor(firstEnv));
  assert.deepEqual(await verifyAdminAccess(first, firstEnv), { subject: reader, canWrite: false });
  assert.equal(await verifyAdminAccess(request(await tokenFor(secondEnv)), secondEnv), null);
  assert.deepEqual(await verifyAdminAccess(request(await tokenFor(secondEnv, {}, { kid: key.kid }, rotated)), secondEnv),
    { subject: reader, canWrite: false });
  firstKeys = [];
  assert.equal(await verifyAdminAccess(request(await tokenFor(firstEnv, {}, {}, rotated)), firstEnv), null);
  assert.equal(await verifyAdminAccess(first, firstEnv), null);
  assert.equal(fetch.mock.callCount(), 3);
});

test('bounds parallel refreshes and rejects malformed or oversized JWKS responses', async t => {
  const env = envFor('parallel');
  const req = request(await tokenFor(env));
  const { promise, resolve } = Promise.withResolvers<Response>();
  const fetch = t.mock.method(globalThis, 'fetch', () => promise);
  const first = verifyAdminAccess(req, env);
  await assert.rejects(verifyAdminAccess(req, env), AdminAccessTemporarilyUnavailable);
  assert.equal(fetch.mock.callCount(), 1);
  resolve(Response.json({ keys: [key.jwk] }));
  assert.deepEqual(await first, { subject: reader, canWrite: false });

  const malformed = [
    new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/certs' } }),
    new Response('broken JSON'),
    Response.json({ keys: [key.jwk, key.jwk] }),
    Response.json({ keys: Array.from({ length: 17 }, (_, n) => ({ ...key.jwk, kid: `key-${n}` })) }),
    Response.json({ keys: [{ ...key.jwk, alg: 'RS512' }] }),
    Response.json({ keys: [key.jwk], filler: 'x'.repeat(64 * 1024) }),
  ];
  for (const [index, response] of malformed.entries()) {
    const currentEnv = envFor(`malformed-${index}`);
    fetch.mock.mockImplementationOnce(async () => response);
    assert.equal(await verifyAdminAccess(request(await tokenFor(currentEnv)), currentEnv), null);
  }
});
