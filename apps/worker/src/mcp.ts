// src/mcp.ts — Model Context Protocol (MCP) server endpoint for aiapp.im.
//
// Transport: plain stateless JSON-RPC 2.0 over HTTP — one request body in, one
// JSON-RPC response out. There are no SSE streams and no session state; that
// transport note ships in the `instructions` field of the initialize result so
// assistants discover it together with the tools. All three tools are
// read-only and read the same D1 data as the public /api/v1 directory API
// (/sites, /stats, /leaderboard) through the shared src/db.ts helpers.

import { normalizeDomain } from './domain.ts';
import type { Db, Row, SqlParam } from './db.ts';

// ---------------------------------------------------------------------------
// Protocol / server constants
// ---------------------------------------------------------------------------

/** Protocol version returned when the client's offer cannot be echoed. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Versions a client may offer that this server also understands. */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

/** serverInfo name/version advertised on initialize. */
export const MCP_SERVER_INFO = { name: 'aiapp', version: '1.0.0' } as const;

/** POST /mcp budget: requests per IP per minute. */
export const MCP_RATE_LIMIT = 60;
export const MCP_RATE_WINDOW_MS = 60_000;

/** search_sites bounds: default page size and hard clamp. */
export const MCP_SEARCH_DEFAULT_LIMIT = 10;
export const MCP_SEARCH_MAX_LIMIT = 25;

/** Grades the directory rates (Pending/Declined are scan states, not grades). */
export const MCP_GRADES: readonly string[] = ['A', 'B', 'C', 'D', 'F'];

/** JSON-RPC 2.0 error codes used by this endpoint. */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;

/** Initialize `instructions`: the declared, discoverable surface of the server. */
export const MCP_INSTRUCTIONS =
  'aiapp.im is a public directory of AI-friendliness ratings for websites; every rating comes ' +
  'from public, reproducible scans (the AFR standard) and is served read-only here. Transport: ' +
  'stateless JSON-RPC 2.0 over HTTP at POST /mcp — no SSE streams and no session state. Tools: ' +
  'site_rating returns the grade, score, strategy tag, last scan time and view count for one ' +
  'domain; search_sites returns graded sites (A–F) ranked by score with optional keyword and ' +
  'grade filters; grade_distribution returns directory totals, per-grade counts and the number ' +
  'of pending sites. Start with search_sites or grade_distribution, then call site_rating for ' +
  'a specific domain.';

// ---------------------------------------------------------------------------
// Tool catalog (tools/list)
// ---------------------------------------------------------------------------

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: readonly McpTool[] = [
  {
    name: 'site_rating',
    description:
      'Look up the aiapp.im AI-friendliness rating for a single domain: grade, AFR score, ' +
      'strategy tag, last scan time and page views. The values are public, reproducible scan ' +
      'results; an unknown domain is reported as a tool error, not a protocol error.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Bare domain to look up, e.g. "example.com" (a full URL is accepted too).',
        },
      },
      required: ['domain'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_sites',
    description:
      'Search the aiapp.im directory of AI-friendliness ratings and get graded sites (A–F) ' +
      'ranked by score descending. Only public, reproducible scan results are returned — ' +
      'pending (unscanned) sites are excluded.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional keyword matched case-insensitively against domain and title.',
        },
        grade: {
          type: 'string',
          enum: [...MCP_GRADES],
          description: 'Optional grade filter.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MCP_SEARCH_MAX_LIMIT,
          default: MCP_SEARCH_DEFAULT_LIMIT,
          description: `How many results to return (default ${MCP_SEARCH_DEFAULT_LIMIT}, max ${MCP_SEARCH_MAX_LIMIT}).`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'grade_distribution',
    description:
      'Get directory-wide totals for aiapp.im: overall site count, verified count, pending ' +
      '(unscanned) count, average score and per-grade counts A–F. Derived from the same public, ' +
      'reproducible scan results as every published rating.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Protocol-level failure: reported as a JSON-RPC error object. */
class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Tool-level failure: MCP reports tool failures as results, not protocol errors. */
class ToolFailure extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON-RPC ids are strings, numbers or null (floats/objects/booleans are invalid). */
function isId(value: unknown): value is string | number | null {
  if (value === null || typeof value === 'string') return true;
  return typeof value === 'number' && Number.isFinite(value);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Resolve a tool argument to a bare lowercase domain. Bare domains go through
 * normalizeDomain; assistant-friendly inputs (full URL, mixed case, trailing
 * path) fall back to the URL host before the lookup is declared a miss. */
function resolveDomain(raw: string): string | null {
  const bare = normalizeDomain(raw);
  if (bare) return bare;
  try {
    const host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
    return normalizeDomain(host);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tool implementations (read-only D1 reads)
// ---------------------------------------------------------------------------

interface RatingRow extends Row {
  domain: string;
  grade: string | null;
  score_total: number | null;
  strategy_tag: string | null;
  scanned_at: string | null;
}

interface SearchRow extends Row {
  domain: string;
  grade: string | null;
  score_total: number | null;
  strategy_tag: string | null;
}

interface StatsTotals extends Row {
  total: number;
  verified: number | null;
  pending: number | null;
  avg_score: number | null;
}

/** site_rating — the site record behind GET /api/v1/sites/:domain, camelCased
 * for the tool surface, with the same best-effort view counter. */
async function toolSiteRating(db: Db, args: Record<string, unknown>): Promise<unknown> {
  if (typeof args.domain !== 'string') {
    throw new RpcError(JSONRPC_INVALID_PARAMS, 'domain must be a string');
  }
  const domain = resolveDomain(args.domain);
  if (!domain) throw new ToolFailure('site not found');
  const site = await db
    .prepare(
      `SELECT s.*, c.slug AS category_slug FROM sites s
       LEFT JOIN categories c ON c.id = s.category_id WHERE s.domain = ?`,
    )
    .get<RatingRow>(domain);
  if (!site) throw new ToolFailure('site not found');

  let views = 0;
  try {
    const pv = await db
      .prepare('SELECT views FROM page_views WHERE domain = ?')
      .get<{ views: number }>(domain);
    views = pv?.views ?? 0;
  } catch {
    views = 0; // counter table absent — same fallback as the detail endpoint
  }

  return {
    domain: site.domain,
    grade: site.grade ?? null,
    score: site.score_total ?? null,
    strategyTag: site.strategy_tag ?? null,
    scannedAt: site.scanned_at ?? null,
    views,
  };
}

/** search_sites — ranked directory slice (same WHERE/ORDER as GET /api/v1/sites
 * with sort=score: active, graded, non-null score, score DESC then domain). */
async function toolSearchSites(db: Db, args: Record<string, unknown>): Promise<unknown> {
  const queryArg = args.query;
  if (queryArg !== undefined && queryArg !== null && typeof queryArg !== 'string') {
    throw new RpcError(JSONRPC_INVALID_PARAMS, 'query must be a string');
  }
  const gradeArg = args.grade;
  if (
    gradeArg !== undefined &&
    gradeArg !== null &&
    (typeof gradeArg !== 'string' || !MCP_GRADES.includes(gradeArg))
  ) {
    throw new RpcError(JSONRPC_INVALID_PARAMS, `grade must be one of ${MCP_GRADES.join(', ')}`);
  }
  const limitArg = args.limit;
  if (
    limitArg !== undefined &&
    limitArg !== null &&
    (typeof limitArg !== 'number' || !Number.isFinite(limitArg))
  ) {
    throw new RpcError(JSONRPC_INVALID_PARAMS, 'limit must be a number');
  }

  const query = typeof queryArg === 'string' ? queryArg.trim() : '';
  const grade = typeof gradeArg === 'string' ? gradeArg : '';
  let limit = MCP_SEARCH_DEFAULT_LIMIT;
  if (typeof limitArg === 'number' && Number.isFinite(limitArg)) {
    limit = Math.min(MCP_SEARCH_MAX_LIMIT, Math.max(1, Math.floor(limitArg)));
  }

  const where: string[] = [
    "s.status = 'active'",
    's.grade IS NOT NULL',
    "s.grade != 'Pending'",
    's.score_total IS NOT NULL',
  ];
  const params: SqlParam[] = [];
  if (query) {
    const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    where.push("(s.domain LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  if (grade) {
    where.push('s.grade = ?');
    params.push(grade);
  }

  const rows = await db
    .prepare(
      `SELECT s.domain, s.grade, s.score_total, s.strategy_tag FROM sites s
       WHERE ${where.join(' AND ')}
       ORDER BY s.score_total DESC, s.domain ASC LIMIT ?`,
    )
    .all<SearchRow>(...params, limit);

  return rows.map((row) => ({
    domain: row.domain,
    grade: row.grade,
    score: row.score_total,
    strategyTag: row.strategy_tag,
  }));
}

/** grade_distribution — the same aggregates as GET /api/v1/stats. */
async function toolGradeDistribution(db: Db): Promise<unknown> {
  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS verified,
              SUM(CASE WHEN grade = 'Pending' THEN 1 ELSE 0 END) AS pending,
              AVG(CASE WHEN grade != 'Pending' THEN score_total END) AS avg_score
       FROM sites WHERE status = 'active'`,
    )
    .get<StatsTotals>();
  const gradeRows = await db
    .prepare(
      `SELECT grade, COUNT(*) AS n FROM sites
       WHERE status = 'active' AND grade IS NOT NULL GROUP BY grade`,
    )
    .all<{ grade: string; n: number }>();

  const grades: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const row of gradeRows) if (row.grade in grades) grades[row.grade] = row.n;

  const avg = totals?.avg_score;
  return {
    total: totals?.total ?? 0,
    verified: totals?.verified ?? 0,
    pending: totals?.pending ?? 0,
    avg_score: avg === null || avg === undefined ? null : Math.round(avg * 10) / 10,
    grades,
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

function initializeResult(params: unknown): Record<string, unknown> {
  if (!isPlainObject(params)) {
    throw new RpcError(JSONRPC_INVALID_PARAMS, 'params must be an object');
  }
  const requested = params.protocolVersion;
  if (requested !== undefined && requested !== null && typeof requested !== 'string') {
    throw new RpcError(JSONRPC_INVALID_PARAMS, 'protocolVersion must be a string');
  }
  const protocolVersion =
    typeof requested === 'string' && MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : MCP_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    // `instructions` is the MCP-defined location; it is mirrored inside
    // serverInfo so the declared surface is discoverable from either field.
    serverInfo: { ...MCP_SERVER_INFO, instructions: MCP_INSTRUCTIONS },
    instructions: MCP_INSTRUCTIONS,
  };
}

/** Validate and run tools/call; tool failures become isError results. */
async function callTool(db: Db, params: unknown): Promise<Record<string, unknown>> {
  if (!isPlainObject(params)) {
    throw new RpcError(JSONRPC_INVALID_PARAMS, 'params must be an object');
  }
  const name = params.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new RpcError(JSONRPC_INVALID_PARAMS, 'params.name must be a non-empty string');
  }
  const rawArgs = params.arguments;
  if (rawArgs !== undefined && rawArgs !== null && !isPlainObject(rawArgs)) {
    throw new RpcError(JSONRPC_INVALID_PARAMS, 'params.arguments must be an object');
  }
  const args: Record<string, unknown> = isPlainObject(rawArgs) ? rawArgs : {};

  try {
    let payload: unknown;
    switch (name) {
      case 'site_rating':
        payload = await toolSiteRating(db, args);
        break;
      case 'search_sites':
        payload = await toolSearchSites(db, args);
        break;
      case 'grade_distribution':
        payload = await toolGradeDistribution(db);
        break;
      default:
        throw new RpcError(JSONRPC_INVALID_PARAMS, `Tool not found: ${name}`);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      isError: false,
    };
  } catch (err) {
    if (err instanceof ToolFailure) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    throw err;
  }
}

async function dispatch(
  db: Db,
  id: unknown,
  method: string,
  params: unknown,
): Promise<Record<string, unknown>> {
  switch (method) {
    case 'initialize':
      return rpcResult(id, initializeResult(params));
    case 'tools/list':
      if (params !== undefined && params !== null && !isPlainObject(params)) {
        throw new RpcError(JSONRPC_INVALID_PARAMS, 'params must be an object');
      }
      return rpcResult(id, { tools: MCP_TOOLS });
    case 'tools/call':
      return rpcResult(id, await callTool(db, params));
    case 'ping':
      if (params !== undefined && params !== null && !isPlainObject(params)) {
        throw new RpcError(JSONRPC_INVALID_PARAMS, 'params must be an object');
      }
      return rpcResult(id, {});
    default:
      return rpcError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP entry point (wired to POST /mcp in src/index.ts)
// ---------------------------------------------------------------------------

export interface McpHttpRequest {
  /** Raw POST body */
  rawBody: string;
  /** Database backing the read-only tools */
  db: Db;
}

/** 200 → JSON-RPC response; 400 → transport-level JSON-RPC error (parse /
 * invalid request); 202 → notification: accepted, no response body. */
export type McpHttpResponse =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400; body: Record<string, unknown> }
  | { status: 202; body: null };

export async function handleMcpRequest(request: McpHttpRequest): Promise<McpHttpResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.rawBody);
  } catch {
    return { status: 400, body: rpcError(null, JSONRPC_PARSE_ERROR, 'Parse error') };
  }
  if (!isPlainObject(parsed)) {
    return { status: 400, body: rpcError(null, JSONRPC_INVALID_REQUEST, 'Invalid Request') };
  }
  if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
    const id = isId(parsed.id) ? parsed.id : null;
    return { status: 400, body: rpcError(id, JSONRPC_INVALID_REQUEST, 'Invalid Request') };
  }

  const method = parsed.method;
  // MCP notifications (initialized, cancelled, …) never get a response.
  if (method.startsWith('notifications/')) return { status: 202, body: null };
  const hasId = Object.prototype.hasOwnProperty.call(parsed, 'id');
  if (!hasId) return { status: 202, body: null }; // any other JSON-RPC notification
  const id = parsed.id;
  if (!isId(id)) return { status: 400, body: rpcError(null, JSONRPC_INVALID_REQUEST, 'Invalid Request') };

  try {
    return { status: 200, body: await dispatch(request.db, id, method, parsed.params) };
  } catch (err) {
    if (err instanceof RpcError) return { status: 200, body: rpcError(id, err.code, err.message) };
    throw err;
  }
}
