import {assertNoDefaultMemoryAccess} from '../../memory/encryption/execution-context.js';
/**
 * PostgreSQL pool, query helpers and transactions (B2.2a).
 *
 * Pool: created lazily from readPgConfig() (AGENT_PLAYER_DB=postgres +
 * AGENT_PLAYER_PG_URL), with the result type parsers of types.ts and
 * TimeZone=UTC on every session. Connection fields are passed one by one
 * (never the URL), so what config.ts checked is exactly what is used.
 *
 * Query helpers take SQLite-style `?` placeholders (placeholders.ts) and
 * return the shapes better-sqlite3 returns: all() rows, one() first row or
 * undefined, run() { changes, lastInsertRowid? }.
 *
 * Transactions: withPgTransaction(fn) takes one client from the pool, runs
 * BEGIN, fn, COMMIT (ROLLBACK on a throw/rejection) and releases the client.
 * Every helper called inside fn (at any await depth) uses that client: the
 * transaction travels in an AsyncLocalStorage, so repositories need no
 * client parameter. A nested withPgTransaction reuses the outer client with a
 * SAVEPOINT: an inner failure rolls back only the inner work, and the outer
 * transaction can catch it and go on. That is what better-sqlite3 does for a
 * nested db.transaction(), so both drivers behave the same. Work inside one
 * transaction must be sequential: starting two nested transactions at the
 * same time on one client is refused, and a query that runs after its
 * transaction ended is refused too (it would otherwise run on a released
 * client).
 */

import type pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readPgConfig, PgConfigError, type PgConfig } from './config.js';
import { makePgTypes, type FallbackTypeParser } from './types.js';
import { convertPlaceholders, PlaceholderError } from './placeholders.js';
import { runResult, type RunResult } from './dialect.js';

export type Param = string | number | bigint | boolean | null | undefined | Buffer | Date;

export class PgTransactionError extends Error {}

let pool: Promise<pg.Pool> | null = null;

type PgModule = typeof import('pg');
let pgModule: Promise<PgModule> | null = null;

/**
 * The 'pg' package, loaded on first use only. SQLite mode never calls this,
 * so the app loads and runs without pg installed (no static runtime import
 * of 'pg' anywhere reachable from the app; see test/pg-lazy-import.test.mjs).
 */
export function loadPg(): Promise<PgModule> {
  if (!pgModule) {
    pgModule = import('pg').then((m) => ((m as unknown as { default?: PgModule }).default ?? m) as PgModule);
    pgModule.catch(() => { pgModule = null; });
  }
  return pgModule;
}

/** A pool for `cfg` (the caller owns it and must end() it). */
export async function createPgPool(cfg: PgConfig): Promise<pg.Pool> {
  const pgm = await loadPg();
  const p = new pgm.Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    max: cfg.max,
    types: makePgTypes(pgm.types.getTypeParser as unknown as FallbackTypeParser),
    options: '-c TimeZone=UTC',
    application_name: 'agent-player',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle client can fail (server restart); without a listener the process dies.
  p.on('error', (err) => console.error('[pg] idle client error:', (err as { code?: string })?.code ?? 'unknown'));
  return p;
}

/** The process pool (AGENT_PLAYER_DB=postgres only); created once, on first use. */
export function getPgPool(): Promise<pg.Pool> {
  assertNoDefaultMemoryAccess();
  if (!pool) {
    const cfg = readPgConfig();
    if (!cfg) return Promise.reject(new PgConfigError('PostgreSQL is not configured (AGENT_PLAYER_DB=postgres)'));
    pool = createPgPool(cfg);
    pool.catch(() => { pool = null; });
  }
  return pool;
}

/** Use `p` as the process pool (tests, the migration CLI). */
export function setPgPool(p: pg.Pool | null): void {
  pool = p ? Promise.resolve(p) : null;
}

export async function closePgPool(): Promise<void> {
  const p = pool;
  pool = null;
  const real = p ? await p.catch(() => null) : null;
  if (real) await real.end();
}

// ---------------------------------------------------------------------------
// Transaction context
// ---------------------------------------------------------------------------

interface TxShared {
  client: pg.PoolClient;
  /** Open savepoints, innermost last. */
  stack: string[];
  seq: number;
  closed: boolean;
}

interface TxFrame {
  shared: TxShared;
  /** Savepoint this frame runs in (null = the outer transaction). */
  savepoint: string | null;
  /**
   * afterPgCommit() callbacks registered in this frame. A released savepoint
   * hands its list to the enclosing frame; a rolled-back one drops it; the
   * outer transaction runs its list once COMMIT succeeded.
   */
  afterCommit: Array<() => unknown>;
}

const txStore = new AsyncLocalStorage<TxFrame>();

/** True inside withPgTransaction. */
export function inPgTransaction(): boolean {
  const f = txStore.getStore();
  return !!f && !f.shared.closed;
}

/**
 * Run `fn` outside any open transaction: its queries use the pool, not the
 * caller's transaction client. For detached work (fire-and-forget audit
 * rows, B2.2b) that may still be running when the caller's transaction ends.
 */
export function outsidePgTransaction<T>(fn: () => T): T {
  return txStore.exit(fn);
}

/**
 * Run `fn` once the work so far is committed: right away outside a
 * transaction, otherwise after the outermost COMMIT succeeds (never when the
 * transaction, or the savepoint `fn` was registered in, rolls back). For side
 * effects outside the database that must follow committed state only (FU-05:
 * credential JSON backups). `fn` runs outside the transaction; an error it
 * throws is logged and does not undo the commit.
 */
export async function afterPgCommit(fn: () => unknown): Promise<void> {
  const f = txStore.getStore();
  if (f && !f.shared.closed) {
    f.afterCommit.push(fn);
    return;
  }
  await runAfterCommit([fn]);
}

async function runAfterCommit(hooks: Array<() => unknown>): Promise<void> {
  for (const hook of hooks) {
    try {
      await txStore.exit(hook);
    } catch (err) {
      console.error('[pg] after-commit action failed:', (err as Error)?.message ?? 'unknown error');
    }
  }
}

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

function target(): Queryable | Promise<Queryable> {
  assertNoDefaultMemoryAccess();
  const f = txStore.getStore();
  if (!f) return getPgPool();
  if (f.shared.closed) throw new PgTransactionError('query after its transaction ended (missing await inside withTransaction?)');
  return f.shared.client;
}

const sqlCache = new Map<string, { text: string; count: number }>();

function prepare(sql: string, params: readonly Param[]): { text: string; values: unknown[] } {
  let c = sqlCache.get(sql);
  if (!c) {
    c = convertPlaceholders(sql);
    if (sqlCache.size < 2000) sqlCache.set(sql, c);
  }
  if (c.count !== params.length) {
    throw new PlaceholderError(`SQL needs ${c.count} parameter(s), got ${params.length}`);
  }
  return { text: c.text, values: params.map((v) => (v === undefined ? null : v)) };
}

async function query(sql: string, params: readonly Param[]): Promise<pg.QueryResult> {
  assertNoDefaultMemoryAccess();
  const { text, values } = prepare(sql, params);
  return (await target()).query(text, values);
}

/** All rows (better-sqlite3 .all()). */
export async function pgAll<T = Record<string, unknown>>(sql: string, ...params: Param[]): Promise<T[]> {
  return (await query(sql, params)).rows as T[];
}

/** First row or undefined (better-sqlite3 .get()). */
export async function pgOne<T = Record<string, unknown>>(sql: string, ...params: Param[]): Promise<T | undefined> {
  return (await query(sql, params)).rows[0] as T | undefined;
}

/** INSERT/UPDATE/DELETE: { changes } (better-sqlite3 .run()). */
export async function pgRun(sql: string, ...params: Param[]): Promise<RunResult> {
  return runResult(await query(sql, params));
}

/**
 * INSERT ... RETURNING <idColumn>: { changes, lastInsertRowid }. The SQL must
 * carry the RETURNING clause itself (dialect.returningId()).
 */
export async function pgInsert(sql: string, idColumn: string, ...params: Param[]): Promise<RunResult> {
  if (!/\bRETURNING\b/i.test(sql)) throw new PgTransactionError('pgInsert: SQL needs RETURNING (use returningId())');
  return runResult(await query(sql, params), idColumn);
}

/** Several statements without parameters (better-sqlite3 .exec()). */
export async function pgExec(sql: string): Promise<void> {
  await (await target()).query(sql);
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

async function inSavepoint<T>(outer: TxFrame, fn: () => T | Promise<T>): Promise<Awaited<T>> {
  const s = outer.shared;
  const top = s.stack.length ? s.stack[s.stack.length - 1] : null;
  if (top !== outer.savepoint) {
    throw new PgTransactionError('nested transactions inside one transaction must run one after another, not at the same time');
  }
  const name = `ap_sp_${++s.seq}`;
  // Claimed before the first await, so a concurrent sibling sees it and is refused.
  s.stack.push(name);
  const sq = (sql: string) => {
    if (s.closed) throw new PgTransactionError('savepoint after its transaction ended');
    return s.client.query(sql);
  };
  try {
    await sq(`SAVEPOINT ${name}`);
    try {
      const frame: TxFrame = { shared: s, savepoint: name, afterCommit: [] };
      const out = await txStore.run(frame, fn);
      await sq(`RELEASE SAVEPOINT ${name}`);
      outer.afterCommit.push(...frame.afterCommit);
      return out;
    } catch (err) {
      try {
        await sq(`ROLLBACK TO SAVEPOINT ${name}`);
        await sq(`RELEASE SAVEPOINT ${name}`);
      } catch {
        // The outer transaction is unusable now; its COMMIT is refused and it rolls back.
      }
      throw err;
    }
  } finally {
    s.stack.pop();
  }
}

/**
 * Run `fn` in one transaction (see the header). Resolves with fn's result;
 * a throw or rejection rolls back and rethrows the original error.
 */
export async function withPgTransaction<T>(fn: () => T | Promise<T>): Promise<Awaited<T>> {
  const outer = txStore.getStore();
  if (outer && !outer.shared.closed) return inSavepoint(outer, fn);

  const client = await (await getPgPool()).connect();
  const shared: TxShared = { client, stack: [], seq: 0, closed: false };
  const root: TxFrame = { shared, savepoint: null, afterCommit: [] };
  let discard = false;
  let out: Awaited<T>;
  try {
    await client.query('BEGIN');
    out = await txStore.run(root, fn);
    // Closed BEFORE COMMIT is queued: work still running from fn (not awaited)
    // is refused from here on. Queries queued earlier run first (the client
    // runs them in order), so nothing lands on the client after release.
    shared.closed = true;
    const done = await client.query('COMMIT');
    // COMMIT of an aborted transaction (a statement failed and fn caught the
    // error) answers ROLLBACK without raising: never report that as success.
    if (done.command !== 'COMMIT') {
      throw new PgTransactionError('transaction was aborted by an earlier error and has been rolled back');
    }
  } catch (err) {
    shared.closed = true; // as above, before ROLLBACK is queued
    // Also after a failed BEGIN/COMMIT (then ROLLBACK is a harmless no-op).
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true; // connection state unknown: do not return it to the pool
    }
    throw err;
  } finally {
    shared.closed = true;
    client.release(discard ? true : undefined);
  }
  // Committed: run the after-commit actions (the client is already released).
  await runAfterCommit(root.afterCommit);
  return out;
}
