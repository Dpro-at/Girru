import {fileURLToPath as backendFixtureFileURLToPath} from 'node:url';
// CORE-07: forgetting. "Forget this" removes a memory from search, the hybrid
// index, readable copies, exports, version text, proposals and summaries;
// only a tombstone stays. Retention rules are an explicit owner job.
// Run: node --import tsx --test test/memory-forget.test.mjs
// Throwaway DB + cwd, random test-only secrets, no network (fetch refused).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = backendFixtureFileURLToPath(new URL('../',import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'ap-memforget-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
delete process.env.MEMORY_SUMMARY_MODEL;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };

const quiet = { log: console.log, warn: console.warn };
console.log = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`).run(id, `${id}@example.test`, id, role);
addUser('mg-owner', 'owner');
addUser('mg-user', 'user');
db.prepare('UPDATE agents_config SET is_primary = 0').run();
db.prepare(`INSERT INTO agents_config (id, name, is_primary) VALUES ('mg-agent', 'Mg Agent', 1)`).run();
db.prepare(`INSERT INTO agents_config (id, name) VALUES ('mg-second', 'Mg Second')`).run();

const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { memoryRoutes } = await import(join(backendDir, 'src/api/routes/memory.ts'));
const { memoryFilesRoutes } = await import(join(backendDir, 'src/api/routes/memory-files.ts'));
const { memoryLearningRoutes } = await import(join(backendDir, 'src/api/routes/memory-learning.ts'));
const { getMemoryIndexer } = await import(join(backendDir, 'src/memory/indexer.ts'));
const { getMemoryStorage } = await import(join(backendDir, 'src/memory/storage.ts'));
const W = await import(join(backendDir, 'src/memory/weekly-summary.ts'));
const J = await import(join(backendDir, 'src/memory/jobs.ts'));
const R = await import(join(backendDir, 'src/memory/retention.ts'));
const D = await import(join(backendDir, 'src/memory/drawers.ts'));
const { MemoryTiersService } = await import(join(backendDir, 'src/services/memory-tiers.ts'));
const { memoryEditTool } = await import(join(backendDir, 'src/tools/memory/edit.ts'));
const { memoryForgetTool } = await import(join(backendDir, 'src/tools/memory/forget.ts'));
const { approvalCategory } = await import(join(backendDir, 'src/tools/approvals.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');

const app = Fastify();
registerAuthGate(app);
await app.register(memoryRoutes);
await app.register(memoryFilesRoutes);
await app.register(memoryLearningRoutes);
await app.ready();
console.log = quiet.log;
console.warn = quiet.warn;

test.after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  try { getMemoryIndexer().close(); } catch { /* not opened */ }
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const quietly = async (fn) => { const l = console.log; const w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };
const call = (method, url, who = 'mg-owner', payload) => quietly(() => app.inject({ method, url, headers: auth(who), payload }));

// UI-IP-04: approve/reject send back the reviewHash of the proposal as reviewed.
const reviewHashOf = async (id, who = 'mg-owner') => { const r = await call('GET', `/api/memory/proposals/${id}`, who); return r.statusCode === 200 ? r.json().reviewHash : undefined; };
const decide = async (id, action, who = 'mg-owner', payload = {}) => call('POST', `/api/memory/proposals/${id}/${action}`, who, { expectedReviewHash: await reviewHashOf(id, who), ...payload });
const create = async (who, content, extra = {}) => {
  const res = await call('POST', '/api/memory', who, { type: 'fact', content, importance: 7, ...extra });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().memory;
};

// Every row of every table, as text.
const dbText = () => {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name);
  return tables.map((t) => { try { return JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all()); } catch { return ''; } }).join('\n');
};
const filesText = (root) => {
  const out = [];
  const walk = (p) => {
    for (const name of readdirSync(p)) {
      const f = join(p, name);
      const st = statSync(f);
      if (st.isDirectory()) walk(f);
      else out.push(readFileSync(f).toString('latin1') + readFileSync(f, 'utf-8'));
    }
  };
  walk(root);
  return out.join('\n');
};

const SECRET = 'Zephyr-7731 kayak harbour plan';
let target, keep, pref, proposalId;

test('setup: memory in search, hybrid index, versions, copies, exports, proposal and summary', async () => {
  target = await create('mg-owner', SECRET, { drawer: { kind: 'project', key: 'alpha' } });
  keep = await create('mg-owner', 'Alpha deploys on Tuesdays', { drawer: { kind: 'project', key: 'alpha' } });
  // An edit: the old text sits in the version history.
  assert.equal((await call('PUT', `/api/memory/${target.id}`, 'mg-owner', { content: `${SECRET} v2` })).statusCode, 200);
  target = await getMemoryStorage().getOwned('mg-owner', target.id);
  // Hybrid index (vector + full text) holds it too.
  const indexer = getMemoryIndexer();
  await indexer.index({ ...target, layer: 'session', importance: 7, accessCount: 0 });
  await indexer.index({ ...keep, createdAt: new Date(keep.createdAt), layer: 'session', importance: 7, accessCount: 0 });
  assert.ok(indexer.getStats().totalMemories >= 2);
  // Exports in two agent folders.
  assert.equal((await call('POST', '/api/memory/files/project:alpha/export')).statusCode, 200);
  assert.equal((await call('POST', '/api/memory/files/project:alpha/export?agentId=mg-second')).statusCode, 200);
  assert.ok(readFileSync(join(dir, '.data/agents/mg-agent/memory/mg-owner/project--alpha.md'), 'utf-8').includes(SECRET));
  // A pending agent proposal that quotes it (an edit making it a money topic).
  const ctx = { workspaceDir: dir, userId: 'mg-owner', agentId: 'mg-agent', memoryDrawers: D.selectDrawers({ audience: 'owner', project: 'alpha' }) };
  const e = await quietly(() => memoryEditTool.execute({ id: target.id, content: `${SECRET} costs 500 dollars` }, ctx));
  assert.equal(e.data.pendingApproval, true);
  proposalId = e.data.proposalId;
  // A stored weekly summary that lists it.
  const rec = await W.runWeeklySummary('mg-owner', { summarizer: async () => ({ text: `Learned: ${SECRET}`, model: 'stub' }) });
  assert.ok(rec.text.includes(SECRET) && rec.modelText.includes(SECRET));
  // Found by search before.
  const found = (await call('POST', '/api/memory/search', 'mg-owner', { query: 'Zephyr kayak harbour', limit: 20 })).json().results;
  assert.ok(found.some((r) => r.memory.id === target.id));
  assert.ok(dbText().includes(SECRET));
  assert.ok(existsSync(join(dir, '.data/memory/mg-owner', `fact-${target.id}.md`)), 'per-memory copy written');
  pref = await create('mg-owner', 'Owner prefers green tea', { type: 'preference' });
});

test('forget: gone from search, index, copies, exports, versions, proposals, summaries; tombstone only', async () => {
  const res = await call('POST', `/api/memory/${target.id}/forget`);
  assert.equal(res.statusCode, 200, res.body);
  const out = res.json().forgotten;
  assert.equal(out.memoryId, target.id);
  assert.deepEqual(out.cancelledProposals, [proposalId]);
  assert.deepEqual(out.reexported.sort(), ['mg-agent', 'mg-second']);

  // Search / recall / list.
  const search = (await call('POST', '/api/memory/search', 'mg-owner', { query: 'Zephyr kayak harbour', limit: 20 })).json().results;
  assert.ok(!search.some((r) => r.memory.id === target.id));
  const relevant = (await call('GET', `/api/memory/relevant?query=${encodeURIComponent('Zephyr kayak harbour')}&project=alpha&limit=20`)).json().memories;
  assert.ok(!relevant.some((m) => m.id === target.id));
  assert.ok(!(await call('GET', '/api/memory')).json().memories.some((m) => m.id === target.id));
  assert.equal((await call('GET', `/api/memory/${target.id}`)).statusCode, 404);

  // Hybrid index rows (vector + full text) are gone; the other memory stays.
  const idx = getMemoryIndexer();
  const raw = idx.db;
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM memory_index WHERE memory_id = ?').get(target.id).n, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM memory_fts WHERE memory_id = ?').get(target.id).n, 0);
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM memory_fts WHERE memory_fts MATCH 'zephyr'`).get().n, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM memory_index WHERE memory_id = ?').get(keep.id).n, 1);

  // Exports re-written without it (both agent folders), per-memory copy removed.
  for (const agent of ['mg-agent', 'mg-second']) {
    const text = readFileSync(join(dir, `.data/agents/${agent}/memory/mg-owner/project--alpha.md`), 'utf-8');
    assert.ok(!text.includes(SECRET) && !text.includes(target.id), agent);
    assert.ok(text.includes('Alpha deploys on Tuesdays'));
  }
  assert.ok(!existsSync(join(dir, '.data/memory/mg-owner', `fact-${target.id}.md`)));

  // Versions: only a tombstone (id, time, actor), no text.
  const v = db.prepare('SELECT change, type, content, importance_score, created_by, reason FROM memory_versions WHERE memory_id = ?').all(target.id).map((r) => ({ ...r }));
  assert.deepEqual(v, [{ change: 'forget', type: null, content: null, importance_score: null, created_by: 'mg-owner', reason: null }]);
  assert.deepEqual((await call('GET', '/api/memory/forgotten')).json().tombstones.map((t) => [t.memoryId, t.drawerId, t.actor]), [[target.id, 'project:alpha', 'mg-owner']]);

  // Proposal cancelled and redacted; summary re-rendered without it.
  const p = (await call('GET', `/api/memory/proposals/${proposalId}`)).json();
  assert.equal(p.status, 'cancelled');
  assert.deepEqual(p.changes, [{ op: 'update', id: target.id, redacted: true }]);
  assert.equal((await decide(proposalId, 'approve')).statusCode, 409);
  const sum = (await call('GET', '/api/memory/weekly-summary')).json().summary;
  assert.ok(!sum.text.includes(SECRET) && sum.modelText === null);

  // Nowhere in any table, and not in any file under .data (DB file incl.).
  assert.ok(!dbText().includes('Zephyr-7731'), 'no table row keeps the text');
  assert.ok(!filesText(join(dir, '.data')).includes('Zephyr-7731'), 'no file keeps the text');
  // Audited by id only.
  const a = db.prepare(`SELECT resource_id, metadata FROM audit_logs WHERE action = 'memory.forget'`).get();
  assert.equal(a.resource_id, target.id);
  assert.ok(!String(a.metadata).includes('Zephyr'));
  // Forgetting twice: not found.
  assert.equal((await call('POST', `/api/memory/${target.id}/forget`)).statusCode, 404);
});

test('forget after a plain delete erases the kept history', async () => {
  const m = await create('mg-owner', 'Quokka-4410 travel note');
  assert.equal((await call('DELETE', `/api/memory/${m.id}`)).statusCode, 200);
  assert.ok(dbText().includes('Quokka-4410'), 'a plain delete keeps the history (reversible)');
  assert.equal((await call('POST', `/api/memory/${m.id}/forget`)).statusCode, 200);
  assert.ok(!dbText().includes('Quokka-4410'));
});

test('only the memory\'s own user forgets it; forget-all and retention are owner-only', async () => {
  const mine = await create('mg-user', 'Member private note Okapi-12');
  assert.equal((await call('POST', `/api/memory/${pref.id}/forget`, 'mg-user')).statusCode, 404, 'another user\'s memory');
  assert.ok(await getMemoryStorage().getOwned('mg-owner', pref.id));
  assert.equal((await call('POST', `/api/memory/${mine.id}/forget`, 'mg-owner')).statusCode, 404);
  assert.equal((await call('POST', `/api/memory/${mine.id}/forget`, 'mg-user')).statusCode, 200, 'own memory');
  for (const [method, url] of [['POST', '/api/memory/forget-all'], ['GET', '/api/memory/retention'], ['PUT', '/api/memory/retention'], ['POST', '/api/memory/retention/run']]) {
    assert.equal((await call(method, url, 'mg-user', method === 'GET' ? undefined : {})).statusCode, 403, url);
    assert.equal((await quietly(() => app.inject({ method, url, payload: method === 'GET' ? undefined : {} }))).statusCode, 401, url);
  }
  assert.equal((await quietly(() => app.inject({ method: 'POST', url: `/api/memory/${pref.id}/forget` }))).statusCode, 401);
});

test('forget-all: a drawer, with explicit confirmation', async () => {
  const b1 = await create('mg-owner', 'Beta note one', { drawer: { kind: 'project', key: 'beta' } });
  const b2 = await create('mg-owner', 'Beta note two', { drawer: { kind: 'project', key: 'beta' } });
  assert.equal((await call('POST', '/api/memory/forget-all', 'mg-owner', { drawer: 'project:beta' })).statusCode, 400, 'confirm missing');
  assert.equal((await call('POST', '/api/memory/forget-all', 'mg-owner', { drawer: 'project:..', confirm: 'FORGET' })).statusCode, 400);
  const res = await call('POST', '/api/memory/forget-all', 'mg-owner', { drawer: 'project:beta', confirm: 'FORGET' });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().memoryIds.sort(), [b1.id, b2.id].sort());
  assert.ok((await getMemoryStorage().getOwned('mg-owner', keep.id)) && (await getMemoryStorage().getOwned('mg-owner', pref.id)), 'other drawers kept');
  assert.ok(!dbText().includes('Beta note'));
});

test('memory_forget tool: needs one-time owner approval; own memory only; never in outsider turns', async () => {
  assert.equal(approvalCategory({ name: 'memory_forget' }), 'delete');
  const m = await create('mg-owner', 'Tapir-555 shopping list');
  const ctx = { workspaceDir: dir, userId: 'mg-owner', agentId: 'mg-agent' };
  const channel = { ...ctx, toolPolicy: { channel: 'telegram', allowedTools: new Set(['memory_forget']) } };
  assert.ok((await quietly(() => memoryForgetTool.execute({ id: m.id }, channel))).error);
  assert.ok((await quietly(() => memoryForgetTool.execute({ id: m.id }, { workspaceDir: dir }))).error);
  assert.ok((await quietly(() => memoryForgetTool.execute({ id: m.id }, { ...ctx, userId: 'mg-user' }))).error);
  assert.ok(await getMemoryStorage().getOwned('mg-owner', m.id));
  // Drawer scope: a task-only run cannot forget owner or project memories,
  // live or already deleted (history only).
  const taskOnly = { ...ctx, memoryDrawers: [{ kind: 'task', key: 't-x' }] };
  const r1 = await quietly(() => memoryForgetTool.execute({ id: m.id }, taskOnly));
  assert.match(r1.error, /not open/);
  const proj = await create('mg-owner', 'Kudu-88 project note', { drawer: { kind: 'project', key: 'gamma' } });
  assert.equal((await call('DELETE', `/api/memory/${proj.id}`)).statusCode, 200);
  assert.match((await quietly(() => memoryForgetTool.execute({ id: proj.id }, ctx))).error, /not open/, 'deleted project memory, project not open');
  assert.match((await quietly(() => memoryForgetTool.execute({ id: proj.id }, taskOnly))).error, /not open/);
  assert.ok(dbText().includes('Kudu-88'), 'history untouched');
  const gammaCtx = { ...ctx, memoryDrawers: D.selectDrawers({ audience: 'owner', project: 'gamma' }) };
  assert.ok((await quietly(() => memoryForgetTool.execute({ id: proj.id }, gammaCtx))).data?.success);
  assert.ok(!dbText().includes('Kudu-88'));
  assert.ok(await getMemoryStorage().getOwned('mg-owner', m.id));
  const ok = await quietly(() => memoryForgetTool.execute({ id: m.id }, ctx));
  assert.ok(ok.data?.success, ok.content?.[0]?.text);
  assert.ok(!ok.content[0].text.includes('Tapir'), 'result does not repeat the text');
  assert.equal(db.prepare(`SELECT created_by FROM memory_versions WHERE memory_id = ?`).get(m.id).created_by, 'agent:mg-agent');
  assert.ok(!dbText().includes('Tapir-555'));
});

const DAY = 24 * 60 * 60 * 1000;
async function oldMemory(content, drawer, ageDays, extra = {}) {
  const storage = getMemoryStorage();
  const id = `old-${Math.random().toString(36).slice(2)}`;
  await storage.save({
    id, userId: 'mg-owner', type: extra.type || 'fact', content, drawer, importanceScore: (extra.importance ?? 5) / 10,
    memoryLayer: 'factual', status: 'active', metadata: {}, createdAt: new Date(Date.now() - ageDays * DAY), accessCount: 0, expiryTimestamp: null,
  });
  return id;
}

test('retention: explicit owner job; task TTL summarizes + forgets, experience consolidated, important drawers untouched', async () => {
  // Orchestrator tasks: one finished long ago, one still running.
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, status TEXT, completed_at TEXT)`);
  db.prepare(`INSERT INTO tasks (id, status, completed_at) VALUES ('t-done', 'completed', ?), ('t-run', 'running', NULL)`).run(new Date(Date.now() - 200 * DAY).toISOString());
  const done = [await oldMemory('Done task step Ibex-1', { kind: 'task', key: 't-done' }, 210), await oldMemory('Done task step Ibex-2', { kind: 'task', key: 't-done' }, 205)];
  const running = await oldMemory('Running task note', { kind: 'task', key: 't-run' }, 300);
  const recent = await oldMemory('Recent task note', { kind: 'task', key: 't-new' }, 10); // no task row: last activity 10 days ago
  const exp = [await oldMemory('Lesson Gnu-1', { kind: 'experience' }, 400, { type: 'insight' }), await oldMemory('Lesson Gnu-2', { kind: 'experience' }, 390, { type: 'insight' }), await oldMemory('Lesson Gnu-3', { kind: 'experience' }, 380, { type: 'insight' })];
  const expImportant = await oldMemory('Key lesson kept', { kind: 'experience' }, 400, { type: 'insight', importance: 9 });
  const ownerOld = await oldMemory('Owner fact from long ago', { kind: 'owner' }, 2000);
  const peopleOld = await oldMemory('Person fact from long ago', { kind: 'people', key: 'p1' }, 2000);
  const exists = async (id) => !!(await getMemoryStorage().getOwned('mg-owner', id));
  const allExist = async (list) => (await Promise.all(list.map(exists))).every(Boolean);
  const noneExist = async (list) => !(await Promise.all(list.map(exists))).some(Boolean);

  // Defaults: off; the scheduled job does nothing (but the run is recorded).
  const cfg = (await call('GET', '/api/memory/retention')).json();
  assert.deepEqual(cfg.config, { enabled: false, taskTtlDays: 90, experienceAfterDays: 180, experienceMinGroup: 3 });
  const off = await J.runMemoryJob({ job: 'retention', userId: 'mg-owner' });
  assert.equal(off.skipped, 'disabled');
  assert.ok(await allExist([...done, running, recent, ...exp]));

  // Dry run: reports, changes nothing.
  const dry = (await call('POST', '/api/memory/retention/run', 'mg-owner', { dryRun: true })).json();
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.actions.map((a) => [a.kind, a.drawerId, a.items]), [['task-summary', 'task:t-done', 2], ['experience-consolidation', 'experience', 3]]);
  assert.ok(await allExist([...done, ...exp]));

  // Validation, then turn it on.
  assert.equal((await call('PUT', '/api/memory/retention', 'mg-owner', { taskTtlDays: 0 })).statusCode, 400);
  assert.equal((await call('PUT', '/api/memory/retention', 'mg-owner', { enabled: 'yes' })).statusCode, 400);
  const put = await call('PUT', '/api/memory/retention', 'mg-owner', { enabled: true, taskTtlDays: 30 });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal(put.json().config.taskTtlDays, 30);

  const ran = await J.runMemoryJob({ job: 'retention', userId: 'mg-owner' });
  assert.equal(ran.skipped, null);
  assert.equal(ran.forgotten, 5);
  assert.ok((await noneExist(done)) && (await noneExist(exp)), 'originals forgotten');
  assert.ok(await allExist([running, recent, expImportant, ownerOld, peopleOld]), 'running/recent tasks, important lessons, owner and people drawers kept');
  for (const id of [...done, ...exp]) {
    assert.deepEqual(db.prepare('SELECT change, content FROM memory_versions WHERE memory_id = ?').all(id).map((r) => [r.change, r.content]), [['forget', null]]);
  }
  const summaries = (await getMemoryStorage().getByDrawers('mg-owner', [{ kind: 'experience' }])).filter((m) => m.metadata?.source === 'retention');
  assert.equal(summaries.length, 2);
  const taskSummary = summaries.find((m) => m.metadata.retention === 'task-summary');
  assert.match(taskSummary.content, /^Summary of task t-done \(2 items, /);
  assert.ok(taskSummary.content.includes('Done task step Ibex-1'));
  assert.equal(summaries.find((m) => m.metadata.retention === 'experience-consolidation').type, 'insight');

  // Recorded (counts only) and audited; a second run finds nothing new.
  const runs = (await call('GET', '/api/memory/retention')).json().runs;
  assert.ok(runs.length >= 3);
  assert.ok(!JSON.stringify(runs).includes('Ibex') && !JSON.stringify(runs).includes('Gnu'));
  assert.ok(db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'memory_retention.run'`).get());
  const again = await J.runMemoryJob({ job: 'retention', userId: 'mg-owner' });
  assert.equal(again.forgotten, 0);
  await assert.rejects(() => J.runMemoryJob({ job: 'retention', userId: 'mg-user' }), /owner/);
});

test('tier expiry never removes owner, project or people memories (forgetting rule 1)', async () => {
  const storage = getMemoryStorage();
  const base = { userId: 'mg-owner', type: 'fact', memoryLayer: 'working', status: 'active', metadata: {}, createdAt: new Date(), accessCount: 0, importanceScore: 0.3, expiryTimestamp: Date.now() - 1000 };
  await storage.save({ ...base, id: 'exp-owner', content: 'expired owner note', drawer: { kind: 'owner' } });
  await storage.save({ ...base, id: 'exp-people', content: 'expired people note', drawer: { kind: 'people', key: 'p2' } });
  await storage.save({ ...base, id: 'exp-task', content: 'expired task note', drawer: { kind: 'task', key: 't9' } });
  await quietly(() => MemoryTiersService.expireWorkingMemory());
  assert.ok((await storage.getOwned('mg-owner', 'exp-owner')) && (await storage.getOwned('mg-owner', 'exp-people')));
  assert.equal(await storage.getOwned('mg-owner', 'exp-task'), null);
});

test('embeddings keep no vocabulary of seen words (no cache of forgotten text)', async () => {
  const { getEmbeddingService } = await import(join(backendDir, 'src/memory/embedding.ts'));
  const svc = getEmbeddingService();
  assert.equal(svc.vocabulary, undefined);
  const a = await svc.embed('stable vector words');
  const b = await svc.embed('stable vector words');
  assert.deepEqual(a, b);
});

test('CORE-07b: an approved memory_forget re-runs with the turn\'s stored drawer scope, never wider', async () => {
  const tools = await import(join(backendDir, 'src/tools/index.ts'));
  const A = await import(join(backendDir, 'src/tools/approvals.ts'));
  const S = await import(join(backendDir, 'src/tools/memory/scope.ts'));
  const inDelta = await create('mg-owner', 'Okapi-31 delta note', { drawer: { kind: 'project', key: 'delta' } });
  const inEps = await create('mg-owner', 'Okapi-32 epsilon note', { drawer: { kind: 'project', key: 'epsilon' } });
  const turn = { workspaceDir: dir, userId: 'mg-owner', agentId: 'mg-agent', sessionId: 's-07b', taskId: 'task-07b', memoryDrawers: D.selectDrawers({ audience: 'owner', project: 'delta' }) };
  const ask = async (id, ctx = turn) => {
    const res = await quietly(() => tools.createToolsRegistry(ctx).execute('memory_forget', { id }));
    assert.equal(res.details?.status, 'pending_approval', res.content?.[0]?.text);
    return res.details.approvalId;
  };
  const approveIt = async (id) => {
    const full = await A.getApprovalDetail(id);
    return quietly(() => A.approveAndRun(id, 'mg-owner', full.paramsHash));
  };

  // The owner sees the scope; it is bound by the hash.
  const a1 = await ask(inDelta.id);
  const full = await A.getApprovalDetail(a1);
  assert.deepEqual(full.runScope, { memoryDrawers: [{ kind: 'owner' }, { kind: 'experience' }, { kind: 'project', key: 'delta' }], taskId: 'task-07b' });
  // Project delta memory: reachable because the turn had delta open.
  const r1 = await approveIt(a1);
  assert.equal(r1.record.status, 'executed', r1.result.content?.[0]?.text);
  assert.ok(!(await getMemoryStorage().getOwned('mg-owner', inDelta.id)));

  // Same turn asking for an epsilon memory: still refused after approval.
  const a2 = await ask(inEps.id);
  const r2 = await approveIt(a2);
  assert.equal(r2.record.status, 'failed');
  assert.match(r2.result.error, /not open/);
  assert.ok(await getMemoryStorage().getOwned('mg-owner', inEps.id));

  // Widening the stored scope after the request breaks the hash: nothing runs.
  const a3 = await ask(inEps.id);
  const shown = (await A.getApprovalDetail(a3)).paramsHash;
  db.prepare('UPDATE tool_approvals SET run_scope = ? WHERE id = ?')
    .run(JSON.stringify({ memoryDrawers: [{ kind: 'project', key: 'epsilon' }] }), a3);
  const r3 = await quietly(() => A.approveAndRun(a3, 'mg-owner', shown));
  assert.equal(r3.record.status, 'failed');
  // Removing the stored scope (to fall back to the default) breaks it too.
  const a3n = await ask(inEps.id);
  const shownN = (await A.getApprovalDetail(a3n)).paramsHash;
  db.prepare('UPDATE tool_approvals SET run_scope = NULL WHERE id = ?').run(a3n);
  assert.equal((await quietly(() => A.approveAndRun(a3n, 'mg-owner', shownN))).record.status, 'failed');
  assert.ok(await getMemoryStorage().getOwned('mg-owner', inEps.id));

  // Approval-time intersection: an outsider policy allows no drawers; bad entries dropped.
  assert.deepEqual(S.approvalRunDrawers([{ kind: 'project', key: 'epsilon' }], { toolPolicy: { channel: 'telegram' } }), []);
  assert.deepEqual(S.approvalRunDrawers([{ kind: 'project', key: '..' }, { kind: 'owner' }, { kind: 'owner' }, { kind: 'nope' }], {}), [{ kind: 'owner' }]);
  assert.deepEqual(S.approvalRunDrawers('owner', {}), []);
  const many = Array.from({ length: 15 }, (_, i) => ({ kind: 'people', key: `p-${i}` }));
  assert.equal(S.approvalRunDrawers(many, {}).length, 10);

  // A turn whose drawers did not include the owner drawer: the approved call cannot reach it either.
  const own = await create('mg-owner', 'Okapi-33 owner note');
  const a4 = await ask(own.id, { ...turn, memoryDrawers: [{ kind: 'task', key: 'task-07b' }] });
  const r4 = await approveIt(a4);
  assert.equal(r4.record.status, 'failed');
  assert.ok(await getMemoryStorage().getOwned('mg-owner', own.id));
  // An epsilon turn reaches the epsilon memory.
  const a5 = await ask(inEps.id, { ...turn, memoryDrawers: D.selectDrawers({ audience: 'owner', project: 'epsilon' }) });
  assert.equal((await approveIt(a5)).record.status, 'executed');
  assert.ok(!(await getMemoryStorage().getOwned('mg-owner', inEps.id)));
});
