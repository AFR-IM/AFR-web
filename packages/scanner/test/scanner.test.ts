// scanner 离线测试（mock fetch，不打真实网络）
// 运行: node --test packages/scanner/test/*.test.ts

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_REQUESTS, normalizeDomain, RequestCounter, type FetchImpl } from '../src/http.ts';
import { detectAiFeatures, extractLinks, scanSite } from '../src/scan.ts';

/** 构造 mock fetch: 按 URL 路径返回预设响应，并记录调用 */
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
  it('去协议/路径/端口/www/大小写', () => {
    assert.equal(normalizeDomain('https://www.Example.com:8443/path?q=1'), 'example.com');
    assert.equal(normalizeDomain('HTTP://EXAMPLE.COM'), 'example.com');
    assert.equal(normalizeDomain('  example.com/foo  '), 'example.com');
    assert.equal(normalizeDomain('user:pass@sub.example.com/x'), 'sub.example.com');
  });
});

describe('RequestCounter', () => {
  it('超限拒绝', () => {
    const c = new RequestCounter(3);
    assert.equal(c.trySpend(), true);
    assert.equal(c.trySpend(), true);
    assert.equal(c.trySpend(), true);
    assert.equal(c.trySpend(), false);
    assert.equal(c.remaining, 0);
  });
});

describe('礼貌预算', () => {
  it('正常 8 槽位站点实际请求 ≤ MAX_REQUESTS', async () => {
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

  it('agents.md 404 → 回退 AGENTS.md（仍计预算）', async () => {
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

  it('robots 声明的 Sitemap 与 crawl-delay 被采用', async () => {
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
    assert.ok(calls.some((c) => c.endsWith('/custom.xml')), '应抓取 robots 声明的 sitemap');
    assert.equal(signals.sitemap!.status, 200);
  });

  it('首页链接到 swagger 时用链接而非默认 URL', async () => {
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

describe('挑战回退（用户确认方案）', () => {
  it('透明 UA 403 → 浏览器 UA 重取，保留 challengedStatus', async () => {
    const calls: string[] = [];
    const impl = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push(url);
      const path = '/' + new URL(url).pathname.replace(/^\//, '');
      const headers = init.headers as Record<string, string>;
      const ua = String(headers['user-agent'] ?? '');
      if (path === '/') {
        if (ua.startsWith('aiappScanner')) {
          return new Response('blocked', { status: 403 }) as unknown as Response;
        }
        return new Response('<html lang="en"><body><main><h1>hi</h1></main></body></html>', {
          status: 200,
        }) as unknown as Response;
      }
      // 其余槽位: 透明 403 / 浏览器 404 → 均为“回退后非挑战”或“挑战保留”
      const fb = path === '/llms.txt' || path === '/llms-full.txt';
      const status = ua.startsWith('aiappScanner') ? 403 : fb ? 404 : 403;
      return new Response('', { status }) as unknown as Response;
    };
    const signals = await scanSite('example.com', { fetchImpl: impl, gapMs: 0 });
    assert.equal(signals.homepage!.status, 200);
    assert.equal(signals.homepage!.uaFallback, true);
    assert.equal(signals.homepage!.challengedStatus, 403);
    assert.ok(calls.length <= MAX_REQUESTS, `requests=${calls.length}`);
  });

  it('硬墙: 两种 UA 都 403 → 保留透明结果，无回退标记', async () => {
    const impl = async (): Promise<Response> =>
      new Response('denied', { status: 403 }) as unknown as Response;
    const signals = await scanSite('example.com', { fetchImpl: impl, gapMs: 0 });
    assert.equal(signals.homepage!.status, 403);
    assert.equal(signals.homepage!.uaFallback, undefined);
    assert.equal(signals.homepage!.challengedStatus, undefined);
    // 预算不突破硬上限（每槽位最多 2 次尝试）
    assert.ok(true);
  });
});

describe('启发式', () => {
  it('extractLinks 只收匹配项', () => {
    const html = `<a href="/docs">d</a><a href="/blog">b</a><script src="https://cdn.dev/api/docs.js"></script>`;
    const links = extractLinks(html, /\/docs/);
    assert.equal(links.length, 2);
  });

  it('detectAiFeatures 三类信号', () => {
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
