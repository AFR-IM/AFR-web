// Publish a plain-text release note for the current scoring engine.
// The release ledger is independent of the engine and all scored data.

import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { AFR_METHOD } from '../../../packages/afr/src/method.ts';
import { requestReserved, reserveRequestStatement } from './admin-audit.ts';
import { operatorLabel } from './admin-content.ts';
import { adminAlert, adminField, adminForm, adminNav, adminPanel, adminStat, adminTable } from './admin-ui.ts';
import type { Db } from './db.ts';

const h = (strings: TemplateStringsArray, ...values: unknown[]): HtmlEscapedString =>
  html(strings, ...values) as HtmlEscapedString;

const AUDIT_ACTION = 'scoring.publish';
const SCORING_PATH = '/admin/scoring';
const HISTORY_LIMIT = 50;
// The console form sends a UUID; the ledger accepts any opaque token of that
// shape (letters, digits, dot, colon, dash, underscore).
const REQUEST_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
// No escape hatch: the bundled method contract is the only engine a note can describe.
const ENGINE_VERSION = AFR_METHOD.engineVersion;
const NOTES_MAX = 500;

/** Public projection. Safe to attach to the matching public method version. */
export interface ScoringRelease {
  engineVersion: string;
  notes: string;
  publishedAt: string;
}

export interface AdminScoringRelease extends ScoringRelease {
  publishedBy: string;
}

export interface ScoringReleaseInput {
  requestId: string;
  /** Supplied by the admin auth layer. */
  subject: string;
  engineVersion: string;
  notes: string;
}

export type ScoringReleaseResult =
  | { result: 'applied' | 'replayed' }
  | { result: 'conflict'; error: string };

/** Read the newest release for the requested engine, even if another version was published later. */
export async function readScoringRelease(db: Db, engineVersion: string = ENGINE_VERSION): Promise<ScoringRelease | null> {
  const row = await db.prepare(
    `SELECT engine_version AS engineVersion, notes, published_at AS publishedAt
     FROM scoring_releases WHERE engine_version = ? ORDER BY id DESC LIMIT 1`,
  ).get<ScoringRelease>(engineVersion);
  return row ?? null;
}

/** Recent entries for the authenticated administrator board, newest first. */
export async function listScoringReleases(db: Db): Promise<AdminScoringRelease[]> {
  return db.prepare(
    `SELECT engine_version AS engineVersion, notes, published_at AS publishedAt, published_by AS publishedBy
     FROM scoring_releases ORDER BY id DESC LIMIT ?`,
  ).all<AdminScoringRelease>(HISTORY_LIMIT);
}

/** Each distinct publish appends a release and an audit entry, even for the same engine version. */
export async function publishScoringRelease(db: Db, input: ScoringReleaseInput): Promise<ScoringReleaseResult> {
  const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  if (!REQUEST_ID.test(requestId)) return { result: 'conflict', error: '请求编号无效。' };
  if (!subject || subject.length > 256) return { result: 'conflict', error: '操作人无效。' };
  if (input.engineVersion !== ENGINE_VERSION) {
    return { result: 'conflict', error: `只能发布当前评分引擎 ${ENGINE_VERSION} 的说明。请刷新页面后重试。` };
  }

  const notes = typeof input.notes === 'string' ? input.notes.replace(/\r\n?/g, '\n').trim() : '';
  if (!notes || notes.length > NOTES_MAX || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(notes)) {
    return { result: 'conflict', error: `请填写 1–${NOTES_MAX} 字的纯文本发布说明。` };
  }
  if (await requestReserved(db, requestId)) return { result: 'replayed' };

  try {
    await db.batch([
      reserveRequestStatement({ requestId, action: AUDIT_ACTION, subject }),
      {
        sql: `INSERT INTO admin_scoring_publish (request_id, subject, engine_version, notes)
              VALUES (?, ?, ?, ?)`,
        params: [requestId, subject, ENGINE_VERSION, notes],
      },
    ]);
  } catch (error) {
    // The primary key also protects simultaneous writes that both passed the preflight.
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed:\s*admin_requests\.request_id\b/i.test(message) && await requestReserved(db, requestId)) {
      return { result: 'replayed' };
    }
    throw error;
  }
  // The view has no conditional writes. A successful batch commits the release and audit row.
  return { result: 'applied' };
}

export function renderScoringBoard(
  releases: AdminScoringRelease[],
  notice?: { kind: 'ok' | 'error'; text: string },
  canWrite = true,
): HtmlEscapedString {
  const fields = h`<input type="hidden" name="engine_version" value="${ENGINE_VERSION}">
    ${adminField('发布说明（公开）', h`<textarea name="notes" maxlength="${NOTES_MAX}" rows="5" required></textarea>`)}`;
  const rows = releases.map(release => h`<tr>
    <th scope="row"><code>${release.engineVersion}</code></th>
    <td>${release.notes.split('\n').map((line, index) => h`${index ? h`<br>` : ''}${line}`)}</td>
    <td><time datetime="${release.publishedAt}">${release.publishedAt}</time></td>
    <td>${operatorLabel(release.publishedBy)}</td>
  </tr>`);
  return h`${adminNav(SCORING_PATH)}
    ${notice ? adminAlert(notice.kind, notice.text) : ''}
    ${adminPanel('评分规则版本发布', h`${adminStat('当前评分引擎', ENGINE_VERSION)}
      <p class="muted">同版本再次发布会保留历史说明，公开端展示该版本的最新说明。</p>
      ${canWrite ? adminForm(SCORING_PATH, crypto.randomUUID(), fields, '发布说明') : ''}`)}
    ${adminPanel('发布历史', adminTable(['引擎版本', '发布说明', '发布时间', '发布者'], rows))}`;
}
