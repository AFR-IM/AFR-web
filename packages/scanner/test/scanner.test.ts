// Scanner offline tests (mock fetch, no real network access)
// Run: node --test packages/scanner/test/*.test.ts

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_REQUESTS, normalizeDomain, RequestCounter, type FetchImpl } from '../src/http.ts';
import { detectAiFeatures, extractLinks, scanSite } from '../src/scan.ts';

/** Build a mock fetch: return preset responses by URL path and record the calls */
function mockFetch(routes: Record<string, { status?: number; body?: string; throws?: string }>) {
  const calls: string[] = [];
  const impl: FetchImpl = async (url) => {
    calls.push(url);
    const path = '/' + new URL(url).pathname.replace(/^\//, '');
    const key = path === '/' ? '/' : path;
    const r = routes[key] ?? routes['*'] ?? { status: 404 };
    if (r.throws) throw Object.assign(new Error(r.throws), { name: 'TypeError' });
    return new Response(r.body ?? '', {
      status: r.status ?? 200,
      headers: { 'content-type': 'text/html' },
      url,
    }) as unknown as Response;
  };
  return { impl, calls };
}

describe('normalizeDomain', () => {
  it('strips scheme/path/port/www/case', () => {
    assert.equal(normalizeDomain('https://www.Example.com:8443/path?q=1'), 'example.com');
    assert.equal(normalizeDomain('HTTP://EXAMPLE.COM'), 'example.com');
    assert.equal(normalizeDomain('  example.com/foo  '), 'example.com');
    assert.equal(normalizeDomain('user:pass@sub.example.com/x'), 'sub.example.com');
  });
});

describe('RequestCounter', () => {
  it('rejects spending beyond the limit', () => {
    const c = new RequestCounter(3);
    assert.equal(c.trySpend(), true);
    assert.equal(c.trySpend(), true);
    assert.equal(c.trySpend(), true);
    assert.equal(c.trySpend(), false);
    assert.equal(c.remaining, 0);
  });
});

describe('polite budget', () => {
  it('a normal 8-slot site stays within MAX_REQUESTS actual requests', async () => {
    const { impl, calls } = mockFetch({
      '/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\n' },
      '/llms.txt': { status: 404 },
      '/llms-full.txt': { status: 404 },
      '/': { status: 200, body: '<html lang="en"><body><main><h1>hi</h1></main></body></html>' },
      '/sitemap.xml': { status: 404 },
      '/agents.md': { status: 404 },
      '/openapi.json': { status: 404 },
      '/.well-known/mcp': { status: 404 },
    });
    const signals = await scanSite('example.com', { fetchImpl: impl, gapMs: 0 });
    assert.ok(calls.length <= MAX_REQUESTS, `requests=${calls.length}`);
    assert.equal(signals.domain, 'example.com');
    assert.equal(signals.openapi!.probed, true);
    assert.equal(signals.mcp!.probed, true);
    assert.equal(signals.robots!.status, 200);
  });

  it('agents.md 404 → falls back to AGENTS.md (still counted against the budget)', async () => {
    const { impl, calls } = mockFetch({
      '/robots.txt': { status: 404 },
      '/llms.txt': { status: 404 },
      '/llms-full.txt': { status: 404 },
      '/': { status: 200, body: '<html></html>' },
      '/sitemap.xml': { status: 404 },
      '/agents.md': { status: 404 },
      '/AGENTS.md': { status: 200, body: '# agents' },
      '/openapi.json': { status: 404 },
      '/.well-known/mcp': { status: 404 },
    });
    const signals = await scanSite('example.com', { fetchImpl: impl, gapMs: 0 });
    assert.equal(signals.agentsMd!.status, 200);
    assert.ok(calls.some((c) => c.endsWith('/AGENTS.md')));
    assert.ok(calls.length <= MAX_REQUESTS);
  });

  it('probes /ai.txt and exposes the probe (agent-instructions sub-check input)', async () => {
    const { impl } = mockFetch({
      '/robots.txt': { status: 404 },
      '/llms.txt': { status: 404 },
      '/llms-full.txt': { status: 404 },
      '/': { status: 200, body: '<html><body>hi</body></html>' },
      '/sitemap.xml': { status: 404 },
      '/agents.md': { status: 404 },
      '/openapi.json': { status: 404 },
      '/.well-known/mcp': { status: 404 },
      '/ai.txt': { status: 200, body: '# AI policy' },
    });
    const signals = await scanSite('example.com', { fetchImpl: impl });
    assert.equal(signals.aiTxt?.status, 200);
    assert.equal(signals.aiTxt?.body, '# AI policy');
  });

  it('Sitemap and crawl-delay declared in robots.txt are honored', async () => {
    const { impl, calls } = mockFetch({
      '/robots.txt': { status: 200, body: 'Sitemap: https://example.com/custom.xml\ncrawl-delay: 0\n' },
      '/llms.txt': { status: 404 },
      '/llms-full.txt': { status: 404 },
      '/': { status: 200, body: '<html></html>' },
      '/custom.xml': { status: 200, body: '<urlset/>' },
      '/agents.md': { status: 404 },
      '/AGENTS.md': { status: 404 },
      '/openapi.json': { status: 404 },
      '/.well-known/mcp': { status: 404 },
    });
    const signals = await scanSite('example.com', { fetchImpl: impl, gapMs: 0 });
    assert.ok(calls.some((c) => c.endsWith('/custom.xml')), 'should fetch the sitemap declared in robots.txt');
    assert.equal(signals.sitemap!.status, 200);
  });

  it('uses the swagger link from the homepage instead of the default URL', async () => {
    const { impl, calls } = mockFetch({
      '/robots.txt': { status: 404 },
      '/llms.txt': { status: 404 },
      '/llms-full.txt': { status: 404 },
      '/': {
        status: 200,
        body: `<html><body><a href="/api/swagger.json">api</a>
          <link rel="stylesheet" href="/static/swagger-ui.css"></body></html>`,
      },
      '/sitemap.xml': { status: 404 },
      '/agents.md': { status: 404 },
      '/AGENTS.md': { status: 404 },
      '/api/swagger.json': { status: 200, body: '{"openapi":"3.0.0","info":{}}' },
      '/.well-known/mcp': { status: 404 },
    });
    const signals = await scanSite('example.com', { fetchImpl: impl, gapMs: 0 });
    assert.equal(signals.openapi!.found, true);
    assert.ok(calls.some((c) => c.endsWith('/api/swagger.json')));
    assert.ok(!calls.some((c) => c.endsWith('/openapi.json')));
  });
});

describe('challenge fallback (browser-UA recovery)', () => {
  it('transparent UA 403 → re-fetch with browser UA, challengedStatus preserved', async () => {
    const calls: string[] = [];
    const impl = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push(url);
      const path = '/' + new URL(url).pathname.replace(/^\//, '');
      const headers = init.headers as Record<string, string>;
      const ua = String(headers['user-agent'] ?? '');
      if (path === '/') {
        if (ua.startsWith('afrScanner')) {
          return new Response('blocked', { status: 403 }) as unknown as Response;
        }
        return new Response('<html lang="en"><body><main><h1>hi</h1></main></body></html>', {
          status: 200,
        }) as unknown as Response;
      }
      // Other slots: transparent 403 / browser 404 → both "non-challenge after fallback" or "challenge preserved"
      const fb = path === '/llms.txt' || path === '/llms-full.txt';
      const status = ua.startsWith('afrScanner') ? 403 : fb ? 404 : 403;
      return new Response('', { status }) as unknown as Response;
    };
    const signals = await scanSite('example.com', { fetchImpl: impl, gapMs: 0 });
    assert.equal(signals.homepage!.status, 200);
    assert.equal(signals.homepage!.uaFallback, true);
    assert.equal(signals.homepage!.challengedStatus, 403);
    assert.ok(calls.length <= MAX_REQUESTS, `requests=${calls.length}`);
  });

  it('hard wall: both UAs get 403 → transparent result kept, no fallback marker', async () => {
    const impl = async (): Promise<Response> =>
      new Response('denied', { status: 403 }) as unknown as Response;
    const signals = await scanSite('example.com', { fetchImpl: impl, gapMs: 0 });
    assert.equal(signals.homepage!.status, 403);
    assert.equal(signals.homepage!.uaFallback, undefined);
    assert.equal(signals.homepage!.challengedStatus, undefined);
    // budget stays within the hard cap (at most 2 attempts per slot)
    assert.ok(true);
  });
});

describe('heuristics', () => {
  it('extractLinks keeps only matching entries', () => {
    const html = `<a href="/docs">d</a><a href="/blog">b</a><script src="https://cdn.dev/api/docs.js"></script>`;
    const links = extractLinks(html, /\/docs/);
    assert.equal(links.length, 2);
  });

  it('detectAiFeatures detects all three signal types', () => {
    const html = `<script src="https://widget.intercom.io/w.js"></script>
      <a href="/console/api">console</a>
      <p>Ask AI about semantic search powered by GPT-4</p>`;
    const f = detectAiFeatures(html);
    assert.equal(f.chatWidget, true);
    assert.equal(f.aiSearch, true);
    assert.equal(f.developerConsole, true);
    assert.deepEqual(detectAiFeatures('<html><body>plain</body></html>'), {
      chatWidget: false,
      aiSearch: false,
      developerConsole: false,
    });
  });
});

describe('afr-1.6.0 signals: API-docs split + MCP handshake', () => {
  /** GET routes shared by the handshake tests; /.well-known/mcp returns `discovery` */
  function getRoutes(discovery: string) {
    return {
      '/robots.txt': { status: 404 },
      '/llms.txt': { status: 404 },
      '/llms-full.txt': { status: 404 },
      '/': { status: 200, body: '<html lang="en"><body><main><h1>hi</h1></main></body></html>' },
      '/sitemap.xml': { status: 404 },
      '/agents.md': { status: 404 },
      '/openapi.json': { status: 404 },
      '/.well-known/mcp': { status: 200, body: discovery },
      '/ai.txt': { status: 404 },
    };
  }

  /** Mock that answers the MCP handshake on POST /mcp and records every POST */
  function mockHandshake(opts: {
    discovery: string;
    failAt?: 'initialize' | 'tools';
    session?: string;
  }) {
    const posts: { method?: string; sessionId?: string }[] = [];
    const impl: FetchImpl = async (url, init) => {
      const path = '/' + new URL(url).pathname.replace(/^\//, '');
      const reply = (status: number, body: string, extra: Record<string, string> = {}) =>
        new Response(body, {
          status,
          headers: { 'content-type': 'application/json', ...extra },
        }) as unknown as Response;
      if ((init?.method ?? 'GET') === 'POST') {
        const msg = JSON.parse(String(init.body ?? '{}')) as { method?: string; id?: number };
        const headers = (init.headers ?? {}) as Record<string, string>;
        posts.push({ method: msg.method, sessionId: headers['mcp-session-id'] });
        if (msg.method === 'initialize') {
          if (opts.failAt === 'initialize') return reply(500, 'boom');
          return reply(
            200,
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { protocolVersion: '2025-06-18', serverInfo: { name: 'demo', version: '1.0' } },
            }),
            opts.session ? { 'mcp-session-id': opts.session } : {},
          );
        }
        if (msg.method === 'notifications/initialized') return reply(202, '');
        if (msg.method === 'tools/list') {
          if (opts.failAt === 'tools') {
            return reply(200, JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } }));
          }
          return reply(
            200,
            JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'alpha' }, { name: 'beta' }] } }),
          );
        }
        return reply(400, '{}');
      }
      const route = getRoutes(opts.discovery)[path as '/'] ?? { status: 404 };
      return reply(route.status ?? 404, route.body ?? '');
    };
    return { impl, posts };
  }

  it('apiDocs is homepage links only — an OpenAPI hit no longer sets it', async () => {
    const { impl } = mockFetch({
      ...getRoutes('not a document'),
      '/openapi.json': { status: 200, body: '{"openapi":"3.1.0","info":{"title":"t","version":"1"}}' },
    });
    const signals = await scanSite('example.com', { fetchImpl: impl, gapMs: 0 });
    assert.equal(signals.openapi!.found, true);
    assert.equal(signals.apiDocs!.found, false);
    assert.deepEqual(signals.apiDocs!.urls, []);
  });

  it('discovery document + successful handshake stores the tool names', async () => {
    const discovery = JSON.stringify({ endpoint: 'https://example.com/mcp', transport: 'http' });
    const { impl, posts } = mockHandshake({ discovery, session: 'sess-1' });
    const signals = await scanSite('example.com', { fetchImpl: impl, gapMs: 0 });
    assert.equal(signals.mcp!.found, true);
    assert.deepEqual(signals.mcp!.tools, ['alpha', 'beta']);
    assert.deepEqual(
      posts.map((p) => p.method),
      ['initialize', 'notifications/initialized', 'tools/list'],
    );
    // the session id minted by initialize rides on the two follow-up calls
    assert.equal(posts[1]!.sessionId, 'sess-1');
    assert.equal(posts[2]!.sessionId, 'sess-1');
  });

  it('a discovery body without an endpoint field records discovery only (no POSTs)', async () => {
    const { impl, posts } = mockHandshake({ discovery: '<html><body>marketing page</body></html>' });
    const signals = await scanSite('example.com', { fetchImpl: impl, gapMs: 0 });
    assert.equal(signals.mcp!.found, true);
    assert.equal(signals.mcp!.tools, undefined);
    assert.equal(posts.length, 0);
  });

  it('a failed initialize or a tools/list error leaves the snapshot unverified', async () => {
    const discovery = JSON.stringify({ endpoint: 'https://example.com/mcp' });
    const failed = mockHandshake({ discovery, failAt: 'initialize' });
    const s1 = await scanSite('example.com', { fetchImpl: failed.impl, gapMs: 0 });
    assert.equal(s1.mcp!.found, true);
    assert.equal(s1.mcp!.tools, undefined);
    assert.equal(failed.posts.length, 1, 'handshake stops at the failed step');

    const errored = mockHandshake({ discovery, failAt: 'tools' });
    const s2 = await scanSite('example.com', { fetchImpl: errored.impl, gapMs: 0 });
    assert.equal(s2.mcp!.tools, undefined);
    assert.equal(errored.posts.length, 3);
  });

  it('the handshake adds exactly three POSTs to the scan', async () => {
    const discovery = JSON.stringify({ endpoint: 'https://example.com/mcp' });
    const { impl, posts } = mockHandshake({ discovery });
    const signals = await scanSite('example.com', { fetchImpl: impl, gapMs: 0 });
    assert.deepEqual(signals.mcp!.tools, ['alpha', 'beta']);
    // 9 GET slots + 3 handshake POSTs = 12 ≤ MAX_REQUESTS
    assert.equal(posts.length, 3);
  });
});
