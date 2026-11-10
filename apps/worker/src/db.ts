// src/db.ts — thin database abstraction (zero business logic).
//
// One interface, two adapters:
//   - createD1Db(d1)     → Cloudflare D1 in production (bound as `DB` in wrangler.toml)
//   - createSqliteDb(h)  → node:sqlite DatabaseSync in tests (test/*.test.ts)
//
// `node:sqlite` is deliberately NOT imported here: this module is bundled into
// the Worker, and Node builtins must not leak into the worker graph. Tests build
// `new DatabaseSync(':memory:')` themselves and pass the handle in. On our Node 22
// node:sqlite loads without a flag (an ExperimentalWarning is printed).

/** Values accepted by both adapters for `?` placeholders */
export type SqlParam = string | number | null;

export type Row = Record<string, unknown>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** Prepared statement — async on both adapters (node:sqlite results are wrapped in promises) */
export interface Prepared {
  all<T = Row>(...params: SqlParam[]): Promise<T[]>;
  get<T = Row>(...params: SqlParam[]): Promise<T | undefined>;
  run(...params: SqlParam[]): Promise<RunResult>;
}

export interface Db {
  prepare(sql: string): Prepared;
  /** Run one or more statements (schema.sql in tests) */
  exec(sql: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// D1 adapter (production)
// ---------------------------------------------------------------------------

/** Structural view of D1PreparedStatement — satisfied by Cloudflare's D1Database */
export interface D1StatementLike {
  bind(...values: SqlParam[]): D1StatementLike;
  all<T = Row>(): Promise<{ results: T[] }>;
  first<T = Row>(): Promise<T | null>;
  run(): Promise<{ meta?: { last_row_id?: number }; changes?: number }>;
}

/** Structural view of D1Database — satisfied by the `DB` binding */
export interface D1Like {
  prepare(sql: string): D1StatementLike;
  /** Multi-statement execution (D1 exposes `exec` for raw SQL batches) */
  exec(sql: string): Promise<unknown>;
}

export function createD1Db(d1: D1Like): Db {
  return {
    prepare(sql: string): Prepared {
      return {
        async all<T = Row>(...params: SqlParam[]): Promise<T[]> {
          const res = await d1.prepare(sql).bind(...params).all<T>();
          return res.results;
        },
        async get<T = Row>(...params: SqlParam[]): Promise<T | undefined> {
          const row = await d1.prepare(sql).bind(...params).first<T>();
          return row ?? undefined;
        },
        async run(...params: SqlParam[]): Promise<RunResult> {
          const res = await d1.prepare(sql).bind(...params).run();
          return {
            changes: res.changes ?? 0,
            lastInsertRowid: Number(res.meta?.last_row_id ?? 0),
          };
        },
      };
    },
    async exec(sql: string): Promise<void> {
      await d1.exec(sql);
    },
  };
}

// ---------------------------------------------------------------------------
// node:sqlite adapter (tests)
// ---------------------------------------------------------------------------

/** Structural view of a node:sqlite prepared statement (sync API) */
export interface SqliteStatementLike {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

/** Structural view of node:sqlite DatabaseSync */
export interface SqliteHandleLike {
  prepare(sql: string): SqliteStatementLike;
  exec(sql: string): void;
}

export function createSqliteDb(handle: SqliteHandleLike): Db {
  return {
    prepare(sql: string): Prepared {
      const stmt = handle.prepare(sql);
      return {
        async all<T = Row>(...params: SqlParam[]): Promise<T[]> {
          return stmt.all(...params) as T[];
        },
        async get<T = Row>(...params: SqlParam[]): Promise<T | undefined> {
          return stmt.get(...params) as T | undefined;
        },
        async run(...params: SqlParam[]): Promise<RunResult> {
          const res = stmt.run(...params);
          return {
            changes: Number(res.changes),
            lastInsertRowid: Number(res.lastInsertRowid),
          };
        },
      };
    },
    async exec(sql: string): Promise<void> {
      handle.exec(sql);
    },
  };
}
