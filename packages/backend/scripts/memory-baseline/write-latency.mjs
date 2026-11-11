// STORE-MAP-01 P9b: write cost of the one write pipeline (MD1, LAT rule 2).
// Times learn() for routine chat extractions (the most frequent save) in a
// drawer that already holds `--size` memories, P9b off or on (one mode per
// process). The background enrichment is not part of the save: it is timed
// apart (enrichMs) after the saves.
// Run from packages/backend:
//   node --import tsx scripts/memory-baseline/write-latency.mjs [--p9b] [--size 2000] [--saves 200] [--out f.json]
import { backendDir, addUser, argValue, cleanup, openDb, percentile, quietly } from './env.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syntheticMemories } from './corpus.mjs';

const p9b = process.argv.includes('--p9b');
if (p9b) process.env.GIRRU_STORE_P9B = '1'; else process.env.GIRRU_STORE_P9B = '0';
process.env.MEMORY_EMBEDDINGS = 'hash';
const size = Number(argValue('size', '2000'));
const saves = Number(argValue('saves', '200'));
const out = argValue('out', null);
const OWNER = 'p0-owner';
const { db, closeDatabase } = await openDb();
addUser(db, OWNER, 'owner');
const L = await import(join(backendDir, 'src/memory/learning.ts'));
const PL = await import(join(backendDir, 'src/memory/quality/pipeline.ts'));
const { getMemoryStorage } = await import(join(backendDir, 'src/memory/storage.ts'));
await quietly(() => getMemoryStorage().initialize());
const insert = db.prepare(`INSERT INTO memories (id, user_id, type, content, memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key)
  VALUES (?, ?, 'fact', ?, 'factual', 'active', '{}', 0.5, ?, 0, 'owner', '')`);
db.transaction(() => [...syntheticMemories(size, 7)].forEach((r, i) => insert.run(`d-${i}`, OWNER, r.content, r.createdAt)));
const times = [];
for (let i = 0; i < saves; i++) {
  const t = performance.now();
  await quietly(() => L.learn({ userId: OWNER, actor: 'extraction', candidates: [{ content: `Write latency probe ${i}: the courier comes on weekday ${i % 7} at ${8 + (i % 9)} o'clock`, type: 'fact', origin: 'extraction' }] }));
  times.push(performance.now() - t);
}
const t0 = performance.now();
await PL.enrichmentIdle();
const report = { p9b, size, saves, saveMs: { p50: +percentile(times, 50).toFixed(2), p95: +percentile(times, 95).toFixed(2) }, enrichMs: Math.round(performance.now() - t0) };
console.log(JSON.stringify(report));
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
closeDatabase();
cleanup();
