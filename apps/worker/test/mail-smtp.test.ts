// test/mail-smtp.test.ts — generic SMTP egress + outbound mail quota.
//
// The SMTP conversation is exercised against a fake socket (the `connect` step
// is injectable), so the whole protocol flow is covered without a network.
// The quota is exercised against a node:sqlite database built from
// schema.sql (the helper seeds the new mail_quota / mail_cooldown tables).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp, deliverOwnerMail, type WorkerEnv } from '../src/index.ts';
import {
  buildSmtpMessage,
  classifySmtpError,
  describeSmtpProblem,
  encodeDotStuff,
  parseSmtpConfig,
  parseSmtpResponse,
  sendViaSmtp,
  type SmtpConfig,
} from '../src/mail-smtp.ts';
import {
  consumeMailQuota,
  readMailQuotaStatus,
} from '../src/mail-quota.ts';
import { openSeededDb } from './helpers.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** A resolved SMTP channel with a credential that must never show up in an
 * error message or a log line. */
const CONFIG: SmtpConfig = {
  host: 'mail.test.example',
  port: 587,
  security: 'starttls',
  username: 'user@example.com',
  password: 'sup3r-s3cret',
  from: 'AFR <notifications@afr.im>',
};

const RECIPIENT = 'owner@example.com';

/** Fake SMTP server socket: records what the client wrote and answers with
 * scripted replies. A reply of null means "the server stays silent". */
class FakeSocket {
  readonly written: string[] = [];
  startTlsCalls = 0;
  closed = false;
  private buffer = '';
  private pending: ((chunk: Uint8Array | null) => void) | null = null;
  private readonly responder: (command: string) => string | null;

  constructor(
    responder: (command: string) => string | null,
    greeting = '220 mail.test.example ESMTP ready\r\n',
  ) {
    this.responder = responder;
    if (greeting) this.buffer += greeting;
  }

  async write(data: string | Uint8Array): Promise<number> {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.written.push(text);
    const command = (text.split('\r\n')[0] ?? '').trim();
    const reply = this.responder(command);
    if (reply !== null) this.push(reply);
    return text.length;
  }

  read(): Promise<Uint8Array | null> {
    if (this.buffer) {
      const chunk = this.buffer;
      this.buffer = '';
      return Promise.resolve(encoder.encode(chunk));
    }
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }

  async startTls(): Promise<FakeSocket> {
    this.startTlsCalls += 1;
    return this;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private push(text: string): void {
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve(encoder.encode(text));
    } else {
      this.buffer += text;
    }
  }
}

/** The scripted server of the happy path (and of the failure paths through
 * the `overrides` map). */
function scriptedResponder(overrides: Record<string, string> = {}) {
  let authPayloads = 0;
  return (command: string): string | null => {
    if (command.startsWith('EHLO')) {
      return (
        overrides.EHLO ??
        '250-mail.test.example Hello\r\n250-SIZE 52428800\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n'
      );
    }
    if (command === 'STARTTLS') return overrides.STARTTLS ?? '220 2.0.0 Ready to start TLS\r\n';
    if (command === 'AUTH LOGIN') return overrides.AUTH ?? '334 VXNlcm5hbWU6\r\n';
    if (command.startsWith('AUTH PLAIN')) {
      return overrides.AUTH ?? '235 2.7.0 Authentication successful\r\n';
    }
    // The two base64 credential payloads of the AUTH LOGIN exchange. The
    // check comes last: "DATA" is a valid base64 alphabet string.
    if (command.startsWith('MAIL FROM')) return '250 2.1.0 Ok\r\n';
    if (command.startsWith('RCPT TO')) return overrides.RCPT ?? '250 2.1.5 Ok\r\n';
    if (command === 'DATA') return '354 End data with <CR><LF>.<CR><LF>\r\n';
    if (command === 'QUIT') return '221 2.0.0 Bye\r\n';
    // The DATA payload (the message itself) is answered with the final 250.
    if (command.startsWith('From:')) return '250 2.0.0 Ok: queued as 4242\r\n';
    if (/^[A-Za-z0-9+/=]+$/.test(command)) {
      authPayloads += 1;
      if (authPayloads === 1) return '334 UGFzc3dvcmQ6\r\n';
      return overrides.AUTH ?? '235 2.7.0 Authentication successful\r\n';
    }
    return null;
  };
}

/** Reduce the recorded writes to a comparable command sequence. */
function commandLabels(socket: FakeSocket): string[] {
  const labels: string[] = [];
  for (const chunk of socket.written) {
    const first = (chunk.split('\r\n')[0] ?? '').trim();
    if (first.startsWith('EHLO')) labels.push('EHLO');
    else if (first === 'STARTTLS') labels.push('STARTTLS');
    else if (first.startsWith('AUTH LOGIN')) labels.push('AUTH LOGIN');
    else if (first.startsWith('AUTH PLAIN')) labels.push('AUTH PLAIN');
    else if (first.startsWith('MAIL FROM')) labels.push('MAIL FROM');
    else if (first.startsWith('RCPT TO')) labels.push('RCPT TO');
    else if (first === 'DATA') labels.push('DATA');
    else if (first === 'QUIT') labels.push('QUIT');
    else if (chunk.startsWith('From:')) labels.push('BODY');
    else labels.push('AUTH PAYLOAD');
  }
  return labels;
}

function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return { DB: undefined as unknown as WorkerEnv['DB'], ...overrides };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('parseSmtpConfig / describeSmtpProblem', () => {
  it('reports "not_configured" when no host is set', () => {
    assert.equal(parseSmtpConfig({}), null);
    assert.equal(describeSmtpProblem({}), 'not_configured');
    assert.equal(describeSmtpProblem({ SMTP_HOST: '   ' }), 'not_configured');
  });

  it('reports "port_25_blocked" for the port the platform forbids', () => {
    const env = { SMTP_HOST: 'mail.test.example', SMTP_PORT: '25', SMTP_FROM: 'a@b.im' };
    assert.equal(describeSmtpProblem(env), 'port_25_blocked');
    assert.equal(parseSmtpConfig(env)?.port, 25);
  });

  it('reports "missing_from" when no sender identity is configured', () => {
    const env = { SMTP_HOST: 'mail.test.example', SMTP_PORT: '587' };
    assert.equal(describeSmtpProblem(env), 'missing_from');
    assert.equal(parseSmtpConfig(env)?.from, undefined);
  });

  it('resolves the default port and transport security', () => {
    const config = parseSmtpConfig({ SMTP_HOST: 'mail.test.example', SMTP_FROM: 'a@b.im' });
    assert.ok(config);
    assert.equal(config.host, 'mail.test.example');
    assert.equal(config.port, 587);
    assert.equal(config.security, 'starttls');
    assert.equal(describeSmtpProblem({ SMTP_HOST: 'mail.test.example', SMTP_FROM: 'a@b.im' }), 'ok');
  });

  it('reads every channel variable', () => {
    const config = parseSmtpConfig({
      SMTP_HOST: 'smtp.test.example',
      SMTP_PORT: '465',
      SMTP_SECURITY: 'ssl',
      SMTP_USERNAME: 'user',
      SMTP_PASSWORD: 'secret',
      SMTP_FROM: 'AFR <no-reply@afr.im>',
      SMTP_REPLY_TO: 'reply@afr.im',
    });
    assert.deepEqual(config, {
      host: 'smtp.test.example',
      port: 465,
      security: 'ssl',
      username: 'user',
      password: 'secret',
      from: 'AFR <no-reply@afr.im>',
      replyTo: 'reply@afr.im',
    });
  });
});

// ---------------------------------------------------------------------------
// Protocol helpers
// ---------------------------------------------------------------------------

describe('parseSmtpResponse', () => {
  it('reads the continuation marker of a multi-line reply', () => {
    const first = parseSmtpResponse('250-mail.test.example Hello');
    assert.equal(first.code, 250);
    assert.equal(first.text, 'mail.test.example Hello');
    assert.equal(first.more, true);

    const last = parseSmtpResponse('250 OK');
    assert.equal(last.code, 250);
    assert.equal(last.text, 'OK');
    assert.equal(last.more, false);
  });

  it('reads a three digit code', () => {
    assert.equal(parseSmtpResponse('535 5.7.8 Authentication credentials invalid').code, 535);
    assert.equal(parseSmtpResponse('354 End data with <CR><LF>.<CR><LF>').code, 354);
  });

  it('reports code 0 for a line that is not a reply', () => {
    const parsed = parseSmtpResponse('garbage');
    assert.equal(parsed.code, 0);
    assert.equal(parsed.text, 'garbage');
    assert.equal(parsed.more, false);
  });
});

describe('encodeDotStuff', () => {
  it('doubles a dot at the start of a line', () => {
    assert.equal(encodeDotStuff('.hidden'), '..hidden');
    assert.equal(encodeDotStuff('first\r\n.second'), 'first\r\n..second');
    assert.equal(encodeDotStuff('first\n.second\nthird'), 'first\n..second\nthird');
  });

  it('leaves everything else untouched', () => {
    assert.equal(encodeDotStuff('plain body'), 'plain body');
    assert.equal(encodeDotStuff('a.b.c'), 'a.b.c');
    assert.equal(encodeDotStuff('line\ndot.in.middle'), 'line\ndot.in.middle');
  });
});

describe('buildSmtpMessage', () => {
  it('writes the mandatory headers', () => {
    const message = buildSmtpMessage({
      from: 'AFR <notifications@afr.im>',
      to: 'owner@example.com',
      subject: 'Your AFR report',
      text: 'Hello there.',
      date: new Date('2026-11-20T10:00:00Z'),
      messageId: '<abc123@afr.im>',
    });
    assert.ok(message.includes('From: AFR <notifications@afr.im>'));
    assert.ok(message.includes('To: owner@example.com'));
    assert.ok(message.includes('Subject: Your AFR report'));
    assert.ok(message.includes('Date: Fri, 20 Nov 2026 10:00:00 +0000'));
    assert.ok(message.includes('Message-ID: <abc123@afr.im>'));
    assert.ok(message.includes('Hello there.'));
  });

  it('encodes a non-ASCII subject as an RFC 2047 word', () => {
    const message = buildSmtpMessage({
      from: 'no-reply@afr.im',
      to: 'owner@example.com',
      subject: '你的 AFR 评分变化',
      text: 'x',
      date: new Date('2026-11-20T10:00:00Z'),
    });
    assert.match(message, /Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
    assert.ok(!message.includes('你的'));
  });

  it('builds a multipart message when an HTML part is given', () => {
    const message = buildSmtpMessage({
      from: 'no-reply@afr.im',
      to: 'owner@example.com',
      subject: 'Report',
      text: 'plain',
      html: '<p>html</p>',
      date: new Date('2026-11-20T10:00:00Z'),
    });
    assert.ok(message.includes('Content-Type: multipart/alternative; boundary="'));
    assert.ok(message.includes('Content-Type: text/html; charset=utf-8'));
    assert.ok(message.includes('<p>html</p>'));
  });
});

describe('classifySmtpError', () => {
  it('maps the reply codes to their class', () => {
    assert.equal(classifySmtpError(535, 'Authentication credentials invalid'), 'auth');
    assert.equal(classifySmtpError(534, 'Authentication mechanism is too weak'), 'auth');
    assert.equal(classifySmtpError(550, 'No such user'), 'recipient');
    assert.equal(classifySmtpError(554, 'Transaction failed'), 'protocol');
    assert.equal(classifySmtpError(421, 'Service not available'), 'network');
    assert.equal(classifySmtpError(0, 'connection timed out'), 'timeout');
    assert.equal(classifySmtpError(220, 'STARTTLS command not recognized'), 'tls');
  });
});

// ---------------------------------------------------------------------------
// The SMTP conversation
// ---------------------------------------------------------------------------

describe('sendViaSmtp', () => {
  it('runs the whole conversation in the right order', async () => {
    const socket = new FakeSocket(scriptedResponder());
    const result = await sendViaSmtp({
      config: CONFIG,
      to: RECIPIENT,
      subject: 'Your AFR report',
      text: 'Hello there.',
      now: () => new Date('2026-11-20T10:00:00Z'),
      connect: async () => socket,
    });

    assert.equal(result.ok, true);
    assert.ok(result.id);
    assert.equal(result.error, undefined);
    assert.deepEqual(commandLabels(socket), [
      'EHLO',
      'STARTTLS',
      'EHLO',
      'AUTH LOGIN',
      'AUTH PAYLOAD',
      'AUTH PAYLOAD',
      'MAIL FROM',
      'RCPT TO',
      'DATA',
      'BODY',
      'QUIT',
    ]);
    assert.equal(socket.startTlsCalls, 1);
    // The message itself carries the headers and the body.
    const body = socket.written.find((chunk) => chunk.startsWith('From:')) ?? '';
    assert.ok(body.includes('Subject: Your AFR report'));
    assert.ok(body.includes('Hello there.'));
    assert.ok(body.endsWith('\r\n.\r\n'));
  });

  it('skips STARTTLS on an implicit TLS channel', async () => {
    const socket = new FakeSocket(scriptedResponder());
    const result = await sendViaSmtp({
      config: { ...CONFIG, security: 'ssl', port: 465 },
      to: RECIPIENT,
      subject: 's',
      text: 't',
      now: () => new Date('2026-11-20T10:00:00Z'),
      connect: async () => socket,
    });
    assert.equal(result.ok, true);
    assert.equal(socket.startTlsCalls, 0);
    assert.ok(!commandLabels(socket).includes('STARTTLS'));
  });

  it('reports an authentication failure without leaking the password', async () => {
    const socket = new FakeSocket(
      scriptedResponder({ AUTH: '535 5.7.8 Authentication credentials invalid\r\n' }),
    );
    const result = await sendViaSmtp({
      config: CONFIG,
      to: RECIPIENT,
      subject: 's',
      text: 't',
      now: () => new Date('2026-11-20T10:00:00Z'),
      connect: async () => socket,
    });

    assert.equal(result.ok, false);
    assert.equal(result.category, 'auth');
    assert.ok(result.error);
    assert.ok(!result.error.includes('sup3r-s3cret'));
    assert.ok(!result.error.includes(RECIPIENT));
  });

  it('reports a rejected recipient', async () => {
    const socket = new FakeSocket(
      scriptedResponder({ RCPT: '550 5.1.1 <owner@example.com>: No such user\r\n' }),
    );
    const result = await sendViaSmtp({
      config: CONFIG,
      to: RECIPIENT,
      subject: 's',
      text: 't',
      now: () => new Date('2026-11-20T10:00:00Z'),
      connect: async () => socket,
    });

    assert.equal(result.ok, false);
    assert.equal(result.category, 'recipient');
    assert.ok(result.error);
    assert.ok(!result.error.includes(RECIPIENT));
  });

  it('gives up when the server stays silent', async () => {
    const socket = new FakeSocket(() => null);
    const result = await sendViaSmtp({
      config: CONFIG,
      to: RECIPIENT,
      subject: 's',
      text: 't',
      now: () => new Date(),
      timeoutMs: 30,
      connect: async () => socket,
    });

    assert.equal(result.ok, false);
    assert.equal(result.category, 'timeout');
  });

  it('gives up when the injected clock passes the budget', async () => {
    const socket = new FakeSocket(scriptedResponder());
    const base = Date.now();
    let calls = 0;
    const result = await sendViaSmtp({
      config: CONFIG,
      to: RECIPIENT,
      subject: 's',
      text: 't',
      // The first call opens the budget, every later call is past it.
      now: () => new Date(base + (calls++ === 0 ? 0 : 60_000)),
      connect: async () => socket,
    });

    assert.equal(result.ok, false);
    assert.equal(result.category, 'timeout');
  });

  it('refuses port 25 before a socket is opened', async () => {
    let connectCalls = 0;
    const result = await sendViaSmtp({
      config: { ...CONFIG, port: 25 },
      to: RECIPIENT,
      subject: 's',
      text: 't',
      now: () => new Date(),
      connect: async () => {
        connectCalls += 1;
        return new FakeSocket(() => null);
      },
    });

    assert.equal(result.ok, false);
    assert.equal(connectCalls, 0);
    assert.match(result.error ?? '', /25/);
  });

  it('refuses to send without a sender identity', async () => {
    let connectCalls = 0;
    const result = await sendViaSmtp({
      config: { ...CONFIG, from: undefined },
      to: RECIPIENT,
      subject: 's',
      text: 't',
      now: () => new Date(),
      connect: async () => {
        connectCalls += 1;
        return new FakeSocket(() => null);
      },
    });

    assert.equal(result.ok, false);
    assert.equal(connectCalls, 0);
  });
});

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

describe('consumeMailQuota', () => {
  it('allows a mail and counts it', async () => {
    const { db } = openSeededDb();
    const now = () => new Date('2026-11-20T10:00:00Z');

    const decision = await consumeMailQuota(db, {
      domain: 'example.com',
      recipient: RECIPIENT,
      now,
    });
    assert.equal(decision.allowed, true);

    const status = await readMailQuotaStatus(db, now);
    assert.equal(status.day, '2026-11-20');
    assert.equal(status.globalUsed, 1);
    assert.equal(status.globalLimit, 50);
  });

  it('refuses when the global daily budget is exhausted', async () => {
    const { db } = openSeededDb();
    const now = () => new Date('2026-11-20T10:00:00Z');

    for (let i = 0; i < 50; i += 1) {
      const decision = await consumeMailQuota(db, {
        domain: `d${i}.example`,
        recipient: `r${i}@example.com`,
        now,
      });
      assert.equal(decision.allowed, true);
    }

    const blocked = await consumeMailQuota(db, {
      domain: 'last.example',
      recipient: 'last@example.com',
      now,
    });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, 'global_daily');
    assert.ok((blocked.retryAfterSeconds ?? 0) > 0);
  });

  it('refuses when a domain used its daily budget', async () => {
    const { db } = openSeededDb();
    const now = () => new Date('2026-11-20T10:00:00Z');

    for (let i = 0; i < 3; i += 1) {
      const decision = await consumeMailQuota(db, {
        domain: 'example.com',
        recipient: `r${i}@example.com`,
        now,
      });
      assert.equal(decision.allowed, true);
    }

    const blocked = await consumeMailQuota(db, {
      domain: 'example.com',
      recipient: 'r9@example.com',
      now,
    });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, 'per_domain_daily');
  });

  it('refuses a second mail to the same recipient inside the cooldown', async () => {
    const { db } = openSeededDb();
    const now = () => new Date('2026-11-20T10:00:00Z');

    const first = await consumeMailQuota(db, {
      domain: 'example.com',
      recipient: RECIPIENT,
      now,
    });
    assert.equal(first.allowed, true);

    const second = await consumeMailQuota(db, {
      domain: 'other.example',
      recipient: RECIPIENT,
      now,
    });
    assert.equal(second.allowed, false);
    assert.equal(second.reason, 'recipient_cooldown');
    assert.ok((second.retryAfterSeconds ?? 0) > 0);
  });

  it('does not consume quota when a request is refused', async () => {
    const { db } = openSeededDb();
    const now = () => new Date('2026-11-20T10:00:00Z');

    await consumeMailQuota(db, { domain: 'example.com', recipient: RECIPIENT, now });
    const blocked = await consumeMailQuota(db, {
      domain: 'example.com',
      recipient: RECIPIENT,
      now,
    });
    assert.equal(blocked.allowed, false);

    const status = await readMailQuotaStatus(db, now);
    assert.equal(status.globalUsed, 1);
  });

  it('starts a fresh budget on the next UTC day', async () => {
    const { db } = openSeededDb();
    const day1 = () => new Date('2026-11-20T23:59:00Z');
    const day2 = () => new Date('2026-11-21T00:01:00Z');

    for (let i = 0; i < 3; i += 1) {
      await consumeMailQuota(db, {
        domain: 'example.com',
        recipient: `r${i}@example.com`,
        now: day1,
      });
    }
    const blocked = await consumeMailQuota(db, {
      domain: 'example.com',
      recipient: 'r9@example.com',
      now: day1,
    });
    assert.equal(blocked.allowed, false);

    const nextDay = await consumeMailQuota(db, {
      domain: 'example.com',
      recipient: 'r9@example.com',
      now: day2,
    });
    assert.equal(nextDay.allowed, true);

    const status = await readMailQuotaStatus(db, day2);
    assert.equal(status.day, '2026-11-21');
    assert.equal(status.globalUsed, 1);
  });

  it('stores the recipient only as a hash', async () => {
    const { db, raw } = openSeededDb();
    await consumeMailQuota(db, {
      domain: 'example.com',
      recipient: RECIPIENT,
      now: () => new Date('2026-11-20T10:00:00Z'),
    });

    const rows = raw
      .prepare('SELECT recipient_hash FROM mail_cooldown')
      .all() as { recipient_hash: string }[];
    assert.equal(rows.length, 1);
    assert.match(rows[0]?.recipient_hash ?? '', /^[0-9a-f]{64}$/);
    assert.ok(!(rows[0]?.recipient_hash ?? '').includes('owner@example.com'));
  });
});

// ---------------------------------------------------------------------------
// Channel selection
// ---------------------------------------------------------------------------

describe('deliverOwnerMail', () => {
  it('sends through Resend and counts the mail', async () => {
    const { db } = openSeededDb();
    const calls: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({ id: 'email_123' });
    }) as unknown as typeof fetch;

    const result = await deliverOwnerMail(
      db,
      { RESEND_API_KEY: 're_key', EMAIL_FROM: 'no-reply@afr.im' },
      {
        domain: 'example.com',
        to: RECIPIENT,
        subject: 'Report',
        text: 'text',
        idempotencyKey: 'test-1',
        fetchImpl: fakeFetch,
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.channel, 'resend');
    assert.equal(result.id, 'email_123');
    assert.deepEqual(calls, ['https://api.resend.com/emails']);

    const status = await readMailQuotaStatus(db);
    assert.equal(status.globalUsed, 1);
  });

  it('falls back to SMTP when the HTTP channel fails', async () => {
    const { db } = openSeededDb();
    const failingFetch = (async () =>
      new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const socket = new FakeSocket(scriptedResponder());

    const result = await deliverOwnerMail(
      db,
      {
        RESEND_API_KEY: 're_key',
        SMTP_HOST: 'mail.test.example',
        SMTP_FROM: 'no-reply@afr.im',
      },
      {
        domain: 'example.com',
        to: RECIPIENT,
        subject: 'Report',
        text: 'text',
        fetchImpl: failingFetch,
        connect: async () => socket,
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.channel, 'smtp');
    assert.ok(commandLabels(socket).includes('MAIL FROM'));
  });

  it('refuses a mail over the quota without calling a channel', async () => {
    const { db } = openSeededDb();
    let fetchCalls = 0;
    const fakeFetch = (async () => {
      fetchCalls += 1;
      return Response.json({ id: 'x' });
    }) as unknown as typeof fetch;

    for (let i = 0; i < 50; i += 1) {
      await consumeMailQuota(db, {
        domain: `d${i}.example`,
        recipient: `r${i}@example.com`,
      });
    }

    const result = await deliverOwnerMail(
      db,
      { RESEND_API_KEY: 're_key' },
      {
        domain: 'example.com',
        to: RECIPIENT,
        subject: 's',
        text: 't',
        fetchImpl: fakeFetch,
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, 'mail_not_sent');
    assert.equal(fetchCalls, 0);
    // The reason stays inside the worker.
    assert.ok(!JSON.stringify(result).includes('global_daily'));
  });
});

// ---------------------------------------------------------------------------
// Channel status
// ---------------------------------------------------------------------------
describe('GET /api/v1/mail/status', () => {
  it('reports the configured channels without leaking a value', async () => {
    const app = createApp({ db: openSeededDb().db });
    const res = await app.request(
      '/api/v1/mail/status',
      {},
      envWith({
        RESEND_API_KEY: 're_secret_key',
        SMTP_HOST: 'smtp.test.example',
        SMTP_FROM: 'no-reply@afr.im',
        SMTP_PASSWORD: 'smtp_secret',
      }),
    );

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.channels.resend, 'configured');
    assert.equal(body.channels.smtp, 'configured');
    assert.equal(body.channels.cf_email, 'unavailable');
    assert.deepEqual(body.missing, []);
    assert.equal(body.quota.globalLimit, 50);
    assert.equal(body.quota.globalUsed, 0);

    const dumped = JSON.stringify(body);
    assert.ok(!dumped.includes('re_secret_key'));
    assert.ok(!dumped.includes('smtp_secret'));
    assert.ok(!dumped.includes('smtp.test.example'));
  });

  it('lists the missing variables by name only', async () => {
    const app = createApp({ db: openSeededDb().db });
    const res = await app.request('/api/v1/mail/status', {}, envWith());

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.channels.resend, 'missing');
    assert.equal(body.channels.smtp, 'missing');
    assert.deepEqual(body.missing, ['RESEND_API_KEY', 'SMTP_HOST']);
  });

  it('marks a blocked SMTP port as invalid', async () => {
    const app = createApp({ db: openSeededDb().db });
    const res = await app.request(
      '/api/v1/mail/status',
      {},
      envWith({ SMTP_HOST: 'smtp.test.example', SMTP_PORT: '25', SMTP_FROM: 'no-reply@afr.im' }),
    );

    const body = await res.json();
    assert.equal(body.channels.smtp, 'invalid');
    assert.ok(body.missing.includes('SMTP_PORT'));
  });
});
