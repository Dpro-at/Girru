// KNOW-INDEX-01 on PostgreSQL (migration 184): the same document memory as on SQLite — a project PDF and
// Markdown file are indexed (chunks with page / heading, vectors as bytea), a question is answered with the
// file and page, an edit gives the new answer (revision + 1), a deleted file drops its chunks, an
// unreadable PDF is listed with its reason, the agent's knowledge folder is read for that agent only, and
// turning the project off forgets its index.
// Runs ONLY when AGENT_PLAYER_PG_TEST_URL names a THROWAWAY database on 127.0.0.1 with the
// migrations-pg applied (scripts/pg/integration.sh). Rows are tagged and removed afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const URL_ = process.env.AGENT_PLAYER_PG_TEST_URL;
const skip = URL_ ? false : 'AGENT_PLAYER_PG_TEST_URL is not set (PostgreSQL integration test)';

let m = {};
let dir;
if (URL_) {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-pg-doc-index-')));
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
  process.env.GIRRU_DOC_INDEX = '1';
  process.env.AGENT_PLAYER_DB = 'postgres';
  process.env.AGENT_PLAYER_PG_URL = URL_;
  const quiet = { log: console.log, warn: console.warn };
  console.log = () => {}; console.warn = () => {};
  const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
  await getDatabase({ path: process.env.DATABASE_PATH }).initialize();
  console.log = quiet.log; console.warn = quiet.warn;
  m = {
    closeDatabase,
    pool: await import('../src/db/pg/pool.ts'),
    users: (await import('../src/repositories/pg/users-store.ts')).pgUsersStore,
    projects: await import('../src/repositories/chat-conversations.ts'),
    keys: await import('../src/memory/project-keys.ts'),
    ix: await import('../src/memory/docs/indexer.ts'),
    pack: await import('../src/memory/context/pack.ts'),
    agents: await import('../src/services/agent-files.ts'),
    F: await import('./helpers/pdf-fixture.mjs'),
  };
}

const tag = randomBytes(4).toString('hex');
const S = {};
const one = (sql, ...p) => m.pool.pgOne(sql, ...p);
const write = (file, data) => {
  writeFileSync(file, data);
  const t = new Date(Date.now() + Math.floor(Math.random() * 1e6) + 1000);
  utimesSync(file, t, t);
};
const spec = (port) => m.F.simplePdf([['Spec', 'Overview of the system.'], ['Networking', `The relay listens on port ${port} for phone pairing.`]]);
const ask = async (query, agentId = null) => {
  const pack = await m.pack.contextPack({ userId: S.owner, agentId, drawers: S.drawers, persona: '' });
  return m.pack.messageRecall({ userId: S.owner, drawers: S.drawers, query, pack, agentId });
};

test.before(async () => {
  if (!URL_) return;
  const owner = await m.users.create({ email: `owner-${tag}@pg.test`, username: `owner_${tag}`, password: `pw-${randomBytes(8).toString('hex')}`, role: 'owner' });
  S.owner = owner.id;
  S.folder = join(dir, 'alpha');
  mkdirSync(join(S.folder, 'docs'), { recursive: true });
  write(join(S.folder, 'docs', 'spec.pdf'), spec(41588));
  write(join(S.folder, 'docs', 'guide.md'), '# Guide\n\n## Releases\n\nA release ships every Thursday after the smoke tests.\n');
  S.project = await m.projects.createProject(S.owner, { name: `Alpha ${tag}`, folder: S.folder });
  S.drawers = [{ kind: 'owner' }, { kind: 'project', key: m.keys.projectKeyOf(S.project) }];
});

test.after(async () => {
  if (!URL_) return;
  for (const t of ['doc_index_chunks', 'doc_index_files', 'doc_index_sources']) await m.pool.pgRun(`DELETE FROM ${t} WHERE owner_id = ?`, S.owner).catch(() => {});
  await m.pool.pgRun('DELETE FROM chat_projects WHERE user_id = ?', S.owner).catch(() => {});
  await m.pool.pgRun('DELETE FROM users WHERE id = ?', S.owner).catch(() => {});
  await m.closeDatabase?.();
  await m.pool.closePgPool?.();
  rmSync(dir, { recursive: true, force: true });
});

test('a fact in the project PDF: the answer with file and page (PostgreSQL)', { skip }, async () => {
  S.source = await m.ix.setDocSource(S.owner, 'project', S.project.id, true);
  await m.ix.docIndexIdle();
  const rep = await m.ix.indexSource(S.source.id);
  assert.equal(rep.state, 'ready');
  assert.equal(rep.files, 2);
  const vec = await one('SELECT embedding_model, embedding_vec FROM doc_index_chunks WHERE owner_id = ? LIMIT 1', S.owner);
  assert.equal(vec.embedding_model, 'hash-v2');
  assert.ok(Buffer.isBuffer(vec.embedding_vec) && vec.embedding_vec.length === 256 * 4);
  const r = await ask('Which port does the relay listen on for phone pairing?');
  assert.match(r.text, /- \(docs\/spec\.pdf, page 2\) .*41588/);
  assert.deepEqual(r.items.find((i) => i.kind === 'document').cite, { file: 'docs/spec.pdf', page: 2, heading: null });
  const md = await ask('On which day does a release ship?');
  assert.match(md.text, /docs\/guide\.md › Guide › Releases\) .*Thursday/);
});

test('edit: the new answer with the next revision; delete: its chunks go (PostgreSQL)', { skip }, async () => {
  const before = Number((await one('SELECT revision FROM doc_index_files WHERE owner_id = ? AND display_path = ?', S.owner, 'docs/spec.pdf')).revision);
  write(join(S.folder, 'docs', 'spec.pdf'), spec(41599));
  assert.equal((await m.ix.indexSource(S.source.id)).changed, 1);
  assert.equal(Number((await one('SELECT revision FROM doc_index_files WHERE owner_id = ? AND display_path = ?', S.owner, 'docs/spec.pdf')).revision), before + 1);
  const r = await ask('Which port does the relay listen on for phone pairing?');
  assert.match(r.text, /page 2\) .*41599/);
  assert.ok(!r.text.includes('41588'));
  unlinkSync(join(S.folder, 'docs', 'spec.pdf'));
  assert.equal((await m.ix.indexSource(S.source.id)).removed, 1);
  assert.equal(Number((await one(`SELECT COUNT(*) AS n FROM doc_index_files WHERE owner_id = ? AND display_path = 'docs/spec.pdf'`, S.owner)).n), 0);
});

test('an unreadable PDF is listed with its reason (PostgreSQL)', { skip }, async () => {
  write(join(S.folder, 'docs', 'scan.pdf'), m.F.imageOnlyPdf());
  await m.ix.indexSource(S.source.id);
  const st = (await m.ix.docIndexStatus(S.owner)).find((s) => s.id === S.source.id);
  assert.deepEqual(st.unreadable, [{ file: 'docs/scan.pdf', reason: 'no_text' }]);
  assert.equal(st.unreadable.length, 1);
});

test('the agent knowledge folder, for that agent only (PostgreSQL)', { skip }, async () => {
  const agent = `pg-doc-agent-${tag}`;
  const k = join(m.agents.getAgentDir(agent), 'knowledge');
  mkdirSync(k, { recursive: true });
  writeFileSync(join(k, 'pricing.md'), '# Pricing\n\nThe team plan costs 19 euro per seat each month.\n');
  // Not marked "It reads this file": found when it helps (indexed) instead of whole in the instructions.
  writeFileSync(join(m.agents.getAgentDir(agent), 'files.json'), JSON.stringify({ notRead: ['pricing.md'], removed: [] }));
  await ask('How much does the team plan cost per seat?', agent);
  await m.ix.docIndexIdle();
  assert.match((await ask('How much does the team plan cost per seat?', agent)).text, /knowledge\/pricing\.md › Pricing\) .*19 euro/);
  assert.ok(!(await ask('How much does the team plan cost per seat?', `other-${tag}`)).text.includes('pricing.md'));
});

test('turning the project off forgets its index (PostgreSQL)', { skip }, async () => {
  await m.ix.setDocSource(S.owner, 'project', S.project.id, false);
  assert.equal(Number((await one('SELECT COUNT(*) AS n FROM doc_index_chunks WHERE source_id = ?', S.source.id)).n), 0);
  assert.ok(!(await ask('On which day does a release ship?')).text.includes('guide.md'));
});

test('every project with a folder is read by default; the Documents view (PostgreSQL)', { skip }, async () => {
  const folder = join(dir, 'mine');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'notes.md'), '# Notes\n\nThe staging server restarts every Sunday at 04:00.\n');
  const one = await m.projects.createProject(S.owner, { name: `One ${tag}`, folder });
  const view = await m.ix.documentsView(S.owner);
  await m.ix.docIndexIdle();
  assert.equal(view.projects.find((p) => p.id === one.id).source.enabled, true);
  // The project turned off earlier stays off.
  assert.equal(view.projects.find((p) => p.id === S.project.id).source.enabled, false);
  const after = (await m.ix.documentsView(S.owner)).projects.find((p) => p.id === one.id);
  assert.equal(after.source.files, 1);
  assert.equal(after.folders[0].files, 1);
});
