// src/admin-content.ts — the content & community board of the administrator
// console (SSOT item 18, domain B).
//
// Three operator workflows live here:
//   1. claim moderation       — owner statements wait in `claims` until an
//                               operator publishes or rejects them;
//   2. batch reclassification — the directory is full of sites in the `other`
//                               category, so the operator moves them in
//                               batches;
//   3. correction tickets     — a tracked request to fix a category, title,
//                               score or state.
//
// Every write is paired with its row in the shared append-only audit trail
// (src/admin-audit.ts). The business write and the audit row are put into one
// `db.batch([...])`, which D1 runs inside a single transaction: a site is
// never reclassified without its audit row, and a claim is never published
// without one either. The audit insert is guarded by the state the business
// write produced, so an audit row can only exist for a write that landed.

import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
// The repository's own domain helpers: the scanner strips scheme, path, port
// and a leading `www.`, the worker validates the bare FQDN. An operator never
// gets a second definition of "the same domain".
import { normalizeDomain as stripHost } from '../../../packages/scanner/src/http.ts';
import {
  requestReserved,
  reserveRequestStatement,
  readAdminAudit,
  type AdminAuditEntryView,
} from './admin-audit.ts';
import {
  adminAlert,
  adminField,
  adminForm,
  adminNav,
  adminPanel,
  adminStat,
  adminTable,
} from './admin-ui.ts';
import type { Db, SqlParam } from './db.ts';
import { normalizeDomain as validateDomain } from './domain.ts';

/** hono's `h` is typed as possibly async; this module never nests async
 * components, so the sync result is asserted once here. */
const h = (strings: TemplateStringsArray, ...values: unknown[]): HtmlEscapedString =>
  html(strings, ...values) as HtmlEscapedString;

/** Rows shown per board section. */
const BOARD_LIMIT = 50;
/** Claims one moderation batch may decide. */
const CLAIM_BATCH_LIMIT = 100;
/** Domains one reclassification batch may move. */
const RECLASSIFY_BATCH_LIMIT = 40;
/** D1 allows 100 bound parameters per query — an `IN (...)` list stays below. */
const IN_CHUNK = 50;
/** Maximum length of a correction ticket detail. */
const DETAIL_MAX = 500;
/** The kinds a correction ticket may carry. */
const TICKET_KINDS = ['category', 'title', 'score', 'status', 'other'] as const;

// ---------------------------------------------------------------------------
// Board data
// ---------------------------------------------------------------------------

export interface PendingClaim {
  id: number;
  domain: string;
  statement: string;
  created_at: string | null;
}

export interface CorrectionTicket {
  id: number;
  domain: string;
  kind: string;
  detail: string;
  status: string;
  subject: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface VerifiedSite {
  domain: string;
  title: string | null;
  grade: string | null;
  verified_at: string | null;
  verify_method: string | null;
  mailbox_registered: 0 | 1;
}

export interface ContentBoard {
  pendingClaims: PendingClaim[];
  tickets: CorrectionTicket[];
  verifiedSites: VerifiedSite[];
  categories: { id: number; slug: string; name_zh: string | null; name_en: string | null }[];
  otherCount: number;
  otherSites: { domain: string; title: string | null; rank: number | null; grade: string | null }[];
  audit: AdminAuditEntryView[];
}

interface ClaimRow {
  id: number;
  domain: string | null;
  statement: string | null;
  created_at: string | null;
}

interface TicketRow {
  id: number;
  domain: string;
  kind: string;
  detail: string;
  status: string;
  subject: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface VerifiedRow {
  domain: string;
  title: string | null;
  grade: string | null;
  verified_at: string | null;
  verify_method: string | null;
  mailbox_registered: number;
}

interface CategoryRow {
  id: number;
  slug: string;
  name_zh: string | null;
  name_en: string | null;
}

interface SiteCategoryRow {
  domain: string;
  category_id: number | null;
  category_slug: string | null;
}

interface OtherSiteRow {
  domain: string;
  title: string | null;
  rank: number | null;
  grade: string | null;
}

/** The private board data. Call only after the admin access check passed. */
export async function readContentBoard(db: Db): Promise<ContentBoard> {
  const [claims, tickets, verified, categories, other, otherSites, audit] = await Promise.all([
    db
      .prepare(
        `SELECT id, domain, statement, created_at FROM claims
         WHERE status = 'pending' ORDER BY id ASC LIMIT ?`,
      )
      .all<ClaimRow>(BOARD_LIMIT),
    db
      .prepare(
        `SELECT id, domain, kind, detail, status, subject, created_at, updated_at, closed_at
         FROM admin_correction_tickets
         ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, id ASC LIMIT ?`,
      )
      .all<TicketRow>(BOARD_LIMIT),
    db
      .prepare(
        `SELECT s.domain, s.title, s.grade,
                o.verified_at AS verified_at,
                o.verify_method AS verify_method,
                CASE WHEN m.domain IS NULL THEN 0 ELSE 1 END AS mailbox_registered
         FROM sites s
         LEFT JOIN owners o ON o.domain = s.domain
         LEFT JOIN owner_emails m ON m.domain = s.domain AND m.verified_at IS NOT NULL
         WHERE s.verified = 1
         ORDER BY (o.verified_at IS NULL), o.verified_at DESC, s.domain ASC
         LIMIT ?`,
      )
      .all<VerifiedRow>(BOARD_LIMIT),
    db.prepare(`SELECT id, slug, name_zh, name_en FROM categories ORDER BY id ASC`).all<CategoryRow>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM sites s
         JOIN categories c ON c.id = s.category_id WHERE c.slug = 'other'`,
      )
      .get<{ n: number }>(),
    db
      .prepare(
        `SELECT s.domain, s.title, s.rank, s.grade FROM sites s
         JOIN categories c ON c.id = s.category_id
         WHERE c.slug = 'other' AND s.title IS NOT NULL AND trim(s.title) <> ''
         ORDER BY (s.rank IS NULL), s.rank ASC, s.domain ASC
         LIMIT ?`,
      )
      .all<OtherSiteRow>(BOARD_LIMIT),
    readAdminAudit(db, BOARD_LIMIT),
  ]);

  return {
    pendingClaims: claims.map(row => ({
      id: row.id,
      domain: row.domain ?? '',
      statement: row.statement ?? '',
      created_at: row.created_at,
    })),
    tickets: tickets.map(row => ({
      id: row.id,
      domain: row.domain,
      kind: row.kind,
      detail: row.detail,
      status: row.status,
      subject: row.subject,
      created_at: row.created_at,
      updated_at: row.updated_at,
      closed_at: row.closed_at,
    })),
    verifiedSites: verified.map(row => ({
      domain: row.domain,
      title: row.title,
      grade: row.grade,
      verified_at: row.verified_at,
      verify_method: row.verify_method,
      mailbox_registered: row.mailbox_registered === 1 ? 1 : 0,
    })),
    categories: categories.map(row => ({
      id: row.id,
      slug: row.slug,
      name_zh: row.name_zh,
      name_en: row.name_en,
    })),
    otherCount: Number(other?.n ?? 0),
    otherSites: otherSites.map(row => ({
      domain: row.domain,
      title: row.title,
      rank: row.rank,
      grade: row.grade,
    })),
    audit,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The canonical key of a site. `null` when the input is not a domain. */
function canonicalDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const stripped = stripHost(raw);
  if (!stripped) return null;
  return validateDomain(stripped);
}

/** The replay key of an action. Empty when the caller sent nothing usable. */
function normalizeRequestId(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const id = raw.trim().toLowerCase();
  return id.length > 0 && id.length <= 128 ? id : '';
}

/** The authenticated operator. Never taken from the request body. */
function normalizeSubject(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const subject = raw.trim();
  return subject.length > 0 && subject.length <= 256 ? subject : '';
}

/** Positive, de-duplicated ids in the caller's order. `null` when invalid. */
function normalizeIds(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > CLAIM_BATCH_LIMIT) return null;
  const ids: number[] = [];
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return null;
    if (!ids.includes(value)) ids.push(value);
  }
  return ids.length > 0 ? ids : null;
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * Claim a request id on its own. Used when an action turns out to change
 * nothing: the receipt still exists, so the same request cannot act later.
 */
async function reserveRequest(
  db: Db,
  requestId: string,
  action: string,
  subject: string,
): Promise<'reserved' | 'replayed'> {
  try {
    await db
      .prepare('INSERT INTO admin_requests (request_id, action, subject, created_at) VALUES (?, ?, ?, ?)')
      .run(requestId, action, subject, new Date().toISOString());
    return 'reserved';
  } catch (error) {
    if (isReplayViolation(error)) return 'replayed';
    throw error;
  }
}

/** True when the failure was the replay key (unique index) rather than a bug. */
function isReplayViolation(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null)?.message ?? error);
  return /UNIQUE constraint failed|append-only/i.test(message);
}

// ---------------------------------------------------------------------------
// 1. Claim moderation
// ---------------------------------------------------------------------------

/**
 * Decide a batch of owner statements. Only `pending` claims can be decided;
 * a claim that was already handled is counted as skipped, not as an error.
 */
/**
 * How many objects an action really changed. A write into a write-only view
 * reports no rows of its own — the audit row the trigger wrote is the proof
 * that the change landed, and it exists exactly when it did.
 */
async function landedCount(db: Db, requestId: string, action: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM admin_audit WHERE request_id = ? AND action = ?')
    .get<{ n: number }>(requestId, action);
  return Number(row?.n ?? 0);
}

export async function moderateClaims(
  db: Db,
  input: {
    requestId: string;
    subject: string;
    claimIds: number[];
    decision: 'publish' | 'reject';
  },
): Promise<{ result: 'applied' | 'replayed' | 'conflict'; changed: number; skipped: number }> {
  const requestId = normalizeRequestId(input.requestId);
  const subject = normalizeSubject(input.subject);
  if (!requestId || !subject) return { result: 'conflict', changed: 0, skipped: 0 };
  if (input.decision !== 'publish' && input.decision !== 'reject') {
    return { result: 'conflict', changed: 0, skipped: 0 };
  }
  const ids = normalizeIds(input.claimIds);
  if (!ids) return { result: 'conflict', changed: 0, skipped: 0 };

  const action = input.decision === 'publish' ? 'claims.publish' : 'claims.reject';

  // The replay key: a request id may act only once.
  if (await requestReserved(db, requestId)) return { result: 'replayed', changed: 0, skipped: 0 };

  const pending = new Set<number>();
  for (const chunk of chunks(ids, IN_CHUNK)) {
    const rows = await db
      .prepare(
        `SELECT id FROM claims WHERE status = 'pending' AND id IN (${placeholders(chunk.length)})`,
      )
      .all<{ id: number }>(...chunk);
    for (const row of rows) pending.add(row.id);
  }
  const skipped = ids.length - pending.size;
  const targets = ids.filter(id => pending.has(id));
  if (targets.length === 0) {
    // Nothing to decide, but the request is still claimed: a later retry of
    // the same form must not decide a claim that became pending meanwhile.
    const reserved = await reserveRequest(db, requestId, action, subject);
    return { result: reserved === 'replayed' ? 'replayed' : 'applied', changed: 0, skipped };
  }

  // The reservation and the decisions travel in one transaction: a claim can
  // never change without its audit row, and a request id can never act twice.
  const writes: { sql: string; params: SqlParam[] }[] = [
    reserveRequestStatement({ requestId, action, subject }),
    ...targets.map(id => ({
      sql: `INSERT INTO admin_claim_decide (request_id, subject, claim_id, decision)
            VALUES (?, ?, ?, ?)`,
      params: [requestId, subject, id, input.decision],
    })),
  ];

  try {
    await db.batch(writes);
  } catch (error) {
    // A concurrent request with the same id won the race.
    if (isReplayViolation(error) && (await requestReserved(db, requestId))) {
      return { result: 'replayed', changed: 0, skipped };
    }
    throw error;
  }
  const changed = await landedCount(db, requestId, action);
  return { result: 'applied', changed, skipped };
}

// ---------------------------------------------------------------------------
// 2. Batch reclassification
// ---------------------------------------------------------------------------

/**
 * Move a batch of sites into another category. Only `category_id` and
 * `updated_at` are touched — title, verified, rank, status and grade stay
 * exactly as the scanner left them.
 */
export async function reclassifySites(
  db: Db,
  input: { requestId: string; subject: string; domains: string[]; categorySlug: string },
): Promise<{ result: 'applied' | 'replayed' | 'conflict'; changed: number; skipped: string[] }> {
  const requestId = normalizeRequestId(input.requestId);
  const subject = normalizeSubject(input.subject);
  if (!requestId || !subject) return { result: 'conflict', changed: 0, skipped: [] };

  const rawDomains = input.domains;
  if (!Array.isArray(rawDomains) || rawDomains.length === 0 || rawDomains.length > RECLASSIFY_BATCH_LIMIT) {
    return { result: 'conflict', changed: 0, skipped: [] };
  }
  const slug = typeof input.categorySlug === 'string' ? input.categorySlug.trim() : '';
  if (!slug) return { result: 'conflict', changed: 0, skipped: [] };

  // One unusable domain rejects the whole batch: a half-applied
  // reclassification is worse than none.
  const domains: string[] = [];
  for (const raw of rawDomains) {
    const domain = canonicalDomain(raw);
    if (!domain) return { result: 'conflict', changed: 0, skipped: [] };
    if (!domains.includes(domain)) domains.push(domain);
  }
  if (domains.length === 0) return { result: 'conflict', changed: 0, skipped: [] };

  const category = await db
    .prepare('SELECT id, slug FROM categories WHERE slug = ?')
    .get<{ id: number; slug: string }>(slug);
  if (!category) return { result: 'conflict', changed: 0, skipped: [] };

  if (await requestReserved(db, requestId)) return { result: 'replayed', changed: 0, skipped: [] };

  const existing = new Set<string>();
  for (const chunk of chunks(domains, IN_CHUNK)) {
    const rows = await db
      .prepare(`SELECT domain FROM sites WHERE domain IN (${placeholders(chunk.length)})`)
      .all<{ domain: string }>(...chunk);
    for (const row of rows) existing.add(row.domain);
  }
  const skipped = domains.filter(domain => !existing.has(domain));
  const targets = domains.filter(domain => existing.has(domain));
  if (targets.length === 0) {
    const reserved = await reserveRequest(db, requestId, 'reclassify', subject);
    return { result: reserved === 'replayed' ? 'replayed' : 'applied', changed: 0, skipped };
  }

  // The view trigger reads the old category inside the transaction and writes
  // the audit row only when the category really changes — a site that is
  // already in the target category is left alone and leaves no audit row.
  const writes: { sql: string; params: SqlParam[] }[] = [
    reserveRequestStatement({ requestId, action: 'reclassify', subject }),
    ...targets.map(domain => ({
      sql: `INSERT INTO admin_site_reclassify (request_id, subject, domain, category_id, category_slug)
            VALUES (?, ?, ?, ?, ?)`,
      params: [requestId, subject, domain, category.id, category.slug],
    })),
  ];

  try {
    await db.batch(writes);
  } catch (error) {
    if (isReplayViolation(error) && (await requestReserved(db, requestId))) {
      return { result: 'replayed', changed: 0, skipped };
    }
    throw error;
  }
  const changed = await landedCount(db, requestId, 'reclassify');
  return { result: 'applied', changed, skipped };
}

// ---------------------------------------------------------------------------
// 3. Correction tickets
// ---------------------------------------------------------------------------

/** Open a correction ticket for a site. */
export async function createCorrectionTicket(
  db: Db,
  input: { requestId: string; subject: string; domain: string; kind: string; detail: string },
): Promise<{ result: 'applied' | 'replayed' | 'conflict'; ticketId: number }> {
  const requestId = normalizeRequestId(input.requestId);
  const subject = normalizeSubject(input.subject);
  const domain = canonicalDomain(input.domain);
  const kind = typeof input.kind === 'string' ? input.kind.trim() : '';
  const detail = typeof input.detail === 'string' ? input.detail.trim() : '';
  if (
    !requestId ||
    !subject ||
    !domain ||
    !(TICKET_KINDS as readonly string[]).includes(kind) ||
    detail.length < 1 ||
    detail.length > DETAIL_MAX
  ) {
    return { result: 'conflict', ticketId: 0 };
  }

  if (await requestReserved(db, requestId)) {
    return { result: 'replayed', ticketId: await priorTicketId(db, requestId) };
  }

  // The ticket id is chosen by the database inside the transaction, so two
  // concurrent tickets never fight over one id.
  const writes: { sql: string; params: SqlParam[] }[] = [
    reserveRequestStatement({ requestId, action: 'ticket.create', subject }),
    {
      sql: `INSERT INTO admin_ticket_create (request_id, subject, domain, kind, detail)
            VALUES (?, ?, ?, ?, ?)`,
      params: [requestId, subject, domain, kind, detail],
    },
  ];
  try {
    await db.batch(writes);
  } catch (error) {
    if (isReplayViolation(error) && (await requestReserved(db, requestId))) {
      return { result: 'replayed', ticketId: await priorTicketId(db, requestId) };
    }
    throw error;
  }
  return { result: 'applied', ticketId: await priorTicketId(db, requestId) };
}

/** The ticket id a replayed `ticket.create` belongs to. */
async function priorTicketId(db: Db, requestId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT target FROM admin_audit WHERE request_id = ? AND action = 'ticket.create' LIMIT 1`,
    )
    .get<{ target: string }>(requestId);
  const match = /^ticket:(\d+)$/.exec(row?.target ?? '');
  return match ? Number(match[1]) : 0;
}

/** Close an open correction ticket. A ticket that is already closed conflicts. */
export async function closeCorrectionTicket(
  db: Db,
  input: {
    requestId: string;
    subject: string;
    ticketId: number;
    status: 'resolved' | 'dismissed';
  },
): Promise<{ result: 'applied' | 'replayed' | 'conflict' }> {
  const requestId = normalizeRequestId(input.requestId);
  const subject = normalizeSubject(input.subject);
  const ticketId = input.ticketId;
  const status = input.status;
  if (!requestId || !subject) return { result: 'conflict' };
  if (!Number.isSafeInteger(ticketId) || ticketId < 1) return { result: 'conflict' };
  if (status !== 'resolved' && status !== 'dismissed') return { result: 'conflict' };

  if (await requestReserved(db, requestId)) return { result: 'replayed' };

  const ticket = await db
    .prepare('SELECT id, status FROM admin_correction_tickets WHERE id = ?')
    .get<{ id: number; status: string }>(ticketId);
  if (!ticket || ticket.status !== 'open') return { result: 'conflict' };

  // The trigger closes the ticket and writes the audit row in one statement,
  // and only when the ticket was really open.
  const writes: { sql: string; params: SqlParam[] }[] = [
    reserveRequestStatement({ requestId, action: 'ticket.close', subject }),
    {
      sql: `INSERT INTO admin_ticket_close (request_id, subject, ticket_id, status)
            VALUES (?, ?, ?, ?)`,
      params: [requestId, subject, ticketId, status],
    },
  ];

  try {
    await db.batch(writes);
  } catch (error) {
    if (isReplayViolation(error) && (await requestReserved(db, requestId))) {
      return { result: 'replayed' };
    }
    throw error;
  }
  // A lost race leaves the ticket open and no audit row.
  if ((await landedCount(db, requestId, 'ticket.close')) !== 1) return { result: 'conflict' };
  return { result: 'applied' };
}

/**
 * The operator as the console shows it. The audit keeps the full subject; the
 * page shows an opaque id, so the console never prints a login address.
 */
export function operatorLabel(subject: string): string {
  const value = subject.trim();
  if (!value) return '—';
  if (value.startsWith('local:')) {
    const email = value.slice('local:'.length);
    const at = email.indexOf('@');
    const name = at === -1 ? email : email.slice(0, at);
    return `local:${name.slice(0, 1)}***`;
  }
  return value.length > 32 ? `${value.slice(0, 32)}…` : value;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The B domain page. The caller wraps it into the console document. */
export function renderContentBoard(board: ContentBoard): HtmlEscapedString {
  return h`${adminNav('/admin/content')}
    ${adminPanel('待审声明', claimsSection(board))}
    ${adminPanel('纠错工单', ticketsSection(board))}
    ${adminPanel('已验证站点抽查', verifiedSection(board))}
    ${adminPanel('批量重分类', reclassifySection(board))}
    ${adminPanel('最近审计记录', auditSection(board))}`;
}

/**
 * The claim moderation form. The checkboxes and the decision select live in
 * one form, so a batch is one request. The per-row buttons precede the select
 * in the document, so a click on 批准/驳回 submits that decision while the
 * select decides when the form is submitted with its own button. Read the
 * decision with `form.get('decision')` — it is the clicked button first, the
 * select second — or with `form.getAll('decision')[0]`.
 */
function claimsSection(board: ContentBoard): HtmlEscapedString {
  const rows = board.pendingClaims.map(claim =>
    h`<tr>
      <td><input type="checkbox" name="claim_ids" value="${claim.id}" aria-label="选择声明 ${claim.id}"></td>
      <th scope="row">${claim.domain}</th>
      <td>${claim.statement}</td>
      <td>${claim.created_at ?? ''}</td>
      <td>
        <button type="submit" name="publish_id" value="${claim.id}">批准</button>
        <button type="submit" name="reject_id" value="${claim.id}">驳回</button>
      </td>
    </tr>`,
  );
  const table = adminTable(
    ['选择', '域名', '声明', '创建时间', '快捷决定'],
    rows,
    '待审核的站点声明，按提交顺序排列。',
  );
  const fields = h`${table}
    ${adminField(
      '批量决定（勾选上面的声明后使用；行内按钮只决定该行）',
      h`<select name="decision"><option value="publish">批准</option><option value="reject">驳回</option></select>`,
    )}`;
  return h`${adminStat('待审声明', String(board.pendingClaims.length))}
    ${board.pendingClaims.length ? '' : adminAlert('warn', '暂无待审声明。')}
    ${adminForm('/admin/content/claims', crypto.randomUUID(), fields, '提交审核', '批量审核声明')}`;
}

/** The correction ticket list plus the form that opens a new ticket. */
function ticketsSection(board: ContentBoard): HtmlEscapedString {
  const rows = board.tickets.map(ticket =>
    h`<tr>
      <th scope="row">${ticket.id}</th>
      <td>${ticket.domain}</td>
      <td>${ticket.kind}</td>
      <td>${ticket.detail}</td>
      <td>${ticket.status}</td>
      <td>${ticket.subject}</td>
      <td>${ticket.created_at}</td>
      <td>${ticket.updated_at}</td>
      <td>${ticket.closed_at ?? ''}</td>
      <td>${ticket.status === 'open' ? closeTicketForm(ticket) : ''}</td>
    </tr>`,
  );
  const table = adminTable(
    ['编号', '域名', '类型', '说明', '状态', '操作人', '创建', '更新', '关闭', '操作'],
    rows,
    '未关闭的工单排在前面。',
  );
  const open = board.tickets.filter(ticket => ticket.status === 'open').length;
  const newTicket = adminForm(
    '/admin/content/tickets',
    crypto.randomUUID(),
    h`${adminField('域名', h`<input name="domain" required maxlength="253" placeholder="example.com">`)}
      ${adminField(
        '类型',
        h`<select name="kind">
          <option value="category">分类</option>
          <option value="title">标题</option>
          <option value="score">评分</option>
          <option value="status">状态</option>
          <option value="other">其他</option>
        </select>`,
      )}
      ${adminField('说明', h`<textarea name="detail" required maxlength="500"></textarea>`)}`,
    '新建工单',
    '新建纠错工单',
  );
  return h`${adminStat('未关闭工单', String(open))}
    ${table}
    ${newTicket}`;
}

/** The close form of one open ticket. */
function closeTicketForm(ticket: CorrectionTicket): HtmlEscapedString {
  const fields = h`${adminField(
    '处理结果',
    h`<select name="status">
      <option value="resolved">已解决</option>
      <option value="dismissed">不处理</option>
    </select>`,
  )}`;
  return adminForm(
    `/admin/content/tickets/${ticket.id}/close`,
    crypto.randomUUID(),
    fields,
    '关闭工单',
  );
}

/** The verified spot check. No mailbox address ever reaches this page. */
function verifiedSection(board: ContentBoard): HtmlEscapedString {
  const rows = board.verifiedSites.map(site =>
    h`<tr>
      <th scope="row">${site.domain}</th>
      <td>${site.title ?? ''}</td>
      <td>${site.grade ?? ''}</td>
      <td>${site.verified_at ?? ''}</td>
      <td>${site.verify_method ?? ''}</td>
      <td>${site.mailbox_registered === 1 ? '已登记' : '未登记'}</td>
    </tr>`,
  );
  const table = adminTable(
    ['域名', '标题', '等级', '验证时间', '验证方式', '邮箱登记'],
    rows,
    '已验证站点的抽查，最多 50 条。',
  );
  return h`${adminStat('已验证站点', String(board.verifiedSites.length))} ${table}`;
}

/** The batch reclassification tool: a target category and the sites to move. */
function reclassifySection(board: ContentBoard): HtmlEscapedString {
  const options = board.categories.map(category =>
    h`<option value="${category.slug}">${category.name_zh ?? category.name_en ?? category.slug}</option>`,
  );
  const rows = board.otherSites.map(site =>
    h`<tr>
      <td><input type="checkbox" name="domains" value="${site.domain}" aria-label="选择站点 ${site.domain}"></td>
      <th scope="row">${site.domain}</th>
      <td>${site.title ?? ''}</td>
      <td>${site.rank ?? ''}</td>
      <td>${site.grade ?? ''}</td>
    </tr>`,
  );
  const fields = h`${adminField('目标分类', h`<select name="category">${options}</select>`)}
    ${adminTable(
      ['选择', '域名', '标题', '排名', '等级'],
      rows,
      '当前归入 other 的站点，按排名排序，最多 50 条。',
    )}
    ${adminField(
      '或手动指定域名（每行一个，最多 40 个）',
      h`<textarea name="domains_text" placeholder="example.com&#10;example.org"></textarea>`,
    )}`;
  return h`${adminStat('other 分类站点', String(board.otherCount), '未分类的站点数量。')}
    ${adminForm('/admin/content/reclassify', crypto.randomUUID(), fields, '应用重分类', '批量重分类')}`;
}

/** The recent audit rows of the shared trail. */
function auditSection(board: ContentBoard): HtmlEscapedString {
  const rows = board.audit.map(entry =>
    h`<tr>
      <th scope="row">${entry.id}</th>
      <td>${entry.created_at}</td>
      <td>${operatorLabel(entry.subject)}</td>
      <td>${entry.action}</td>
      <td>${entry.target}</td>
      <td>${JSON.stringify(entry.before)}</td>
      <td>${JSON.stringify(entry.after)}</td>
    </tr>`,
  );
  return adminTable(
    ['编号', '时间', '操作人', '动作', '对象', '变更前', '变更后'],
    rows,
    '共享审计轨迹，最近 50 条。',
  );
}
