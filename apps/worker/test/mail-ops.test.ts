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
