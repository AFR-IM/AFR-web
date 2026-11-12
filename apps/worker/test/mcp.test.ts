// test/mcp.test.ts — MCP endpoint (POST /mcp): initialize handshake, the three
// read-only tools against a seeded node:sqlite database, and JSON-RPC error
// mapping (parse / invalid request / method not found / invalid params).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/index.ts';
import { MCP_RATE_WINDOW_MS } from '../src/mcp.ts';
import { RateLimiter, memoryStore } from '../src/rate-limit.ts';
import { openSeededDb } from './helpers.ts';

type TestApp = ReturnType<typeof createApp>;

function app(): TestApp {
  return createApp({ db: openSeededDb().db });
}

/** POST a message (object is JSON-encoded; a string is sent verbatim). */
async function post(target: TestApp, message: unknown): Promise<Response> {
  return target.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof message === 'string' ? message : JSON.stringify(message),
  });
}

/** POST a well-formed JSON-RPC request and return the parsed response body. */
async function rpc(target: TestApp, message: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await post(target, message);
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, any>;
}

describe('POST /mcp — initialize handshake', () => {
  it('echoes a supported protocol version and declares capabilities, serverInfo and instructions', async () => {
    const res = await post(app(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);

    const body = await res.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.equal(body.result.protocolVersion, '2025-03-26');
    assert.deepEqual(body.result.capabilities, { tools: { listChanged: false } });
    assert.equal(body.result.serverInfo.name, 'aiapp');
    assert.equal(body.result.serverInfo.version, '1.0.0');

    // The instructions are the declared, discoverable surface: transport note,
    // the three tools and the public-scan provenance of the data.
    const instructions = body.result.instructions;
    assert.equal(typeof instructions, 'string');
    assert.ok(instructions.includes('site_rating'));
    assert.ok(instructions.includes('search_sites'));
    assert.ok(instructions.includes('grade_distribution'));
    assert.ok(instructions.includes('reproducible'));
    assert.ok(instructions.includes('POST /mcp'));
    assert.equal(body.result.serverInfo.instructions, instructions);
  });

  it('falls back to the current protocol version when the client offers an unknown one', async () => {
    const unknown = await rpc(app(), {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    });
    assert.equal(unknown.result.protocolVersion, '2025-06-18');

    const missing = await rpc(app(), {
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: {},
    });
    assert.equal(missing.result.protocolVersion, '2025-06-18');
  });

  it('rejects non-object initialize params with -32602', async () => {
    const res = await post(app(), {
      jsonrpc: '2.0',
      id: 4,
      method: 'initialize',
      params: 'not-an-object',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error.code, -32602);
    assert.equal(body.id, 4);
  });
});

describe('GET /mcp (MCP transport probe)', () => {
  it('returns 405 with Allow: POST and no-store', async () => {
    const res = await app().request('/mcp');
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = await res.json();
    assert.equal(body.error, 'method_not_allowed');
    assert.equal(body.allow, 'POST');
  });

  it('answers the CORS preflight with 204', async () => {
    const res = await app().request('/mcp', { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.ok((res.headers.get('access-control-allow-methods') ?? '').includes('POST'));
  });
});

describe('JSON-RPC protocol errors', () => {
  it('maps malformed JSON to -32700', async () => {
    const res = await post(app(), '{"jsonrpc":"2.0",');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, null);
    assert.equal(body.error.code, -32700);
  });

  it('maps unknown methods to -32601', async () => {
    const res = await post(app(), { jsonrpc: '2.0', id: 7, method: 'resources/list' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 7);
    assert.equal(body.error.code, -32601);
  });

  it('maps invalid requests (wrong jsonrpc / non-object body) to -32600', async () => {
    const wrongVersion = await post(app(), { jsonrpc: '1.0', id: 8, method: 'ping' });
    assert.equal(wrongVersion.status, 400);
    assert.equal((await wrongVersion.json()).error.code, -32600);

    const arrayBody = await post(app(), [1, 2, 3]);
    assert.equal(arrayBody.status, 400);
    assert.equal((await arrayBody.json()).error.code, -32600);
  });

  it('answers ping with an empty result', async () => {
    const body = await rpc(app(), { jsonrpc: '2.0', id: 9, method: 'ping' });
    assert.deepEqual(body.result, {});
  });
});

describe('POST /mcp — notifications', () => {
  it('accepts notifications/initialized with 202 and an empty body', async () => {
    const notification = await post(app(), {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    assert.equal(notification.status, 202);
    assert.equal(await notification.text(), '');

    // Same answer when a client (incorrectly) attaches an id.
    const withId = await post(app(), {
      jsonrpc: '2.0',
      id: 99,
      method: 'notifications/initialized',
    });
    assert.equal(withId.status, 202);
    assert.equal(await withId.text(), '');
  });
});

describe('POST /mcp — tools/list', () => {
  it('exposes exactly the three tools with their schemas', async () => {
    const body = await rpc(app(), { jsonrpc: '2.0', id: 10, method: 'tools/list' });
    const tools = body.result.tools;
    assert.deepEqual(
      tools.map((t: { name: string }) => t.name),
      ['site_rating', 'search_sites', 'grade_distribution'],
    );
    for (const tool of tools) {
      assert.ok(tool.description.includes('aiapp.im'));
      assert.ok(tool.description.includes('scan'));
      assert.equal(tool.inputSchema.type, 'object');
    }

    assert.deepEqual(tools[0].inputSchema.required, ['domain']);
    assert.equal(tools[0].inputSchema.properties.domain.type, 'string');
    assert.deepEqual(tools[1].inputSchema.properties.grade.enum, ['A', 'B', 'C', 'D', 'F']);
    assert.equal(tools[1].inputSchema.properties.limit.default, 10);
    assert.equal(tools[1].inputSchema.properties.limit.maximum, 25);
    assert.deepEqual(tools[2].inputSchema.properties, {});
  });
});

describe('POST /mcp — tools/call site_rating', () => {
  it('returns the site record for a known domain', async () => {
    const body = await rpc(app(), {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'site_rating', arguments: { domain: 'example.com' } },
    });
    assert.equal(body.result.isError, false);
    const site = JSON.parse(body.result.content[0].text);
    assert.deepEqual(site, {
      domain: 'example.com',
      grade: 'A',
      score: 92,
      strategyTag: 'AI-Open',
      scannedAt: '2026-11-10T10:00:00.000Z',
      views: 0,
    });
  });

  it('accepts assistant-friendly inputs like a full URL', async () => {
    const body = await rpc(app(), {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'site_rating', arguments: { domain: 'https://Example.com/some/path' } },
    });
    assert.equal(body.result.isError, false);
    const site = JSON.parse(body.result.content[0].text);
    assert.equal(site.domain, 'example.com');
    assert.equal(site.grade, 'A');
  });

  it('reports unknown sites as an isError tool result ("site not found")', async () => {
    const body = await rpc(app(), {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'site_rating', arguments: { domain: 'ghost.example' } },
    });
    // Tool failures are results, not protocol errors.
    assert.equal(body.error, undefined);
    assert.equal(body.result.isError, true);
    assert.equal(body.result.content[0].text, 'site not found');
  });

  it('rejects a non-string domain with -32602', async () => {
    const body = await rpc(app(), {
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'site_rating', arguments: { domain: 42 } },
    });
    assert.equal(body.error.code, -32602);
  });
});

describe('POST /mcp — tools/call search_sites', () => {
  it('returns graded sites ranked by score (Pending excluded)', async () => {
    const body = await rpc(app(), {
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: { name: 'search_sites', arguments: {} },
    });
    assert.equal(body.result.isError, false);
    const items = JSON.parse(body.result.content[0].text);
    assert.deepEqual(
      items.map((i: { domain: string }) => i.domain),
      ['example.com', 'coolsite.io', 'neutral.net', 'closed.org'],
    );
    assert.deepEqual(Object.keys(items[0]), ['domain', 'grade', 'score', 'strategyTag']);
    assert.deepEqual(items[0], {
      domain: 'example.com',
      grade: 'A',
      score: 92,
      strategyTag: 'AI-Open',
    });
  });

  it('filters by grade and by keyword', async () => {
    const byGrade = JSON.parse(
      (
        await rpc(app(), {
          jsonrpc: '2.0',
          id: 16,
          method: 'tools/call',
          params: { name: 'search_sites', arguments: { grade: 'B' } },
        })
      ).result.content[0].text,
    );
    assert.deepEqual(
      byGrade.map((i: { domain: string }) => i.domain),
      ['coolsite.io'],
    );

    const byQuery = JSON.parse(
      (
        await rpc(app(), {
          jsonrpc: '2.0',
          id: 17,
          method: 'tools/call',
          params: { name: 'search_sites', arguments: { query: 'COOL' } },
        })
      ).result.content[0].text,
    );
    assert.deepEqual(
      byQuery.map((i: { domain: string }) => i.domain),
      ['coolsite.io'],
    );
  });

  it('clamps limit to [1, 25] with a default of 10', async () => {
    // 4 seeded graded sites + 30 bulk graded sites → the clamp is observable.
    const { db, raw } = openSeededDb();
    const insert = raw.prepare(
      `INSERT INTO sites (domain, title, lang, category_id, strategy_tag, grade, score_total, status, verified, created_at)
       VALUES (?, ?, 'en', 1, 'AI-Open', ?, ?, 'active', 0, '2026-11-01T00:00:00.000Z')`,
    );
    const grades = ['A', 'B', 'C', 'D', 'F'];
    for (let i = 1; i <= 30; i++) {
      insert.run(`bulk${i}.test`, `Bulk ${i}`, grades[i % 5] ?? 'A', 100 - i);
    }
    const target = createApp({ db });

    const call = async (limit?: number): Promise<unknown[]> => {
      const body = await rpc(target, {
        jsonrpc: '2.0',
        id: 18,
        method: 'tools/call',
        params: { name: 'search_sites', arguments: limit === undefined ? {} : { limit } },
      });
      return JSON.parse(body.result.content[0].text) as unknown[];
    };

    assert.equal((await call()).length, 10); // default
    assert.equal((await call(100)).length, 25); // clamped down
    assert.equal((await call(0)).length, 1); // clamped up
    assert.equal((await call(-5)).length, 1);
  });

  it('rejects invalid grade/limit arguments with -32602', async () => {
    const badGrade = await rpc(app(), {
      jsonrpc: '2.0',
      id: 19,
      method: 'tools/call',
      params: { name: 'search_sites', arguments: { grade: 'Z' } },
    });
    assert.equal(badGrade.error.code, -32602);

    const badLimit = await rpc(app(), {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'search_sites', arguments: { limit: 'many' } },
    });
    assert.equal(badLimit.error.code, -32602);
  });
});

describe('POST /mcp — tools/call dispatch errors', () => {
  it('maps unknown tool names to -32602 invalid params', async () => {
    const body = await rpc(app(), {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'no_such_tool', arguments: {} },
    });
    assert.equal(body.error.code, -32602);
    assert.ok(body.error.message.includes('no_such_tool'));
  });

  it('maps missing tools/call params to -32602', async () => {
    const body = await rpc(app(), { jsonrpc: '2.0', id: 22, method: 'tools/call' });
    assert.equal(body.error.code, -32602);
  });
});

describe('POST /mcp — tools/call grade_distribution', () => {
  it('returns totals, per-grade counts and the pending count', async () => {
    const body = await rpc(app(), {
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: { name: 'grade_distribution', arguments: {} },
    });
    assert.equal(body.result.isError, false);
    const stats = JSON.parse(body.result.content[0].text);
    assert.deepEqual(stats, {
      total: 5,
      verified: 1,
      pending: 1,
      avg_score: 58.8,
      grades: { A: 1, B: 1, C: 1, D: 0, F: 1 },
    });
  });
});

describe('POST /mcp — rate limiting', () => {
  it('limits requests per IP and answers 429 with Retry-After when spent', async () => {
    const limiter = new RateLimiter(memoryStore(), 2, MCP_RATE_WINDOW_MS, 'mcp-test');
    const target = createApp({ db: openSeededDb().db, mcpLimit: limiter });
    const message = { jsonrpc: '2.0', id: 30, method: 'ping' };

    assert.equal((await post(target, message)).status, 200);
    assert.equal((await post(target, message)).status, 200);

    const rejected = await post(target, message);
    assert.equal(rejected.status, 429);
    assert.equal(rejected.headers.get('cache-control'), 'no-store');
    assert.ok(Number(rejected.headers.get('retry-after')) >= 1);
    const body = await rejected.json();
    assert.equal(body.error, 'rate_limited');
    assert.ok(body.retryAfter >= 1);
  });
});
