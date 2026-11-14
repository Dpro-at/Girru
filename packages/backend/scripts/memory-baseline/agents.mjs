// Several agents on ONE shared memory: Claude Code, Codex and Gemini CLI read and propose at the same
// time through Girru, each in its own process on the same SQLite file (WAL). This measures what a
// single-search benchmark cannot: whether reads stay fast together, whether a save slows them down,
// whether two agents editing one memory are caught instead of overwriting each other, how long a new
// fact takes to be visible to another agent, and that one project's memory never reaches another.
//
// Hash vectors are used, so nothing waits on a local embedding model and the numbers are about
// concurrency, not about embedding quality. Every process uses the real paths (MemoryStorage.search,
// quality recall, learning.updateVersioned) — never raw SQL writes.
//
// Run from packages/backend:
//   node --import tsx scripts/memory-baseline/agents.mjs [--memories 20000] [--agents 3] [--searches 40] [--out f.json]
//   --agents 1,3,6   measure these agent counts in turn (default 1,3,6)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const isWorker = process.argv.includes('--worker');
const OWNER = 'agents-owner';
/** The writer waits this long so the reader is already searching when the note lands. */
const HANDOFF_DELAY_MS = 300;
const QUERIES = [
  'which database does the project use now', 'who is the contact at the client', 'when do deploys go out',
  'what is the release deadline', 'قاعدة البيانات الحالية للمشروع', 'متى موعد التسليم', 'wer ist der Ansprechpartner',
  'what is the known issue with exports', 'where is production hosted', 'شنو مشكلة التصدير',
];

if (!isWorker) await parent();
else await worker();

/** The parent: seeds one shared database, then runs the phases with worker processes. */
async function parent() {
  const backendCwd = process.cwd(); // env.mjs moves this process into the data folder; children need the real one
  const nMemories = Number(arg('memories', '20000'));
  const nSearches = Number(arg('searches', '40'));
  const counts = String(arg('agents', '1,3,6')).split(',').map(Number).filter((n) => n > 0);
  const out = arg('out', null);

  const dataRoot = mkdtempSync(join(tmpdir(), 'girru-agents-'));
  // Every process must share the folder AND the secrets (the encryption key is part of the data).
  const env = {
    ...process.env,
    GIRRU_BENCH_DATA: dataRoot,
    JWT_SECRET: randomBytes(64).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    MEMORY_EMBEDDINGS: 'hash',
    MEMORY_GRAPH_MODEL: 'off',
  };
  Object.assign(process.env, env);

  const { openDb, addUser, quietly, moduleUrl, backendDir, percentile } = await import('./env.mjs');
  const { syntheticMemories } = await import('./corpus.mjs');
  const { db } = await openDb();
  addUser(db, OWNER, 'owner');
  const { hashEmbed, HASH_MODEL, HASH_DIMS } = await import(moduleUrl(backendDir, 'src/memory/embedding.ts'));
  const { normalizeMemoryText } = await import(moduleUrl(backendDir, 'src/memory/text-normalize.ts'));
  const { getMemoryStorage } = await import(moduleUrl(backendDir, 'src/memory/storage.ts'));
  await quietly(() => getMemoryStorage().initialize());

  const insert = db.prepare(`INSERT INTO memories (id, user_id, type, content, embedding, embedding_model, embedding_dims,
    memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'factual', 'active', '{}', 0.5, ?, 0, ?, ?)`);
  const t0 = Date.now();
  let batch = [], i = 0;
  const flush = () => { const rows = batch; batch = []; db.transaction(() => { for (const row of rows) insert.run(...row); }); };
  for (const m of syntheticMemories(nMemories, 23)) {
    batch.push([`m-${i++}`, OWNER, m.type, m.content, JSON.stringify(hashEmbed(normalizeMemoryText(m.content))), HASH_MODEL, HASH_DIMS, m.createdAt, m.drawerKind, m.drawerKey]);
    if (batch.length >= 5000) flush();
  }
  if (batch.length) flush();
  // One memory of project beta, to prove it never reaches a chat with alpha open.
  insert.run('beta-secret', OWNER, 'fact', 'Beta project: the staging database password rotation is monthly.',
    JSON.stringify(hashEmbed(normalizeMemoryText('Beta project staging database password rotation monthly'))), HASH_MODEL, HASH_DIMS, new Date().toISOString(), 'project', 'beta');
  // One memory three agents will try to edit at the same time. Saved through the real path, so it has
  // a version baseline (a raw INSERT has none, and then every edit is refused).
  await quietly(() => getMemoryStorage().save({
    id: 'contended', userId: OWNER, type: 'fact', content: 'Alpha project: the server database is MariaDB.',
    drawer: { kind: 'project', key: 'alpha' }, memoryLayer: 'factual', importanceScore: 0.5, status: 'active',
    metadata: {}, createdAt: new Date(), accessCount: 0, expiryTimestamp: null,
  }));
  // storage.save writes the row; the version baseline is recorded by the learning path, so do it here.
  const { recordBaselineIfMissing } = await import(moduleUrl(backendDir, 'src/memory/versions.ts'));
  const seeded = await quietly(() => getMemoryStorage().getOwned(OWNER, 'contended'));
  await quietly(() => recordBaselineIfMissing(seeded, 'seed'));
  const { currentVersionStep } = await import(moduleUrl(backendDir, 'src/memory/validity.ts'));
  const { sql } = await import(moduleUrl(backendDir, 'src/db/sql.ts')).catch(() => ({ sql: null }));
  const startVersion = sql ? await quietly(() => sql().read(currentVersionStep('contended')))
    : (db.prepare('SELECT MAX(version) AS v FROM memory_versions WHERE memory_id = ?').get('contended')?.v ?? 1);
  db.exec?.('PRAGMA wal_checkpoint(TRUNCATE)');
  const seedMs = Date.now() - t0;
  console.log(`seeded         ${i} memories in ${(seedMs / 1000).toFixed(1)}s (hash vectors, WAL)`);

  const run = (job, agents, extra = []) => Promise.all(Array.from({ length: agents }, (_, k) =>
    new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(import.meta.url), ['--worker', '--job', job, '--agent', String(k), '--searches', String(nSearches), ...extra],
        { env, cwd: backendCwd, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      let result = null;
      child.on('message', (m) => { result = m; });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 && result ? resolve(result) : reject(new Error(`agent ${k} (${job}) exited ${code}`))));
    })));

  const report = { memories: i, searches: nSearches, seedMs, phases: {} };

  // 1. Reads together: the same searches, by 1, then 3, then 6 agents at once.
  for (const agents of counts) {
    const started = Date.now();
    const rs = await run('search', agents);
    const all = rs.flatMap((r) => r.ms);
    // Throughput over the searching window only (the slowest agent's loop), not process start-up.
    const loop = Math.max(...rs.map((r) => r.loopMs));
    report.phases[`read-${agents}`] = {
      agents, searches: all.length, p50: +percentile(all, 50).toFixed(1), p95: +percentile(all, 95).toFixed(1),
      loopMs: +loop.toFixed(0), startupMs: Date.now() - started - Math.round(loop),
      perSecond: +((all.length / loop) * 1000).toFixed(1), hits: rs.reduce((s, r) => s + r.hits, 0),
    };
    const p = report.phases[`read-${agents}`];
    console.log(`read x${String(agents).padEnd(2)}       p50 ${String(p.p50).padStart(6)} ms · p95 ${String(p.p95).padStart(6)} ms · ${p.perSecond} searches/s`);
  }

  // 2. Reads while another agent is saving memories through the real save path.
  {
    const started = Date.now();
    const rs = await Promise.all([run('search', Math.max(...counts)), run('save', 1)]);
    const all = rs[0].flatMap((r) => r.ms);
    report.phases['read-while-saving'] = {
      agents: Math.max(...counts), p50: +percentile(all, 50).toFixed(1), p95: +percentile(all, 95).toFixed(1),
      saved: rs[1][0].saved, perSecond: +((all.length / Math.max(...rs[0].map((r) => r.loopMs))) * 1000).toFixed(1), wallMs: Date.now() - started,
    };
    const p = report.phases['read-while-saving'];
    console.log(`read + save    p50 ${String(p.p50).padStart(6)} ms · p95 ${String(p.p95).padStart(6)} ms · ${p.saved} memories saved meanwhile`);
  }

  // 3. Three agents edit ONE memory, each having read version 1: one wins, the others are refused.
  {
    const rs = await run('edit', 3, ['--version', String(startVersion)]);
    const won = rs.filter((r) => r.ok).length, refused = rs.filter((r) => r.refused).length;
    const after = db.prepare('SELECT content FROM memories WHERE id = ?').get('contended');
    const v = db.prepare('SELECT MAX(version) AS v FROM memory_versions WHERE memory_id = ?').get('contended');
    report.phases['same-memory-edits'] = { agents: 3, won, refused, failed: 3 - won - refused, finalVersion: v?.v ?? null, finalContent: after?.content ?? null,
      errors: rs.filter((r) => r.error).map((r) => r.error) };
    console.log(`3 edits, 1 id  ${won} saved · ${refused} refused (the memory changed since they read it) · version now ${v?.v}`);
  }

  // 4. One agent saves, another searches until it sees it: how long a new fact takes to travel.
  {
    const rs = await run('handoff', 2);
    const reader = rs.find((r) => r.role === 'reader');
    report.phases.handoff = reader;
    console.log(`handoff        ${reader.foundMs === null ? 'NOT seen within the wait' : `seen by the other agent ${reader.foundMs} ms after it was written (polled every 25 ms)`}`);
  }

  // 5. A chat with project alpha open must never see project beta's memory.
  {
    const rs = await run('isolation', 1);
    report.phases.isolation = rs[0];
    console.log(`isolation      beta memory in an alpha chat: ${rs[0].leaks} (0 is correct) · beta visible in a beta chat: ${rs[0].betaSeesOwn}`);
  }

  if (out) writeFileSync(out, JSON.stringify(report, null, 1));
  // Windows keeps the database file open a moment after the last connection closes.
  try { rmSync(dataRoot, { recursive: true, force: true }); }
  catch { console.log(`left behind     ${dataRoot} (delete it when the file is free)`); }
}

/** One agent: its own process, its own connection to the shared database. */
async function worker() {
  const job = arg('job', 'search');
  const agent = Number(arg('agent', '0'));
  const nSearches = Number(arg('searches', '40'));
  const { openDb, quietly, moduleUrl, backendDir } = await import('./env.mjs');
  await openDb();
  const { getMemoryStorage } = await import(moduleUrl(backendDir, 'src/memory/storage.ts'));
  const D = await import(moduleUrl(backendDir, 'src/memory/drawers.ts'));
  const storage = getMemoryStorage();
  await quietly(() => storage.initialize());
  const alpha = D.selectDrawers({ audience: 'owner', project: 'alpha' });
  const search = (query, drawers = alpha) => quietly(() => storage.search({ query, userId: OWNER, drawers, limit: 5 }));
  const send = (m) => { process.send(m); process.exit(0); };

  if (job === 'search') {
    await search(QUERIES[0]); // warm up: module load and the recall index, not counted
    const ms = []; let hits = 0;
    const loopStart = performance.now();
    for (let k = 0; k < nSearches; k++) {
      const q = QUERIES[(k + agent) % QUERIES.length];
      const t = performance.now();
      const r = await search(q);
      ms.push(+(performance.now() - t).toFixed(2));
      hits += r.length;
    }
    send({ role: 'reader', ms, hits, loopMs: performance.now() - loopStart });
  }

  if (job === 'save') {
    const { learnFromText } = await import(moduleUrl(backendDir, 'src/memory/learning.ts')).catch(() => ({}));
    let saved = 0;
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      const id = `saved-${agent}-${saved}`;
      await quietly(() => storage.save({
        id, userId: OWNER, type: 'fact', content: `Alpha project note number ${saved}: the weekly review moved to Thursday.`,
        drawer: { kind: 'project', key: 'alpha' }, memoryLayer: 'factual', importanceScore: 0.5, status: 'active',
        metadata: {}, createdAt: new Date(), accessCount: 0, expiryTimestamp: null,
      })).catch(() => null);
      saved++;
    }
    send({ role: 'writer', saved, usedLearn: !!learnFromText });
  }

  if (job === 'edit') {
    const { updateVersioned } = await import(moduleUrl(backendDir, 'src/memory/learning.ts'));
    // Every agent read version 1 and edits from that, as three coding tools would.
    let ok = false, refused = false, error = null;
    try {
      const res = await quietly(() => updateVersioned(OWNER, 'contended', { content: `Alpha project: the server database is ${['ClickHouse', 'PostgreSQL 16', 'MySQL 8'][agent] ?? 'X'}.` },
        `agent-${agent}`, 'concurrent edit test', Number(arg('version', '1'))));
      ok = !!res;
      refused = res === null;
    } catch (e) {
      // A refusal arrives as MemoryVersionConflictError ("This memory changed while you were editing").
      const m = String(e?.message ?? e);
      if (e?.status === 409 || e?.constructor?.name === 'MemoryVersionConflictError' || /changed while you were editing/i.test(m)) refused = true;
      else error = m.slice(0, 200);
    }
    send({ role: 'editor', agent, ok, refused, error });
  }

  if (job === 'handoff') {
    if (agent === 0) {
      await new Promise((r) => setTimeout(r, HANDOFF_DELAY_MS)); // let the reader start and warm up first
      await quietly(() => storage.save({
        id: 'handoff-note', userId: OWNER, type: 'fact', content: 'Alpha project handoff: done the export fix, left the retry limit, next the invoice totals.',
        drawer: { kind: 'project', key: 'alpha' }, memoryLayer: 'factual', importanceScore: 0.6, status: 'active',
        metadata: {}, createdAt: new Date(), accessCount: 0, expiryTimestamp: null,
      }));
      send({ role: 'writer', wrote: true });
    } else {
      await search('handoff'); // warm up
      const start = performance.now();
      let foundMs = null;
      while (performance.now() - start < 10000 + HANDOFF_DELAY_MS) {
        const r = await search('what was left in the alpha handoff');
        // The writer waits HANDOFF_DELAY_MS before writing, so subtract it: what is left is the travel time.
        if (r.some((x) => x.memory.id === 'handoff-note')) { foundMs = Math.max(0, Math.round(performance.now() - start - HANDOFF_DELAY_MS)); break; }
        await new Promise((r2) => setTimeout(r2, 25));
      }
      send({ role: 'reader', foundMs });
    }
  }

  if (job === 'isolation') {
    const beta = D.selectDrawers({ audience: 'owner', project: 'beta' });
    const inAlpha = await search('staging database password rotation');
    const inBeta = await search('staging database password rotation', beta);
    send({
      role: 'reader',
      leaks: inAlpha.filter((x) => x.memory.id === 'beta-secret').length,
      betaSeesOwn: inBeta.some((x) => x.memory.id === 'beta-secret'),
    });
  }
}
