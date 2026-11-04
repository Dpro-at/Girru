// STORE-MAP-01 P9 on PostgreSQL: migration 179's drawer index exists and is used, the recall index
// returns the same memories, scores and order as the full-row path (packed bytea vectors, JSON-only
// vectors), and forget writes a forget-ledger line (ids and a keyed hash only) and drops the user's
// recall index. Runs ONLY when AGENT_PLAYER_PG_TEST_URL names a THROWAWAY database on 127.0.0.1 with
// the migrations-pg applied (scripts/pg/integration.sh). Rows are tagged and removed afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const URL_ = process.env.AGENT_PLAYER_PG_TEST_URL;
const skip = URL_ ? false : 'AGENT_PLAYER_PG_TEST_URL is not set (PostgreSQL integration test)';

let m = {};
let dir;
if (URL_) {
  dir = mkdtempSync(join(tmpdir(), 'ap-pg-store-p9-'));
  mkdirSync(join(dir, '.data'), { recursive: true });
  process.chdir(dir);
  process.env.HOME = dir;
  process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
  process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
  process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
  process.env.MEMORY_EMBEDDINGS = 'hash';
  process.env.MEMORY_GRAPH_MODEL = 'off';
  process.env.OLLAMA_URL = 'http://127.0.0.1:9';
  process.env.AGENT_PLAYER_DB = 'postgres';
  process.env.AGENT_PLAYER_PG_URL = URL_;
  process.env.GIRRU_STORE_P9 = '0';
  const quiet = { log: console.log, warn: console.warn };
  console.log = () => {}; console.warn = () => {};
  const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
  await getDatabase({ path: process.env.DATABASE_PATH }).initialize();
  console.log = quiet.log; console.warn = quiet.warn;
  m = {
    closeDatabase,
    pool: await import('../src/db/pg/pool.ts'),
    users: (await import('../src/repositories/pg/users-store.ts')).pgUsersStore,
    q: (await import('../src/repositories/sql-steps.ts')).q,
    storage: (await import('../src/memory/storage.ts')).getMemoryStorage(),
    embedding: await import('../src/memory/embedding.ts'),
    normalize: await import('../src/memory/text-normalize.ts'),
    vectors: await import('../src/memory/vectors.ts'),
    drawers: await import('../src/memory/drawers.ts'),
    forget: await import('../src/memory/forget.ts'),
    ledger: await import('../src/memory/forget-ledger.ts'),
    index: await import('../src/memory/recall-index.ts'),
    person: await import('../src/memory/person.ts'),
    places: await import('../src/memory/place-settings.ts'),
    stays: await import('../src/memory/stays-local.ts'),
    health: await import('../src/memory/health.ts'),
    learning: await import('../src/memory/learning.ts'),
    files: await import('../src/memory/memory-files.ts'),
    summary: await import('../src/memory/project-summary.ts'),
    lessons: await import('../src/memory/lessons.ts'),
    relevance: await import('../src/memory/agent-relevance.ts'),
  };
}

const tag = randomBytes(4).toString('hex');
let owner;

test.after(async () => {
  if (!URL_) return;
  const run = (s, ...a) => m.pool.pgRun(s, ...a).catch(() => {});
  await run('DELETE FROM memory_place_settings WHERE owner_id = ?', owner);
  await run('DELETE FROM memory_health_events WHERE owner_id = ?', owner);
  await run('DELETE FROM notifications WHERE user_id = ?', owner);
  await run('DELETE FROM memory_graph_entities WHERE user_id = ?', owner);
  await run('DELETE FROM memory_versions WHERE user_id = ?', owner);
  await run('DELETE FROM memory_file_proposals WHERE user_id = ?', owner);
  await run("DELETE FROM agent_rules WHERE reason LIKE ?", `%lesson:%`);
  await run('DELETE FROM agents_config WHERE id LIKE ?', `pq-${tag}-%`);
  await run('DELETE FROM memories WHERE user_id = ?', owner);
  await run('DELETE FROM users WHERE id = ?', owner);
  await m.closeDatabase?.();
  await m.pool.closePgPool?.();
  rmSync(dir, { recursive: true, force: true });
});

test('P9 drawer index, recall index parity and the forget ledger (PostgreSQL)', { skip }, async () => {
  owner = (await m.users.create({ email: `owner-${tag}@pg.test`, username: `owner_${tag}`, password: `pw-${randomBytes(8).toString('hex')}`, role: 'owner' })).id;
  const idx = await m.q.all("SELECT indexdef FROM pg_indexes WHERE tablename = 'memories' AND indexname = 'idx_memories_drawer_expr'");
  assert.equal(idx.length, 1);
  assert.match(idx[0].indexdef, /COALESCE\(drawer_kind/);

  const words = ['deploy', 'server', 'invoice', 'customer', 'النشر', 'الخادم', 'فاتورة', 'العميل', 'backup', 'login'];
  const drawers = [['owner', ''], ['project', 'alpha'], ['project', 'beta'], ['experience', '']];
  for (let i = 0; i < 120; i++) {
    const content = Array.from({ length: 3 + (i % 7) }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(' ') + ` item ${i}`;
    const vec = m.embedding.hashEmbed(m.normalize.normalizeMemoryText(content));
    const [dk, dkey] = drawers[i % drawers.length];
    await m.q.run(`INSERT INTO memories (id, user_id, type, content, embedding, embedding_model, embedding_dims, embedding_vec,
      memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key)
      VALUES (?, ?, 'fact', ?, ?, ?, ?, ?, ?, 'active', '{}', 0.5, ?, 0, ?, ?)`,
    `p9-${tag}-${String(i).padStart(3, '0')}`, owner, content, JSON.stringify(vec), m.embedding.HASH_MODEL, m.embedding.HASH_DIMS,
    i % 2 ? m.vectors.packVector(vec) : null, i % 9 === 0 ? 'working' : 'factual', new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), dk, dkey || null);
  }
  const OPEN = m.drawers.selectDrawers({ audience: 'owner', project: 'alpha' });
  const shape = (rs) => rs.map((r) => [r.memory.id, r.similarity, r.scoreBreakdown.vectorScore, r.scoreBreakdown.keywordScore]);
  for (const query of ['deploy server', 'فاتورة العميل', 'backup login', 'item 17', 'nothing matches this']) {
    for (const extra of [{}, { limit: 30 }, { layer: 'working' }]) {
      process.env.GIRRU_STORE_P9 = '0';
      const off = shape(await m.storage.search({ query, userId: owner, drawers: OPEN, limit: 10, ...extra }));
      process.env.GIRRU_STORE_P9 = '1';
      const on = shape(await m.storage.search({ query, userId: owner, drawers: OPEN, limit: 10, ...extra }));
      const warm = shape(await m.storage.search({ query, userId: owner, drawers: OPEN, limit: 10, ...extra }));
      assert.deepEqual(on, off, query);
      assert.deepEqual(warm, off, `${query} (warm)`);
    }
  }
  assert.ok(m.index.recallIndexStats().entries > 0);

  // Forget: a ledger line with ids and a keyed hash, and the recall index of the user goes.
  const id = `p9-${tag}-001`;
  assert.ok(await m.forget.forgetMemory(owner, id, owner));
  const lines = m.ledger.readLedger().filter((l) => l.memoryId === id);
  assert.equal(lines.length, 1);
  assert.match(lines[0].mac, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(readFileSync(join(dir, '.data', m.ledger.LEDGER_FILE), 'utf8'), /deploy|item/);
  assert.equal(m.index.recallIndexStats().users, 0);
  const after = await m.storage.search({ query: 'item 1', userId: owner, drawers: OPEN, limit: 50 });
  assert.ok(!after.some((r) => r.memory.id === id));
  process.env.GIRRU_STORE_P9 = '0';
});

test('P9 one person, people-fact retention and stays-local (PostgreSQL)', { skip }, async () => {
  process.env.GIRRU_STORE_P9 = '1';
  const ins = (id, content, kind, key, status = 'active', validTo = null) => m.q.run(`INSERT INTO memories (id, user_id, type, content, memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key, valid_to)
    VALUES (?, ?, 'fact', ?, 'factual', ?, '{}', 0.5, ?, 0, ?, ?, ?)`, id, owner, content, status, new Date().toISOString(), kind, key, validTo);
  await ins(`pp-${tag}-1`, 'Rana likes green tea.', 'people', `rana${tag}`);
  await ins(`pp-${tag}-old`, 'Rana lives in Basra.', 'people', `rana${tag}`, 'replaced', new Date(Date.now() - 400 * 86_400_000).toISOString());
  await ins(`pp-${tag}-m`, `Lunch with rana${tag} on Monday.`, 'owner', null);
  await m.q.run(`INSERT INTO memory_graph_entities (id, user_id, kind, name, norm_name, aliases) VALUES (?, ?, 'person', ?, ?, '[]')`, `e-${tag}`, owner, `Rana${tag}`, `rana${tag}`);
  const ex = await m.person.exportPerson(owner, `rana${tag}`);
  assert.deepEqual(ex.drawer.map((x) => x.id).sort(), [`pp-${tag}-1`, `pp-${tag}-old`]);
  assert.deepEqual(ex.mentions.map((x) => x.id), [`pp-${tag}-m`]);
  assert.equal(ex.graph.length, 1);
  assert.deepEqual((await m.person.stalePeopleFacts(owner)).map((x) => x.id), [`pp-${tag}-old`]);
  // People stays local by default; a project switched on too.
  await m.places.setPlaceSetting(owner, 'project:alpha', true);
  const r = await m.stays.cloudSafeDrawers(owner, [{ kind: 'owner' }, { kind: 'project', key: 'alpha' }, { kind: 'people', key: `rana${tag}` }]);
  assert.deepEqual(r.drawers, [{ kind: 'owner' }]);
  const f = await m.person.forgetPerson(owner, `rana${tag}`, owner, { confirm: `rana${tag}`, mentionIds: [`pp-${tag}-m`] });
  assert.deepEqual(f, { drawer: 2, mentions: 1, graph: 1 });
  assert.equal((await m.q.all('SELECT id FROM memories WHERE id LIKE ?', `pp-${tag}-%`)).length, 0);
  assert.equal((await m.q.all('SELECT id FROM memory_graph_entities WHERE id = ?', `e-${tag}`)).length, 0);
  process.env.GIRRU_STORE_P9 = '0';
});

test('P9 health counts on PostgreSQL (migration 180)', { skip }, async () => {
  process.env.GIRRU_STORE_P9 = '1';
  await m.health.recordHealthEvent(owner, 'recall_failed', 'a-1');
  await m.health.recordHealthEvent(owner, 'recall_failed', 'a-1');
  await m.health.recordHealthEvent(owner, 'doctor', 'h', { duplicate: 2 });
  const h = await m.health.memoryHealth(owner);
  assert.equal(h.rows.find((r) => r.id === 'remembering').state, 'needs_you');
  assert.equal(h.rows.find((r) => r.id === 'background').word, '2 to tidy');
  assert.equal(h.rows.find((r) => r.id === 'backups').detail.postgres, true);
  const n = await m.q.all("SELECT COUNT(*) AS n FROM memory_health_events WHERE owner_id = ? AND kind = 'notice'", owner);
  assert.equal(Number(n[0].n), 1);
  const b = await m.health.supportBundle(owner);
  assert.equal(b.database.driver, 'postgres');
  process.env.GIRRU_STORE_P9 = '0';
});

test('P9 quality on PostgreSQL: supersede, lesson proposals, project summary, agent profile', { skip }, async () => {
  process.env.GIRRU_STORE_P9 = '1';
  // M4: keep new supersedes the contradicted fact.
  const ex = (content) => ({ content, type: 'fact', importance: 5, origin: 'extraction' });
  const old = (await m.learning.learn({ userId: owner, actor: 'extraction', candidates: [ex(`The pq${tag} printer is enabled for guests`)] })).saved[0];
  const out = await m.learning.learn({ userId: owner, actor: 'extraction', candidates: [ex(`The pq${tag} printer is disabled for guests`)] });
  const p = out.proposed[0];
  assert.equal(p.conflictWith, old.id);
  const r = await m.files.decideConflict(owner, p.id, 'keep_new', owner, p.reviewHash);
  assert.deepEqual(r.applied.replaced, [old.id]);
  const was = await m.q.one('SELECT status, valid_to, superseded_by FROM memories WHERE id = ?', old.id);
  assert.equal(was.status, 'replaced');
  assert.ok(was.valid_to);
  assert.equal(was.superseded_by, r.applied.added[0]);
  // M2: a repeated finding becomes one skill proposal, once; an instruction a suggested rule.
  // (The first test's synthetic experience rows repeat words too; they are not this case.)
  await m.q.run("DELETE FROM memories WHERE user_id = ? AND drawer_kind = 'experience' AND id LIKE ?", owner, `p9-${tag}-%`);
  const ins = (id, content, kind, key, type = 'fact') => m.q.run(`INSERT INTO memories (id, user_id, type, content, memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key)
    VALUES (?, ?, ?, ?, 'factual', 'active', '{}', 0.5, ?, 0, ?, ?)`, id, owner, type, content, new Date(Date.now() - 1000 * Number(id.slice(-1))).toISOString(), kind, key);
  await ins(`pq-${tag}-l1`, `The pq${tag} embed endpoint answers 404 when the model is not pulled`, 'experience', null, 'insight');
  await ins(`pq-${tag}-l2`, `pq${tag} embed endpoint 404 means the model was not pulled`, 'experience', null, 'insight');
  await ins(`pq-${tag}-l3`, `A 404 from the pq${tag} embed endpoint: the model is not pulled`, 'experience', null, 'insight');
  await ins(`pq-${tag}-r1`, `Always run the pq${tag} migration test before pushing`, 'experience', null, 'insight');
  await ins(`pq-${tag}-r2`, `Always run the pq${tag} migration test before you push`, 'experience', null, 'insight');
  await ins(`pq-${tag}-r3`, `Run the pq${tag} migration test always before pushing`, 'experience', null, 'insight');
  const props = await m.lessons.promoteLessons(owner);
  assert.deepEqual(props.map((x) => x.kind).sort(), ['rule', 'skill']);
  assert.equal((await m.lessons.promoteLessons(owner)).length, 0, 'proposed once');
  // M7: a versioned project summary.
  for (let i = 1; i <= 5; i++) await ins(`pq-${tag}-s${i}`, `pq${tag} billing fact number ${i}`, 'project', `pq${tag}`);
  const first = (await m.summary.runProjectSummaries(owner)).find((x) => x.drawer === `project:pq${tag}`);
  assert.equal(first.version, 1);
  assert.equal((await m.summary.runProjectSummaries(owner)).filter((x) => x.drawer === `project:pq${tag}`).length, 0);
  await ins(`pq-${tag}-s6`, `pq${tag} billing fact number six`, 'project', `pq${tag}`);
  const second = (await m.summary.runProjectSummaries(owner)).find((x) => x.drawer === `project:pq${tag}`);
  assert.equal(second.version, 2);
  assert.equal(second.replaced, first.memoryId);
  assert.deepEqual((await m.summary.projectSummaryVersions(owner, { kind: 'project', key: `pq${tag}` })).map((v) => v.current), [true, false]);
  // M3: the agent profile reads specialty, department and team.
  await m.q.run(`INSERT INTO agents_config (id, name, provider, model, is_primary, department, specialty) VALUES (?, 'A', 'ollama', 'x', 0, 'backend', 'Database API engineer'), (?, 'B', 'ollama', 'x', 0, 'backend', NULL)`, `pq-${tag}-a`, `pq-${tag}-b`);
  const profile = await m.relevance.agentProfile(`pq-${tag}-a`);
  assert.ok(profile.terms.has('databas') || profile.terms.size > 0);
  assert.ok(profile.team.has(`pq-${tag}-b`));
  process.env.GIRRU_STORE_P9 = '0';
});
