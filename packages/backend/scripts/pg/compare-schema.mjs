#!/usr/bin/env node
/**
 * B2.1: compare the SQLite schema (built fresh from the migrations, in a temp
 * dir) with the PostgreSQL schema in a rehearsal database.
 *
 * SQLite side: better-sqlite3, same order as the runner in src/db/database.ts
 * (schema.sql, migrations table, migrations/*.sql), then schema.sql once more
 * as the runner does on every later start (steady state).
 * PostgreSQL side: catalog queries through `psql` (no pg client needed).
 *
 * Usage: node scripts/pg/compare-schema.mjs --db agent_player_rehearsal [--host 127.0.0.1] [--out report.txt]
 * Exit code 1 when an unexpected difference is found.
 */

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapType, strftimeToPg, translateAll, RUNNER_MIGRATIONS_TABLE } from './translate-migrations.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(here, '..', '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

export function buildSqlite(path) {
  const dbDir = join(backendDir, 'src', 'db');
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  const schema = readFileSync(join(dbDir, 'schema.sql'), 'utf8');
  db.exec(schema);
  db.exec(RUNNER_MIGRATIONS_TABLE);
  for (const f of readdirSync(join(dbDir, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    db.transaction(() => db.exec(readFileSync(join(dbDir, 'migrations', f), 'utf8')))();
  }
  db.exec(schema); // second start: schema.sql runs again (adds indexes on rebuilt tables)
  // B2.2b-2: what the app creates at run time (scripts/pg/runtime, the source
  // of migrations-pg r*): the credentials indexes, and the vault and key
  // tables under their PostgreSQL names (on SQLite they live in own files).
  for (const f of readdirSync(join(backendDir, 'scripts', 'pg', 'runtime')).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(backendDir, 'scripts', 'pg', 'runtime', f), 'utf8'));
  }
  return db;
}

/** FTS5 shadow tables of a virtual table `vt` (SQLite creates them itself). */
const FTS_SHADOW = ['data', 'idx', 'content', 'docsize', 'config'];

export function sqliteSchema(db) {
  const all = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
  // B2.2b-4: FTS5 virtual tables have no PostgreSQL table; they become a
  // tsvector column with a GIN index (hand-written override). Listed apart.
  const virtual = all.filter((t) => /^CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql || '')).map((t) => t.name);
  const shadow = new Set(virtual.flatMap((v) => FTS_SHADOW.map((x) => `${v}_${x}`)));
  const tables = all.filter((t) => !virtual.includes(t.name) && !shadow.has(t.name));
  const out = { tables: {}, virtual, triggers: db.prepare(`SELECT name, tbl_name AS tbl FROM sqlite_master WHERE type = 'trigger'`).all() };
  for (const t of tables) {
    const cols = db.prepare(`SELECT * FROM pragma_table_info(?)`).all(t.name);
    const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const fkRows = db.prepare(`SELECT * FROM pragma_foreign_key_list(?)`).all(t.name);
    const fks = {};
    for (const r of fkRows) (fks[r.id] ||= { table: r.table, from: [], to: [], onDelete: r.on_delete, onUpdate: r.on_update }).from.push(r.from), fks[r.id].to.push(r.to);
    const indexes = [];
    for (const ix of db.prepare(`SELECT * FROM pragma_index_list(?)`).all(t.name)) {
      const cols2 = db.prepare(`SELECT name, "desc" FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno`).all(ix.name).map((c) => (c.desc ? `${c.name} DESC` : c.name));
      const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(ix.name)?.sql || '';
      const w = /\bWHERE\b([\s\S]+)$/i.exec(sql);
      indexes.push({ name: ix.name, unique: !!ix.unique, origin: ix.origin, cols: cols2, pred: w ? w[1].trim() : null });
    }
    const checks = (stripSqlComments(t.sql).match(/\bCHECK\s*\(/gi) || []).length;
    out.tables[t.name] = { cols, pk, fks: Object.values(fks), indexes, checks };
  }
  return out;
}

function stripSqlComments(sql) {
  return sql.replace(/'(?:[^']|'')*'|--[^\n]*/g, (m) => (m.startsWith('--') ? '' : m));
}

// ---------------------------------------------------------------------------
// PostgreSQL (via psql)
// ---------------------------------------------------------------------------

const PG_QUERY = `
SELECT json_build_object(
 'tables', (SELECT coalesce(json_agg(c.relname ORDER BY c.relname), '[]') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'),
 'columns', (SELECT json_agg(json_build_object('table', table_name, 'name', column_name, 'type', data_type, 'notnull', is_nullable = 'NO', 'default', column_default, 'identity', is_identity = 'YES') ORDER BY table_name, ordinal_position) FROM information_schema.columns WHERE table_schema = 'public'),
 'constraints', (SELECT json_agg(json_build_object('table', cl.relname, 'name', co.conname, 'type', co.contype,
     'cols', (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(co.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = co.conrelid AND a.attnum = k.attnum),
     'reftable', rt.relname,
     'refcols', (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(co.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = co.confrelid AND a.attnum = k.attnum),
     'ondelete', co.confdeltype, 'onupdate', co.confupdtype, 'def', pg_get_constraintdef(co.oid)))
   FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace LEFT JOIN pg_class rt ON rt.oid = co.confrelid
   WHERE n.nspname = 'public'),
 'indexes', (SELECT json_agg(json_build_object('table', t.relname, 'name', i.relname, 'unique', ix.indisunique, 'primary', ix.indisprimary,
     'constraint', EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid AND c.conrelid = ix.indrelid),
     'def', pg_get_indexdef(ix.indexrelid), 'pred', pg_get_expr(ix.indpred, ix.indrelid)))
   FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public'),
 'triggers', (SELECT coalesce(json_agg(json_build_object('table', c.relname, 'name', t.tgname, 'def', pg_get_triggerdef(t.oid))), '[]')
   FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal)
);`;

function pgSchema(host, dbName) {
  const raw = execFileSync('psql', ['-h', host, '-d', dbName, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', PG_QUERY], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const j = JSON.parse(raw);
  const out = { tables: {}, triggers: j.triggers };
  for (const t of j.tables) out.tables[t] = { cols: [], cons: [], indexes: [] };
  for (const c of j.columns || []) out.tables[c.table]?.cols.push(c);
  for (const c of j.constraints || []) out.tables[c.table]?.cons.push(c);
  for (const i of j.indexes || []) out.tables[i.table]?.indexes.push(i);
  return out;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const PG_TYPE_NAME = { bigint: 'bigint', integer: 'integer', text: 'text', 'double precision': 'double precision', timestamptz: 'timestamp with time zone', date: 'date', bytea: 'bytea' };
const FK_ACTION = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

function classifySqliteDefault(v, kind) {
  if (v == null) return 'null';
  const s = v.trim().replace(/^\((.*)\)$/s, '$1').trim();
  const rnd = /^(?:'([^']*)'\s*\|\|\s*)?lower\(hex\(randomblob\((\d+)\)\)\)$/i.exec(s);
  if (rnd) return `randhex:${rnd[1] || ''}:${Number(rnd[2]) * 2}`;
  if (/^CURRENT_TIMESTAMP$/i.test(s) || /^datetime\('now'\)$/i.test(s)) return kind === 'ts' ? 'now' : 'textnow:YYYY-MM-DD HH24:MI:SS';
  const sf = /^strftime\('([^']*)',\s*'now'\)$/i.exec(s);
  if (sf) return kind === 'ts' ? 'now' : `textnow:${strftimeToPg(sf[1])}`;
  if (/^(TRUE|FALSE)$/i.test(s)) return `lit:${/TRUE/i.test(s) ? 1 : 0}`;
  if (/^[-+]?\d+(\.\d+)?$/.test(s)) return `lit:${Number(s)}`;
  return `lit:${s}`;
}

function classifyPgDefault(v) {
  if (v == null) return 'null';
  let s = v.trim();
  if (/gen_random_uuid/.test(s)) {
    const prefix = /^\('([^']*)'::text\s*\|\|/.exec(s);
    const sub = /substr\(.*,\s*1,\s*(\d+)\)/.exec(s);
    return `randhex:${prefix ? prefix[1] : ''}:${sub ? Number(sub[1]) : 32}`;
  }
  if (/^now\(\)$|^CURRENT_TIMESTAMP$/i.test(s)) return 'now';
  const quotedNum = /^'([-+]?\d+(\.\d+)?)'::[a-z ]+$/i.exec(s);
  if (quotedNum) return `lit:${Number(quotedNum[1])}`;
  const tc = /^to_char\(.*,\s*'([^']*)'::text\)$/.exec(s);
  if (tc) return `textnow:${tc[1]}`;
  s = s.replace(/::[a-z ]+$/i, '').replace(/^\((.*)\)$/s, '$1').replace(/::[a-z ]+$/i, '');
  if (/^[-+]?\d+(\.\d+)?$/.test(s)) return `lit:${Number(s)}`;
  return `lit:${s}`;
}

function normPred(s, pg) {
  if (s == null) return null;
  let t = s;
  if (pg) {
    t = t.replace(/::[a-z]+( [a-z]+)?/gi, '');
    t = t.replace(/\s*=\s*ANY\s*\(ARRAY\[(.*?)\]\)/gi, ' IN ($1)');
  }
  return t.replace(/[\s()]/g, '').toLowerCase();
}

function pgIndexCols(def) {
  const m = /USING \w+ \((.*)\)( WHERE .*)?$/.exec(def);
  if (!m) return [];
  let body = m[1];
  // cut at the matching parenthesis of the column list
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') { if (depth === 0) { body = body.slice(0, i); break; } depth--; }
  }
  return body.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

export function compare(sq, pg, expectedFkDrops) {
  const diffs = [];
  const expected = [];
  const stats = { tables: 0, columns: 0, fks: 0, uniques: 0, indexes: 0, checks: 0, triggers: 0 };
  const add = (msg) => diffs.push(msg);
  const pkQuirk = [];
  const sqT = Object.keys(sq.tables).sort();
  const pgT = Object.keys(pg.tables).sort();
  for (const t of sqT) if (!pg.tables[t]) add(`table missing in PostgreSQL: ${t}`);
  for (const t of pgT) if (!sq.tables[t]) add(`extra table in PostgreSQL: ${t}`);

  for (const t of sqT.filter((x) => pg.tables[x])) {
    stats.tables++;
    const S = sq.tables[t];
    const P = pg.tables[t];
    const pcols = new Map(P.cols.map((c) => [c.name, c]));
    // columns
    for (const c of S.cols) {
      stats.columns++;
      const p = pcols.get(c.name);
      if (!p) { add(`${t}.${c.name}: column missing in PostgreSQL`); continue; }
      const { pg: exp, kind } = mapType(c.type.replace(/\(.*\)$/, ''));
      const identity = c.pk > 0 && S.pk.length === 1 && /^INTEGER$/i.test(c.type.trim());
      if (PG_TYPE_NAME[exp] !== p.type) add(`${t}.${c.name}: type ${c.type} -> expected ${exp}, got ${p.type}`);
      if (identity !== p.identity) add(`${t}.${c.name}: identity expected ${identity}, got ${p.identity}`);
      const sqNotNull = !!c.notnull || c.pk > 0;
      if (sqNotNull !== p.notnull) {
        add(`${t}.${c.name}: NOT NULL sqlite=${sqNotNull} pg=${p.notnull}`);
      } else if (!c.notnull && c.pk > 0 && !identity) {
        pkQuirk.push(`${t}.${c.name}`);
      }
      const a = identity ? 'identity' : classifySqliteDefault(c.dflt_value, kind);
      const b = p.identity ? 'identity' : classifyPgDefault(p.default);
      if (a !== b) add(`${t}.${c.name}: default sqlite=${c.dflt_value} (${a}) pg=${p.default} (${b})`);
    }
    for (const p of P.cols) {
      if (S.cols.some((c) => c.name === p.name)) continue;
      if (p.type === 'tsvector' && (sq.virtual || []).length) expected.push(`${t}.${p.name}: tsvector column in PostgreSQL (full text for the SQLite FTS5 table(s) ${sq.virtual.join(', ')})`);
      else add(`${t}.${p.name}: extra column in PostgreSQL`);
    }
    const sqOrder = S.cols.map((c) => c.name).join(',');
    const pgOrder = P.cols.map((c) => c.name).join(',');
    if (sqOrder !== pgOrder && S.cols.length === P.cols.length) add(`${t}: column order differs`);

    // primary key
    const ppk = P.cons.find((c) => c.type === 'p');
    const ppkCols = ppk ? ppk.cols : [];
    if (S.pk.join(',') !== ppkCols.join(',')) add(`${t}: primary key sqlite=(${S.pk}) pg=(${ppkCols})`);

    // foreign keys
    const sig = (from, table, to, del, upd) => `(${from.join(',')}) -> ${table}(${to.join(',')}) delete=${del} update=${upd}`;
    const sqF = S.fks.map((f) => {
      const to = f.to.some((x) => x == null) ? (sq.tables[f.table]?.pk || []) : f.to;
      return sig(f.from, f.table, to, f.onDelete, f.onUpdate);
    });
    const pgF = P.cons.filter((c) => c.type === 'f').map((c) => sig(c.cols, c.reftable, c.refcols, FK_ACTION[c.ondelete], FK_ACTION[c.onupdate]));
    for (const f of sqF) {
      stats.fks++;
      if (pgF.includes(f)) continue;
      const from = /^\(([^)]*)\) -> (\w+)/.exec(f);
      const key = `${t}|${from[1]}|${from[2]}`;
      if (expectedFkDrops.has(key)) expected.push(`${t}: FK ${f} not in PostgreSQL (dropped by translator: target table does not exist / type mismatch)`);
      else add(`${t}: FK missing in PostgreSQL: ${f}`);
    }
    for (const f of pgF) if (!sqF.includes(f)) add(`${t}: extra FK in PostgreSQL: ${f}`);

    // unique constraints (SQLite autoindexes) and created indexes
    const sqU = S.indexes.filter((i) => i.origin === 'u').map((i) => i.cols.join(','));
    const pgU = P.cons.filter((c) => c.type === 'u').map((c) => c.cols.join(','));
    for (const u of sqU) { stats.uniques++; if (!pgU.includes(u)) add(`${t}: UNIQUE (${u}) missing in PostgreSQL`); }
    for (const u of pgU) if (!sqU.includes(u)) add(`${t}: extra UNIQUE (${u}) in PostgreSQL`);
    const pgIdx = new Map(P.indexes.filter((i) => !i.constraint).map((i) => [i.name, i]));
    for (const i of S.indexes.filter((x) => x.origin === 'c')) {
      stats.indexes++;
      const p = pgIdx.get(i.name);
      if (!p) { add(`${t}: index ${i.name} missing in PostgreSQL`); continue; }
      pgIdx.delete(i.name);
      if (i.unique !== p.unique) add(`${t}: index ${i.name} unique sqlite=${i.unique} pg=${p.unique}`);
      // An expression index (SQLite lists an expression key as an empty name): PostgreSQL rewrites the
      // expression text (casts, ARRAY for IN), so it is compared by its plain columns and noted; the
      // query plan on each driver is checked by the tests (store-p9-index, pg-store-p9).
      if (i.cols.some((c) => c === '' || c === null)) {
        const plain = i.cols.filter((c) => c).every((c) => p.def.includes(c));
        if (!plain) add(`${t}: expression index ${i.name} plain columns differ: sqlite=(${i.cols.join(', ')}) pg=${p.def}`);
        else expected.push(`${t}: expression index ${i.name} (same plain columns; expressions checked by the tests)`);
        if (normPred(i.pred, false) !== normPred(p.pred, true)) add(`${t}: index ${i.name} WHERE sqlite=${i.pred} pg=${p.pred}`);
        continue;
      }
      const pc = pgIndexCols(p.def).join(', ');
      if (i.cols.join(', ') !== pc) add(`${t}: index ${i.name} columns sqlite=(${i.cols.join(', ')}) pg=(${pc})`);
      if (normPred(i.pred, false) !== normPred(p.pred, true)) add(`${t}: index ${i.name} WHERE sqlite=${i.pred} pg=${p.pred}`);
    }
    for (const [name, p] of pgIdx) {
      const tsv = P.cols.filter((c) => c.type === 'tsvector').map((c) => c.name);
      if (/ USING gin /i.test(p.def) && pgIndexCols(p.def).every((c) => tsv.includes(c))) expected.push(`${t}: GIN index ${name} on the tsvector column (FTS5 replacement)`);
      else add(`${t}: extra index in PostgreSQL: ${name}`);
    }

    // CHECK constraints (count)
    const pgChecks = P.cons.filter((c) => c.type === 'c').length;
    stats.checks += S.checks;
    if (S.checks !== pgChecks) add(`${t}: CHECK count sqlite=${S.checks} pg=${pgChecks}`);
  }

  // triggers
  for (const tr of sq.triggers) {
    stats.triggers++;
    const p = pg.triggers.find((x) => x.name === tr.name && x.table === tr.tbl);
    if (!p) add(`trigger ${tr.name} on ${tr.tbl} missing in PostgreSQL`);
  }
  for (const p of pg.triggers) if (!sq.triggers.some((x) => x.name === p.name)) add(`extra trigger in PostgreSQL: ${p.name}`);
  for (const v of sq.virtual || []) expected.push(`SQLite FTS5 virtual table ${v} (and its shadow tables) has no PostgreSQL table: replaced by a tsvector column + GIN index`);
  if (pkQuirk.length) expected.push(`${pkQuirk.length} non-INTEGER PRIMARY KEY columns are nullable in SQLite (legacy quirk) and NOT NULL in PostgreSQL: ${pkQuirk.join(', ')}`);
  return { diffs, expected, stats };
}

function expectedDrops() {
  const set = new Set();
  for (const r of translateAll(backendDir)) {
    for (const n of r.notes) {
      let m = /^(\w+): FOREIGN KEY \(([^)]*)\) REFERENCES (\w+) dropped/.exec(n);
      if (m) set.add(`${m[1]}|${m[2].split(', ').join(',')}|${m[3]}`);
      m = /^(\w+)\.(\w+): REFERENCES (\w+) dropped/.exec(n);
      if (m) set.add(`${m[1]}|${m[2]}|${m[3]}`);
    }
  }
  return set;
}

function main() {
  const host = arg('host', '127.0.0.1');
  const dbName = arg('db', 'agent_player_rehearsal');
  const outPath = arg('out', null);
  const dir = mkdtempSync(join(tmpdir(), 'ap-pg-compare-'));
  let report;
  let failed = false;
  try {
    const db = buildSqlite(join(dir, 'fresh.db'));
    const sq = sqliteSchema(db);
    db.close();
    const pg = pgSchema(host, dbName);
    const { diffs, expected, stats } = compare(sq, pg, expectedDrops());
    failed = diffs.length > 0;
    report = [
      `Schema comparison SQLite (fresh, steady state) vs PostgreSQL ${dbName}@${host}`,
      `SQLite tables: ${Object.keys(sq.tables).length}, PostgreSQL tables: ${Object.keys(pg.tables).length}`,
      `checked: ${stats.tables} tables, ${stats.columns} columns, ${stats.fks} foreign keys, ${stats.uniques} unique constraints, ${stats.indexes} indexes, ${stats.checks} CHECK constraints, ${stats.triggers} triggers`,
      `unexpected differences: ${diffs.length}`,
      ...diffs.map((d) => `  DIFF ${d}`),
      `expected differences: ${expected.length}`,
      ...expected.map((d) => `  EXPECTED ${d}`),
      '',
    ].join('\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (outPath) writeFileSync(outPath, report);
  process.stdout.write(report);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
