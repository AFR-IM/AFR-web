// src/mail-smtp.ts — generic SMTP egress for Cloudflare Workers.
//
// Why this file exists: the owner-mail subsystem was wired to a single HTTP
// provider (Resend). Switching providers must not require a code change, so
// the SMTP conversation lives here and is driven purely by environment
// variables (host/port/security/user/password/from).
//
// Constraints that shaped the code:
//   - `cloudflare:sockets` cannot be imported statically: the module only
//     exists inside workerd, and the Node test runner cannot resolve it. The
//     import is therefore dynamic and confined to the runtime path; everything
//     that can be decided without a network (config parsing, response parsing,
//     message building, error classification) is an exported pure function and
//     is unit tested directly.
//   - The `connect` step is injectable, so the whole protocol flow is tested
//     against a fake socket instead of a live server.
//   - Cloudflare blocks outbound TCP port 25. The port is rejected before a
//     socket is opened, so the operator gets a precise reason instead of a
//     generic network failure.
//   - Secrets, complete recipient addresses and message bodies must never
//     reach an error string: errors carry a category plus a status code, and
//     any credential that could appear is scrubbed before it is returned.

/** Transport security of the SMTP channel. */
export type SmtpSecurity = 'starttls' | 'ssl' | 'none';

/** Resolved SMTP channel configuration (no secret is ever echoed back). */
export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username?: string;
  password?: string;
  from?: string;
  replyTo?: string;
}

/** Why the SMTP channel cannot be used (or that it can). */
export type SmtpProblem = 'not_configured' | 'port_25_blocked' | 'missing_from' | 'ok';

/** Failure classes of an SMTP delivery — safe to log (no secrets). */
export type SmtpErrorCategory = 'auth' | 'recipient' | 'tls' | 'timeout' | 'protocol' | 'network';

/** A parsed SMTP reply line. */
export interface SmtpResponse {
  /** Three digit reply code; 0 when the line is not a reply at all. */
  code: number;
  /** Reply text without the code and the separator. */
  text: string;
  /** True for a continuation line ("250-…"), false for the last line. */
  more: boolean;
}

/** Result of one delivery attempt. */
export interface SmtpSendResult {
  ok: boolean;
  /** Message-ID of the accepted mail (also the idempotency handle). */
  id?: string;
  /** Redacted error text — never contains the password or a full address. */
  error?: string;
  category?: SmtpErrorCategory;
}

/** Default port of a submission channel (implicit TLS is 465, 2525 is common). */
export const DEFAULT_SMTP_PORT = 587;
/** Default transport security: opportunistic STARTTLS on the submission port. */
export const DEFAULT_SMTP_SECURITY: SmtpSecurity = 'starttls';
/** Total budget for one SMTP conversation (connect → QUIT). */
export const SMTP_TIMEOUT_MS = 10_000;

/** EHLO name of this client. */
const CLIENT_NAME = 'afr.im';
/** Domain used for the generated Message-ID. */
const MESSAGE_ID_DOMAIN = 'afr.im';

// ---------------------------------------------------------------------------
// Configuration (pure)
// ---------------------------------------------------------------------------

/** Resolve the SMTP channel from the environment.
 *
 * Returns null when no host is configured — that is the "channel not
 * configured" case, not an error. A missing sender address is *not* fatal
 * here: `describeSmtpProblem` reports it, and the send path refuses to
 * pretend a mail was sent without an identity. */
export function parseSmtpConfig(env: Record<string, string | undefined>): SmtpConfig | null {
  const host = (env.SMTP_HOST ?? '').trim();
  if (!host) return null;

  const parsedPort = Number.parseInt((env.SMTP_PORT ?? '').trim(), 10);
  const port =
    Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535
      ? parsedPort
      : DEFAULT_SMTP_PORT;

  const rawSecurity = (env.SMTP_SECURITY ?? '').trim().toLowerCase();
  const security: SmtpSecurity =
    rawSecurity === 'ssl' || rawSecurity === 'none' ? rawSecurity : DEFAULT_SMTP_SECURITY;

  const config: SmtpConfig = { host, port, security };

  const username = (env.SMTP_USERNAME ?? '').trim();
  if (username) config.username = username;
  const password = env.SMTP_PASSWORD ?? '';
  if (password) config.password = password;
  const from = (env.SMTP_FROM ?? '').trim();
  if (from) config.from = from;
  const replyTo = (env.SMTP_REPLY_TO ?? '').trim();
  if (replyTo) config.replyTo = replyTo;

  return config;
}

/** Explain why the SMTP channel can or cannot be used.
 *
 * The check order is deliberate: a missing host outranks everything (there is
 * no channel at all), the blocked platform port outranks the missing sender
 * (fixing the port would not make the channel work), and only then is the
 * sender identity checked. */
export function describeSmtpProblem(env: Record<string, string | undefined>): SmtpProblem {
  const host = (env.SMTP_HOST ?? '').trim();
  if (!host) return 'not_configured';

  const parsedPort = Number.parseInt((env.SMTP_PORT ?? '').trim(), 10);
  const port =
    Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535
      ? parsedPort
      : DEFAULT_SMTP_PORT;
  if (port === 25) return 'port_25_blocked';

  const from = (env.SMTP_FROM ?? '').trim();
  if (!from) return 'missing_from';

  return 'ok';
}

// ---------------------------------------------------------------------------
// Protocol helpers (pure)
// ---------------------------------------------------------------------------

/** Parse one SMTP reply line.
 *
 * "250-SIZE 52428800" is a continuation (more = true), "250 OK" ends the
 * response. A line that is not a reply at all yields code 0 so the caller can
 * treat it as a protocol violation instead of a status code. */
export function parseSmtpResponse(line: string): SmtpResponse {
  const trimmed = (line ?? '').replace(/[\r\n]+$/, '').trim();
  const match = /^(\d{3})([ -]?)([\s\S]*)$/.exec(trimmed);
  if (!match) return { code: 0, text: trimmed, more: false };
  const code = Number.parseInt(match[1] ?? '0', 10);
  const more = match[2] === '-';
  const text = (match[3] ?? '').trim();
  return { code, text, more };
}

/** Escape the body for the DATA phase.
 *
 * A line that starts with a dot would otherwise end the mail early, so the
 * dot is doubled. Nothing else is touched — the caller keeps full control of
 * the line endings. */
export function encodeDotStuff(body: string): string {
  return (body ?? '').replace(/(^|\n)\./g, '$1..');
}

/** Classify an SMTP failure.
 *
 * The category is what ends up in a log line, so it must never carry
 * credentials — only the failure class. */
export function classifySmtpError(code: number, text: string): SmtpErrorCategory {
  const lower = (text ?? '').toLowerCase();
  // Recipient rejections are explicit codes and are checked first: a
  // "550 no such user" must never be reported as a policy or auth problem.
  if (code === 550 || code === 551 || code === 553) return 'recipient';
  // 535/534 = credentials rejected, 530 = authentication required,
  // 454 = temporary authentication failure.
  if (code === 535 || code === 534 || code === 530 || code === 454) return 'auth';
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
  if (
    lower.includes('starttls') ||
    lower.includes('tls') ||
    lower.includes('ssl') ||
    lower.includes('certificate')
  ) {
    return 'tls';
  }
  // 421 = service not available, the connection itself is the problem.
  if (code === 421) return 'network';
  if (code >= 400) return 'protocol';
  if (lower.includes('auth')) return 'auth';
  return 'protocol';
}

/** Extract the bare address of a "Display Name <user@host>" string. */
export function extractAddress(value: string): string {
  const angled = /<([^>]+)>/.exec(value ?? '');
  if (angled && angled[1]) return angled[1].trim();
  return (value ?? '').trim();
}

/** Base64 of the UTF-8 bytes of a string (AUTH payloads, RFC 2047 words). */
function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  // Chunked so a long string cannot blow the argument limit of fromCharCode.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** RFC 2047 encoded word for a header value that carries non-ASCII text.
 *
 * The subject is split into chunks of whole characters so a multi-byte
 * character is never cut in half, and every chunk stays below the 75 character
 * limit of an encoded word. */
export function encodeHeaderValue(value: string): string {
  const text = value ?? '';
  // Only plain ASCII stays as it is; everything else is encoded below.
  if (!/[^\x20-\x7e]/.test(text)) return text;
  const chunks: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of text) {
    const chSize = new TextEncoder().encode(ch).length;
    if (size + chSize > 45) {
      chunks.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += chSize;
  }
  if (current) chunks.push(current);
  return chunks.map((chunk) => `=?UTF-8?B?${base64Utf8(chunk)}?=`).join(' ');
}

/** RFC 5322 date header (UTC). */
export function formatRfc5322Date(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} +0000`
  );
}

/** Random hex string (Message-ID, MIME boundary). */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  const webCrypto: Crypto = (globalThis as unknown as { crypto: Crypto }).crypto;
  webCrypto.getRandomValues(buf);
  let out = '';
  for (const byte of buf) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Build a Message-ID header value. */
export function buildMessageId(domain: string = MESSAGE_ID_DOMAIN): string {
  return `<${randomHex(12)}@${domain}>`;
}

/** Arguments of the message builder. */
export interface SmtpMessageArgs {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Date header (defaults to now). */
  date?: Date;
  /** Message-ID (defaults to a generated one). */
  messageId?: string;
  /** MIME boundary (defaults to a generated one). */
  boundary?: string;
}

/** Build the RFC 5322 message (headers + body) that is sent in the DATA phase.
 *
 * A subject with non-ASCII characters is encoded as an RFC 2047 encoded word
 * (base64 variant), because a raw 8-bit subject is rejected by many servers.
 * With an HTML part the message becomes multipart/alternative. */
export function buildSmtpMessage(args: SmtpMessageArgs): string {
  const { from, to, subject, text, html } = args;
  const date = args.date ?? new Date();
  const messageId = args.messageId ?? buildMessageId();

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${formatRfc5322Date(date)}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
  ];

  if (!html) {
    headers.push('Content-Type: text/plain; charset=utf-8');
    headers.push('Content-Transfer-Encoding: 8bit');
    return `${headers.join('\r\n')}\r\n\r\n${text}`;
  }

  const boundary = args.boundary ?? `afr-${randomHex(16)}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    `--${boundary}--`,
  ].join('\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

// ---------------------------------------------------------------------------
// Runtime (socket)
// ---------------------------------------------------------------------------

/** Minimal surface of a socket — the real `cloudflare:sockets` socket and the
 * test fake both satisfy it. `read`/`write` are the documented convenience
 * methods; the stream properties are the fallback for runtimes that only
 * expose the streams. */
export interface SmtpSocketLike {
  read?: () => Promise<Uint8Array | null>;
  write?: (data: string | Uint8Array) => Promise<number> | number;
  readable?: ReadableStream<Uint8Array>;
  writable?: WritableStream<Uint8Array>;
  close?: () => Promise<void> | void;
  startTls?: (options?: unknown) => SmtpSocketLike | Promise<SmtpSocketLike>;
  opened?: Promise<unknown>;
}

/** Arguments of one delivery. */
export interface SmtpSendArgs {
  config: SmtpConfig;
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Injectable connect step (tests); defaults to cloudflare:sockets. */
  connect?: (opts: unknown) => Promise<unknown>;
  /** Total budget override (tests); defaults to SMTP_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** Thrown when the conversation exceeds its budget. */
class SmtpTimeoutError extends Error {}
/** Thrown when the peer violates the protocol or closes the connection. */
class SmtpProtocolError extends Error {}

/** Mask a mail address so a log line cannot identify the recipient. */
function maskAddress(value: string): string {
  const match = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(value);
  if (!match || !match[1] || !match[2]) return value;
  const local = match[1];
  const head = local.charAt(0);
  const masked = local.length <= 2 ? `${head}*` : `${head}***`;
  return value.replace(match[0], `${masked}@${match[2]}`);
}

/** Remove credentials and mask addresses from an error string. */
function scrub(value: string, secrets: (string | undefined)[]): string {
  let out = value ?? '';
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (match) => maskAddress(match));
  return out;
}

/** Budget of the conversation, derived from the (injectable) clock. */
interface Deadline {
  check(): void;
  remaining(): number;
}

function createDeadline(now: () => Date, timeoutMs: number): Deadline {
  const start = now().getTime();
  return {
    check(): void {
      if (now().getTime() - start > timeoutMs) throw new SmtpTimeoutError('smtp timeout');
    },
    remaining(): number {
      return Math.max(0, timeoutMs - (now().getTime() - start));
    },
  };
}

/** Race a promise against the remaining budget. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) throw new SmtpTimeoutError('smtp timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SmtpTimeoutError('smtp timeout')), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Thin transport wrapper: prefers the socket convenience methods, falls back
 * to the readable/writable streams. */
class Transport {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readonly encoder = new TextEncoder();
  private readonly socket: SmtpSocketLike;

  constructor(socket: SmtpSocketLike) {
    this.socket = socket;
  }

  async write(text: string): Promise<void> {
    if (typeof this.socket.write === 'function') {
      await this.socket.write(text);
      return;
    }
    if (!this.socket.writable) throw new SmtpProtocolError('socket cannot write');
    if (!this.writer) this.writer = this.socket.writable.getWriter();
    await this.writer.write(this.encoder.encode(text));
  }

  async read(): Promise<Uint8Array | null> {
    if (typeof this.socket.read === 'function') return await this.socket.read();
    if (!this.socket.readable) throw new SmtpProtocolError('socket cannot read');
    if (!this.reader) this.reader = this.socket.readable.getReader();
    const { value, done } = await this.reader.read();
    return done ? null : value;
  }

  async close(): Promise<void> {
    try {
      await this.socket.close?.();
    } catch {
      // Closing a broken socket must not mask the original error.
    }
  }
}

/** The SMTP conversation state (line buffer + deadline). */
class SmtpSession {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  private readonly transport: Transport;
  private readonly deadline: Deadline;

  constructor(transport: Transport, deadline: Deadline) {
    this.transport = transport;
    this.deadline = deadline;
  }

  async writeRaw(text: string): Promise<void> {
    this.deadline.check();
    await this.transport.write(text);
  }

  async writeLine(line: string): Promise<void> {
    await this.writeRaw(`${line}\r\n`);
  }

  /** Read one reply line (buffered). */
  async readLine(): Promise<string> {
    for (;;) {
      const crlf = this.buffer.indexOf('\r\n');
      if (crlf >= 0) {
        const line = this.buffer.slice(0, crlf);
        this.buffer = this.buffer.slice(crlf + 2);
        return line;
      }
      const lf = this.buffer.indexOf('\n');
      if (lf >= 0) {
        const line = this.buffer.slice(0, lf);
        this.buffer = this.buffer.slice(lf + 1);
        return line;
      }
      this.deadline.check();
      const chunk = await withTimeout(this.transport.read(), this.deadline.remaining());
      if (chunk === null || chunk === undefined) {
        throw new SmtpProtocolError('smtp connection closed by peer');
      }
      this.buffer += this.decoder.decode(chunk, { stream: true });
    }
  }

  /** Read a full reply (continuation lines included). */
  async readResponse(): Promise<SmtpResponse & { lines: string[] }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      lines.push(line);
      const parsed = parseSmtpResponse(line);
      if (!parsed.more) return { ...parsed, lines };
    }
  }

  /** Send a command and read its reply. */
  async command(line: string): Promise<SmtpResponse & { lines: string[] }> {
    await this.writeLine(line);
    return this.readResponse();
  }
}

/** Default connect step: the only place that touches `cloudflare:sockets`.
 *
 * The import is dynamic on purpose — the module exists only inside workerd,
 * and a static import would break the Node test runner and any bundler that
 * resolves the worker graph outside the platform. */
async function defaultConnect(opts: unknown): Promise<unknown> {
  const sockets = await import('cloudflare:sockets');
  const options = opts as { hostname: string; port: number; secureTransport: 'on' | 'off' };
  return sockets.connect(
    { hostname: options.hostname, port: options.port },
    { secureTransport: options.secureTransport, allowHalfOpen: false },
  );
}

function fail(category: SmtpErrorCategory, error: string): SmtpSendResult {
  return { ok: false, error, category };
}

/** Send one mail over SMTP.
 *
 * The flow is the textbook one: connect → greeting → EHLO → (STARTTLS +
 * EHLO again) → AUTH → MAIL FROM → RCPT TO → DATA → body → QUIT. Any step
 * that answers with an unexpected code aborts the delivery and is reported
 * with a category, never with the raw credentials. */
export async function sendViaSmtp(args: SmtpSendArgs): Promise<SmtpSendResult> {
  const { config, to, subject, text, html } = args;
  const now = args.now ?? (() => new Date());
  const connect = args.connect ?? defaultConnect;
  const timeoutMs = args.timeoutMs ?? SMTP_TIMEOUT_MS;

  // The platform forbids outbound port 25: refuse before a socket is opened
  // so the operator gets a precise reason instead of a generic network error.
  if (config.port === 25) {
    return fail('network', 'smtp port 25 is blocked by the platform (use 587, 465 or 2525)');
  }
  // Without a sender identity the mail would be sent as nobody — refuse.
  if (!config.from) {
    return fail('protocol', 'smtp sender address is not configured');
  }
  if (!config.host) {
    return fail('protocol', 'smtp host is not configured');
  }

  const deadline = createDeadline(now, timeoutMs);
  const secrets = [config.password, config.username];
  let transport: Transport | undefined;

  try {
    const options = {
      hostname: config.host,
      port: config.port,
      secureTransport: config.security === 'ssl' ? ('on' as const) : ('off' as const),
    };
    const raw = await withTimeout(Promise.resolve(connect(options)), deadline.remaining());
    const socket = raw as SmtpSocketLike | undefined;
    if (!socket || typeof socket !== 'object') {
      throw new SmtpProtocolError('smtp connect did not return a socket');
    }
    transport = new Transport(socket);

    // A refused connection surfaces here (the platform rejects port 25 and
    // unreachable hosts alike) — classify it as a network failure.
    if (socket.opened && typeof socket.opened.then === 'function') {
      await withTimeout(Promise.resolve(socket.opened), deadline.remaining());
    }

    let session = new SmtpSession(transport, deadline);

    const greeting = await session.readResponse();
    if (greeting.code !== 220) {
      return fail(
        classifySmtpError(greeting.code, greeting.text),
        `smtp greeting rejected (${greeting.code})`,
      );
    }

    let ehlo = await session.command(`EHLO ${CLIENT_NAME}`);
    if (ehlo.code !== 250) {
      return fail(
        classifySmtpError(ehlo.code, ehlo.text),
        `smtp EHLO rejected (${ehlo.code})`,
      );
    }

    if (config.security === 'starttls') {
      // The upgrade must happen before the credentials are sent: a server
      // that refuses STARTTLS must never receive a password in the clear.
      const tls = await session.command('STARTTLS');
      if (tls.code !== 220) {
        return fail('tls', `smtp STARTTLS rejected (${tls.code})`);
      }
      const upgraded = await withTimeout(
        Promise.resolve(socket.startTls?.()),
        deadline.remaining(),
      );
      if (!upgraded) return fail('tls', 'smtp STARTTLS upgrade failed');
      transport = new Transport(upgraded as SmtpSocketLike);
      session = new SmtpSession(transport, deadline);
      // The capabilities have to be asked again after the handshake.
      ehlo = await session.command(`EHLO ${CLIENT_NAME}`);
      if (ehlo.code !== 250) {
        return fail(
          classifySmtpError(ehlo.code, ehlo.text),
          `smtp EHLO rejected (${ehlo.code})`,
        );
      }
    }

    if (config.username && config.password) {
      const authLine = ehlo.lines.find((line) => /^\d{3}[ -]AUTH\s/i.test(line)) ?? '';
      const mechanisms = authLine.replace(/^\d{3}[ -]/, '').toUpperCase();
      // Servers that do not advertise the mechanisms are still tried: AUTH
      // LOGIN is the de-facto fallback, AUTH PLAIN the second chance.
      const supportsLogin = mechanisms ? /\bLOGIN\b/.test(mechanisms) : true;
      const supportsPlain = mechanisms ? /\bPLAIN\b/.test(mechanisms) : true;

      let authenticated = false;
      let lastCode = 0;
      let lastText = '';

      if (supportsLogin) {
        const step1 = await session.command('AUTH LOGIN');
        if (step1.code === 334) {
          await session.writeLine(base64Utf8(config.username));
          const step2 = await session.readResponse();
          if (step2.code === 334) {
            await session.writeLine(base64Utf8(config.password));
            const step3 = await session.readResponse();
            if (step3.code === 235) authenticated = true;
            else {
              lastCode = step3.code;
              lastText = step3.text;
            }
          } else {
            lastCode = step2.code;
            lastText = step2.text;
          }
        } else {
          lastCode = step1.code;
          lastText = step1.text;
        }
      }

      if (!authenticated && supportsPlain) {
        // AUTH PLAIN payload: NUL separated identity, as RFC 4616 demands.
        const payload = base64Utf8(`\u0000${config.username}\u0000${config.password}`);
        const plain = await session.command(`AUTH PLAIN ${payload}`);
        if (plain.code === 235) authenticated = true;
        else {
          lastCode = plain.code;
          lastText = plain.text;
        }
      }

      if (!authenticated) {
        return fail(
          classifySmtpError(lastCode, lastText),
          `smtp authentication failed (${lastCode})`,
        );
      }
    }

    const mailFrom = await session.command(`MAIL FROM:<${extractAddress(config.from)}>`);
    if (mailFrom.code !== 250) {
      return fail(
        classifySmtpError(mailFrom.code, mailFrom.text),
        `smtp MAIL FROM rejected (${mailFrom.code})`,
      );
    }

    const rcptTo = await session.command(`RCPT TO:<${to}>`);
    if (rcptTo.code !== 250 && rcptTo.code !== 251) {
      return fail(
        classifySmtpError(rcptTo.code, rcptTo.text),
        `smtp RCPT TO rejected (${rcptTo.code})`,
      );
    }

    const data = await session.command('DATA');
    if (data.code !== 354) {
      return fail(
        classifySmtpError(data.code, data.text),
        `smtp DATA rejected (${data.code})`,
      );
    }

    const messageId = buildMessageId();
    const message = buildSmtpMessage({
      from: config.from,
      to,
      subject,
      text,
      html,
      date: now(),
      messageId,
    });
    // The body is dot-stuffed and terminated by the lone dot on its own line.
    await session.writeRaw(`${encodeDotStuff(message)}\r\n.\r\n`);

    const accepted = await session.readResponse();
    if (accepted.code !== 250) {
      return fail(
        classifySmtpError(accepted.code, accepted.text),
        `smtp message rejected (${accepted.code})`,
      );
    }

    // QUIT is best effort: the mail is already accepted at this point.
    try {
      await session.command('QUIT');
    } catch {
      // Ignore — the delivery succeeded.
    }
    return { ok: true, id: messageId };
  } catch (err) {
    if (err instanceof SmtpTimeoutError) {
      return fail('timeout', 'smtp timeout');
    }
    if (err instanceof SmtpProtocolError) {
      return fail('protocol', scrub(err.message, secrets));
    }
    const message = err instanceof Error ? err.message : String(err);
    return fail('network', scrub(`smtp network error: ${message}`, secrets));
  } finally {
    await transport?.close();
  }
}
