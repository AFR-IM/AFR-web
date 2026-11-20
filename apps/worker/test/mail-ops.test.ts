// test/mail-ops.test.ts — API-key exemption and mail housekeeping.
//
// The exemption exists so that a machine client (AI agent, script) can use
// the public POST endpoints without running a browser widget; the gate must
// therefore open for a valid key and stay shut for everything else.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_KEY_HEADER, hashApiKey, isValidApiKey } from '../src/api-key.ts';
import { encryptEmail, hashToken } from '../src/email.ts';
import { createApp } from '../src/index.ts';
import { pruneMailArtifacts } from '../src/mail-gc.ts';
import { openSeededDb } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** The inbound tables live in the mail worker's schema but share this
 * database, so the tests have to create them as well. */
const INBOUND_SCHEMA = readFileSync(
  join(here, '..', '..', 'mail-worker', 'schema.sql'),
  'utf8',
);

function openMailDb(): ReturnType<typeof openSeededDb> {
  const seeded = openSeededDb();
  seeded.raw.exec(INBOUND_SCHEMA);
  return seeded;
}

async function seedKey(raw: DatabaseSync, key: string, revoked = false): Promise<void> {
  raw
    .prepare(
      'INSERT INTO api_keys (key_hash, domain_contact, tier, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(await hashApiKey(key), null, 'free', new Date().toISOString(), revoked ? new Date().toISOString() : null);
}

describe('api keys', () => {
  it('hashes deterministically and differently from the plaintext', async () => {
    const first = await hashApiKey('agent-key-123');
    const second = await hashApiKey('agent-key-123');
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.notEqual(first, 'agent-key-123');
    assert.notEqual(first, await hashApiKey('agent-key-124'));
  });

  it('accepts a live key and rejects unknown or revoked ones', async () => {
    const { db, raw } = openSeededDb();
    await seedKey(raw, 'good-key');
    await seedKey(raw, 'revoked-key', true);

    assert.equal(await isValidApiKey(db, 'good-key'), true);
    assert.equal(await isValidApiKey(db, 'revoked-key'), false);
    assert.equal(await isValidApiKey(db, 'unknown-key'), false);
    assert.equal(await isValidApiKey(db, null), false);
    assert.equal(await isValidApiKey(db, '  '), false);
  });

  it('fails closed when the table cannot be read', async () => {
    const { db, raw } = openSeededDb();
    raw.exec('DROP TABLE api_keys');
    assert.equal(await isValidApiKey(db, 'any-key'), false);
  });
});

describe('mail housekeeping', () => {
  it('removes expired challenges and old mail, keeps the rest', async () => {
    const { db, raw } = openMailDb();
    const now = new Date('2026-11-20T12:00:00.000Z');
    const old = '2026-01-01T00:00:00.000Z';
    const recent = '2026-11-19T00:00:00.000Z';

    raw
      .prepare(
        'INSERT INTO email_challenges (domain, challenge_hash, email_cipher, email_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
      )
      .run('a.example', 'h1', 'c', 'e', old, old);
    raw
      .prepare(
        'INSERT INTO email_challenges (domain, challenge_hash, email_cipher, email_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
      )
      .run('b.example', 'h2', 'c', 'e', '2026-11-21T00:00:00.000Z', recent);

    raw
      .prepare(
        'INSERT INTO inbound_mail (sender, recipient, subject, body, links, headers, message_id, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('a@example.com', 'owner@afr.im', 'old', 'body', '[]', '{}', 'm1', old);
    raw
      .prepare(
        'INSERT INTO inbound_mail (sender, recipient, subject, body, links, headers, message_id, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('b@example.com', 'owner@afr.im', 'new', 'body', '[]', '{}', 'm2', recent);

    raw
      .prepare(
        'INSERT INTO notify_outbox (domain, event_key, grade, score_total, prev_grade, prev_score, status, attempts, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('a.example', 'k1', 'A', 90, 'B', 80, 'sent', 1, old, old);
    raw
      .prepare(
        'INSERT INTO notify_outbox (domain, event_key, grade, score_total, prev_grade, prev_score, status, attempts, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('b.example', 'k2', 'A', 90, 'B', 80, 'pending', 0, recent, null);

    raw
      .prepare('INSERT INTO mail_cooldown (recipient_hash, last_sent_at) VALUES (?, ?)')
      .run('hash-old', old);
    raw
      .prepare('INSERT INTO mail_cooldown (recipient_hash, last_sent_at) VALUES (?, ?)')
      .run('hash-new', recent);

    const pruned = await pruneMailArtifacts(db, { now: () => now });
    assert.equal(pruned.challenges, 1);
    assert.equal(pruned.inboundMail, 1);
    assert.equal(pruned.outbox, 1);
    assert.equal(pruned.cooldown, 1);

    const challenges = raw.prepare('SELECT domain FROM email_challenges').all() as { domain: string }[];
    assert.deepEqual(challenges.map((c) => c.domain), ['b.example']);
    const mail = raw.prepare('SELECT subject FROM inbound_mail').all() as { subject: string }[];
    assert.deepEqual(mail.map((m) => m.subject), ['new']);
    const outbox = raw.prepare('SELECT event_key FROM notify_outbox').all() as { event_key: string }[];
    assert.deepEqual(outbox.map((o) => o.event_key), ['k2']);
    const cooldown = raw
      .prepare('SELECT recipient_hash FROM mail_cooldown')
      .all() as { recipient_hash: string }[];
    assert.deepEqual(cooldown.map((c) => c.recipient_hash), ['hash-new']);
  });

  it('never throws when a table is missing', async () => {
    const { db, raw } = openMailDb();
    raw.exec('DROP TABLE email_challenges');
    raw.exec('DROP TABLE inbound_mail');
    raw.exec('DROP TABLE notify_outbox');
    raw.exec('DROP TABLE mail_cooldown');
    raw.exec('DROP TABLE inbound_actions');
    const pruned = await pruneMailArtifacts(db);
    assert.deepEqual(pruned, {
      challenges: 0,
      inboundMail: 0,
      inboundActions: 0,
      outbox: 0,
      cooldown: 0,
    });
  });
});

describe('the human check and the machine path', () => {
  it('lets a machine client through with an API key and rejects it without one', async () => {
    const { db, raw } = openSeededDb();
    const key = 'agent-key-for-the-machine';
    raw
      .prepare(
        'INSERT INTO api_keys (key_hash, domain_contact, tier, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)',
      )
      .run(await hashApiKey(key), null, 'free', new Date().toISOString());

    const app = createApp({ db });
    const body = JSON.stringify({ domain: 'machine-client-example.com' });

    const rejected = await app.request(
      '/api/v1/submissions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      },
      { TURNSTILE_SECRET: 'test-secret' },
    );
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error, 'turnstile_failed');

    const accepted = await app.request(
      '/api/v1/submissions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [API_KEY_HEADER]: key },
        body,
      },
      { TURNSTILE_SECRET: 'test-secret' },
    );
    assert.equal(accepted.status, 201, 'an API key replaces the human check');
    const payload = await accepted.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.domain, 'machine-client-example.com');
  });
});

// ---------------------------------------------------------------------------
// The management token of an owner mailbox
//
// The token is handed out exactly once (by the mailbox confirmation) and
// authorises every later read of the mailbox. Without it nobody learns even
// the masked address of a stranger's mailbox.
// ---------------------------------------------------------------------------

describe('the management token of an owner mailbox', () => {
  const SECRET = btoa('a'.repeat(32));
  const TOKEN = 'manage-0123456789abcdef0123456789abcdef';

  /** A confirmed mailbox with a known management token. */
  async function seedMailbox(raw: DatabaseSync, domain: string, email: string): Promise<void> {
    const { cipher, hash } = await encryptEmail(email, SECRET);
    raw
      .prepare(
        `INSERT INTO owner_emails
           (domain, email_cipher, email_hash, verified_at, verify_token_hash, verify_expires_at, manage_token_hash, notify, created_at, updated_at)
         VALUES (?, ?, ?, '2026-11-20T00:00:00.000Z', NULL, NULL, ?, 1, '2026-11-20', '2026-11-20')`,
      )
      .run(domain, cipher, hash, await hashToken(TOKEN));
  }

  function read(
    app: ReturnType<typeof createApp>,
    token: string | null,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-forwarded-for': '203.0.113.95',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    return app.request(
      '/api/v1/owners/email?domain=example.com',
      { headers },
      { EMAIL_ENC_KEY: SECRET },
    );
  }

  it('refuses a request without a token and with a wrong token', async () => {
    const { db, raw } = openSeededDb();
    await seedMailbox(raw, 'example.com', 'owner@example.com');
    const app = createApp({ db });

    const anonymous = await read(app, null);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error, 'unauthorized');

    const wrong = await read(app, 'manage-ffffffffffffffffffffffffffffffff');
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).error, 'unauthorized');
  });

  it('answers the masked address for the right token — and nothing else', async () => {
    const { db, raw } = openSeededDb();
    await seedMailbox(raw, 'example.com', 'owner@example.com');
    const app = createApp({ db });

    const res = await read(app, TOKEN);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['domain', 'email_masked', 'notify', 'verified']);
    assert.equal(body.domain, 'example.com');
    assert.equal(body.email_masked, 'o***@example.com');
    assert.equal(body.verified, true);
    assert.equal(body.notify, true);
    assert.ok(!JSON.stringify(body).includes('owner@example.com'), 'no plaintext in the answer');
    assert.ok(!JSON.stringify(body).includes(TOKEN), 'the token is never echoed back');
  });

  it('refuses a token of another domain', async () => {
    const { db, raw } = openSeededDb();
    await seedMailbox(raw, 'example.com', 'owner@example.com');
    const app = createApp({ db });

    const res = await app.request(
      '/api/v1/owners/email?domain=coolsite.io',
      {
        headers: {
          accept: 'application/json',
          'x-forwarded-for': '203.0.113.95',
          authorization: `Bearer ${TOKEN}`,
        },
      },
      { EMAIL_ENC_KEY: SECRET },
    );
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'unauthorized');
  });
});
