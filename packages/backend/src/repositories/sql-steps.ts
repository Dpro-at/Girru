import {deviceSqlBefore,deviceSqlAfter} from '../devices/storage.js';
/**
 * SQL steps (B2.2b-3): one copy of a module's database logic for both
 * drivers, including multi-statement transactions.
 *
 * Why generators: a better-sqlite3 transaction must run synchronously (work
 * after an `await` would land outside it), a PostgreSQL transaction is
 * async. A step is a generator that yields its queries:
 *
 *   function* approve(id: string): Step<number> {
 *     const d = yield* dialect();
 *     const row = yield* one<{ n: number }>(`SELECT ... WHERE id = ?${forUpdate(d)}`, id);
 *     yield* run('UPDATE ... WHERE id = ?', id);
 *     return row?.n ?? 0;
 *   }
 *
 * and a driver runs it:
 *
 *   SQLite      every query synchronously; `tx` inside better-sqlite3's
 *               db.transaction (SAVEPOINT when nested), so the transaction
 *               stays synchronous and nothing else can interleave.
 *   PostgreSQL  every query awaited; `tx` inside withPgTransaction (the
 *               AsyncLocalStorage client, SAVEPOINT when nested).
 *
 * A step composes others with `yield*` (they join the same transaction), may
 * do synchronous non-database work (validation, hashing, a sync file write
 * that must roll the transaction back when it throws), and catches query
 * errors with try/catch as usual (a failed statement is thrown into the
 * generator). It never awaits: async work (encryption, the network) is done
 * before or after the step.
 *
 * Inside a step, `yield* atomic(() => body)` runs `body` in a transaction
 * (a SAVEPOINT when one is open).
 *
 * Callers use `sql()` (the runner for the process driver, dbDriver()):
 *   await sql().read(step)     one step; no transaction of its own (on
 *                              PostgreSQL it joins an open withTransaction)
 *   await sql().tx(() => step) one transaction (all or nothing)
 *   sqliteSync(step)           SQLite only: the result right away (for the
 *                              few synchronous callers that remain on SQLite,
 *                              e.g. createToolsRegistry); throws on PostgreSQL
 */

import type Database from 'better-sqlite3';
import type { Dialect } from '../db/pg/dialect.js';
import { getDatabase } from '../db/index.js';
import { dbDriver } from '../db/pg/config.js';
import { pgAll, pgOne, pgRun, withPgTransaction } from '../db/pg/pool.js';

/** A bound value; Buffer = BLOB on SQLite, bytea on PostgreSQL. */
export type SqlParam = string | number | null | Buffer;

type Op =
  | { kind: 'one' | 'all' | 'run'; sql: string; params: SqlParam[] }
  | { kind: 'dialect' }
  | { kind: 'tx'; body: () => Step<unknown> };

/** A unit of database work that yields its queries (see the header). */
export type Step<T> = Generator<Op, T, unknown>;

/** First row or undefined (better-sqlite3 .get()). */
export function* one<T = any>(sql: string, ...params: SqlParam[]): Step<T | undefined> {
  return (yield { kind: 'one', sql, params }) as T | undefined;
}

/** All rows (better-sqlite3 .all()). */
export function* all<T = any>(sql: string, ...params: SqlParam[]): Step<T[]> {
  return (yield { kind: 'all', sql, params }) as T[];
}

/** INSERT / UPDATE / DELETE: { changes } (better-sqlite3 .run(), PostgreSQL rowCount). */
export function* run(sql: string, ...params: SqlParam[]): Step<{ changes: number }> {
  return (yield { kind: 'run', sql, params }) as { changes: number };
}

/** The dialect of the driver that runs this step (for the db/pg/dialect.ts helpers). */
export function* dialect(): Step<Dialect> {
  return (yield { kind: 'dialect' }) as Dialect;
}

/**
 * Run `body` atomically inside a step: its own transaction when none is
 * open, else a SAVEPOINT (a throw rolls back only `body`'s work, and the
 * caller may catch it and go on).
 */
export function* atomic<T>(body: () => Step<T>): Step<T> {
  return (yield { kind: 'tx', body }) as T;
}

/**
 * A transaction-scoped lock on a name (B2.2b-4): PostgreSQL
 * pg_advisory_xact_lock on a 64-bit hash of `name`, held until the
 * transaction ends, so check-then-write sequences on the same name (a
 * memory's next version, a drawer's next revision) run one after another.
 * SQLite: nothing to do (one connection; a write transaction already holds
 * the database lock). Only meaningful inside `tx` / `atomic`.
 */
export function* lockName(name: string): Step<void> {
  const d = yield* dialect();
  if (d === 'postgres') yield* one('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', name);
}

/** True when the table exists (sqlite_master / information_schema of the current schema). */
export function* tableExists(name: string): Step<boolean> {
  const d = yield* dialect();
  return !!(yield* one(d === 'postgres'
    ? `SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?`
    : `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`, name));
}

/** True when the table has the column (pragma_table_info / information_schema). */
export function* columnExists(table: string, column: string): Step<boolean> {
  const d = yield* dialect();
  return !!(yield* one(d === 'postgres'
    ? `SELECT 1 AS ok FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?`
    : `SELECT 1 AS ok FROM pragma_table_info(?) WHERE name = ?`, table, column));
}

/**
 * B2.2c: user table names of the current database, sorted by name
 * (sqlite_master without the sqlite_* tables / information_schema base
 * tables of the current schema). With `likePrefix`: only names matching
 * LIKE likePrefix || '_%' (SQLite LIKE ignores ASCII case; ILIKE on
 * PostgreSQL gives the same match).
 */
export function* tableNames(likePrefix?: string): Step<string[]> {
  const d = yield* dialect();
  const rows = d === 'postgres'
    ? (likePrefix === undefined
      ? yield* all<{ name: string }>(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`)
      : yield* all<{ name: string }>(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name ILIKE ? || '_%' ORDER BY table_name`, likePrefix))
    : (likePrefix === undefined
      ? yield* all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      : yield* all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? || '_%'`, likePrefix));
  return rows.map((r) => r.name);
}

/** B2.2c: the column names of a table, in table order (pragma_table_info / information_schema). */
export function* tableColumns(table: string): Step<string[]> {
  const d = yield* dialect();
  const rows = d === 'postgres'
    ? yield* all<{ name: string }>(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position`, table)
    : yield* all<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, table);
  return rows.map((r) => r.name);
}

export interface StepRunner {
  readonly dialect: Dialect;
  /** Run one step without a transaction of its own. */
  read<T>(step: Step<T>): Promise<T>;
  /**
   * Run a step in one transaction; a throw rolls everything back. Nested
   * (inside another tx or an open withTransaction): a SAVEPOINT.
   * `immediate` (SQLite): BEGIN IMMEDIATE, the write lock is taken first.
   */
  tx<T>(body: () => Step<T>, opts?: { immediate?: boolean }): Promise<T>;
}

/**
 * The SQLite database a runner works on: the main database (getDatabase())
 * or, for the stores that keep their own SQLite file (webhooks), that file.
 */
interface SqliteHandle {
  prepare(sql: string): Database.Statement;
  getDb(): Database.Database;
}

const mainSqlite = (): SqliteHandle => getDatabase();

function sqliteOp(op: Op, h: SqliteHandle): unknown {
  if (op.kind === 'dialect') return 'sqlite';
  if (op.kind === 'tx') return h.getDb().transaction(() => driveSync(op.body(), h))();
  const prepared=deviceSqlBefore(op);const stmt=h.prepare(prepared.sql);
  if(op.kind==='one')return deviceSqlAfter(op,stmt.get(...prepared.params));
  if(op.kind==='all')return deviceSqlAfter(op,stmt.all(...prepared.params));
  return {changes:stmt.run(...prepared.params).changes};
}

async function pgOp(op: Op): Promise<unknown> {
  if (op.kind === 'dialect') return 'postgres';
  if (op.kind === 'tx') return withPgTransaction(() => driveAsync(op.body()));
  const prepared=deviceSqlBefore(op);
  if(op.kind==='one')return deviceSqlAfter(op,await pgOne(prepared.sql,...prepared.params));
  if(op.kind==='all')return deviceSqlAfter(op,await pgAll(prepared.sql,...prepared.params));
  return {changes:(await pgRun(prepared.sql,...prepared.params)).changes};
}

/** Drive a step synchronously on SQLite. */
function driveSync<T>(step: Step<T>, h: SqliteHandle = mainSqlite()): T {
  let r = step.next();
  while (!r.done) {
    let value: unknown;
    try {
      value = sqliteOp(r.value, h);
    } catch (err) {
      r = step.throw(err);
      continue;
    }
    r = step.next(value);
  }
  return r.value;
}

async function driveAsync<T>(step: Step<T>): Promise<T> {
  let r = step.next();
  while (!r.done) {
    let value: unknown;
    try {
      value = await pgOp(r.value);
    } catch (err) {
      r = step.throw(err);
      continue;
    }
    r = step.next(value);
  }
  return r.value;
}

function sqliteRunner(handle: () => SqliteHandle): StepRunner {
  return {
    dialect: 'sqlite',
    read<T>(step: Step<T>): Promise<T> {
      try {
        return Promise.resolve(driveSync(step, handle()));
      } catch (err) {
        return Promise.reject(err);
      }
    },
    tx<T>(body: () => Step<T>, opts: { immediate?: boolean } = {}): Promise<T> {
      try {
        const h = handle();
        const t = h.getDb().transaction(() => driveSync(body(), h));
        return Promise.resolve(opts.immediate ? t.immediate() : t());
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };
}

export const sqliteSteps: StepRunner = sqliteRunner(mainSqlite);

/**
 * B2.2c: a SQLite runner on a database of its own (a store that keeps its
 * own SQLite file, e.g. webhooks.db); same semantics as sqliteSteps. On
 * PostgreSQL such stores use pgSteps (their tables are in the main database).
 */
export function sqliteStepsOn(db: Database.Database): StepRunner {
  const h: SqliteHandle = { prepare: (q) => db.prepare(q), getDb: () => db };
  return sqliteRunner(() => h);
}

export const pgSteps: StepRunner = {
  dialect: 'postgres',
  read: (step) => driveAsync(step),
  // PostgreSQL has no BEGIN IMMEDIATE: a step that needs a write lock up
  // front takes it itself (FOR UPDATE, pg_advisory_xact_lock).
  tx: (body) => withPgTransaction(() => driveAsync(body())),
};

/** The runner for a driver. */
export function stepsFor(driver: 'sqlite' | 'postgres'): StepRunner {
  return driver === 'postgres' ? pgSteps : sqliteSteps;
}

/** The runner for the process driver (AGENT_PLAYER_DB, db/pg/config.ts). */
export function sql(): StepRunner {
  return stepsFor(dbDriver());
}

export class SyncOnPostgresError extends Error {}

/**
 * SQLite only: run a step and return its result synchronously. For the
 * synchronous callers that are still SQLite-only; on PostgreSQL it throws
 * (use the async API there).
 */
export function sqliteSync<T>(step: Step<T>): T {
  if (dbDriver() === 'postgres') {
    throw new SyncOnPostgresError('synchronous database access is SQLite only; use the async API on PostgreSQL');
  }
  return driveSync(step);
}

/**
 * B2.2c: one-statement shorthands on the process driver, for route code
 * whose queries are independent single statements (each is its own read,
 * no transaction; check-then-write sequences use sql().tx with steps).
 */
export const q = {
  one<T = any>(text: string, ...params: SqlParam[]): Promise<T | undefined> {
    return sql().read(one<T>(text, ...params));
  },
  all<T = any>(text: string, ...params: SqlParam[]): Promise<T[]> {
    return sql().read(all<T>(text, ...params));
  },
  run(text: string, ...params: SqlParam[]): Promise<{ changes: number }> {
    return sql().read(run(text, ...params));
  },
  /** The process driver's dialect (for the db/pg/dialect.ts helpers). */
  get dialect(): Dialect {
    return sql().dialect;
  },
};

/**
 * A SUM / AVG / numeric aggregate as a number: PostgreSQL returns numeric as
 * text, SQLite a number already. null stays null (SQLite SUM of no rows).
 */
export function num<T extends number | null | undefined>(v: unknown): T {
  if (v === null || v === undefined) return v as T;
  return (typeof v === 'number' ? v : Number(v)) as T;
}
