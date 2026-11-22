// @afr/web — the site's middleware.
//
// The detail pages are rendered on demand (SSOT item 20 — 详情页按需生成).
// The static build served /site/<domain> as a directory, so a request
// without the trailing slash was answered with a redirect to the slash
// form. A rendered route has no directory to redirect — Astro answers 404
// before the page runs — so the answer is given here instead, where every
// request passes.
//
// Only the detail URLs are handled: the other routes keep the answer the
// asset layer gives them (a redirect to the same slash form).

import { defineMiddleware } from 'astro:middleware';

/** /site/<domain> and /zh-CN/site/<domain>, without the trailing slash. */
const DETAIL_WITHOUT_SLASH = /^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?site\/[^/]+$/;

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname, search } = context.url;
  if (!pathname.endsWith('/') && DETAIL_WITHOUT_SLASH.test(pathname)) {
    const res = context.redirect(`${pathname}/${search}`, 307);
    // The redirect never changes — let the edge keep it. Without this the
    // Worker runs for every no-slash request (old links, crawlers).
    res.headers.set('Cache-Control', 'public, max-age=3600');
    return res;
  }
  return next();
});
