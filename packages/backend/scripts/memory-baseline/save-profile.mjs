// Where one memory save spends its time, at a given number of stored memories. A save that costs more
// as memory grows blocks every read in the same process (better-sqlite3 is synchronous), which is what
// made three agents slow before MEM-CONC-02: the knowledge-graph prune ran on every save and scanned
// every memory of the owner five times (950 ms per save at 100,000, now ~1 ms).
//
// It times the three parts of MemoryStorage.save (the embedding, the row write, the readable copy) next
// to a bare INSERT, for scale. Hash vectors, so nothing waits on an embedding model.
//
// Run from packages/backend:
//   node --max-old-space-size=16384 --import tsx scripts/memory-baseline/save-profile.mjs --memories 100000
import { openDb, addUser, quietly, moduleUrl, backendDir } from './env.mjs';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
const OWNER = 'prof-owner';
const N = Number(process.argv[process.argv.indexOf('--memories') + 1] || 100000);
const { db } = await openDb();
addUser(db, OWNER, 'owner');
const { getMemoryStorage } = await import(moduleUrl(backendDir, 'src/memory/storage.ts'));
const { hashEmbed, HASH_MODEL, HASH_DIMS } = await import(moduleUrl(backendDir, 'src/memory/embedding.ts'));
const { normalizeMemoryText } = await import(moduleUrl(backendDir, 'src/memory/text-normalize.ts'));
const { syntheticMemories } = await import('./corpus.mjs');
const storage = getMemoryStorage();
await quietly(() => storage.initialize());
const insert = db.prepare(`INSERT INTO memories (id, user_id, type, content, embedding, embedding_model, embedding_dims,
  memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'factual', 'active', '{}', 0.5, ?, 0, ?, ?)`);
let batch = [], i = 0;
const flush = () => { const rows = batch; batch = []; db.transaction(() => { for (const r of rows) insert.run(...r); }); };
for (const m of syntheticMemories(N, 23)) {
  batch.push([`m-${i++}`, OWNER, m.type, m.content, JSON.stringify(hashEmbed(normalizeMemoryText(m.content))), HASH_MODEL, HASH_DIMS, m.createdAt, m.drawerKind, m.drawerKey]);
  if (batch.length >= 5000) flush();
}
if (batch.length) flush();
console.log(`seeded ${i}`);
const mk = (k) => ({ id: `prof-${k}`, userId: OWNER, type: 'fact', content: `Alpha note ${k}: the weekly review moved to Thursday.`,
  drawer: { kind: 'project', key: 'alpha' }, memoryLayer: 'factual', importanceScore: 0.5, status: 'active',
  metadata: {}, createdAt: new Date(), accessCount: 0, expiryTimestamp: null });
const { sql } = await import(moduleUrl(backendDir, 'src/repositories/sql-steps.ts'));
// Time the three parts of save(): the embedding, the row write and the markdown copy.
const parts = {};
for (const name of ['ensureEmbedding', 'saveToMarkdown']) {
  const orig = storage[name].bind(storage);
  storage[name] = async (...a) => { const t = performance.now(); try { return await orig(...a); } finally { parts[name] = (performance.now() - t).toFixed(0); } };
}
const origWrite = storage.writeRowStep.bind(storage);
storage.writeRowStep = function* (m) { const t = performance.now(); try { return yield* origWrite(m); } finally { parts.writeRowStep = (performance.now() - t).toFixed(0); } };
for (let k = 0; k < 4; k++) {
  // A bare row INSERT, for scale: what the database itself costs.
  const t0 = performance.now();
  insert.run(`raw-${k}`, OWNER, 'fact', 'raw row', JSON.stringify(hashEmbed('raw row')), HASH_MODEL, HASH_DIMS, new Date().toISOString(), 'project', 'alpha');
  const tRaw = performance.now() - t0;
  const t1 = performance.now();
  await quietly(() => storage.save(mk(100 + k)));
  const tSave = performance.now() - t1;
  console.log(`save ${k}: raw INSERT ${tRaw.toFixed(1)} ms · storage.save ${tSave.toFixed(0)} ms · ${JSON.stringify(parts)}`);
}
process.exit(0);
