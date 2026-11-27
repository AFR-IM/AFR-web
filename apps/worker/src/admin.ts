import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { AdminAccessTemporarilyUnavailable, verifyAdminAccess, type AdminAccessEnv } from './admin-access.ts';
import { adminLoginEnabled, clearAdminSession, issueAdminSession, readAdminCredentials, verifyAdminSession, type AdminLoginEnv } from './admin-login.ts';
import { readAdminQueue, retryAdminSubmission } from './admin-queue.ts';
import {
  closeCorrectionTicket,
  createCorrectionTicket,
  moderateClaims,
  operatorLabel,
  readContentBoard,
  reclassifySites,
  renderContentBoard,
} from './admin-content.ts';
import {
  readCommercialBoard,
  renderCommercialBoard,
  revokeApiKeyForDomain,
  revokeProForDomain,
} from './admin-commercial.ts';
import { readMonitorBoard, renderMonitorBoard } from './admin-monitor.ts';
import { listScoringReleases, publishScoringRelease, renderScoringBoard } from './admin-scoring.ts';
import { AD_REPORT_CLOSE_PATH, ADS_ADMIN_PATH, closeAdReport, moderateAd, readAdsBoard, renderAdsBoard } from './ads.ts';
import { moderatePromo } from './promo.ts';
import { recordCharityDonation } from './charity.ts';
import {
  parseBeneficiaryForm,
  readSettings,
  renderSettingsPage,
  writeSettings,
  type Beneficiary,
} from './admin-settings.ts';
import { adminAlert, adminDocument, adminNav, adminPanel, adminTable } from './admin-ui.ts';
import type { RateLimiter } from './rate-limit.ts';
import type { Db } from './db.ts';

const headers = {
  'Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  // A no-referrer navigation POST can send Origin: null. Keep same-origin
  // referrers for the native forms without disclosing admin paths cross-site.
  'Referrer-Policy': 'same-origin',
  // The console ships one inline stylesheet; no script, no frame, no
  // third-party resource is allowed at all.
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const retryPath = /^\/admin\/retry\/([1-9]\d{0,15})\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const closeTicketPath = /^\/admin\/content\/tickets\/([1-9]\d{0,15})\/close$/;
const retryable = new Set(['scanned', 'done', 'rejected']);
/** The admin forms are bigger than the login form (a batch of 40 domains). */
const FORM_LIMIT = 64 * 1024;

/** hono's `html` is typed as possibly async; the console never nests async
 * components, so the sync result is asserted once here. */
const h = (strings: TemplateStringsArray, ...values: unknown[]): HtmlEscapedString =>
  html(strings, ...values) as HtmlEscapedString;

/** The notice codes a successful action can redirect back with. */
const NOTICES: Record<string, string> = {
  claims_applied: '声明审核已提交。',
  retried: '该提交已重新入队。',
  reclassified: '批量重分类已应用。',
  ticket_created: '纠错工单已创建。',
  ticket_closed: '纠错工单已关闭。',
  pro_revoked: 'Pro 期限已撤销。',
  apikey_revoked: '机器密钥已吊销。',
  ad_moderated: '广告状态已更新。',
  ad_report_closed: '广告举报已处理。',
  promo_moderated: '推广状态已更新。',
  donation_recorded: '捐赠已登记（台账只追加，不可修改）。',
  scoring_published: '评分版本说明已发布。',
  settings_updated: '设置已保存。',
  replayed: '这个请求已经执行过了，重复提交被忽略。',
};

function page(title: string, body: HtmlEscapedString, status = 200) {
  return new Response(adminDocument(title, body), {
    status, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function loginPage(failed = false, notice = '邮箱或密码错误。', retryAfter?: number) {
  const response = page('管理员登录', h`${failed ? adminAlert('error', notice) : ''}
    <form method="post" action="/admin/login">
      <p><label>邮箱 <input name="email" type="email" autocomplete="username" required maxlength="254"></label></p>
      <p><label>密码 <input name="password" type="password" autocomplete="current-password" required maxlength="64"></label></p>
      <button type="submit">登录</button>
    </form>`, failed ? 401 : 200);
  if (retryAfter !== undefined) response.headers.set('Retry-After', String(retryAfter));
  return response;
}

/** Same precedence as the public API's client IP: first X-Forwarded-For hop,
 * then X-Real-IP. Used only to key the failed-login limiter. */
function adminClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  return request.headers.get('x-real-ip') ?? 'unknown';
}

/** A redirect back to a console page with a notice code. */
function back(path: string, notice: string): Response {
  return new Response(null, { status: 303, headers: { ...headers, Location: `${path}?notice=${notice}` } });
}

/** An error page: what went wrong and where to go back. */
function errorPage(title: string, message: string, path: string): Response {
  return page(title, h`${adminAlert('error', message)}<p><a href="${path}">返回</a></p>`, 400);
}

/** Read a urlencoded admin form. Larger than the login form on purpose. */
async function readAdminForm(request: Request): Promise<URLSearchParams | null> {
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  const body = new Uint8Array(FORM_LIMIT);
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return new URLSearchParams(new TextDecoder().decode(body.subarray(0, length)));
      if (length + value.length > body.length) {
        await reader.cancel();
        return null;
      }
      body.set(value, length);
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }
}

/** The request id of an admin form. A missing one means the form is not ours. */
function requestIdOf(form: URLSearchParams): string {
  return (form.get('request_id') ?? '').trim();
}

/**
 * The beneficiaries of the settings form: the edited rows win over the
 * hidden mirror of the stored list (the mirror only exists because the
 * console forbids inline scripts).
 */
function beneficiariesOf(form: URLSearchParams): Beneficiary[] | null {
  const hasRows = Array.from(form.keys()).some(key => key.startsWith('beneficiary_name_'));
  if (hasRows) return parseBeneficiaryForm(form);
  const raw = (form.get('beneficiaries_json') ?? '').trim();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Beneficiary[]) : null;
  } catch {
    return null;
  }
}

/**
 * The domains of the reclassification form: the ticked preview rows plus
 * the domains the operator typed in.
 */
function domainsOf(form: URLSearchParams): string[] {
  const out = new Set<string>();
  for (const value of form.getAll('domains')) {
    const domain = value.trim();
    if (domain) out.add(domain);
  }
  const typed = (form.get('domains_text') ?? '').split(/[\s,;]+/).map(part => part.trim()).filter(Boolean);
  for (const domain of typed) out.add(domain);
  return [...out];
}

/** A claim id list that is either empty or made of positive integers. */
function claimIdsOf(form: URLSearchParams): number[] | null {
  const raw = form.getAll('claim_ids').map(value => value.trim());
  if (raw.length === 0) return [];
  const ids: number[] = [];
  for (const value of raw) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    ids.push(id);
  }
  return ids;
}

export async function handleAdmin(request: Request, env: AdminAccessEnv & AdminLoginEnv & { ADS_SALES_OPEN?: string; PAID_SALES_OPEN?: string }, getDb: () => Db, loginLimiter?: RateLimiter): Promise<Response> {
  try {
    const url = new URL(request.url);
    const isBoard = url.pathname === '/admin' || url.pathname === '/admin/';
    const localLogin = adminLoginEnabled(env);
    if (localLogin && url.protocol !== 'https:') {
      return Response.json({ error: 'forbidden' }, { status: 403, headers });
    }
    if (localLogin && request.method === 'POST' && (url.pathname === '/admin/login' || url.pathname === '/admin/logout')) {
      if (request.headers.get('Origin') !== url.origin) {
        return Response.json({ error: 'forbidden' }, { status: 403, headers });
      }
      if (url.pathname === '/admin/logout') {
        return new Response(null, { status: 303, headers: { ...headers, Location: '/admin/', 'Set-Cookie': clearAdminSession() } });
      }
      // Failed-login guard: ADMIN_LOGIN_FAIL_LIMIT attempts per IP per minute.
      // The password is a 256-bit secret, so this only bounds online tryout —
      // it exists to make probing visible and rate-limited. Fail-open: any
      // limiter/store error lets the attempt through instead of failing login.
      const ip = adminClientIp(request);
      let blocked = false;
      if (loginLimiter) {
        try {
          blocked = !(await loginLimiter.check(ip)).allowed;
        } catch (error) {
          console.warn(`admin login limiter unavailable (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      if (blocked) {
        console.warn(`admin login blocked ip=${ip}`);
        return loginPage(true, '尝试过于频繁，请稍后再试。', loginLimiter?.retryAfter());
      }
      const form = await readAdminCredentials(request);
      const session = form && await issueAdminSession(env, form.get('email') ?? '', form.get('password') ?? '');
      if (!session) {
        // Every failure is logged (console only — no audit table) and counts
        // against the per-IP budget, so the next attempt from this IP can be
        // refused before the credential check runs.
        const email = (form?.get('email') ?? '').slice(0, 254).replace(/[^\w.+-]+/g, '_');
        console.warn(`admin login failed ip=${ip} email=${email}`);
        if (loginLimiter) {
          try {
            await loginLimiter.consume(ip);
          } catch (error) {
            console.warn(`admin login limiter consume failed (${error instanceof Error ? error.message : String(error)})`);
          }
        }
        return loginPage(true);
      }
      return new Response(null, { status: 303, headers: { ...headers, Location: '/admin/', 'Set-Cookie': session } });
    }
    const localActor = localLogin ? await verifyAdminSession(request, env) : null;
    const actor = localLogin ? localActor : await verifyAdminAccess(request, env);
    if (!actor) {
      if (localLogin && isBoard && request.method === 'GET') return loginPage();
      return Response.json({ error: 'unauthorized' }, { status: 401, headers });
    }
    const db = getDb();

    if (request.method === 'GET') {
      if (isBoard || url.pathname === '/admin/queue') {
        const board = await readAdminQueue(db);
        if (url.pathname === '/admin/queue') {
          return Response.json(
            {
              ...board,
              canWrite: actor.canWrite,
              // The operator is an opaque id in the projection as well.
              audit: board.audit.map(entry => ({ ...entry, subject: operatorLabel(entry.subject) })),
            },
            { headers },
          );
        }
        const queueTable = (rows: typeof board.recent, showRetry: boolean) => adminTable(
          ['域名', '队列状态', '站点状态', '来源', '入队', '结束', ...(showRetry ? ['操作'] : [])],
          rows.map(row => h`<tr><th scope="row">${row.domain}</th><td>${row.status}</td><td>${row.site_status}</td>
            <td>${row.source}</td><td>${row.created_at}</td><td>${row.done_at}</td>
            ${showRetry ? h`<td>${retryable.has(row.status ?? '') ? h`<form method="post"
              action="/admin/retry/${row.id}/${crypto.randomUUID()}"><button type="submit">重新入队
              <span>(${row.domain})</span></button></form>` : ''}</td>` : ''}</tr>`),
        );
        const notice = NOTICES[(url.searchParams.get('notice') ?? '').trim()];
        return page('扫描队列', h`${adminNav('/admin/')}
          ${localActor ? h`<form method="post" action="/admin/logout"><button type="submit">退出登录</button></form>` : ''}
          ${notice ? adminAlert('ok', notice) : ''}
          ${adminPanel('待处理（最早 50 条）', board.backlog.length ? queueTable(board.backlog, false) : h`<p>无待处理项。</p>`)}
          ${adminPanel('最近提交（最多 50 条）', board.recent.length ? queueTable(board.recent, actor.canWrite) : h`<p>暂无提交。</p>`)}
          ${adminPanel('操作记录（最近 50 条）', adminTable(
            ['时间', '对象', '变更'],
            board.audit.map(entry => h`<tr><td>${entry.created_at}</td><td>${operatorLabel(entry.subject)}</td>
              <td>${entry.before.domain} · #${entry.before.id} (${entry.before.status}) → #${entry.after.id} (${entry.after.status})</td></tr>`),
          ))}`);
      }
      if (url.pathname === '/admin/content') {
        const board = await readContentBoard(db);
        const notice = NOTICES[(url.searchParams.get('notice') ?? '').trim()];
        return page('内容与社区', h`${notice ? adminAlert('ok', notice) : ''}${renderContentBoard(board)}`);
      }
      if (url.pathname === '/admin/commercial') {
        const [board, ads] = await Promise.all([readCommercialBoard(db), readAdsBoard(db)]);
        const notice = NOTICES[(url.searchParams.get('notice') ?? '').trim()];
        return page('商业化', h`${notice ? adminAlert('ok', notice) : ''}${renderCommercialBoard(board)}
          <p class="muted">站长自助购买${env.ADS_SALES_OPEN === 'true' ? '已启用' : '已关闭'}；
            火把与推广${env.PAID_SALES_OPEN === 'true' ? '已开售' : '已停售（默认关）'}。</p>
          ${renderAdsBoard(ads, actor.canWrite)}`);
      }
      if (url.pathname === '/admin/scoring') {
        const notice = NOTICES[(url.searchParams.get('notice') ?? '').trim()];
        return page('评分规则版本', renderScoringBoard(
          await listScoringReleases(db), notice ? { kind: 'ok', text: notice } : undefined, actor.canWrite,
        ));
      }
      if (url.pathname === '/admin/monitor') {
        const board = await readMonitorBoard(db);
        return page('监控看板', renderMonitorBoard(board));
      }
      if (url.pathname === '/admin/settings') {
        const snapshot = await readSettings(db);
        const notice = NOTICES[(url.searchParams.get('notice') ?? '').trim()];
        return page('设置', renderSettingsPage(snapshot, notice ? { kind: 'ok', text: notice } : undefined));
      }
      return Response.json({ error: 'not_found' }, { status: 404, headers });
    }

    if (request.method !== 'POST') {
      return Response.json({ error: 'not_found' }, { status: 404, headers });
    }
    if (!actor.canWrite || request.headers.get('Origin') !== url.origin) {
      return Response.json({ error: 'forbidden' }, { status: 403, headers });
    }

    const retryMatch = retryPath.exec(url.pathname);
    if (retryMatch) {
      const id = Number(retryMatch[1]);
      if (!Number.isSafeInteger(id)) return Response.json({ error: 'invalid_submission' }, { status: 400, headers });
      const result = await retryAdminSubmission(db, { id, requestId: retryMatch[2]!, subject: actor.subject });
      if (request.headers.get('Accept')?.includes('text/html')) {
        if (result === 'conflict') return errorPage('无法重新入队', '队列状态已变更，或该记录不能重试。', '/admin/');
        return back('/admin/', result === 'replayed' ? 'replayed' : 'retried');
      }
      return Response.json({ result }, { status: result === 'conflict' ? 409 : result === 'queued' ? 201 : 200, headers });
    }

    const form = await readAdminForm(request);
    if (!form) return errorPage('表单无效', '表单内容无法解析，或超过允许的大小。', '/admin/');
    const requestId = requestIdOf(form);
    if (!requestId) return errorPage('请求无效', '缺少请求编号，请刷新页面重试。', '/admin/');

    if (url.pathname === '/admin/content/claims') {
      // A row button decides exactly that row; the checkboxes plus the
      // select decide a batch. Nothing else is accepted.
      const publishId = form.get('publish_id');
      const rejectId = form.get('reject_id');
      let claimIds: number[];
      let decision: 'publish' | 'reject';
      if (publishId !== null || rejectId !== null) {
        if (publishId !== null && rejectId !== null) {
          return errorPage('审核未执行', '一次只能决定一条声明。', '/admin/content');
        }
        const raw = (publishId ?? rejectId ?? '').trim();
        const id = Number(raw);
        if (!Number.isSafeInteger(id) || id < 1) {
          return errorPage('审核未执行', '声明编号不合法。', '/admin/content');
        }
        claimIds = [id];
        decision = publishId !== null ? 'publish' : 'reject';
      } else {
        const ids = claimIdsOf(form);
        if (ids === null) return errorPage('审核未执行', '选中的声明编号不合法。', '/admin/content');
        const chosen = (form.get('decision') ?? '').trim();
        if (chosen !== 'publish' && chosen !== 'reject') {
          return errorPage('审核未执行', '没有选择审核决定。', '/admin/content');
        }
        claimIds = ids;
        decision = chosen;
      }
      const result = await moderateClaims(db, { requestId, subject: actor.subject, claimIds, decision });
      if (result.result === 'conflict') return errorPage('审核未执行', '选择的声明不合法，或没有待审声明。', '/admin/content');
      return back('/admin/content', result.result === 'replayed' ? 'replayed' : 'claims_applied');
    }

    if (url.pathname === '/admin/content/reclassify') {
      const domains = domainsOf(form);
      if (domains.length === 0) {
        return errorPage('重分类未执行', '没有选择要重分类的站点。', '/admin/content');
      }
      const result = await reclassifySites(db, {
        requestId,
        subject: actor.subject,
        domains,
        categorySlug: (form.get('category') ?? '').trim(),
      });
      if (result.result === 'conflict') {
        return errorPage('重分类未执行', '域名或分类不合法，或一次超过 40 个域名。', '/admin/content');
      }
      return back('/admin/content', result.result === 'replayed' ? 'replayed' : 'reclassified');
    }

    if (url.pathname === '/admin/content/tickets') {
      const result = await createCorrectionTicket(db, {
        requestId,
        subject: actor.subject,
        domain: (form.get('domain') ?? '').trim(),
        kind: (form.get('kind') ?? '').trim(),
        detail: (form.get('detail') ?? '').trim(),
      });
      if (result.result === 'conflict') return errorPage('工单未创建', '域名、类型或说明不符合要求。', '/admin/content');
      return back('/admin/content', result.result === 'replayed' ? 'replayed' : 'ticket_created');
    }

    const closeMatch = closeTicketPath.exec(url.pathname);
    if (closeMatch) {
      const ticketId = Number(closeMatch[1]);
      const status = (form.get('status') ?? '').trim();
      if (status !== 'resolved' && status !== 'dismissed') {
        return errorPage('工单未关闭', '没有选择处理结果。', '/admin/content');
      }
      const result = await closeCorrectionTicket(db, { requestId, subject: actor.subject, ticketId, status });
      if (result.result === 'conflict') return errorPage('工单未关闭', '工单不存在或已经关闭。', '/admin/content');
      return back('/admin/content', result.result === 'replayed' ? 'replayed' : 'ticket_closed');
    }

    if (url.pathname === '/admin/commercial/pro/revoke') {
      const result = await revokeProForDomain(db, {
        requestId,
        subject: actor.subject,
        domain: (form.get('domain') ?? '').trim(),
      });
      if (result.result === 'conflict') {
        return errorPage('撤销未执行', '域名不合法，或该站点没有 Pro 期限。', '/admin/commercial');
      }
      return back('/admin/commercial', result.result === 'replayed' ? 'replayed' : 'pro_revoked');
    }

    if (url.pathname === '/admin/commercial/api-key/revoke') {
      const result = await revokeApiKeyForDomain(db, {
        requestId,
        subject: actor.subject,
        domain: (form.get('domain') ?? '').trim(),
        keyHash: (form.get('key_hash') ?? '').trim(),
      });
      if (result.result === 'conflict') {
        return errorPage('吊销未执行', '密钥不存在，或它属于另一个站点。', '/admin/commercial');
      }
      return back('/admin/commercial', result.result === 'replayed' ? 'replayed' : 'apikey_revoked');
    }

    if (url.pathname === ADS_ADMIN_PATH) {
      const result = await moderateAd(db, {
        requestId, subject: actor.subject, id: Number(form.get('id')),
        decision: form.get('decision') ?? '', startsAt: form.get('starts_at')?.trim(), note: form.get('note'),
      });
      if (result.result === 'conflict') return errorPage('广告操作未执行', result.error, '/admin/commercial');
      return back('/admin/commercial', result.result === 'replayed' ? 'replayed' : 'ad_moderated');
    }

    if (url.pathname === AD_REPORT_CLOSE_PATH) {
      const result = await closeAdReport(db, {
        // The form's UUID, namespaced the way the console marks its own requests.
        requestId: `admin:${requestId}`, subject: actor.subject,
        reportId: Number(form.get('report_id')),
        decision: form.get('decision') ?? '', note: form.get('note'),
      });
      if (result.result === 'conflict') return errorPage('举报结案未执行', result.error, '/admin/commercial');
      return back('/admin/commercial', result.result === 'replayed' ? 'replayed' : 'ad_report_closed');
    }

    if (url.pathname === '/admin/commercial/promo/decide') {
      const result = await moderatePromo(db, {
        requestId, subject: actor.subject, id: Number(form.get('id')),
        decision: form.get('decision') ?? '', note: form.get('note'),
      });
      if (result.result === 'conflict') return errorPage('推广操作未执行', result.error, '/admin/commercial');
      return back('/admin/commercial', result.result === 'replayed' ? 'replayed' : 'promo_moderated');
    }

    if (url.pathname === '/admin/commercial/charity/record') {
      const result = await recordCharityDonation(db, {
        requestId, subject: actor.subject,
        amount: form.get('amount') ?? '', txHash: form.get('tx_hash') ?? '',
        beneficiary: form.get('beneficiary') ?? '', note: form.get('note'),
      });
      if (result.result === 'conflict') return errorPage('捐赠登记未执行', result.error, '/admin/commercial');
      return back('/admin/commercial', result.result === 'replayed' ? 'replayed' : 'donation_recorded');
    }

    if (url.pathname === '/admin/scoring') {
      const result = await publishScoringRelease(db, {
        requestId, subject: actor.subject,
        engineVersion: form.get('engine_version') ?? '', notes: form.get('notes') ?? '',
      });
      if (result.result === 'conflict') return errorPage('发布未执行', result.error, '/admin/scoring');
      return back('/admin/scoring', result.result === 'replayed' ? 'replayed' : 'scoring_published');
    }

    if (url.pathname === '/admin/settings') {
      const beneficiaries = beneficiariesOf(form);
      const promoWallet = form.get('promo_wallet');
      const charityPool = form.get('charity_pool');
      if (beneficiaries === null || promoWallet === null || charityPool === null) {
        return errorPage('设置未保存', '表单缺少必填字段，请刷新页面重试。', '/admin/settings');
      }
      const result = await writeSettings(db, {
        requestId,
        subject: actor.subject,
        beneficiaries,
        promoWallet: promoWallet.trim(),
        charityPool: charityPool.trim(),
      });
      if (result.result === 'conflict') {
        return errorPage('设置未保存', result.error ?? '输入不符合要求（名单最多 5 家，地址只能含字母数字与 _ - :）。', '/admin/settings');
      }
      return back('/admin/settings', result.result === 'replayed' ? 'replayed' : 'settings_updated');
    }

    return Response.json({ error: 'not_found' }, { status: 404, headers });
  } catch (error) {
    if (error instanceof AdminAccessTemporarilyUnavailable) {
      return Response.json({ error: 'access_refreshing' }, { status: 503, headers: { ...headers, 'Retry-After': '3' } });
    }
    return Response.json({ error: 'admin_unavailable' }, { status: 503, headers });
  }
}
