/* aiapp.im service worker (spec §9 — PWA offline behavior).
 *
 * Version token: bump VERSION to invalidate every cache at once.
 *   - install  → precache the app shell (offline fallback page + chrome)
 *   - activate → delete caches from older versions, then claim clients
 *   - fetch    → GET only, same-origin only:
 *       navigations        → network-first, cache fallback, /offline last resort
 *       /data/*, /search-index.json → stale-while-revalidate
 *       /api/*             → network-first, friendly JSON offline error
 *
 * The offline page exists at /offline (English, canonical fallback) and
 * /zh-CN/offline (Chinese). Both are precached; a failed navigation falls
 * back to the locale copy when possible, then to the English one.
 */

const VERSION = 'aiapp-sw-v1';
const PRECACHE = `aiapp-precache-${VERSION}`;
const RUNTIME = `aiapp-runtime-${VERSION}`;
const OFFLINE_CANONICAL = '/offline';
const OFFLINE_ZH = '/zh-CN/offline';

const SHELL = [
  OFFLINE_CANONICAL,
  OFFLINE_ZH,
  '/manifest.webmanifest',
  '/icons/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(PRECACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('aiapp-') && key !== PRECACHE && key !== RUNTIME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Network-first for pages: fresh when online, cached copy when not. */
async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      const cache = await caches.open(RUNTIME);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Locale-aware fallback: the zh-CN offline page if this was a zh page,
    // otherwise the canonical English offline page.
    const url = new URL(request.url);
    if (url.pathname.startsWith('/zh-CN')) {
      const zh = await caches.match(OFFLINE_ZH);
      if (zh) return zh;
    }
    const shell = await caches.match(OFFLINE_CANONICAL);
    if (shell) return shell;
    return new Response(
      'You are offline and no cached copy is available yet. Reconnect and refresh.',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }
}

/** Stale-while-revalidate for data payloads: answer fast, refresh in background. */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
      return response;
    })
    .catch(() => undefined);
  if (cached) return cached;
  const response = await network;
  if (response) return response;
  return new Response(JSON.stringify({ error: 'offline', message: 'Data is not cached yet. Retry when online.' }), {
    status: 503,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Network-first for the API: live data when online, friendly JSON error when not. */
async function networkFirstApi(request) {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({
        error: 'offline',
        message:
          'The aiapp.im API is unreachable right now. Your connection may be offline — retry in a moment. Human-readable docs: https://aiapp.im/docs',
      }),
      { status: 503, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
    );
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  const path = new URL(request.url).pathname;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (path.startsWith('/data/') || path === '/search-index.json') {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  if (path.startsWith('/api/')) {
    event.respondWith(networkFirstApi(request));
    return;
  }
  // Static assets (hashed build output, icons, manifest): cache-first is safe
  // because build output is content-hashed and the rest is versioned by us.
  if (path.startsWith('/_astro/') || path.startsWith('/icons/')) {
    event.respondWith(
      caches.open(RUNTIME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
        return response;
      }),
    );
  }
});
