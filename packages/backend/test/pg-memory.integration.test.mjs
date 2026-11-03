// B2.2b-4: memory on PostgreSQL, end to end: drawers, add and recall (the
// multilingual CORE-06 set, with the same ranking as SQLite), proposals with
// reviewHash and concurrent decisions, forget and tombstones (one
// transaction, files after the commit), retention, an idempotent import
// batch, embedding round trips (JSON text and bytea), the hybrid index full
// text (tsvector 'simple' + GIN, pg_trgm only when installed), the memory
// services (tiers, consolidation, deduplication, enrichment, quality,
// sharing) and the owner/agent/outsider scope rules (S0-A.14).
// Runs ONLY when AGENT_PLAYER_PG_TEST_URL names a THROWAWAY database on
// 127.0.0.1 that the PostgreSQL runner has already migrated (it writes test
// rows and never cleans up: drop the database afterwards). Otherwise every
// test skips. scripts/pg/integration.sh runs it.
//
// The SQLite file (a temp file, never the real .data) is watched: any
// statement on a memory table that reaches SQLite is a failure (last test),
// except inside the one window where the test runs the same recall on
// SQLite on purpose to compare the ranking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const URL_ = process.env.AGENT_PLAYER_PG_TEST_URL;
const skip = URL_ ? false : 'AGENT_PLAYER_PG_TEST_URL is not set (PostgreSQL integration test)';
const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SET = JSON.parse(readFileSync(join(backendDir, 'test/fixtures/recall-set.json'), 'utf-8'));

const MEMORY_TABLES = /\b(memories|memory_versions|memory_file_proposals|memory_weekly_summaries|memory_retention_config|memory_retention_runs|memory_import_batches|memory_import_previews|memory_import_settings|memory_sharing_audit|memory_quality_history|memory_relationships|memory_enrichment_log|memory_consolidation_log|memory_deduplication_log|memory_index|memory_chunks|memory_relations|mcp_grant_bindings)\b/i;
const sqliteHits = [];
let watch = true;

let m = {};
let dir;
if (URL_) {
  dir = mkdtempSync(join(tmpdir(), 'ap-pg-memory-'));
  mkdirSync(join(dir, '.data'), { recursive: true });
  process.chdir(dir);
  process.env.HOME = dir;
  // SQLite still backs the modules that are not ported yet: a temp file, never the real .data.
  process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
  process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
  process.env.MEMORY_EMBEDDINGS = 'hash'; // no network
  process.env.AGENT_PLAYER_DB = 'postgres';
  process.env.AGENT_PLAYER_PG_URL = URL_;
  process.env.AGENT_PLAYER_PG_POOL_MAX = '8';
  delete process.env.OUTSIDER_AGENT_MEMORY;

  const quiet = { log: console.log, warn: console.warn };
  console.log = () => {}; console.warn = () => {};
  const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
  await getDatabase({ path: process.env.DATABASE_PATH }).initialize(); // B2.2d-17: an explicit temp SQLite file, watched for strays
  console.log = quiet.log; console.warn = quiet.warn;
  // Watch SQLite: a memory table must never be touched there on PostgreSQL.
  const mgr = getDatabase();
  const raw = mgr.getDb();
  for (const target of [mgr, raw]) {
    const original = target.prepare;
    target.prepare = function (sql) {
      if (watch && MEMORY_TABLES.test(String(sql))) sqliteHits.push(String(sql).replace(/\s+/g, ' ').slice(0, 120));
      return original.call(this, sql);
    };
  }
  m = {
    closeDatabase,
    pool: await import('../src/db/pg/pool.ts'),
    repos: await import('../src/repositories/index.ts'),
    actor: await import('../src/repositories/actor.ts'),
    users: (await import('../src/repositories/pg/users-store.ts')).pgUsersStore,
    storage: (await import('../src/memory/storage.ts')).getMemoryStorage(),
    drawers: await import('../src/memory/drawers.ts'),
    files: await import('../src/memory/memory-files.ts'),
    forget: await import('../src/memory/forget.ts'),
    retention: await import('../src/memory/retention.ts'),
    weekly: await import('../src/memory/weekly-summary.ts'),
    pipeline: await import('../src/memory/import/pipeline.ts'),
    reembed: await import('../src/memory/reembed.ts'),
    learning: await import('../src/memory/learning.ts'),
    indexerPg: await import('../src/memory/indexer-pg.ts'),
    embedding: await import('../src/memory/embedding.ts'),
    tiers: (await import('../src/services/memory-tiers.ts')).MemoryTiersService,
    consolidation: (await import('../src/services/memory-consolidation.ts')).getConsolidationService(),
    dedup: await import('../src/services/memory-deduplication.ts'),
    scope: await import('../src/repositories/scope.ts'),
    steps: await import('../src/repositories/sql-steps.ts'),
  };
}

const tag = randomBytes(4).toString('hex');
const one = (sql, ...p) => m.pool.pgOne(sql, ...p);
const all = (sql, ...p) => m.pool.pgAll(sql, ...p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = async (fn) => {
  const s = { log: console.log, warn: console.warn, info: console.info };
  console.log = () => {}; console.warn = () => {}; console.info = () => {};
  try { return await fn(); } finally { Object.assign(console, s); }
};

/** Hold a row lock on a second pool client while `work` starts, so the concurrent calls inside overlap. */
async function withHeldLock(lockSql, params, work, ms = 250) {
  const pool = await m.pool.getPgPool();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(lockSql, params);
    const pending = work();
    await sleep(ms);
    await c.query('COMMIT');
    return await pending;
  } finally {
    c.release();
  }
}

const A = {};
const ids = {};
const repo = () => m.repos.repositories.memory;
const memoryInput = (content, extra = {}) => ({
  id: `${tag}-${randomBytes(6).toString('hex')}`, type: 'fact', content, importanceScore: 0.5, memoryLayer: 'factual',
  status: 'active', metadata: {}, createdAt: new Date(), accessCount: 0, ...extra,
});

test.before(async () => {
  if (!URL_) return;
  const mk = (role) => m.users.create({ email: `${role}-${tag}@pg.test`, username: `${role}_${tag}`, password: `pw-${randomBytes(8).toString('hex')}`, role });
  const owner = await mk('owner');
  const admin = await mk('admin');
  A.owner = m.actor.userActor({ id: owner.id, role: 'owner' });
  A.admin = m.actor.userActor({ id: admin.id, role: 'admin' });
  ids.owner = owner.id;
  ids.admin = admin.id;
  const agent = await silent(() => m.repos.repositories.agents.createConfig(A.owner, { name: `Memory Agent ${tag}`, description: 'memory tests' }));
  ids.agent = agent.id;
  await silent(() => m.storage.initialize());
});

test.after(async () => {
  if (!URL_) return;
  await m.pool.closePgPool();
  m.closeDatabase();
  process.chdir(backendDir);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Drawers
// ---------------------------------------------------------------------------

test('drawers: create validates and defaults by type, lists with counts, backfill on PostgreSQL', { skip }, async () => {
  const r = repo();
  const owner = await silent(() => r.create(A.owner, memoryInput(`Owner prefers window seats ${tag}`), 'test'));
  const skill = await silent(() => r.create(A.owner, memoryInput(`Deploy with blue green ${tag}`, { type: 'skill' }), 'test'));
  const alpha = await silent(() => r.create(A.owner, memoryInput(`Alpha ships on Fridays ${tag}`, { drawer: { kind: 'project', key: 'alpha' } }), 'test'));
  await silent(() => r.create(A.owner, memoryInput(`Ali likes chess ${tag}`, { drawer: { kind: 'people', key: 'p-ali' } }), 'test'));
  ids.drawerOwner = owner.id;
  assert.deepEqual(owner.drawer, { kind: 'owner' });
  assert.deepEqual(skill.drawer, { kind: 'experience' });
  const stored = await one('SELECT drawer_kind, drawer_key, created_at FROM memories WHERE id = ?', alpha.id);
  assert.deepEqual({ kind: stored.drawer_kind, key: stored.drawer_key }, { kind: 'project', key: 'alpha' });
  await assert.rejects(() => r.create(A.owner, memoryInput('x', { drawer: { kind: 'project', key: 'Bad Key!' } }), 'test'), m.drawers.DrawerInputError);
  const list = (await r.drawers(A.owner)).map((d) => `${m.drawers.drawerId(d)}=${d.count}`);
  for (const want of ['experience=1', 'owner=1', 'people:p-ali=1', 'project:alpha=1']) assert.ok(list.includes(want), `${want} in ${list}`);
  // A row saved before drawers (NULL drawer) gets the type default; idempotent.
  await m.pool.pgRun(`INSERT INTO memories (id, user_id, type, content, created_at) VALUES (?, ?, 'insight', 'legacy insight', ?)`, `${tag}-legacy`, ids.owner, new Date().toISOString());
  const first = await silent(() => m.drawers.backfillMemoryDrawers());
  assert.ok(first.experience >= 1);
  assert.deepEqual(await m.drawers.backfillMemoryDrawers(), { owner: 0, experience: 0 });
  assert.deepEqual({ ...(await one('SELECT drawer_kind, drawer_key FROM memories WHERE id = ?', `${tag}-legacy`)) }, { drawer_kind: 'experience', drawer_key: '' });
  // An agent run reads only its open drawers.
  const agentRun = await m.actor.actorFromToolContextAsync({ userId: ids.owner, agentId: ids.agent, memoryDrawers: m.drawers.selectDrawers({ audience: 'owner', project: 'alpha' }) });
  const seen = (await r.list(agentRun)).map((x) => x.id);
  assert.ok(seen.includes(alpha.id) && seen.includes(owner.id));
  assert.ok(!(await r.drawers(agentRun)).some((d) => d.kind === 'people'), 'people drawer not open for the run');
});

// ---------------------------------------------------------------------------
// Add and recall: the CORE-06 multilingual set, same ranking as SQLite
// ---------------------------------------------------------------------------

const OPEN = () => m.drawers.selectDrawers({ audience: 'owner' });
const recallUser = () => `rc-${tag}`;
const idOf = (mid) => `${recallUser()}-${mid}`;
const createdAt = new Date('2026-10-01T10:00:00.000Z');

async function seedRecall() {
  for (const [i, x] of SET.memories.entries()) {
    await silent(() => m.storage.save({
      id: idOf(x.id), userId: recallUser(), type: 'fact', content: x.content, drawer: x.drawer,
      memoryLayer: 'factual', importanceScore: 0.5, status: 'active', metadata: {},
      createdAt: new Date(createdAt.getTime() + i * 1000), accessCount: 0, expiryTimestamp: null,
    }));
  }
}

async function runSet(queries) {
  const out = [];
  for (const q of queries) {
    const results = await m.storage.search({ query: q.query, userId: recallUser(), drawers: OPEN(), limit: 10 });
    out.push({ q, results: results.map((r) => ({ id: r.memory.id, s: r.similarity })) });
  }
  return out;
}

test('recall: the multilingual set (MSA, Iraqi, English, German) on PostgreSQL; Arabic and English queries find their targets', { skip }, async (t) => {
  m.embedding.resetEmbeddingService();
  assert.equal(m.embedding.getEmbeddingService().targetModel(), 'hash-v2');
  await seedRecall();
  const offline = SET.queries.filter((q) => q.offline === true);
  const rows = await runSet(offline);
  const misses = rows.filter((r) => !r.q.targets.some((tid) => r.results.slice(0, 3).some((x) => x.id === idOf(tid))))
    .map((r) => `${r.q.id} "${r.q.query}"`);
  assert.deepEqual(misses, [], 'every offline target in the top 3');
  for (const lang of ['ar', 'en', 'iq', 'de']) assert.ok(rows.some((r) => r.q.lang === lang), lang);
  // Negatives stay below the weakest positive target.
  const posMin = Math.min(...rows.map((r) => r.results.find((x) => r.q.targets.some((tid) => idOf(tid) === x.id)).s));
  const neg = await runSet(SET.queries.filter((q) => q.negative));
  const negMax = Math.max(0, ...neg.map((r) => r.results[0]?.s ?? 0));
  t.diagnostic(`PostgreSQL offline: weakest positive ${posMin.toFixed(3)}, strongest negative ${negMax.toFixed(3)}`);
  assert.ok(negMax < posMin);
  // An Arabic and an English query by name.
  const ar = await m.storage.search({ query: 'أين يسكن محمد؟', userId: recallUser(), drawers: OPEN(), limit: 3 });
  assert.equal(ar[0]?.memory.id, idOf('m08'));
  const en = await m.storage.search({ query: 'green tea in the morning', userId: recallUser(), drawers: OPEN(), limit: 3 });
  assert.equal(en[0]?.memory.id, idOf('m02'));
});

test('recall ranking is identical on SQLite and PostgreSQL (same rows, same JS scoring)', { skip }, async () => {
  const queries = SET.queries.filter((q) => q.offline !== undefined || q.negative);
  const pg = await runSet(queries);
  // The same rows in the temp SQLite file, then the same searches there.
  watch = false;
  process.env.AGENT_PLAYER_DB = 'sqlite';
  let sq;
  try {
    await silent(() => m.storage.initialize());
    await seedRecall();
    sq = await runSet(queries);
  } finally {
    process.env.AGENT_PLAYER_DB = 'postgres';
    watch = true;
  }
  assert.equal(pg.length, sq.length);
  for (let i = 0; i < pg.length; i++) assert.deepEqual(pg[i].results, sq[i].results, `${pg[i].q.id} "${pg[i].q.query}"`);
});

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

test('embeddings: JSON text vectors round-trip exactly; bytea (Float32) in the hybrid index', { skip }, async () => {
  const vector = [0.5, -1.25, 3.0e-8, 0.1, 123.456];
  const mem = memoryInput(`Vector round trip ${tag}`, { embedding: vector, embeddingModel: 'custom-test' });
  await silent(() => m.storage.save({ ...mem, userId: ids.owner }));
  const back = await m.storage.getOwned(ids.owner, mem.id);
  // STORE-MAP-01 P3: with GIRRU_STORE_P3 on the vector is stored as Float32 bytes, so it comes back at Float32 precision.
  const p3 = /^(1|true|yes|on)$/i.test(process.env.GIRRU_STORE_P3 ?? '');
  assert.deepEqual(back.embedding, p3 ? Array.from(new Float32Array(vector)) : vector);
  assert.equal((await one('SELECT embedding_dims FROM memories WHERE id = ?', mem.id)).embedding_dims, 5);
  // Hybrid index: Float32 bytes in a bytea column.
  const idx = m.indexerPg.getPgMemoryIndexer();
  await idx.index({ ...back, layer: 'session', importance: 7, accessCount: 0, embedding: vector });
  const row = await one(`SELECT embedding, pg_typeof(embedding)::text AS t, octet_length(embedding) AS n FROM memory_index WHERE memory_id = ?`, mem.id);
  assert.equal(row.t, 'bytea');
  assert.equal(row.n, vector.length * 4);
  assert.ok(Buffer.isBuffer(row.embedding));
  const f32 = Array.from(new Float32Array(vector));
  assert.deepEqual(m.indexerPg.bufferToEmbedding(row.embedding), f32);
  // Status and re-embedding on PostgreSQL: the custom vector is "stale" for the hash model.
  const status = await m.reembed.embeddingStatus(ids.owner);
  assert.ok(status.stale >= 1);
  const res = await silent(() => m.reembed.reembedUserMemories(ids.owner));
  assert.ok(res.reembedded >= 1);
  assert.equal((await m.reembed.embeddingStatus(ids.owner)).stale, 0);
  assert.equal((await m.storage.getOwned(ids.owner, mem.id)).embeddingModel, 'hash-v2');
});

// ---------------------------------------------------------------------------
// Hybrid index full text: tsvector 'simple' + GIN; pg_trgm only when installed
// ---------------------------------------------------------------------------

test('hybrid index full text: Arabic and English, no stemming, safe query syntax, GIN index; pg_trgm availability', { skip }, async (t) => {
  const idx = m.indexerPg.getPgMemoryIndexer();
  const docs = {
    ar: memoryInput(`يحب محمد القهوة العربية في الصباح ${tag}`, { tags: ['قهوة', 'morning'] }),
    en: memoryInput(`Mohamed drinks strong coffee before work ${tag}`, { tags: ['coffee'] }),
    de: memoryInput(`Die Miete wird am Monatsanfang überwiesen ${tag}`),
  };
  for (const d of Object.values(docs)) await idx.index({ ...d, userId: ids.owner, layer: 'session', importance: 6, accessCount: 0 });
  const hit = async (q) => (await idx.keywordSearch(q, 20)).map((r) => r.memoryId);
  assert.ok((await hit('القهوة')).includes(docs.ar.id), 'Arabic word');
  assert.ok(!(await hit('القهوة')).includes(docs.en.id));
  assert.ok((await hit('coffee')).includes(docs.en.id), 'English word');
  assert.ok((await hit('COFFEE work')).includes(docs.en.id), 'case-insensitive, words ANDed');
  assert.ok(!(await hit('coffee tea')).includes(docs.en.id), 'AND: tea is missing');
  assert.ok((await hit('coffee OR tea')).includes(docs.en.id), 'OR like FTS5');
  assert.ok((await hit('قهوة')).includes(docs.ar.id), 'tags are indexed');
  assert.ok((await hit('überwiesen')).includes(docs.de.id), 'German umlaut word');
  assert.ok(!(await hit('drink')).includes(docs.en.id), "'simple': no English stemming (FTS5 porter would match)");
  assert.deepEqual(await hit('"unterminated (( AND OR -'), [], 'odd syntax never throws');
  const ranked = await idx.keywordSearch('coffee', 20);
  for (const r of ranked) assert.ok(r.score > 0 && r.score <= 1);
  // The generated column and its GIN index exist.
  const col = await one(`SELECT data_type, is_generated FROM information_schema.columns WHERE table_name = 'memory_index' AND column_name = 'fts'`);
  assert.equal(col.data_type, 'tsvector');
  assert.equal(col.is_generated, 'ALWAYS');
  const gin = await one(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_memory_index_fts'`);
  assert.match(gin.indexdef, /USING gin \(fts\)/);
  // The hybrid search combines vector and keyword scores.
  const embedded = await m.embedding.getEmbeddingService().embed('coffee before work');
  const hybrid = await idx.search('coffee', embedded, 5);
  assert.equal(hybrid[0]?.memory.id, docs.en.id);

  // pg_trgm: is it on the server, trusted (no superuser), and may this role create it?
  const avail = await one(`SELECT name, default_version FROM pg_available_extensions WHERE name = 'pg_trgm'`);
  const trusted = await one(`SELECT bool_or(trusted) AS trusted FROM pg_available_extension_versions WHERE name = 'pg_trgm'`);
  const role = await one(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`);
  let created = false;
  let createError = null;
  if (avail) {
    try {
      await m.pool.withPgTransaction(async () => {
        await m.pool.pgRun('CREATE EXTENSION IF NOT EXISTS pg_trgm');
        created = true;
      });
    } catch (err) {
      createError = err?.code ?? 'error';
    }
  }
  t.diagnostic(`pg_trgm: available=${!!avail} trusted=${trusted?.trusted ?? null} role_superuser=${role?.rolsuper} created=${created} error=${createError}`);
  if (created) {
    // Runtime code never creates it; when present, a typo still finds the row.
    const fresh = new m.indexerPg.PgMemoryIndexer();
    assert.equal(await fresh.hasTrgm(), true);
    const fuzzy = await fresh.keywordSearch(`Mohamed drinks strong cofee before work ${tag}`, 5);
    assert.ok(fuzzy.some((r) => r.memoryId === docs.en.id && r.fuzzy === true), 'trigram fallback');
  }
});

// ---------------------------------------------------------------------------
// Proposals: reviewHash, concurrent decisions
// ---------------------------------------------------------------------------

async function addProposal(content, drawer = { kind: 'owner' }) {
  return m.files.createChangeProposal({
    userId: ids.owner, agentId: ids.agent, drawer, source: 'learning', reasons: ['owner-preference'], createdBy: 'test',
    changes: [{ op: 'add', after: { type: 'preference', importance: 8, content } }],
  });
}

test('proposals: reviewHash required and checked; owner only', { skip }, async () => {
  const p = await addProposal(`Prefers aisle seats ${tag}`);
  assert.match(p.reviewHash, /^[0-9a-f]{64}$/);
  assert.equal((await repo().proposal(A.owner, p.id)).reviewHash, p.reviewHash);
  await assert.rejects(() => repo().approveProposal(A.owner, p.id, undefined), (e) => e.code === 'review_hash_required' && e.status === 400);
  await assert.rejects(() => repo().approveProposal(A.owner, p.id, 'f'.repeat(64)), (e) => e.code === 'review_changed' && e.status === 409);
  await assert.rejects(() => repo().proposal(A.admin, p.id), (e) => e instanceof m.scope.ScopeError && e.status === 403);
  const rejected = await repo().rejectProposal(A.owner, p.id, p.reviewHash, 'no');
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.decidedAt, /Z$/);
  await assert.rejects(() => repo().rejectProposal(A.owner, p.id, p.reviewHash), (e) => e.code === 'already_decided');
});

test('proposals: concurrent double approve on two connections -> one memory, one 409 already_decided', { skip }, async () => {
  const text = `Prefers the quarterly report in Arabic and English ${tag}`;
  const p = await addProposal(text);
  const results = await withHeldLock('SELECT id FROM memory_file_proposals WHERE id = $1 FOR UPDATE', [p.id],
    () => Promise.allSettled([1, 2].map(() => silent(() => repo().approveProposal(A.owner, p.id, p.reviewHash)))));
  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.reason?.message)));
  assert.equal(bad.length, 1);
  assert.equal(bad[0].reason.code, 'already_decided');
  assert.equal(bad[0].reason.status, 409);
  assert.equal((await one('SELECT COUNT(*) AS n FROM memories WHERE content = ? AND user_id = ?', text, ids.owner)).n, 1);
  assert.equal((await one('SELECT status FROM memory_file_proposals WHERE id = ?', p.id)).status, 'approved');
  assert.equal((await one(`SELECT COUNT(*) AS n FROM memory_versions WHERE proposal_id = ? AND change = 'create'`, p.id)).n, 1);
});

test('proposals: approve and reject at the same time -> exactly one decision', { skip }, async () => {
  const p = await addProposal(`Likes window tables ${tag}`);
  const results = await withHeldLock('SELECT id FROM memory_file_proposals WHERE id = $1 FOR UPDATE', [p.id],
    () => Promise.allSettled([
      silent(() => repo().approveProposal(A.owner, p.id, p.reviewHash)),
      repo().rejectProposal(A.owner, p.id, p.reviewHash, 'no'),
    ]));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'already_decided');
  const status = (await one('SELECT status FROM memory_file_proposals WHERE id = ?', p.id)).status;
  const n = (await one('SELECT COUNT(*) AS n FROM memories WHERE content = ?', `Likes window tables ${tag}`)).n;
  assert.equal(n, status === 'approved' ? 1 : 0);
});

test('proposals: two approvals in one drawer at the same time get distinct revisions', { skip }, async () => {
  const drawer = { kind: 'project', key: `rev-${tag}` };
  const a = await addProposal(`Revision one ${tag}`, drawer);
  const b = await addProposal(`Revision two ${tag}`, drawer);
  const out = await Promise.all([a, b].map((p) => silent(() => repo().approveProposal(A.owner, p.id, p.reviewHash))));
  assert.deepEqual(out.map((r) => r.revision).sort(), [1, 2]);
  const revs = await all(`SELECT DISTINCT drawer_revision AS r FROM memory_versions WHERE user_id = ? AND drawer_kind = 'project' AND drawer_key = ? ORDER BY 1`, ids.owner, drawer.key);
  assert.deepEqual(revs.map((x) => x.r), [1, 2]);
});

test('drawer file: export, edited upload -> proposal -> approve (file proposal, base hash)', { skip }, async () => {
  const drawer = { kind: 'project', key: `file-${tag}` };
  const mem = await silent(() => repo().create(A.owner, memoryInput(`File entry one ${tag}`, { drawer }), 'test'));
  const view = await silent(() => repo().exportDrawer(A.owner, ids.agent, drawer));
  assert.equal(view.count, 1);
  const edited = view.content.replace(`File entry one ${tag}`, `File entry one, edited ${tag}`) + `\n### new | fact | importance 6\nFile entry two ${tag}\n`;
  const p = await repo().createProposal(A.owner, { agentId: ids.agent, drawer, text: edited, source: 'upload', note: null });
  assert.deepEqual(p.changes.map((c) => c.op).sort(), ['add', 'update']);
  const res = await silent(() => repo().approveProposal(A.owner, p.id, p.reviewHash));
  assert.equal(res.applied.updated[0], mem.id);
  assert.equal((await m.storage.getOwned(ids.owner, mem.id)).content, `File entry one, edited ${tag}`);
  // A stale file (base hash of the old content) is refused.
  await assert.rejects(() => repo().createProposal(A.owner, { agentId: ids.agent, drawer, text: edited, source: 'upload', note: null }), (e) => e.status === 409);
  const history = await repo().drawerHistory(A.owner, drawer);
  assert.ok(history.some((h) => h.change === 'create') && history.some((h) => h.change === 'update' && h.proposalId === p.id));
  assert.ok(history.every((h) => typeof h.memoryId === 'string' && typeof h.drawerRevision === 'number'), 'camelCase aliases kept on PostgreSQL');
});

// ---------------------------------------------------------------------------
// Forget and tombstones
// ---------------------------------------------------------------------------

test('forget: one transaction removes row, history, index rows, proposals text and summaries; tombstone only', { skip }, async () => {
  const drawer = { kind: 'project', key: `fg-${tag}` };
  const SECRET = `Zephyr-${tag} kayak harbour plan`;
  const target = await silent(() => repo().create(A.owner, memoryInput(SECRET, { drawer }), 'test'));
  await silent(() => repo().update(A.owner, target.id, { content: `${SECRET} v2` }, 'edit'));
  const keep = await silent(() => repo().create(A.owner, memoryInput(`Alpha deploys on Tuesdays ${tag}`, { drawer }), 'test'));
  const live = await m.storage.getOwned(ids.owner, target.id);
  await m.indexerPg.getPgMemoryIndexer().index({ ...live, layer: 'session', importance: 7, accessCount: 0 });
  // A pending proposal that quotes it, and a weekly summary that lists it.
  const p = await m.files.createChangeProposal({
    userId: ids.owner, agentId: ids.agent, drawer, source: 'agent', reasons: ['money'], createdBy: 'test',
    changes: [{ op: 'update', id: target.id, before: { type: 'fact', importance: 5, content: `${SECRET} v2` }, after: { type: 'fact', importance: 5, content: `${SECRET} costs 500 dollars` } }],
  });
  const rec = await m.weekly.runWeeklySummary(ids.owner, { summarizer: async () => ({ text: `Learned: ${SECRET}`, model: 'stub' }) });
  assert.ok(rec.text.includes(SECRET));

  // Inside a caller's transaction that rolls back: nothing changes, no file work runs.
  await assert.rejects(() => m.pool.withPgTransaction(async () => {
    await m.forget.forgetMemory(ids.owner, target.id, ids.owner);
    throw new Error('roll back');
  }), /roll back/);
  assert.ok(await m.storage.getOwned(ids.owner, target.id), 'rolled back: still there');
  assert.equal((await one('SELECT status FROM memory_file_proposals WHERE id = ?', p.id)).status, 'pending');

  const out = await silent(() => repo().forget(A.owner, target.id));
  assert.equal(out.memoryId, target.id);
  assert.deepEqual(out.cancelledProposals, [p.id]);
  assert.equal(await m.storage.getOwned(ids.owner, target.id), null);
  assert.ok(await m.storage.getOwned(ids.owner, keep.id), 'the other memory stays');
  const versions = await all('SELECT change, type, content, importance_score, created_by FROM memory_versions WHERE memory_id = ?', target.id);
  assert.deepEqual(versions.map((v) => ({ ...v })), [{ change: 'forget', type: null, content: null, importance_score: null, created_by: ids.owner }]);
  assert.equal((await one('SELECT COUNT(*) AS n FROM memory_index WHERE memory_id = ?', target.id)).n, 0, 'index rows gone in the same transaction');
  assert.deepEqual(await m.indexerPg.getPgMemoryIndexer().keywordSearch(`Zephyr-${tag}`, 5), []);
  const prop = await one('SELECT status, changes FROM memory_file_proposals WHERE id = ?', p.id);
  assert.equal(prop.status, 'cancelled');
  assert.ok(!prop.changes.includes(SECRET));
  const sum = await one('SELECT digest, text, model_text FROM memory_weekly_summaries WHERE id = ?', rec.id);
  assert.ok(!sum.text.includes('Zephyr') && !sum.digest.includes(target.id) && sum.model_text === null);
  const stones = await repo().tombstones(A.owner);
  assert.ok(stones.some((s) => s.memoryId === target.id && s.drawerId === `project:fg-${tag}` && s.actor === ids.owner));
  assert.equal(await m.forget.isForgotten(ids.owner, target.id), true);
  assert.equal(await repo().forget(A.owner, target.id), null, 'second forget: nothing left');
  // Another user cannot forget the owner's memory.
  assert.equal(await repo().forget(A.admin, keep.id), null);
  assert.ok(await m.storage.getOwned(ids.owner, keep.id));
});

test('forget and approve of the same memory at the same time: never resurrected', { skip }, async () => {
  const drawer = { kind: 'project', key: `race-${tag}` };
  const mem = await silent(() => repo().create(A.owner, memoryInput(`Race memory ${tag}`, { drawer }), 'test'));
  const p = await m.files.createChangeProposal({
    userId: ids.owner, agentId: ids.agent, drawer, source: 'agent', reasons: ['overwrite'], createdBy: 'test',
    changes: [{ op: 'update', id: mem.id, before: { type: 'fact', importance: 5, content: `Race memory ${tag}` }, after: { type: 'fact', importance: 5, content: `Race memory changed ${tag}` } }],
  });
  const results = await withHeldLock('SELECT id FROM memories WHERE id = $1 FOR UPDATE', [mem.id],
    () => Promise.allSettled([
      silent(() => repo().approveProposal(A.owner, p.id, p.reviewHash)),
      silent(() => repo().forget(A.owner, mem.id)),
    ]));
  assert.equal(results[1].status, 'fulfilled', String(results[1].reason));
  assert.equal(await m.storage.getOwned(ids.owner, mem.id), null, 'forgotten in the end');
  assert.equal((await one('SELECT COUNT(*) AS n FROM memories WHERE id = ?', mem.id)).n, 0);
  if (results[0].status === 'rejected') assert.equal(results[0].reason.code, 'already_decided');
});

test('forget-all of one drawer (owner only)', { skip }, async () => {
  const drawer = { kind: 'task', key: `fa-${tag}` };
  for (const i of [1, 2, 3]) await silent(() => repo().create(A.owner, memoryInput(`Task note ${i} ${tag}`, { drawer }), 'test'));
  await assert.rejects(() => repo().forgetAll(A.admin, drawer), (e) => e instanceof m.scope.ScopeError);
  const res = await silent(() => repo().forgetAll(A.owner, drawer));
  assert.equal(res.forgotten, 3);
  assert.deepEqual(await m.storage.getByDrawers(ids.owner, [drawer]), []);
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

test('retention: off by default; owner turns it on; old task drawer summarized and forgotten; important drawers untouched', { skip }, async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const old = async (content, drawer, days, extra = {}) => {
    const mem = { ...memoryInput(content, { drawer, createdAt: new Date(Date.now() - days * DAY), ...extra }), userId: ids.owner };
    await silent(() => m.learning.saveVersioned(mem, 'test', 'seed'));
    // The task "ended" at its last activity: move its history back as well.
    await m.pool.pgRun('UPDATE memory_versions SET created_at = ? WHERE memory_id = ?', new Date(Date.now() - days * DAY).toISOString(), mem.id);
    return mem.id;
  };
  const done = [await old(`Done step 1 ${tag}`, { kind: 'task', key: `t-done-${tag}` }, 200), await old(`Done step 2 ${tag}`, { kind: 'task', key: `t-done-${tag}` }, 199)];
  const recent = await old(`Recent step ${tag}`, { kind: 'task', key: `t-new-${tag}` }, 5);
  // B2.2d-15b: an old drawer whose orchestrator task is still running is kept;
  // one whose task completed long ago is summarized.
  const running = await old(`Running step ${tag}`, { kind: 'task', key: `t-run-${tag}` }, 300);
  const finished = await old(`Finished step ${tag}`, { kind: 'task', key: `t-fin-${tag}` }, 300);
  const orchTask = (id, status, completedAt) => m.pool.pgRun(
    `INSERT INTO orchestrator_tasks (id, title, description, status, created_at, completed_at) VALUES (?, 't', 'd', ?, ?, ?)`,
    id, status, new Date(Date.now() - 300 * DAY).toISOString(), completedAt);
  await orchTask(`t-run-${tag}`, 'in_progress', null);
  await orchTask(`t-fin-${tag}`, 'completed', new Date(Date.now() - 250 * DAY).toISOString());
  const lessons = [1, 2, 3].map((i) => `Lesson ${i} ${tag}`);
  const exp = [];
  for (const [i, l] of lessons.entries()) exp.push(await old(l, { kind: 'experience' }, 400 + i, { type: 'insight' }));
  const ownerOld = await old(`Owner fact long ago ${tag}`, { kind: 'owner' }, 2000);
  const exists = async (id) => !!(await m.storage.getOwned(ids.owner, id));

  assert.deepEqual(await m.retention.getRetentionConfig(ids.owner), m.retention.DEFAULT_RETENTION);
  const off = await m.retention.runRetention(ids.owner, { requireEnabled: true });
  assert.equal(off.skipped, 'disabled');
  const dry = await repo().runRetention(A.owner, true);
  assert.ok(dry.actions.some((a) => a.kind === 'task-summary' && a.drawerId === `task:t-done-${tag}` && a.items === 2));
  assert.ok(!dry.actions.some((a) => a.drawerId === `task:t-run-${tag}`), 'running orchestrator task is kept');
  assert.ok(dry.actions.some((a) => a.kind === 'task-summary' && a.drawerId === `task:t-fin-${tag}`), 'completed orchestrator task is summarized');
  assert.ok(await exists(done[0]));
  await assert.rejects(() => repo().setRetention(A.admin, { enabled: true }), (e) => e instanceof m.scope.ScopeError);
  await assert.rejects(() => repo().setRetention(A.owner, { taskTtlDays: 0 }), m.retention.RetentionInputError);
  const cfg = await repo().setRetention(A.owner, { enabled: true, taskTtlDays: 30 });
  assert.equal(cfg.enabled, true);
  assert.equal((await m.retention.getRetentionConfig(ids.owner)).taskTtlDays, 30);
  const run = await silent(() => m.retention.runRetention(ids.owner, { requireEnabled: true }));
  assert.ok(run.forgotten >= 2 + exp.length, `forgotten ${run.forgotten}`);
  for (const id of [...done, ...exp]) assert.equal(await exists(id), false, id);
  for (const id of [recent, ownerOld, running]) assert.equal(await exists(id), true, id);
  assert.equal(await exists(finished), false, finished);
  const summary = (await m.storage.getByDrawers(ids.owner, [{ kind: 'experience' }])).find((x) => x.metadata?.retention === 'task-summary' && x.metadata?.task === `t-done-${tag}`);
  assert.ok(summary && summary.content.includes(`Done step 1 ${tag}`));
  const runs = (await repo().retention(A.owner)).runs;
  assert.equal(runs[0].id, run.id, 'newest run first');
  assert.equal(runs[0].dryRun, false);
});

// ---------------------------------------------------------------------------
// Import: idempotent by operation_key
// ---------------------------------------------------------------------------

test('import batch: preview -> revise -> commit is idempotent by operationKey (also two commits at once)', { skip }, async () => {
  const text = `# Notes\n\nOwner likes sailing on lakes ${tag}.\n\n# Work\n\nThe staging server is in Leipzig ${tag}.\n`;
  const prev = await silent(() => repo().importPreview(A.owner, { files: [{ name: 'notes.md', content: text }], source: 'text' }));
  assert.equal(prev.version, 1);
  assert.ok(prev.items.length >= 2);
  const rev = await repo().reviseImport(A.owner, prev.batchId, { version: 1, contentHash: prev.contentHash, includeAll: true, items: [{ id: prev.items[0].id, include: false }] });
  assert.equal(rev.version, 2);
  await assert.rejects(() => repo().reviseImport(A.owner, prev.batchId, { version: 1, contentHash: prev.contentHash, includeAll: false }), (e) => e.code === 'superseded');
  const key = `op-${tag}-${randomBytes(8).toString('hex')}`;
  const input = { version: rev.version, contentHash: rev.contentHash, operationKey: key, confirm: true };
  const both = await withHeldLock('SELECT id FROM memory_import_batches WHERE id = $1 FOR UPDATE', [prev.batchId],
    () => Promise.all([repo().commitImport(A.owner, prev.batchId, input), repo().commitImport(A.owner, prev.batchId, input)]));
  assert.deepEqual(both.map((r) => !!r.replay).sort(), [false, true], 'one commit, one replay');
  assert.deepEqual(both[0].proposals, both[1].proposals);
  const again = await repo().commitImport(A.owner, prev.batchId, input);
  assert.equal(again.replay, true);
  assert.deepEqual(again.proposals, both[0].proposals);
  const n = (await one('SELECT COUNT(*) AS n FROM memory_file_proposals WHERE import_batch_id = ?', prev.batchId)).n;
  assert.equal(n, both[0].proposals.length, 'proposals created once');
  assert.equal(n, rev.items.filter((i) => i.include).length);
  // The same key on another batch is refused; a different version is not a replay.
  const other = await silent(() => repo().importPreview(A.owner, { files: [{ name: 'other.md', content: `# X\n\nAnother note ${tag}\n` }] }));
  await assert.rejects(() => repo().commitImport(A.owner, other.batchId, { version: other.version, contentHash: other.contentHash, operationKey: key, confirm: true }),
    (e) => e.code === 'operation_key_reused' && e.status === 409);
  await assert.rejects(() => repo().commitImport(A.owner, prev.batchId, { ...input, version: 1 }), (e) => e.code === 'already_committed');
  // Roll back: the pending proposals go, the batch is rolled back.
  const cancel = await repo().cancelImport(A.owner, prev.batchId);
  assert.equal(cancel.status, 'rolled_back');
  assert.equal(cancel.removedProposals, n);
  assert.equal((await one('SELECT status FROM memory_import_batches WHERE id = ?', prev.batchId)).status, 'rolled_back');
  const list = await repo().imports(A.owner);
  assert.ok(list.some((b) => b.batchId === prev.batchId && b.status === 'rolled_back'));
  // Settings round trip.
  assert.deepEqual(await repo().setImportSettings(A.owner, { redactEmails: true }), { redactEmails: true, redactPhones: false });
  assert.deepEqual(await repo().importSettings(A.owner), { redactEmails: true, redactPhones: false });
});

// ---------------------------------------------------------------------------
// Scope rules: owner / admin / agent run / outsider (S0-A.14)
// ---------------------------------------------------------------------------

test('scope: own memory only; agent runs see their drawers; an outsider turn reads nothing and never auto-saves', { skip }, async () => {
  const r = repo();
  const mine = await silent(() => r.create(A.owner, memoryInput(`Owner home address hint ${tag}`), 'test'));
  await assert.rejects(() => r.get(A.admin, mine.id), (e) => e instanceof m.scope.ScopeError && e.status === 404);
  assert.ok(!(await r.list(A.admin)).some((x) => x.id === mine.id));
  assert.deepEqual(await r.search(A.admin, { query: `Owner home address hint ${tag}` }), []);
  const ownerRun = await m.actor.actorFromToolContextAsync({ userId: ids.owner, agentId: ids.agent });
  assert.ok((await r.search(ownerRun, { query: `Owner home address hint ${tag}`, limit: 5 })).some((x) => x.memory.id === mine.id));
  // Outsider (channel) turn: no drawers, nothing read, nothing auto-saved.
  const outsider = await m.actor.actorFromToolContextAsync({ userId: ids.owner, agentId: ids.agent, toolPolicy: { channel: 'telegram' } });
  assert.deepEqual([...outsider.drawers], []);
  assert.deepEqual(await r.search(outsider, { query: `Owner home address hint ${tag}` }), []);
  assert.deepEqual(await r.list(outsider), []);
  assert.equal(await r.stats(outsider), null);
  const learned = await silent(() => r.learn(outsider, { candidates: [{ content: `Visitor said the owner is away ${tag}`, type: 'fact', drawer: { kind: 'owner' } }] }));
  assert.equal(learned.saved.length, 0);
  await assert.rejects(() => r.forget(outsider, mine.id), (e) => e instanceof m.scope.ScopeError && e.status === 403);
  // A routine item learned in the owner's own run is saved and versioned.
  const ok = await silent(() => r.learn(ownerRun, { candidates: [{ content: `Uses dark mode in the editor ${tag}`, type: 'fact' }] }));
  assert.equal(ok.saved.length, 1);
  assert.equal((await r.versions(A.owner, ok.saved[0].id))[0].change, 'create');
  // Owner-only areas.
  await assert.rejects(() => r.weeklySummary(A.admin), (e) => e instanceof m.scope.ScopeError);
  await assert.rejects(() => r.proposals(ownerRun), (e) => e instanceof m.scope.ScopeError);
});

// ---------------------------------------------------------------------------
// Services: tiers, consolidation, deduplication, enrichment, quality, sharing, weekly summary
// ---------------------------------------------------------------------------

test('services on PostgreSQL: tiers, consolidation, dedup (JSON merge in JS), enrichment, quality, sharing, weekly summary', { skip }, async () => {
  const r = repo();
  const work = await silent(() => r.saveDerived(A.owner, memoryInput(`Working note about invoices ${tag}`, { memoryLayer: 'working', importanceScore: 0.7, accessCount: 4 })));
  await m.pool.pgRun('UPDATE memories SET access_count = 4 WHERE id = ?', work.id);
  const stats = await r.layerStats(A.owner);
  assert.ok(stats.every((s) => typeof s.avgImportance === 'number' && 'oldestTimestamp' in s), 'quoted camelCase aliases');
  assert.ok((await r.promotionCandidates(A.owner)).some((c) => c.id === work.id));
  assert.equal(await r.promote(A.owner, work.id, 'experiential'), true);
  assert.equal((await one('SELECT memory_layer FROM memories WHERE id = ?', work.id)).memory_layer, 'experiential');
  const cons = await silent(() => r.runConsolidation(A.owner));
  assert.equal(typeof cons.consolidated, 'number');
  assert.ok((await r.consolidationLog(A.owner, 5)).length >= 1);

  // Deduplication: two near-identical memories merge into one; metadata merged in JS.
  const d1 = await silent(() => r.create(A.admin, memoryInput(`The backup runs nightly at two ${tag}`), 'test'));
  const d2 = await silent(() => r.create(A.admin, memoryInput(`The backup runs nightly at two ${tag}`), 'test'));
  const cand = await r.deduplicationCandidates(A.admin, 0.9);
  assert.ok(cand.some((g) => g.some((x) => x.id === d1.id) && g.some((x) => x.id === d2.id)));
  const dd = await r.runDeduplication(A.admin, 0.9);
  assert.ok(dd.memoriesMerged >= 1);
  const left = await all('SELECT id, metadata FROM memories WHERE id IN (?, ?)', d1.id, d2.id);
  assert.equal(left.length, 1);
  const meta = JSON.parse(left[0].metadata);
  assert.equal(meta.merged_from.length, 1);
  assert.match(meta.merge_timestamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.ok((await r.deduplicationStats(A.admin)).recentRuns.length >= 1);

  // Enrichment + quality.
  const q1 = await silent(() => r.create(A.admin, memoryInput(`Project deadline for the invoice system release is Friday ${tag}`), 'test'));
  await silent(() => r.create(A.admin, memoryInput(`Invoice system release planning meeting about deadline ${tag}`), 'test'));
  const en = await silent(() => r.enrich(A.admin, q1.id));
  assert.equal(en.memoryId, q1.id);
  assert.ok((await r.enrichmentLog(A.admin, q1.id)).length >= 1);
  assert.equal((await one('SELECT auto_enriched FROM memories WHERE id = ?', q1.id)).auto_enriched, 1);
  assert.match((await one('SELECT enriched_at FROM memories WHERE id = ?', q1.id)).enriched_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const qs = await r.qualityStats(A.admin);
  assert.ok(qs.totalMemories >= 2 && typeof qs.averageQuality === 'number');
  const dist = await r.qualityDistribution(A.admin);
  assert.ok(dist.distribution.length >= 1 && dist.layerDistribution.length >= 1);
  assert.ok(Array.isArray(await r.relationships(A.admin, q1.id)));

  // Sharing: team visibility needs a team of the caller; audit rows written with the change.
  const team = await m.repos.repositories.identity.createTeam(A.admin, { name: `Mem Team ${tag}` });
  await assert.rejects(() => r.share(A.admin, q1.id, { visibility: 'team', teamId: 'not-my-team' }), /teamId/);
  const sh = await r.share(A.admin, q1.id, { visibility: 'team', teamId: team.id, reason: 'share' });
  assert.equal(sh.visibility, 'team');
  await r.markCritical(A.admin, q1.id, { critical: true });
  const shared = await r.shared(A.admin, { limit: 10 });
  assert.ok(shared.some((x) => x.id === q1.id && x.is_team_critical === 1));
  assert.deepEqual((await r.sharingAudit(A.admin, { memoryId: q1.id, limit: 10 })).map((a) => a.action).sort(), ['marked_critical', 'visibility_changed']);
  await assert.rejects(() => r.share(A.owner, q1.id, { visibility: 'public' }), (e) => e instanceof m.scope.ScopeError && e.status === 404);

  // Weekly summary: stored newest first (time-ordered ids break created_at ties).
  const s1 = await m.weekly.runWeeklySummary(ids.owner, { summarizer: null });
  const s2 = await m.weekly.runWeeklySummary(ids.owner, { summarizer: null });
  assert.equal((await m.weekly.latestWeeklySummary(ids.owner)).id, s2.id);
  const hist = await m.weekly.listWeeklySummaries(ids.owner);
  assert.deepEqual(hist.slice(0, 2).map((h) => h.id), [s2.id, s1.id]);
  const ws = await r.weeklySummary(A.owner);
  assert.equal(ws.stored, true);
  assert.ok(ws.summary.digest.totals.total >= 1);
});

test('no memory statement reached SQLite', { skip }, () => {
  assert.deepEqual(sqliteHits, []);
});
