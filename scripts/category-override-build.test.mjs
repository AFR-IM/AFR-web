// scripts/category-override-build.test.mjs — the manual category labels, from
// the API to the rendered detail page.
//
// Why it matters: the site build labels a site with the heuristic table
// (src/data/categorize.mjs), but a human can label a site by hand in the
// admin console. The manual label is the better answer, so it has to reach
// every public surface — the API, the badge, the static build and the
// on-demand detail page. When one of them keeps the heuristic label, the
// site shows two different categories at once.
//
// So this covers the whole path: the endpoint is read, a broken endpoint
// degrades to the old behaviour, the label reaches the detail payload, a
// malformed label is refused, and the runtime page reads the same map the
// build wrote.
//
// Run: node --test scripts/category-override-build.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';

import { fetchCategoryOverrides } from '../apps/web/scripts/fetch-category-overrides.mjs';
import { buildDetail } from '../apps/web/src/data/detail.ts';
import { categorize } from '../apps/web/src/data/categorize.mjs';

// The runtime module imports the delisted map as JSON; Node needs the
// import attribute for that, so the JSON is redirected to an empty module
// (the labels under test do not depend on the delisted notes).
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('delisted.json')) {
    return { url: 'data:text/javascript,export default {}%3B', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`)}`,
  import.meta.url,
);
const { CATEGORY_OVERRIDES_URL, loadCategoryOverrides } = await import(
  '../apps/web/src/data/runtime-detail.ts'
);

/** A snapshot shaped like the real corpus output. */
function snapshot(domain = 'acme.test') {
  return {
    signals: {
      domain,
      homepage: { status: 200, url: `https://${domain}/`, title: 'Acme Widgets' },
    },
    afr: {
      domain,
      engineVersion: 'afr-1.5.0',
      scannerVersion: 'scanner-0.1.0',
      scannedAt: '2026-11-10T11:42:36.513Z',
      score: 87,
      grade: 'B',
      state: 'scored',
      strategyTag: 'Middle-Path',
      layers: [{ layer: 'L1', name: 'Reachability', awarded: 35, max: 35, checks: [] }],
      breakdown: { 'l1.robots.ai-policy': 25 },
    },
  };
}

/** Run a function with console.warn captured (the fetch warns on failure). */
async function captureWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

// ── the endpoint read ──────────────────────────────────────────────────────

test('the manual labels are read from the public endpoint', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ 'acme.test': 'dev-tools', 'blog.test': 'news' }),
    };
  };
  const map = await fetchCategoryOverrides({ fetchImpl, apiBase: 'https://example.test/' });
  assert.deepEqual(map, { 'acme.test': 'dev-tools', 'blog.test': 'news' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://example.test/api/v1/category-overrides');
  assert.match(String(seen[0].init?.headers?.accept), /application\/json/);
});

test('a broken endpoint degrades to an empty map instead of failing the build', async () => {
  const { result, warnings } = await captureWarnings(() =>
    fetchCategoryOverrides({
      fetchImpl: async () => {
        throw new Error('network down');
      },
    }),
  );
  assert.deepEqual(result, {});
  assert.equal(warnings.length, 1);

  const { result: onHttpError } = await captureWarnings(() =>
    fetchCategoryOverrides({
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    }),
  );
  assert.deepEqual(onHttpError, {});
});

test('a malformed payload keeps only the usable labels', async () => {
  const map = await fetchCategoryOverrides({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        'good.test': 'dev-tools',
        'bad-slug.test': 'Dev Tools',
        'not-a-string.test': 42,
        'UPPER.test': 'news',
      }),
    }),
  });
  assert.deepEqual(map, { 'good.test': 'dev-tools', 'upper.test': 'news' });

  const notAMap = await fetchCategoryOverrides({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ['nope'] }),
  });
  assert.deepEqual(notAMap, {});
});

// ── the detail payload ─────────────────────────────────────────────────────

test('a manual label replaces the heuristic label', () => {
  const detail = buildDetail(snapshot(), 'acme.test', undefined, { 'acme.test': 'ecommerce' });
  assert.equal(detail.category, 'ecommerce');
});

test('without a label the payload is exactly what it was before', () => {
  const before = buildDetail(snapshot(), 'acme.test');
  const after = buildDetail(snapshot(), 'acme.test', undefined, { 'other.test': 'ecommerce' });
  assert.deepEqual(after, before);
  assert.equal(after.category, categorize('acme.test', 'Acme Widgets', undefined));
});

test('a label that is not a safe slug, or names no category page, is ignored', () => {
  const expected = categorize('acme.test', 'Acme Widgets', undefined);
  for (const bad of [
    '', '   ', 'Dev Tools', 'dev_tools', '../../etc/passwd', 'x'.repeat(65), '<script>',
    // A well-formed slug of a category the product does not have: applying it
    // would render a chip that links to /c/new-slug/ — a page that does not
    // exist. The heuristic label stays.
    'new-slug',
  ]) {
    const detail = buildDetail(snapshot(), 'acme.test', undefined, { 'acme.test': bad });
    assert.equal(detail.category, expected, `slug must be ignored: ${bad}`);
  }
  // A label of a real category is applied.
  assert.equal(buildDetail(snapshot(), 'acme.test', undefined, { 'acme.test': 'news' }).category, 'news');
});

test('a label is matched on the domain, case-insensitively', () => {
  const upper = buildDetail(snapshot('ACME.test'), 'ACME.test', undefined, { 'acme.test': 'ecommerce' });
  assert.equal(upper.category, 'ecommerce');
});

test('the key order of the payload does not move', () => {
  const detail = buildDetail(snapshot(), 'acme.test', undefined, { 'acme.test': 'ecommerce' });
  assert.deepEqual(Object.keys(detail), [
    'domain',
    'title',
    'score',
    'grade',
    'strategyTag',
    'category',
    'scannedAt',
    'engineVersion',
    'scannerVersion',
    'layers',
    'breakdown',
    'history',
  ]);
});

// ── the runtime page ───────────────────────────────────────────────────────

/** A runtime whose ASSETS binding answers with the given payload. */
function runtimeWithAssets(payload, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    runtime: {
      env: {
        ASSETS: {
          fetch: async (req) => {
            calls.push(req.url);
            if (fail) throw new Error('asset binding is broken');
            return { ok: true, status: 200, json: async () => payload };
          },
        },
      },
    },
  };
}

test('the runtime page reads the labels from the deployment asset', async () => {
  const { calls, runtime } = runtimeWithAssets({ 'acme.test': 'ecommerce' });
  const map = await loadCategoryOverrides(runtime, 'https://asset.test');
  assert.deepEqual(map, { 'acme.test': 'ecommerce' });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith(CATEGORY_OVERRIDES_URL), calls[0]);
});

test('a broken asset falls back to the network, and a broken network to an empty map', async () => {
  const { runtime } = runtimeWithAssets({}, { fail: true });
  const original = globalThis.fetch;
  let requested = null;
  globalThis.fetch = async (url) => {
    requested = String(url);
    return { ok: true, status: 200, json: async () => ({ 'acme.test': 'news' }) };
  };
  try {
    const map = await loadCategoryOverrides(runtime, 'https://fallback.test');
    assert.deepEqual(map, { 'acme.test': 'news' });
    assert.ok(requested.endsWith(CATEGORY_OVERRIDES_URL), requested);
  } finally {
    globalThis.fetch = original;
  }

  const { runtime: broken } = runtimeWithAssets({}, { fail: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  try {
    const map = await loadCategoryOverrides(broken, 'https://broken.test');
    assert.deepEqual(map, {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the labels are read once per deployment, not once per request', async () => {
  const { calls, runtime } = runtimeWithAssets({ 'acme.test': 'ecommerce' });
  const first = await loadCategoryOverrides(runtime, 'https://cached.test');
  const second = await loadCategoryOverrides(runtime, 'https://cached.test');
  assert.deepEqual(first, { 'acme.test': 'ecommerce' });
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
});

test('the labels are read again once the cache expires', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { calls, runtime } = runtimeWithAssets({ 'acme.test': 'ecommerce' });
  await loadCategoryOverrides(runtime, 'https://expiring.test');
  assert.equal(calls.length, 1);
  t.mock.timers.tick(11 * 60 * 1000);
  await loadCategoryOverrides(runtime, 'https://expiring.test');
  assert.equal(calls.length, 2);
});
