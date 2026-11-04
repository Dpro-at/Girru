// STORE-MAP-01 P9 (D9): EXPLAIN QUERY PLAN of the hot memory queries on a
// throwaway database with `--size` synthetic memories (corpus.mjs). Prints,
// per query, the plan lines and the time of one run, so a full scan
// ("SCAN memories") is easy to spot.
// Run from packages/backend:
//   node --import tsx scripts/memory-baseline/explain.mjs [--size 100000] [--p9]
// --p9 adds the P9 drawer indexes first (memory/indexes.ts), to compare plans.
import { backendDir, addUser, argValue, cleanup, openDb, quietly } from './env.mjs';
import { join } from 'node:path';
import { syntheticMemories } from './corpus.mjs';

const size = Number(argValue('size', '100000'));
const OWNER = 'p9-owner';
const { db, closeDatabase } = await openDb();
addUser(db, OWNER, 'owner');
const { getMemoryStorage, NOT_AGENT_NOTES_SQL } = await import(join(backendDir, 'src/memory/storage.ts'));
const D = await import(join(backendDir, 'src/memory/drawers.ts'));
const { NOT_ARCHIVED_SQL } = await import(join(backendDir, 'src/memory/scopes/store.ts'));
const { NOT_REPLACED_SQL } = await import(join(backendDir, 'src/memory/validity.ts'));
await quietly(() => getMemoryStorage().initialize());

const insert = db.prepare(`INSERT INTO memories (id, user_id, type, content, memory_layer, status, metadata,
  importance_score, created_at, access_count, drawer_kind, drawer_key, topic_key)
  VALUES (?, ?, ?, ?, 'factual', 'active', '{}', 0.5, ?, 0, ?, ?, ?)`);
let batch = [];
let i = 0;
const flush = () => { const rows = batch; batch = []; db.transaction(() => { for (const row of rows) insert.run(...row); }); };
for (const m of syntheticMemories(size, 23)) {
  batch.push([`m-${i}`, OWNER, m.type, m.content, m.createdAt, m.drawerKind, m.drawerKey, i % 7 === 0 ? `topic-${i}` : null]);
  i++;
  if (batch.length >= 5000) flush();
}
if (batch.length) flush();
if (process.argv.includes('--p9')) {
  const { P9_MEMORY_INDEXES } = await import(join(backendDir, 'src/memory/indexes.ts'));
  for (const ddl of P9_MEMORY_INDEXES) db.exec(ddl);
}
db.exec?.('ANALYZE');

const filter = D.drawerSqlFilter(D.selectDrawers({ audience: 'owner', project: 'alpha' }));
const projectOnly = D.drawerSqlFilter([{ kind: 'project', key: 'alpha' }]);
const queries = {
  'recall (owner chat, project alpha open)': [
    `SELECT * FROM memories WHERE user_id = ? AND ${filter.sql} AND ${NOT_ARCHIVED_SQL} AND ${NOT_REPLACED_SQL} AND ${NOT_AGENT_NOTES_SQL} ORDER BY created_at ASC, id ASC`,
    [OWNER, ...filter.params]],
  'drawer list (one project)': [
    `SELECT * FROM memories WHERE user_id = ? AND ${projectOnly.sql} ORDER BY created_at ASC, id ASC`, [OWNER, ...projectOnly.params]],
  'current fact by topic key': [
    `SELECT * FROM memories WHERE user_id = ? AND ${D.DRAWER_KIND_SQL} = ? AND ${D.DRAWER_KEY_SQL} = ? AND topic_key = ? AND ${NOT_REPLACED_SQL}`,
    [OWNER, 'project', 'alpha', 'topic-7']],
  'drawer counts': [
    `SELECT ${D.DRAWER_KIND_SQL} AS kind, ${D.DRAWER_KEY_SQL} AS key, COUNT(*) AS n FROM memories WHERE user_id = ? GROUP BY 1, 2`, [OWNER]],
};

const report = {};
for (const [name, [q, params]] of Object.entries(queries)) {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...params).map((r) => r.detail);
  const t = performance.now();
  const rows = db.prepare(q).all(...params).length;
  report[name] = { plan, rows, ms: +(performance.now() - t).toFixed(1) };
}
console.log(JSON.stringify({ size, report }, null, 2));
closeDatabase();
cleanup();
