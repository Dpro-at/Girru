// STORE-MAP-01 pilot: cost of the change-log triggers on memory writes.
// Saves N memories into a project drawer through the app's versioned save,
// in alternating rounds with the drawer not opted in (triggers find nothing)
// and opted in (each write also adds its change events), and reports the time per write.
// Run from packages/backend: node --import tsx scripts/memory-baseline/outbox-overhead.mjs [--n 2000]
import { backendDir, moduleUrl, addUser, argValue, cleanup, openDb, percentile, quietly } from './env.mjs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

process.env.MEMORY_EMBEDDINGS = 'hash';
const n = Number(argValue('n', '2000'));
const { db, closeDatabase } = await openDb();
addUser(db, 'p0-owner', 'owner');
const { createProject } = await import(moduleUrl(backendDir, 'src/repositories/chat-conversations.ts'));
const { newMemory, saveVersioned } = await import(moduleUrl(backendDir, 'src/memory/learning.ts'));
const { enableScope, disableScope } = await import(moduleUrl(backendDir, 'src/memory/outbox/events.ts'));
const folder = join(process.cwd(), 'alpha');
mkdirSync(folder, { recursive: true });
const project = await createProject('p0-owner', { name: 'Alpha', folder });
const drawer = { kind: 'project', key: project.slug };

async function round(label) {
  const t = [];
  for (let i = 0; i < n; i++) {
    const m = newMemory('p0-owner', drawer, { type: 'fact', importance: 5, content: `${label} fact number ${i} about the alpha release` }, {});
    const s = performance.now();
    await quietly(() => saveVersioned(m, 'bench', 'bench'));
    t.push(performance.now() - s);
  }
  return { p50: +percentile(t, 50).toFixed(3), p95: +percentile(t, 95).toFixed(3) };
}
// Rounds alternate so the growing table does not count as trigger cost.
const res = { off: [], on: [] };
for (let r = 0; r < 3; r++) {
  res.off.push(await round(`off${r}`));
  const scope = await enableScope('p0-owner', project);
  res.on.push(await round(`on${r}`));
  await disableScope(scope);
}
const events = db.prepare('SELECT COUNT(*) AS c FROM change_events').get().c;
console.log(JSON.stringify({ writesPerRound: n, notOptedInMs: res.off, optedInMs: res.on, events }));
closeDatabase();
cleanup();
