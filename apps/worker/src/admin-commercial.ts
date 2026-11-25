// src/admin-commercial.ts — the commercial board of the administrator
// console (SSOT item 18, domain C).
//
// Two operator workflows live here:
//   1. revoke a Pro term  — a refund, a chargeback, a site that asked to go;
//   2. revoke a machine key — a key that leaked, a client that was retired.
//
// Both writes go through the same pattern as the other domains: a write-only
// view whose trigger performs the business write *and* its audit row in one
// statement, plus the request-id reservation that makes a replay detectable.

import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import {
  readAdminAudit,
  requestReserved,
  reserveRequestStatement,
  type AdminAuditEntryView,
} from './admin-audit.ts';
import {
  adminAlert,
  adminForm,
  adminNav,
  adminPanel,
  adminStat,
  adminTable,
} from './admin-ui.ts';
import { resolveSiteKey } from './commercial.ts';
import { listProEntitlements, type ProTermSummary } from './entitlements.ts';
import type { Db, SqlParam } from './db.ts';

/** hono's `h` is typed as possibly async; this module never nests async
 * components, so the sync result is asserted once here. */
const h = (strings: TemplateStringsArray, ...values: unknown[]): HtmlEscapedString =>
  html(strings, ...values) as HtmlEscapedString;

/** Rows shown per board section. */
const BOARD_LIMIT = 50;
/** The request id of an admin form is a UUID; the revocation reference of the
 * entitlement log (`admin:<uuid>`) is derived from it. */
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LedgerOrderRow {
  merchant_order_id: string;
  subject_id: string;
  status: string;
  amount: string;
  asset: string;
  chain_key: string;
  term_days: number | null;
  created_at: string;
  aipay_reference: string | null;
}

export interface ApiKeyRow {
  key_hash: string;
  domain: string | null;
  tier: string | null;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface CommercialBoard {
  subscribers: ProTermSummary[];
  orders: LedgerOrderRow[];
  apiKeys: ApiKeyRow[];
  audit: AdminAuditEntryView[];
}

/** The private board data. Call only after the admin access check passed. */
export async function readCommercialBoard(db: Db): Promise<CommercialBoard> {
  const [subscribers, orders, apiKeys, audit] = await Promise.all([
    listProEntitlements(db, BOARD_LIMIT),
    db
      .prepare(
        `SELECT merchant_order_id, subject_id, status, amount, asset, chain_key, term_days,
                created_at, aipay_reference
         FROM billing_orders WHERE purpose = 'pro'
         ORDER BY id DESC LIMIT ?`,
      )
      .all<LedgerOrderRow>(BOARD_LIMIT),
    db
      .prepare(
        `SELECT key_hash, domain, tier, created_at, last_used_at, revoked_at
         FROM api_keys ORDER BY created_at DESC LIMIT ?`,
      )
      .all<ApiKeyRow>(BOARD_LIMIT),
    readAdminAudit(db, BOARD_LIMIT),
  ]);
  return { subscribers, orders, apiKeys, audit };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** The replay key of an action. Empty when the caller sent nothing usable. */
function normalizeRequestId(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const id = raw.trim().toLowerCase();
  return REQUEST_ID_RE.test(id) ? id : '';
}

/** The authenticated operator. Never taken from the request body. */
function normalizeSubject(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const subject = raw.trim();
  return subject.length > 0 && subject.length <= 256 ? subject : '';
}

/** True when the failure was the replay key (unique index) rather than a bug. */
function isReplayViolation(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null)?.message ?? error);
  return /UNIQUE constraint failed|append-only/i.test(message);
}

/** How many objects an action really changed. */
async function landedCount(db: Db, requestId: string, action: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM admin_audit WHERE request_id = ? AND action = ?')
    .get<{ n: number }>(requestId, action);
  return Number(row?.n ?? 0);
}

/**
 * Revoke the Pro term of a site.
 *
 * The revocation is an event in the append-only entitlement log — the same
 * form the owner-side revocation uses. A site that buys Pro again gets a new
 * term; the revoked one stays on record.
 */
export async function revokeProForDomain(db: Db, input: {
  requestId: string;
  subject: string;
  domain: string;
}): Promise<{ result: 'applied' | 'replayed' | 'conflict' }> {
  const requestId = normalizeRequestId(input.requestId);
  const subject = normalizeSubject(input.subject);
  if (!requestId || !subject) return { result: 'conflict' };
  const domain = await resolveSiteKey(db, String(input.domain ?? '').trim().toLowerCase());
  if (!domain) return { result: 'conflict' };
  if (await requestReserved(db, requestId)) return { result: 'replayed' };

  const reference = `admin:${requestId}`;
  const writes: { sql: string; params: SqlParam[] }[] = [
    reserveRequestStatement({ requestId, action: 'pro.revoke', subject }),
    {
      sql: `INSERT INTO admin_pro_revoke (request_id, subject, domain, reference)
            VALUES (?, ?, ?, ?)`,
      params: [requestId, subject, domain, reference],
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
  if ((await landedCount(db, requestId, 'pro.revoke')) !== 1) return { result: 'conflict' };
  return { result: 'applied' };
}

/** Revoke one machine key of a site. */
export async function revokeApiKeyForDomain(db: Db, input: {
  requestId: string;
  subject: string;
  domain: string;
  keyHash: string;
}): Promise<{ result: 'applied' | 'replayed' | 'conflict' }> {
  const requestId = normalizeRequestId(input.requestId);
  const subject = normalizeSubject(input.subject);
  const keyHash = String(input.keyHash ?? '').trim().toLowerCase();
  if (!requestId || !subject || !/^[0-9a-f]{64}$/.test(keyHash)) return { result: 'conflict' };
  const domain = String(input.domain ?? '').trim().toLowerCase();
  if (!domain) return { result: 'conflict' };
  if (await requestReserved(db, requestId)) return { result: 'replayed' };

  const writes: { sql: string; params: SqlParam[] }[] = [
    reserveRequestStatement({ requestId, action: 'apikey.revoke', subject }),
    {
      sql: `INSERT INTO admin_api_key_revoke (request_id, subject, domain, key_hash)
            VALUES (?, ?, ?, ?)`,
      params: [requestId, subject, domain, keyHash],
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
  if ((await landedCount(db, requestId, 'apikey.revoke')) !== 1) return { result: 'conflict' };
  return { result: 'applied' };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The state of one term, in the words the operator uses. */
function termState(term: ProTermSummary): string {
  if (term.kind === 'revoke') return '已撤销';
  if (term.active) return '有效';
  return '已过期';
}

/** The C domain page. The caller wraps it into the console document. */
export function renderCommercialBoard(board: CommercialBoard): HtmlEscapedString {
  return h`${adminNav('/admin/commercial')}
    ${adminPanel('Pro 订阅', subscribersSection(board))}
    ${adminPanel('最近订单', ordersSection(board))}
    ${adminPanel('机器密钥', apiKeysSection(board))}
    ${adminPanel('最近审计记录', auditSection(board))}`;
}

/** The Pro terms and the form that revokes one. */
function subscribersSection(board: CommercialBoard): HtmlEscapedString {
  const rows = board.subscribers.map(term =>
    h`<tr>
      <th scope="row">${term.subjectId}</th>
      <td>${termState(term)}</td>
      <td>${term.termDays ?? ''}</td>
      <td>${term.grantedAt ?? ''}</td>
      <td>${term.expiresAt ?? ''}</td>
      <td>${term.sourceOrderId ?? ''}</td>
      <td>${term.kind === 'revoke' ? '' : revokeProForm(term.subjectId)}</td>
    </tr>`,
  );
  const table = adminTable(
    ['域名', '状态', '期限（天）', '开始', '到期', '来源', '操作'],
    rows,
    'Pro 期限由订单与权益事件推导，撤销即写入一条撤销事件。',
  );
  return h`${adminStat('Pro 站点数', String(board.subscribers.length))} ${table}`;
}

/** The form that revokes the Pro term of one site. */
function revokeProForm(domain: string): HtmlEscapedString {
  return adminForm(
    '/admin/commercial/pro/revoke',
    crypto.randomUUID(),
    h`<input type="hidden" name="domain" value="${domain}">`,
    '撤销 Pro',
  );
}

/** The recent orders of the ledger. */
function ordersSection(board: CommercialBoard): HtmlEscapedString {
  const rows = board.orders.map(order =>
    h`<tr>
      <th scope="row">${order.merchant_order_id}</th>
      <td>${order.subject_id}</td>
      <td>${order.status}</td>
      <td>${order.amount} ${order.asset}</td>
      <td>${order.chain_key}</td>
      <td>${order.term_days ?? ''}</td>
      <td>${order.created_at}</td>
    </tr>`,
  );
  return adminTable(
    ['订单号', '域名', '状态', '金额', '链', '期限（天）', '创建时间'],
    rows,
    '本地账本最近 50 条 Pro 订单；确认后才会发放 Pro。',
  );
}

/** The machine keys and the form that revokes one. */
function apiKeysSection(board: CommercialBoard): HtmlEscapedString {
  const rows = board.apiKeys.map(key =>
    h`<tr>
      <th scope="row"><code>${key.key_hash.slice(0, 12)}…</code></th>
      <td>${key.domain ?? ''}</td>
      <td>${key.tier ?? ''}</td>
      <td>${key.created_at ?? ''}</td>
      <td>${key.last_used_at ?? ''}</td>
      <td>${key.revoked_at ? '已吊销' : '有效'}</td>
      <td>${key.revoked_at || !key.domain ? '' : revokeKeyForm(key.domain, key.key_hash)}</td>
    </tr>`,
  );
  const table = adminTable(
    ['密钥', '域名', '档位', '创建', '最近使用', '状态', '操作'],
    rows,
    '只有哈希被保存；吊销后该密钥立即失效。',
  );
  return h`${board.apiKeys.length ? '' : adminAlert('warn', '还没有发放过机器密钥。')} ${table}`;
}

/** The form that revokes one machine key. */
function revokeKeyForm(domain: string, keyHash: string): HtmlEscapedString {
  return adminForm(
    '/admin/commercial/api-key/revoke',
    crypto.randomUUID(),
    h`<input type="hidden" name="domain" value="${domain}">
      <input type="hidden" name="key_hash" value="${keyHash}">`,
    '吊销密钥',
  );
}

/** The recent audit rows of the shared trail. */
function auditSection(board: CommercialBoard): HtmlEscapedString {
  const rows = board.audit.map(entry =>
    h`<tr>
      <th scope="row">${entry.id}</th>
      <td>${entry.created_at}</td>
      <td>${entry.subject}</td>
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
