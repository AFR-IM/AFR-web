// test/mail-worker.test.ts — unit tests for the AFR inbound mail Worker.
//
// The Worker itself never imports node:* — it only runs on workerd. The tests
// therefore build a small D1-shaped adapter over node:sqlite so that the very
// same SQL runs against an in-memory database, and they inject a fake fetch
// so that no test ever touches the network.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  decodeHtmlEntities,
  extractLinks,
  handleOpsRequest,
  parseRawMail,
  pickVerificationLink,
  runAutoProcessing,
  selectHeaders,
  storeInboundMail,
  truncateBody,
  email as emailHandler,
  MAX_BODY_CHARS,
  MAX_LINKS,
  type D1Like,
  type D1StatementLike,
  type MailEnv,
} from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(here, '..', 'schema.sql'), 'utf8');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Adapt node:sqlite to the D1 API surface the Worker uses
 * (prepare → bind → run/all/first). Only the parts the Worker touches are
 * implemented — that is enough to run the production SQL unchanged.
 */
function sqliteD1(raw: DatabaseSync): D1Like {
  return {
    prepare(sql: string): D1StatementLike {
      const stmt = raw.prepare(sql);
      let params: unknown[] = [];
      const api: D1StatementLike = {
        bind(...values: unknown[]) {
          params = values;
          return api;
        },
        async all<T>() {
          return { results: stmt.all(...params) as T[] };
        },
        async first<T>() {
          return (stmt.get(...params) ?? null) as T | null;
        },
        async run() {
          const result = stmt.run(...params);
          return {
            meta: {
              last_row_id: Number(result.lastInsertRowid),
              changes: Number(result.changes),
            },
          };
        },
      };
      return api;
    },
  };
}

/** A fresh in-memory database with the production schema applied. */
function openDb(): { raw: DatabaseSync; db: D1Like } {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA_SQL);
  return { raw, db: sqliteD1(raw) };
}

/** A fake fetch that records its calls and never touches the network. */
function fakeFetch(status = 200): {
  calls: { url: string; init?: Record<string, unknown> }[];
  fetchImpl: (url: string, init?: Record<string, unknown>) => Promise<{ status: number }>;
} {
  const calls: { url: string; init?: Record<string, unknown> }[] = [];
  return {
    calls,
    fetchImpl: async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, init });
      return { status };
    },
  };
}

/** A minimal mail environment. */
function env(db: D1Like, overrides: Partial<MailEnv> = {}): MailEnv {
  return { DB: db, QUEUE_TOKEN: 'test-token', ...overrides };
}

/** Build a raw MIME mail from headers and a body. */
function rawMail(headers: Record<string, string>, body: string): string {
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  return `${lines.join('\r\n')}\r\n\r\n${body}`;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe('schema.sql', () => {
  it('creates the inbound tables and their indexes', () => {
    const { raw } = openDb();
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all<{ name: string }>()
      .map((r) => r.name);
    assert.ok(tables.includes('inbound_mail'), 'missing table inbound_mail');
    assert.ok(tables.includes('inbound_actions'), 'missing table inbound_actions');

    const indexes = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
      .all<{ name: string }>()
      .map((r) => r.name);
    for (const expected of [
      'idx_inbound_mail_received',
      'idx_inbound_mail_sender',
      'idx_inbound_actions_mail',
    ]) {
      assert.ok(indexes.includes(expected), `missing index: ${expected}`);
    }
    raw.close();
  });

  it('is idempotent', () => {
    const { raw } = openDb();
    assert.doesNotThrow(() => raw.exec(SCHEMA_SQL));
    raw.close();
  });
});

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

describe('extractLinks', () => {
  it('collects http(s) links in first-seen order', () => {
    const links = extractLinks('see https://a.test/one and http://b.test/two');
    assert.deepEqual(links, ['https://a.test/one', 'http://b.test/two']);
  });

  it('drops duplicates', () => {
    const links = extractLinks('https://a.test/x https://a.test/x https://a.test/y');
    assert.deepEqual(links, ['https://a.test/x', 'https://a.test/y']);
  });

  it('ignores relative links and non-http schemes', () => {
    const links = extractLinks(
      'relative /path/only mailto:a@b.test ftp://c.test/x https://ok.test/y',
    );
    assert.deepEqual(links, ['https://ok.test/y']);
  });

  it('strips trailing punctuation', () => {
    assert.deepEqual(extractLinks('click https://a.test/x.'), ['https://a.test/x']);
  });

  it('caps the list at 20 links', () => {
    const many = Array.from({ length: 40 }, (_, i) => `https://a.test/${i}`).join(' ');
    const links = extractLinks(many);
    assert.equal(links.length, MAX_LINKS);
    assert.equal(links[0], 'https://a.test/0');
    assert.equal(links[MAX_LINKS - 1], `https://a.test/${MAX_LINKS - 1}`);
  });

  it('scans every source and keeps the overall order', () => {
    const links = extractLinks('https://text.test/1', 'https://html.test/2');
    assert.deepEqual(links, ['https://text.test/1', 'https://html.test/2']);
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes the entities that occur inside URLs', () => {
    assert.equal(
      decodeHtmlEntities('https://x.test/verify?a=1&amp;b=2'),
      'https://x.test/verify?a=1&b=2',
    );
  });

  it('leaves a plain URL untouched', () => {
    assert.equal(decodeHtmlEntities('https://x.test/verify?a=1&b=2'), 'https://x.test/verify?a=1&b=2');
  });
});

// ---------------------------------------------------------------------------
// Header selection, body truncation, MIME parsing
// ---------------------------------------------------------------------------

describe('selectHeaders', () => {
  it('keeps only the operational headers, keyed lowercase', () => {
    const selected = selectHeaders({
      from: 'a@test.test',
      to: 'owner@afr.im',
      subject: 'Hello',
      'message-id': '<abc@test.test>',
      date: 'Thu, 20 Nov 2026 10:00:00 +0000',
      'reply-to': 'reply@test.test',
      'x-spam-score': '0.1',
      received: 'secret',
    });
    assert.deepEqual(Object.keys(selected).sort(), [
      'date',
      'from',
      'message-id',
      'reply-to',
      'subject',
      'to',
    ]);
    assert.equal(selected['message-id'], '<abc@test.test>');
    assert.equal(selected['x-spam-score'], undefined);
  });

  it('drops headers that are absent or empty', () => {
    const selected = selectHeaders({ from: 'a@test.test', subject: '' });
    assert.deepEqual(selected, { from: 'a@test.test' });
  });
});

describe('truncateBody', () => {
  it('keeps short bodies untouched', () => {
    assert.equal(truncateBody('short body'), 'short body');
  });

  it('truncates at 8000 characters', () => {
    const body = 'x'.repeat(MAX_BODY_CHARS + 500);
    const truncated = truncateBody(body);
    assert.equal(truncated.length, MAX_BODY_CHARS);
  });
});

describe('parseRawMail', () => {
  it('reads the plain-text part of a simple mail', () => {
    const parsed = parseRawMail(
      rawMail(
        { From: 'sender@test.test', To: 'owner@afr.im', Subject: 'Verify me' },
        'Please confirm: https://verify.test/verify?token=abc',
      ),
    );
    assert.equal(parsed.headers.subject, 'Verify me');
    assert.match(parsed.text, /Please confirm/);
  });

  it('reads text and html out of a multipart mail', () => {
    const boundary = '----afrmail';
    const raw = [
      'From: sender@test.test',
      'To: owner@afr.im',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'plain https://plain.test/verify',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>html <a href="https://html.test/verify">link</a></p>',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const parsed = parseRawMail(raw);
    assert.match(parsed.text, /plain https:\/\/plain\.test\/verify/);
    assert.ok(parsed.html);
    assert.match(parsed.html, /https:\/\/html\.test\/verify/);
  });

  it('decodes base64 bodies', () => {
    const raw = [
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('hello base64').toString('base64'),
      '',
    ].join('\r\n');
    const parsed = parseRawMail(raw);
    assert.equal(parsed.text, 'hello base64');
  });

  it('decodes quoted-printable bodies', () => {
    const raw = [
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'caf=C3=A9 and a soft=',
      ' break',
      '',
    ].join('\r\n');
    const parsed = parseRawMail(raw);
    // The body keeps the line break that ended the MIME part.
    assert.equal(parsed.text.trim(), 'café and a soft break');
  });
});

// ---------------------------------------------------------------------------
// Storing a mail
// ---------------------------------------------------------------------------

describe('storeInboundMail', () => {
  it('writes every documented column', async () => {
    const { raw, db } = openDb();
    const id = await storeInboundMail(db, {
      sender: 'sender@test.test',
      recipient: 'owner@afr.im',
      subject: 'Verify your domain',
      body: 'click https://verify.test/verify?token=abc',
      links: ['https://verify.test/verify?token=abc'],
      headers: { from: 'sender@test.test', subject: 'Verify your domain' },
      messageId: '<abc@test.test>',
      receivedAt: '2026-11-20T10:00:00.000Z',
    });
    assert.ok(id > 0, 'expected a row id');

    const row = raw
      .prepare('SELECT * FROM inbound_mail WHERE id = ?')
      .get(id) as Record<string, unknown>;
    assert.equal(row.sender, 'sender@test.test');
    assert.equal(row.recipient, 'owner@afr.im');
    assert.equal(row.subject, 'Verify your domain');
    assert.equal(row.body, 'click https://verify.test/verify?token=abc');
    assert.deepEqual(JSON.parse(row.links as string), ['https://verify.test/verify?token=abc']);
    assert.equal(JSON.parse(row.headers as string).subject, 'Verify your domain');
    assert.equal(row.message_id, '<abc@test.test>');
    assert.equal(row.received_at, '2026-11-20T10:00:00.000Z');
    assert.equal(row.processed_at, null);
    raw.close();
  });
});

// ---------------------------------------------------------------------------
// The automatic action
// ---------------------------------------------------------------------------

describe('pickVerificationLink', () => {
  it('accepts a trusted host with a /verify path', () => {
    const link = pickVerificationLink(['https://verify.test/verify?token=x'], ['verify.test']);
    assert.equal(link, 'https://verify.test/verify?token=x');
  });

  it('rejects an untrusted host', () => {
    assert.equal(
      pickVerificationLink(['https://evil.test/verify'], ['verify.test']),
      null,
    );
  });

  it('rejects a trusted host without a /verify path', () => {
    assert.equal(
      pickVerificationLink(['https://verify.test/other'], ['verify.test']),
      null,
    );
  });

  it('does not trust a subdomain of a trusted domain', () => {
    assert.equal(
      pickVerificationLink(['https://sub.verify.test/verify'], ['verify.test']),
      null,
    );
  });

  it('decodes HTML entities before matching', () => {
    assert.equal(
      pickVerificationLink(['https://verify.test/verify?a=1&amp;b=2'], ['verify.test']),
      'https://verify.test/verify?a=1&b=2',
    );
  });
});

describe('runAutoProcessing', () => {
  const trusted = ['verify.test'];

  it('does not visit anything when the sender is not trusted', async () => {
    const { raw, db } = openDb();
    const id = await storeInboundMail(db, {
      sender: 'attacker@evil.test',
      recipient: 'owner@afr.im',
      subject: 's',
      body: 'b',
      links: ['https://verify.test/verify?token=x'],
      headers: {},
      messageId: null,
      receivedAt: '2026-11-20T10:00:00.000Z',
    });

    const fake = fakeFetch();
    await runAutoProcessing(
      db,
      env(db, { TRUSTED_SENDER_DOMAINS: trusted.join(',') }),
      { id, sender: 'attacker@evil.test', links: ['https://verify.test/verify?token=x'] },
      fake.fetchImpl as never,
    );

    assert.equal(fake.calls.length, 0, 'must not visit for an untrusted sender');
    const actions = raw.prepare('SELECT * FROM inbound_actions').all();
    assert.equal(actions.length, 0, 'must not record an action for an untrusted sender');
    const row = raw.prepare('SELECT processed_note FROM inbound_mail WHERE id = ?').get(id) as {
      processed_note: string;
    };
    assert.match(row.processed_note, /skipped/);
    raw.close();
  });

  it('does not visit when the link host is not trusted', async () => {
    const { raw, db } = openDb();
    const links = ['https://evil.test/verify?token=x'];
    const id = await storeInboundMail(db, {
      sender: 'noreply@verify.test',
      recipient: 'owner@afr.im',
      subject: 's',
      body: 'b',
      links,
      headers: {},
      messageId: null,
      receivedAt: '2026-11-20T10:00:00.000Z',
    });

    const fake = fakeFetch();
    await runAutoProcessing(
      db,
      env(db, { TRUSTED_SENDER_DOMAINS: trusted.join(',') }),
      { id, sender: 'noreply@verify.test', links },
      fake.fetchImpl as never,
    );

    assert.equal(fake.calls.length, 0, 'must not visit an untrusted host');
    assert.equal(raw.prepare('SELECT * FROM inbound_actions').all().length, 0);
    raw.close();
  });

  it('visits exactly one trusted verification link and records the action', async () => {
    const { raw, db } = openDb();
    const links = [
      'https://verify.test/verify?token=first',
      'https://verify.test/verify?token=second',
    ];
    const id = await storeInboundMail(db, {
      sender: 'noreply@verify.test',
      recipient: 'owner@afr.im',
      subject: 'Verify',
      body: 'b',
      links,
      headers: {},
      messageId: null,
      receivedAt: '2026-11-20T10:00:00.000Z',
    });

    const fake = fakeFetch(200);
    await runAutoProcessing(
      db,
      env(db, { TRUSTED_SENDER_DOMAINS: trusted.join(',') }),
      { id, sender: 'noreply@verify.test', links },
      fake.fetchImpl as never,
    );

    assert.equal(fake.calls.length, 1, 'must visit at most one link');
    assert.equal(fake.calls[0].url, 'https://verify.test/verify?token=first');
    const headers = fake.calls[0].init?.headers as Record<string, string>;
    assert.ok(headers['User-Agent'], 'the visit must carry a User-Agent');
    assert.ok(fake.calls[0].init?.signal, 'the visit must be abortable');

    const actions = raw.prepare('SELECT * FROM inbound_actions').all() as {
      mail_id: number;
      action: string;
      target_url: string;
      result: string;
    }[];
    assert.equal(actions.length, 1);
    assert.equal(actions[0].mail_id, id);
    assert.equal(actions[0].action, 'visit_link');
    assert.equal(actions[0].target_url, 'https://verify.test/verify?token=first');
    assert.match(actions[0].result, /status=200/);
    assert.ok(actions[0].result.length <= 200);
    raw.close();
  });

  it('does nothing when no trusted sender domains are configured', async () => {
    const { raw, db } = openDb();
    const id = await storeInboundMail(db, {
      sender: 'noreply@verify.test',
      recipient: 'owner@afr.im',
      subject: 's',
      body: 'b',
      links: ['https://verify.test/verify?token=x'],
      headers: {},
      messageId: null,
      receivedAt: '2026-11-20T10:00:00.000Z',
    });
    const fake = fakeFetch();
    await runAutoProcessing(
      db,
      env(db, { TRUSTED_SENDER_DOMAINS: '' }),
      { id, sender: 'noreply@verify.test', links: ['https://verify.test/verify?token=x'] },
      fake.fetchImpl as never,
    );
    assert.equal(fake.calls.length, 0);
    assert.equal(raw.prepare('SELECT * FROM inbound_actions').all().length, 0);
    raw.close();
  });

  it('covers a subdomain of a trusted sender domain, but not a lookalike', async () => {
    const { raw, db } = openDb();
    const fake = fakeFetch();
    const visit = async (sender: string) => {
      const id = await storeInboundMail(db, {
        sender,
        recipient: 'owner@afr.im',
        subject: 's',
        body: 'b',
        links: ['https://verify.test/verify?token=x'],
        headers: {},
        messageId: null,
        receivedAt: '2026-11-20T10:00:00.000Z',
      });
      await runAutoProcessing(
        db,
        env(db, { TRUSTED_SENDER_DOMAINS: 'verify.test' }),
        { id, sender, links: ['https://verify.test/verify?token=x'] },
        fake.fetchImpl as never,
      );
    };
    // A subdomain of the trusted domain is covered by it...
    await visit('noreply@mail.verify.test');
    assert.equal(fake.calls.length, 1);
    // ...but a domain that merely ends with the same characters is not.
    await visit('noreply@notverify.test');
    assert.equal(fake.calls.length, 1, 'a lookalike domain must not be trusted');
    raw.close();
  });
});

// ---------------------------------------------------------------------------
// The read interface
// ---------------------------------------------------------------------------

describe('handleOpsRequest', () => {
  /** Seed one mail so the list endpoint has something to return. */
  async function seed(db: D1Like): Promise<number> {
    return storeInboundMail(db, {
      sender: 'sender@test.test',
      recipient: 'owner@afr.im',
      subject: 'Subject line',
      body: 'the secret body',
      links: ['https://verify.test/verify?token=abc'],
      headers: { from: 'sender@test.test' },
      messageId: '<abc@test.test>',
      receivedAt: '2026-11-20T10:00:00.000Z',
    });
  }

  it('rejects a request without a token', async () => {
    const { raw, db } = openDb();
    const res = await handleOpsRequest(
      new Request('https://afr-mail.test/mail', { method: 'GET' }),
      env(db),
    );
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
    raw.close();
  });

  it('rejects a request with a wrong token', async () => {
    const { raw, db } = openDb();
    const res = await handleOpsRequest(
      new Request('https://afr-mail.test/mail', {
        method: 'GET',
        headers: { 'X-Queue-Token': 'wrong' },
      }),
      env(db),
    );
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.ok(!text.includes('test-token'), 'the expected token must never leak');
    raw.close();
  });

  it('rejects every request when the secret is unset', async () => {
    const { raw, db } = openDb();
    const res = await handleOpsRequest(
      new Request('https://afr-mail.test/mail', {
        method: 'GET',
        headers: { 'X-Queue-Token': 'anything' },
      }),
      env(db, { QUEUE_TOKEN: undefined }),
    );
    assert.equal(res.status, 401);
    raw.close();
  });

  it('lists the recent mails without their body', async () => {
    const { raw, db } = openDb();
    await seed(db);
    const res = await handleOpsRequest(
      new Request('https://afr-mail.test/mail?limit=5', {
        method: 'GET',
        headers: { 'X-Queue-Token': 'test-token' },
      }),
      env(db),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    assert.equal(body.items.length, 1);
    const item = body.items[0];
    assert.equal(item.sender, 'sender@test.test');
    assert.equal(item.recipient, 'owner@afr.im');
    assert.equal(item.subject, 'Subject line');
    assert.equal(item.received_at, '2026-11-20T10:00:00.000Z');
    assert.deepEqual(item.links, ['https://verify.test/verify?token=abc']);
    assert.equal(item.body, undefined, 'the list must not contain the body');
    raw.close();
  });

  it('returns one mail in full', async () => {
    const { raw, db } = openDb();
    const id = await seed(db);
    const res = await handleOpsRequest(
      new Request(`https://afr-mail.test/mail/${id}`, {
        method: 'GET',
        headers: { 'X-Queue-Token': 'test-token' },
      }),
      env(db),
    );
    assert.equal(res.status, 200);
    const mail = (await res.json()) as Record<string, unknown>;
    assert.equal(mail.id, id);
    assert.equal(mail.body, 'the secret body');
    assert.deepEqual(mail.links, ['https://verify.test/verify?token=abc']);
    assert.deepEqual(mail.headers, { from: 'sender@test.test' });
    raw.close();
  });

  it('404s for an unknown mail id', async () => {
    const { raw, db } = openDb();
    const res = await handleOpsRequest(
      new Request('https://afr-mail.test/mail/9999', {
        method: 'GET',
        headers: { 'X-Queue-Token': 'test-token' },
      }),
      env(db),
    );
    assert.equal(res.status, 404);
    raw.close();
  });

  it('lists the automatic actions', async () => {
    const { raw, db } = openDb();
    const id = await seed(db);
    const fake = fakeFetch(200);
    await runAutoProcessing(
      db,
      env(db, { TRUSTED_SENDER_DOMAINS: 'test.test' }),
      { id, sender: 'sender@test.test', links: ['https://test.test/verify'] },
      fake.fetchImpl as never,
    );
    const res = await handleOpsRequest(
      new Request('https://afr-mail.test/actions', {
        method: 'GET',
        headers: { 'X-Queue-Token': 'test-token' },
      }),
      env(db),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].action, 'visit_link');
    raw.close();
  });

  it('answers 405 for every other method', async () => {
    const { raw, db } = openDb();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await handleOpsRequest(
        new Request('https://afr-mail.test/mail', {
          method,
          headers: { 'X-Queue-Token': 'test-token' },
        }),
        env(db),
      );
      assert.equal(res.status, 405, `${method} must be rejected`);
    }
    raw.close();
  });
});

// ---------------------------------------------------------------------------
// The inbound mail handler
// ---------------------------------------------------------------------------

describe('email handler', () => {
  /** A stand-in for the ForwardableEmailMessage the runtime passes in. */
  function message(raw: string): {
    from: string;
    to: string;
    headers: { get(name: string): string | null };
    raw: ReadableStream<Uint8Array>;
  } {
    const headerValues: Record<string, string> = {
      from: 'sender@test.test',
      to: 'owner@afr.im',
      subject: 'Verify your domain',
      'message-id': '<abc@test.test>',
      date: 'Thu, 20 Nov 2026 10:00:00 +0000',
    };
    return {
      from: 'sender@test.test',
      to: 'owner@afr.im',
      headers: { get: (name: string) => headerValues[name.toLowerCase()] ?? null },
      raw: new Response(raw).body as ReadableStream<Uint8Array>,
    };
  }

  it('stores the mail and defers the automatic action', async () => {
    const { raw, db } = openDb();
    const waitUntil: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waitUntil.push(p) };

    await emailHandler(
      message(
        rawMail(
          { From: 'sender@test.test', To: 'owner@afr.im', Subject: 'Verify your domain' },
          'confirm here: https://verify.test/verify?token=abc',
        ),
      ),
      env(db, { TRUSTED_SENDER_DOMAINS: 'test.test' }),
      ctx,
    );

    const row = raw.prepare('SELECT * FROM inbound_mail').get() as Record<string, unknown>;
    assert.ok(row, 'the mail must be stored');
    assert.equal(row.sender, 'sender@test.test');
    assert.equal(row.recipient, 'owner@afr.im');
    assert.equal(row.subject, 'Verify your domain');
    assert.match(row.body as string, /confirm here/);
    assert.deepEqual(JSON.parse(row.links as string), ['https://verify.test/verify?token=abc']);
    assert.equal(row.received_at !== null, true);

    assert.equal(waitUntil.length, 1, 'the automatic action must run in the background');
    await Promise.all(waitUntil);
    raw.close();
  });

  it('stores a parse error instead of dropping the mail', async () => {
    const { raw, db } = openDb();
    const ctx = { waitUntil: () => {} };

    await emailHandler(
      {
        from: 'sender@test.test',
        to: 'owner@afr.im',
        headers: { get: () => null },
        // A stream that fails on read simulates an unparsable mail.
        raw: {
          getReader() {
            return {
              read: async () => {
                throw new Error('boom');
              },
              cancel: async () => {},
            };
          },
        } as unknown as ReadableStream<Uint8Array>,
      },
      env(db),
      ctx,
    );

    const row = raw.prepare('SELECT * FROM inbound_mail').get() as Record<string, unknown>;
    assert.ok(row, 'a broken mail must still be stored');
    assert.match(row.body as string, /^PARSE_ERROR: /);
    raw.close();
  });
});
