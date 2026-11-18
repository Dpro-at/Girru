// STORE-MAP-01 P9b on PostgreSQL (migration 181): the write pipeline's trust records and
// corroboration, owner approval, the quality recall (confidence, "no reliable memory" asked once
// and resolved by the answer), learning from use and forget. Runs ONLY when
// AGENT_PLAYER_PG_TEST_URL names a THROWAWAY database on 127.0.0.1 with the migrations-pg applied
// (scripts/pg/integration.sh). Rows are tagged and removed afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const URL_ = process.env.AGENT_PLAYER_PG_TEST_URL;
const skip = URL_ ? false : 'AGENT_PLAYER_PG_TEST_URL is not set (PostgreSQL integration test)';

let m = {};
let dir;
if (URL_) {
  dir = mkdtempSync(join(tmpdir(), 'ap-pg-store-p9b-'));
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
  process.env.GIRRU_STORE_P9B = '0';
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
    learning: await import('../src/memory/learning.ts'),
    files: await import('../src/memory/memory-files.ts'),
    forget: await import('../src/memory/forget.ts'),
    pack: await import('../src/memory/context/pack.ts'),
    pipeline: await import('../src/memory/quality/pipeline.ts'),
    recall: await import('../src/memory/quality/recall.ts'),
    usage: await import('../src/memory/quality/usage.ts'),
  };
}

const tag = randomBytes(4).toString('hex');
let owner;

test.after(async () => {
  if (!URL_) return;
  const run = (s, ...a) => m.pool.pgRun(s, ...a).catch(() => {});
  await m.pipeline?.enrichmentIdle?.();
  await run('DELETE FROM memory_trust WHERE user_id = ?', owner);
  await run('DELETE FROM memory_trust_sources WHERE user_id = ?', owner);
  await run('DELETE FROM memory_open_questions WHERE user_id = ?', owner);
  await run('DELETE FROM memory_recall_uses WHERE user_id = ?', owner);
  await run('DELETE FROM memory_graph_entities WHERE user_id = ?', owner);
  await run('DELETE FROM memory_versions WHERE user_id = ?', owner);
  await run('DELETE FROM memory_file_proposals WHERE user_id = ?', owner);
  await run('DELETE FROM memories WHERE user_id = ?', owner);
  await run('DELETE FROM users WHERE id = ?', owner);
  await m.closeDatabase?.();
  await m.pool.closePgPool?.();
  rmSync(dir, { recursive: true, force: true });
});

test('P9b write pipeline, confidence, quality recall, ask once and use (PostgreSQL)', { skip }, async () => {
  owner = (await m.users.create({ email: `owner-${tag}@pg.test`, username: `owner_${tag}`, password: `pw-${randomBytes(8).toString('hex')}`, role: 'owner' })).id;
  process.env.GIRRU_STORE_P9B = '1';
  const trust = (id) => m.q.one('SELECT * FROM memory_trust WHERE memory_id = ?', id);
  const kinds = async (id) => (await m.q.all('SELECT kind FROM memory_trust_sources WHERE memory_id = ? ORDER BY at, source_key', id)).map((r) => r.kind);

  // MD1 + MD3: an extraction, then the same fact from an agent -> corroborated and verified.
  const a = await m.learning.learn({ userId: owner, actor: 'extraction', candidates: [{ content: `PG ${tag} loading dock opens at seven every weekday`, type: 'fact', origin: 'extraction' }] });
  const id = a.saved[0].id;
  assert.equal((await trust(id)).source, 'chat');
  const b = await m.learning.learn({ userId: owner, actor: 'agent:pg-agent', agentId: 'pg-agent', candidates: [{ content: `PG ${tag} loading dock opens at seven every weekday`, type: 'fact', origin: 'agent' }] });
  assert.equal(b.saved.length, 0);
  assert.deepEqual(await kinds(id), ['chat', 'agent']);
  assert.equal(Number((await trust(id)).verified), 1);
  await m.pipeline.enrichmentIdle();
  assert.equal((await trust(id)).enrich_state, 'ready');

  // A coding tool's proposal approved by the owner.
  const c = await m.learning.learn({ userId: owner, actor: 'bridge:test-cli', review: true, reviewReason: 'repository-file',
    candidates: [{ content: `PG ${tag} repository uses pnpm workspaces`, type: 'fact', origin: 'agent', drawer: { kind: 'project', key: `pg${tag}` } }] });
  const res = await m.files.approveProposal(owner, c.proposed[0].id, owner, c.proposed[0].reviewHash);
  assert.deepEqual(await kinds(res.applied.added[0]), ['tool', 'approved']);

  // MD6: the quality recall shows confidence; within budget.
  const r = await m.recall.qualityRecall({ userId: owner, drawers: [{ kind: 'owner' }], query: `when does the PG ${tag} loading dock open`, limit: 5 });
  assert.equal(r.reliable, true);
  assert.equal(r.fellBack, false);
  assert.equal(r.items[0].memory.id, id);
  assert.equal(r.items[0].verified, true);

  // MD8: asked once, then resolved by the answer.
  const drawers = [{ kind: 'owner' }];
  const pack = await m.pack.contextPack({ userId: owner, agentId: null, drawers, persona: 'p' });
  const q = `What is the name of the ${tag} moon base commander?`;
  assert.equal((await m.pack.messageRecall({ userId: owner, drawers, query: q, pack })).text, m.pack.NO_RELIABLE_MEMORY);
  assert.equal((await m.pack.messageRecall({ userId: owner, drawers, query: q, pack })).text, m.pack.ALREADY_ASKED);
  const ans = await m.learning.learn({ userId: owner, actor: 'extraction', candidates: [{ content: `Captain Ilse Navarro is the commander of the ${tag} moon base`, type: 'fact', origin: 'extraction' }] });
  const oq = await m.q.one('SELECT status, resolved_memory_id FROM memory_open_questions WHERE user_id = ?', owner);
  assert.equal(oq.status, 'resolved');
  assert.equal(oq.resolved_memory_id, ans.saved[0].id);

  // MD7: verified + used gains weight.
  await m.q.run('INSERT INTO memory_recall_uses (run_id, memory_id, user_id, agent_id, created_at) VALUES (?, ?, ?, NULL, ?)', `run-${tag}`, id, owner, new Date().toISOString());
  await m.usage.learnFromUse(owner);
  assert.ok(Number((await trust(id)).use_weight) > 0);

  // Forget: the trust rows and the resolved question go.
  await m.forget.forgetMemory(owner, ans.saved[0].id, owner);
  assert.ok(!(await m.q.one('SELECT memory_id FROM memory_trust WHERE memory_id = ?', ans.saved[0].id)));
  assert.equal(Number((await m.q.one('SELECT COUNT(*) AS n FROM memory_open_questions WHERE user_id = ?', owner)).n), 0);
  await m.pipeline.enrichmentIdle();
  process.env.GIRRU_STORE_P9B = '0';
});
