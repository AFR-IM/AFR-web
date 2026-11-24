import { html } from 'hono/html';
import { AdminAccessTemporarilyUnavailable, verifyAdminAccess, type AdminAccessEnv } from './admin-access.ts';
import { adminLoginEnabled, clearAdminSession, issueAdminSession, readAdminCredentials, verifyAdminSession, type AdminLoginEnv } from './admin-login.ts';
import { readAdminQueue, retryAdminSubmission } from './admin-queue.ts';
import type { Db } from './db.ts';

const headers = {
  'Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  // A no-referrer navigation POST can send Origin: null. Keep same-origin
  // referrers for the native forms without disclosing admin paths cross-site.
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const retryPath = /^\/admin\/retry\/([1-9]\d{0,15})\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const retryable = new Set(['scanned', 'done', 'rejected']);

function page(title: string, body: ReturnType<typeof html>, status = 200) {
  return new Response(html`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · AFR</title>
    </head><body><main><h1>${title}</h1>${body}</main></body></html>`.toString(), {
    status, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function loginPage(failed = false) {
  return page('AFR 管理员登录', html`${failed ? html`<p role="alert">邮箱或密码错误。</p>` : ''}
    <form method="post" action="/admin/login">
      <p><label>邮箱 <input name="email" type="email" autocomplete="username" required maxlength="254"></label></p>
      <p><label>密码 <input name="password" type="password" autocomplete="current-password" required maxlength="64"></label></p>
      <button type="submit">登录</button>
    </form>`, failed ? 401 : 200);
}

export async function handleAdmin(request: Request, env: AdminAccessEnv & AdminLoginEnv, getDb: () => Db): Promise<Response> {
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
      const form = await readAdminCredentials(request);
      const session = form && await issueAdminSession(env, form.get('email') ?? '', form.get('password') ?? '');
      if (!session) return loginPage(true);
      return new Response(null, { status: 303, headers: { ...headers, Location: '/admin/', 'Set-Cookie': session } });
    }
    const localActor = localLogin ? await verifyAdminSession(request, env) : null;
    const actor = localLogin ? localActor : await verifyAdminAccess(request, env);
    if (!actor) {
      if (localLogin && isBoard && request.method === 'GET') return loginPage();
      return Response.json({ error: 'unauthorized' }, { status: 401, headers });
    }
    if (request.method === 'GET' && (isBoard || url.pathname === '/admin/queue')) {
      const board = await readAdminQueue(getDb());
      if (!isBoard) return Response.json({ ...board, canWrite: actor.canWrite }, { headers });
      const queueTable = (rows: typeof board.recent, showRetry: boolean) => html`<table>
        <thead><tr><th scope="col">域名</th><th scope="col">队列状态</th><th scope="col">站点状态</th>
        <th scope="col">来源</th><th scope="col">入队</th><th scope="col">结束</th>
        ${showRetry ? html`<th scope="col">操作</th>` : ''}</tr></thead><tbody>
        ${rows.map(row => html`<tr><th scope="row">${row.domain}</th><td>${row.status}</td><td>${row.site_status}</td>
          <td>${row.source}</td><td>${row.created_at}</td><td>${row.done_at}</td>
          ${showRetry ? html`<td>${retryable.has(row.status ?? '') ? html`<form method="post"
            action="/admin/retry/${row.id}/${crypto.randomUUID()}"><button type="submit">重新入队
            <span>(${row.domain})</span></button></form>` : ''}</td>` : ''}</tr>`)}
        </tbody></table>`;
      return page('扫描队列', html`
        ${localActor ? html`<form method="post" action="/admin/logout"><button type="submit">退出登录</button></form>` : ''}
        <h2>待处理（最早 50 条）</h2>${board.backlog.length ? queueTable(board.backlog, false) : html`<p>无待处理项。</p>`}
        <h2>最近提交（最多 50 条）</h2>${board.recent.length ? queueTable(board.recent, actor.canWrite) : html`<p>暂无提交。</p>`}
        <h2>操作记录（最近 50 条）</h2><ul>${board.audit.map(entry => html`<li>
          <time datetime="${entry.created_at}">${entry.created_at}</time> · ${entry.subject} · ${entry.before.domain}
          · #${entry.before.id} (${entry.before.status}) → #${entry.after.id} (${entry.after.status})</li>`)}</ul>`);
    }
    const match = request.method === 'POST' ? retryPath.exec(url.pathname) : null;
    if (match) {
      if (!actor.canWrite || request.headers.get('Origin') !== url.origin) {
        return Response.json({ error: 'forbidden' }, { status: 403, headers });
      }
      const id = Number(match[1]);
      if (!Number.isSafeInteger(id)) return Response.json({ error: 'invalid_submission' }, { status: 400, headers });
      const result = await retryAdminSubmission(getDb(), { id, requestId: match[2]!, subject: actor.subject });
      if (request.headers.get('Accept')?.includes('text/html')) {
        if (result === 'conflict') return page('无法重新入队', html`<p>队列状态已变更，或该记录不能重试。</p><a href="/admin/">返回队列</a>`, 409);
        return new Response(null, { status: 303, headers: { ...headers, Location: '/admin/' } });
      }
      return Response.json({ result }, { status: result === 'conflict' ? 409 : result === 'queued' ? 201 : 200, headers });
    }
    return Response.json({ error: 'not_found' }, { status: 404, headers });
  } catch (error) {
    if (error instanceof AdminAccessTemporarilyUnavailable) {
      return Response.json({ error: 'access_refreshing' }, { status: 503, headers: { ...headers, 'Retry-After': '3' } });
    }
    return Response.json({ error: 'admin_unavailable' }, { status: 503, headers });
  }
}
