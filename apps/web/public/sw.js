/* afr.im service worker (spec §9 — PWA offline behavior).
 *
 * Version token: bump VERSION to invalidate every cache at once.
 *   - install  → precache the app shell (offline fallback page + chrome)
 *   - activate → delete caches from older versions, then claim clients
 *   - fetch    → GET only, same-origin only:
 *       /api/*             → network only, friendly JSON offline error
 *       navigations        → stale-while-revalidate, /offline last resort
 *       /data/*, /search-index.json → stale-while-revalidate
 *       static artifacts  → cache-first (build output, icons, fonts, and the
 *                            machine-readable agent documents)
 *
 * The offline page exists at /offline (English, canonical fallback) and
 * /zh-CN/offline (Chinese). Both are precached; a failed navigation falls
 * back to the locale copy when possible, then to the English one.
 *
 * VERSION is bumped whenever the caching behaviour changes: it is the only
 * thing that invalidates the runtime cache, so a deploy that changes these
 * rules (or refreshes a cached agent document) must bump it too.
 */

const VERSION = 'afr-sw-v5';
const PRECACHE = `afr-precache-${VERSION}`;
const RUNTIME = `afr-runtime-${VERSION}`;
const OFFLINE_CANONICAL = '/offline';
const OFFLINE_ZH = '/zh-CN/offline';

const SHELL = [
  OFFLINE_CANONICAL,
  OFFLINE_ZH,
  '/manifest.webmanifest',
  '/icons/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  // robots.txt is ~1 KB: precaching it means an offline client still knows
  // the site's crawl policy. The sitemap (~1.7 MB) is deliberately NOT
  // precached — it would slow every single install and eat the storage
  // budget; it is served cache-first at runtime instead.
  '/robots.txt',
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
            .filter((key) => key.startsWith('afr-') && key !== PRECACHE && key !== RUNTIME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Public pages paint from cache while refreshing. If the server stops
 *  allowing storage or redirects this URL, evict any earlier copy. */
function handleNavigation(event) {
  const request = event.request;
  const runtime = caches.open(RUNTIME);
  const cached = runtime.then((cache) => cache.match(request)).catch(() => undefined);
  const network = fetch(request).catch(() => undefined);
  event.waitUntil(Promise.all([runtime, network]).then(async ([cache, response]) => {
    if (!response) return;
    if (response.redirected || response.type === 'opaqueredirect' || isNoStore(response)) {
      await cache.delete(request);
    } else if (response.ok && response.type === 'basic') {
      await cache.put(request, response.clone());
    }
  }).catch(() => {}));
  event.respondWith((async () => {
    const response = await cached || await network;
    if (response) return response;
    const shell = await caches.open(PRECACHE);
    if (new URL(request.url).pathname.startsWith('/zh-CN/')) {
      const zh = await shell.match(OFFLINE_ZH);
      if (zh) return zh;
    }
    return (await shell.match(OFFLINE_CANONICAL)) || new Response(
      'You are offline and no cached copy is available yet. Reconnect and refresh.',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  })());
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
    return await fetch(request, { cache: 'no-store' });
  } catch {
    return new Response(
      JSON.stringify({
        error: 'offline',
        message:
          'The afr.im API is unreachable right now. Your connection may be offline — retry in a moment. Human-readable docs: https://afr.im/docs',
      }),
      { status: 503, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
    );
  }
}

function isNoStore(response) {
  return /(?:^|,)\s*no-store(?:\s*(?:,|$))/i.test(response.headers.get('cache-control') || '');
}

/** Cache-first for immutable static artifacts: content-hashed build output,
 *  versioned icons and fonts, plus the agent-facing documents that agents and
 *  crawlers read (llms.txt / llms-full.txt / agents.md / ai.txt / openapi.json
 *  / robots.txt / sitemap.xml and the .well-known discovery files).
 *
 *  These paths are the ones a site owner or an agent needs when the network
 *  is gone: the rating methodology, the API contract, the crawl policy and
 *  the map of every listed site. */
const STATIC_PREFIXES = ['/_astro/', '/icons/', '/fonts/', '/.well-known/'];
const STATIC_FILES = [
  '/llms.txt',
  '/llms-full.txt',
  '/agents.md',
  '/ai.txt',
  '/openapi.json',
  '/robots.txt',
  '/sitemap.xml',
];

/** How long a cached copy may be served before it is silently refreshed in
 *  the background. Only the sitemap needs this: it is regenerated on every
 *  deploy and is far too large to precache, so it would otherwise stay
 *  frozen in the runtime cache until the next VERSION bump. Everything else
 *  is refreshed by the VERSION bump that ships it. */
const SITEMAP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isStaticArtifact(path) {
  if (STATIC_FILES.includes(path)) return true;
  return STATIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function staticMaxAge(path) {
  if (path === '/sitemap.xml') return SITEMAP_MAX_AGE_MS;
  return 0;
}

/** Age of a cached response, taken from its Date header. An unknown age is
 *  treated as stale so a background refresh is attempted. */
function isOlderThan(response, maxAgeMs) {
  const date = response && response.headers && response.headers.get
    ? response.headers.get('date')
    : null;
  if (!date) return true;
  const stamp = Date.parse(date);
  if (Number.isNaN(stamp)) return true;
  return Date.now() - stamp > maxAgeMs;
}

/** Refresh a cached entry without delaying the response that is on its way
 *  to the client. Failures are swallowed: a background refresh is best
 *  effort by definition. */
function refreshInBackground(cache, request) {
  fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
      return response;
    })
    .catch(() => undefined);
}

/** Cache-first: serve the stored copy, fill it from the network on a miss.
 *  Offline and never cached → a plain 503 instead of a network error.
 *
 *  `maxAgeMs` keeps the cache-first guarantee (the stored copy is returned
 *  immediately) but lets an aging entry be replaced in the background. */
async function cacheFirst(request, { maxAgeMs = 0 } = {}) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request);
  if (cached) {
    if (maxAgeMs > 0 && isOlderThan(cached, maxAgeMs)) {
      refreshInBackground(cache, request);
    }
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch {
    return new Response('Offline and this file is not cached yet. Reconnect and refresh.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  const path = new URL(request.url).pathname;

  if (path === '/api' || path.startsWith('/api/')) {
    event.respondWith(networkFirstApi(request));
    return;
  }
  if (/^\/(?:zh-CN\/)?(?:admin|owner)(?:\/|$)/.test(path)) return;
  if (request.mode === 'navigate') {
    handleNavigation(event);
    return;
  }
  if (path.startsWith('/data/') || path === '/search-index.json') {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  // Static assets (hashed build output, icons, fonts, agent documents):
  // cache-first is safe because build output is content-hashed and the rest
  // is versioned by us.
  if (isStaticArtifact(path)) {
    event.respondWith(cacheFirst(request, { maxAgeMs: staticMaxAge(path) }));
  }
});
