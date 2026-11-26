// src/admin-ui.ts — the shared HTML building blocks of the administrator
// console (SSOT item 18). The console is server-rendered plain HTML: no
// client framework, no external asset, nothing that could phone home. Every
// page is built from these helpers so the four domains look the same.

import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

/** hono's `h` is typed as possibly async; the console never nests async
 * components, so the sync result is asserted once here. */
const h = (strings: TemplateStringsArray, ...values: unknown[]): HtmlEscapedString =>
  html(strings, ...values) as HtmlEscapedString;

export type Block = HtmlEscapedString | string;

export interface AdminNavItem {
  href: string;
  label: string;
}

/** The console sections, in the order of the SSOT domains A → B → C → D → F. */
export const ADMIN_NAV: AdminNavItem[] = [
  { href: '/admin/', label: 'A 扫描队列' },
  { href: '/admin/content', label: 'B 内容与社区' },
  { href: '/admin/commercial', label: 'C 商业化' },
  { href: '/admin/monitor', label: 'D 监控看板' },
  { href: '/admin/scoring', label: 'E 评分版本' },
  { href: '/admin/settings', label: 'F 设置' },
];

const STYLE = `
:root { color-scheme: light dark; }
body { font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif;
  margin: 0; padding: 1.5rem clamp(1rem, 4vw, 3rem); max-width: 78rem; }
h1 { font-size: 1.4rem; margin: 0 0 .3rem; }
h2 { font-size: 1.1rem; margin: 1.8rem 0 .6rem; }
h3 { font-size: 1rem; margin: 1.2rem 0 .4rem; }
nav { display: flex; flex-wrap: wrap; gap: .5rem; margin: .8rem 0 1.5rem; padding-bottom: .8rem;
  border-bottom: 1px solid rgba(128,128,128,.35); }
nav a { text-decoration: none; padding: .3rem .7rem; border-radius: .4rem;
  border: 1px solid rgba(128,128,128,.35); }
nav a[aria-current="page"] { font-weight: 700; border-color: currentColor; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; font-size: .92rem; }
th, td { border: 1px solid rgba(128,128,128,.35); padding: .35rem .5rem; text-align: left;
  vertical-align: top; word-break: break-word; }
thead th { background: rgba(128,128,128,.12); }
form { margin: .4rem 0 1rem; }
fieldset { border: 1px solid rgba(128,128,128,.35); border-radius: .4rem; margin: .8rem 0;
  padding: .8rem; }
legend { font-weight: 600; padding: 0 .3rem; }
label { display: inline-block; margin: .2rem .6rem .2rem 0; }
input, select, textarea { font: inherit; padding: .25rem .4rem; max-width: 100%; }
textarea { width: 100%; min-height: 5rem; }
button { font: inherit; padding: .3rem .8rem; cursor: pointer; }
.ok { border-left: .3rem solid #2e7d32; padding: .4rem .6rem; background: rgba(46,125,50,.1); }
.warn { border-left: .3rem solid #ef6c00; padding: .4rem .6rem; background: rgba(239,108,0,.1); }
.error { border-left: .3rem solid #c62828; padding: .4rem .6rem; background: rgba(198,40,40,.1); }
.stats { display: flex; flex-wrap: wrap; gap: .8rem; margin: .6rem 0 1.2rem; }
.stat { border: 1px solid rgba(128,128,128,.35); border-radius: .4rem; padding: .5rem .8rem; min-width: 9rem; }
.stat b { display: block; font-size: 1.3rem; }
.muted { color: rgba(128,128,128,.95); font-size: .88rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
`;

/**
 * The whole document of one console page.
 *
 * `body` must be an escaped fragment (an `HtmlEscapedString`), never a plain
 * string: a plain string would be escaped a second time here and the browser
 * would show the markup as text instead of rendering it.
 */
export function adminDocument(title: string, body: HtmlEscapedString): string {
  return h`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} · AFR 管理后台</title>
    <style>${STYLE}</style>
    </head><body><main><h1>${title}</h1>${body}</main></body></html>`.toString();
}

/** The section switcher. The current page is marked for assistive tech. */
export function adminNav(current: string): HtmlEscapedString {
  return h`<nav aria-label="管理后台分区">${ADMIN_NAV.map(item =>
    h`<a href="${item.href}"${item.href === current ? h` aria-current="page"` : ''}>${item.label}</a>`,
  )}</nav>`;
}

/** A titled block. */
export function adminPanel(title: string, body: Block): HtmlEscapedString {
  return h`<section><h2>${title}</h2>${body}</section>`;
}

/** A message line. `kind` picks the colour only. */
export function adminAlert(kind: 'ok' | 'warn' | 'error', text: Block): HtmlEscapedString {
  return h`<p class="${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${text}</p>`;
}

/** A labelled form control. */
export function adminField(label: string, control: Block): HtmlEscapedString {
  return h`<label>${label} ${control}</label>`;
}

/** A single number with its label. */
export function adminStat(label: string, value: Block, hint?: string): HtmlEscapedString {
  return h`<div class="stat"><b>${value}</b>${label}${hint ? h`<div class="muted">${hint}</div>` : ''}</div>`;
}

/** A table. `rows` already contains the cell markup. */
export function adminTable(headers: string[], rows: Block[], caption?: string): HtmlEscapedString {
  return h`<table>${caption ? h`<caption class="muted">${caption}</caption>` : ''}
    <thead><tr>${headers.map(head => h`<th scope="col">${head}</th>`)}</tr></thead>
    <tbody>${rows.length ? rows : h`<tr><td colspan="${headers.length}">暂无记录。</td></tr>`}</tbody>
    </table>`;
}

/** A form that posts to `action` with a replay-safe request id. */
export function adminForm(
  action: string,
  requestId: string,
  fields: Block,
  submit: string,
  legend?: string,
): HtmlEscapedString {
  const body = h`${fields}
    <input type="hidden" name="request_id" value="${requestId}">
    <button type="submit">${submit}</button>`;
  return legend
    ? h`<form method="post" action="${action}"><fieldset><legend>${legend}</legend>${body}</fieldset></form>`
    : h`<form method="post" action="${action}">${body}</form>`;
}

/** A CSRF-safe same-origin check helper for the caller. */
export function isSameOrigin(request: Request, url: URL): boolean {
  return request.headers.get('Origin') === url.origin;
}
