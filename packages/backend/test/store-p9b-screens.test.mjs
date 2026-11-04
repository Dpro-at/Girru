// STORE-MAP-01 P9b screens (boards P9b-1 to P9b-3) and CODE-OPEN-01, backend glue:
//  - "How sure": three levels; Mark as verified (owner) makes it verified at once, Undo takes exactly that back;
//  - corrected after use: was / now and the replies that used the old text; Mark as checked and its Undo;
//  - open questions: answer saved as the owner's fact (verified) resolves it; forget + Undo;
//  - the agent tools do the same with the owner gates (no verify tool); everything is off without GIRRU_STORE_P9B;
//  - Open in Code: only regular files inside a project folder or the data folder; outside, links,
//    keys and databases are refused (window check and the open_in_code tool).
// Run: node --import tsx --test test/store-p9b-screens.test.mjs
// Throwaway DB + cwd + HOME, random test-only secrets, no network, no real model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { clearEnv } from './helpers/switches.mjs';
const backendDir = process.cwd();
const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p9b-screens-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['GIRRU_STORE_P2', 'GIRRU_STORE_P3', 'GIRRU_STORE_P9', 'GIRRU_STORE_P9B', 'GIRRU_STORE_PILOT']) clearEnv(k);
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await load('src/db/database.ts');
const db = getDatabase();
await db.initialize();
const OWNER = 'p9bs-owner';
const MEMBER = 'p9bs-member';
for (const [u, role] of [[OWNER, 'owner'], [MEMBER, 'user']]) {
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`).run(u, `${u}@example.test`, u, role);
}
const { getMemoryStorage } = await load('src/memory/storage.ts');
await getMemoryStorage().initialize();
const D = await load('src/memory/drawers.ts');
const V = await load('src/memory/quality/owner-view.ts');
const { learn } = await load('src/memory/learning.ts');
const { enrichmentIdle } = await load('src/memory/quality/pipeline.ts');
const { resetTrustForTests } = await load('src/memory/quality/trust.ts');
const T = await load('src/tools/memory/index.ts');
const { openInCodeTool } = await load('src/tools/desktop/index.ts');
const { codeTarget } = await load('src/services/code-open.ts');
const { approvalCategory } = await load('src/tools/approvals.ts');
const { DEFAULT_AGENT_TOOLS } = await load('src/tools/grants.ts');
const { createProject } = await load('src/repositories/chat-conversations.ts');

const on = async (fn) => { process.env.GIRRU_STORE_P9B = '1'; resetTrustForTests(); try { return await fn(); } finally { process.env.GIRRU_STORE_P9B = '0'; } };
const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const add = (id, content, kind, key = '') => db.prepare(`INSERT INTO memories (id, user_id, type, content, memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key)
  VALUES (?, ?, 'fact', ?, 'factual', 'active', '{}', 0.5, ?, 0, ?, ?)`).run(id, OWNER, content, ago(10), kind, key);
const ctx = { workspaceDir: dir, userId: OWNER, agentId: 'nora', sessionId: 's1', memoryDrawers: [...D.selectDrawers({ audience: 'owner', project: 'alpha' })] };

test('off: nothing new answers', async () => {
  add('off-1', 'The staging server is closed on weekends.', 'project', 'alpha');
  assert.deepEqual(await V.trustView(OWNER, ['off-1']), []);
  await assert.rejects(V.markVerified(OWNER, 'off-1'), /Not found/);
  assert.match((await T.memoryTrustReviewTool.execute({}, ctx)).error, /not available yet/);
});

test('how sure: three levels, verify by hand and its undo', () => on(async () => {
  const saved = await learn({ userId: OWNER, actor: 'agent:nora', agentId: 'nora', candidates: [{ type: 'fact', content: 'The release notes live in the docs folder of the repository.', origin: 'agent', importance: 5, drawer: { kind: 'project', key: 'alpha' } }] });
  await enrichmentIdle();
  assert.equal(saved.saved.length, 1, JSON.stringify(saved).slice(0, 600));
  const id = saved.saved[0].id;
  let [v] = await V.trustView(OWNER, [id]);
  assert.equal(v.level, 'heard-once');
  assert.deepEqual(v.heardFrom, [{ kind: 'agent', agentId: 'nora' }]);
  v = await V.markVerified(OWNER, id);
  assert.equal(v.level, 'verified'); assert.equal(v.byOwner, true);
  v = await V.unmarkVerified(OWNER, id);
  assert.equal(v.level, 'heard-once'); assert.equal(v.byOwner, false, 'undo takes exactly the owner mark away');
  // A memory from before P9b (no trust record) verifies too and keeps its first source.
  add('legacy-1', 'The test database is on port 5433.', 'project', 'alpha');
  v = await V.markVerified(OWNER, 'legacy-1');
  assert.equal(v.level, 'verified');
  await assert.rejects(V.markVerified(OWNER, 'nope'), /Not found/);
  await assert.rejects(V.markVerified(MEMBER, id), /Not found/, 'another account cannot');
  assert.equal(Object.keys(T).some((k) => /verif/i.test(k)), false, 'agents never verify');
}));

test('corrected after use: was / now, replies, checked and undo; agent tool gates', () => on(async () => {
  add('cor-1', 'The client call is on Tuesdays.', 'project', 'alpha');
  db.prepare(`INSERT INTO memory_versions (id, memory_id, user_id, drawer_kind, drawer_key, drawer_revision, version, change, type, content, created_by, created_at)
    VALUES ('v1', 'cor-1', ?, 'project', 'alpha', 1, 1, 'create', 'fact', 'The client call is on Tuesdays.', 'agent:sara', ?)`).run(OWNER, ago(5));
  db.prepare(`INSERT INTO memory_recall_traces (run_id, user_id, session_id, agent_id, items, created_at, uses_indexed) VALUES ('run-1', ?, 'sess-1', 'sara', '[]', ?, 1)`).run(OWNER, ago(4));
  db.prepare(`INSERT INTO memory_recall_uses (run_id, memory_id, user_id, agent_id, created_at) VALUES ('run-1', 'cor-1', ?, 'sara', ?)`).run(OWNER, ago(4));
  db.prepare(`UPDATE memories SET content = 'The client call is on Wednesdays.' WHERE id = 'cor-1'`).run();
  db.prepare(`INSERT INTO memory_versions (id, memory_id, user_id, drawer_kind, drawer_key, drawer_revision, version, change, type, content, created_by, created_at)
    VALUES ('v2', 'cor-1', ?, 'project', 'alpha', 2, 2, 'update', 'fact', 'The client call is on Wednesdays.', ?, ?)`).run(OWNER, OWNER, ago(2));
  const { learnFromUse } = await load('src/memory/quality/usage.ts');
  await learnFromUse(OWNER);
  let list = await V.correctedList(OWNER);
  const c = list.find((x) => x.memoryId === 'cor-1');
  assert.ok(c, 'flagged');
  assert.equal(c.was, 'The client call is on Tuesdays.'); assert.equal(c.now, 'The client call is on Wednesdays.');
  assert.equal(c.replyCount, 1); assert.equal(c.replies[0].sessionId, 'sess-1'); assert.equal(c.drawer, 'project:alpha');
  assert.deepEqual(await V.trustWaiting(OWNER), { corrected: 1, questions: 0 });
  // Agent: read in open places only, change after approval.
  assert.equal(approvalCategory({ name: 'memory_corrected_checked' }), 'other');
  for (const bad of [{ ...ctx, userId: MEMBER }, { ...ctx, toolPolicy: { channel: 'telegram', allowedTools: [] } }]) assert.ok((await T.memoryTrustReviewTool.execute({}, bad)).error);
  const r = await T.memoryTrustReviewTool.execute({}, ctx);
  assert.equal(r.data.corrected.length, 1);
  const closed = await T.memoryTrustReviewTool.execute({}, { ...ctx, memoryDrawers: D.selectDrawers({ audience: 'owner' }) });
  assert.equal(closed.data.corrected.length, 0); assert.equal(closed.data.hiddenCorrected, 1);
  assert.ok(!(await T.memoryCorrectedCheckedTool.execute({ memory_id: 'cor-1' }, ctx)).error);
  list = await V.correctedList(OWNER);
  assert.equal(list.find((x) => x.memoryId === 'cor-1').checked, true);
  await learnFromUse(OWNER);
  assert.equal((await V.correctedList(OWNER)).find((x) => x.memoryId === 'cor-1').checked, true, 'the weekly job keeps it checked');
  await V.setCorrectedChecked(OWNER, 'cor-1', false);
  assert.equal((await V.trustWaiting(OWNER)).corrected, 1, 'undo');
}));

test('open questions: answer resolves it, forget and undo; agent answer is owner-approved', () => on(async () => {
  const ins = db.prepare(`INSERT INTO memory_open_questions (id, user_id, agent_id, question_hash, question, status, asked_at) VALUES (?, ?, 'nora', ?, ?, 'open', ?)`);
  ins.run('oq-1', OWNER, 'h1', 'Which day is the release freeze?', ago(2));
  ins.run('oq-2', OWNER, 'h2', 'Who signs the supplier contracts?', ago(1));
  ins.run('oq-3', OWNER, 'h3', 'Where do we keep the brand fonts?', ago(16));
  const list = await V.openQuestions(OWNER);
  assert.equal(list.find((q) => q.id === 'oq-3').status, 'expired', 'past 14 days');
  assert.equal(list.filter((q) => q.status === 'open').length, 2);
  // Forget + undo.
  await V.forgetQuestion(OWNER, 'oq-2');
  assert.equal((await V.openQuestions(OWNER)).some((q) => q.id === 'oq-2'), false);
  await assert.rejects(V.restoreQuestion(MEMBER, 'oq-2'), /no longer/);
  assert.equal((await V.restoreQuestion(OWNER, 'oq-2')).status, 'open');
  // The agent saves the owner's answer (approval), it counts as owner-approved and verified.
  assert.equal(approvalCategory({ name: 'memory_question_answer' }), 'other');
  const beta = await T.memoryQuestionAnswerTool.execute({ question_id: 'oq-1', text: 'The freeze starts on Wednesday at noon.', drawer: 'project:beta' }, ctx);
  assert.match(beta.error ?? '', /open in this conversation/, JSON.stringify(beta));
  const a = await T.memoryQuestionAnswerTool.execute({ question_id: 'oq-1', text: 'The release freeze starts on Wednesday at noon.', drawer: 'project:alpha' }, ctx);
  assert.ok(!a.error, a.content[0].text);
  await enrichmentIdle();
  const [v] = await V.trustView(OWNER, [a.data.memoryId]);
  assert.equal(v.level, 'verified');
  assert.equal((await V.openQuestions(OWNER)).find((q) => q.id === 'oq-1').status, 'resolved');
  assert.ok((await T.memoryQuestionAnswerTool.execute({ question_id: 'oq-1', text: 'again', drawer: 'project:alpha' }, ctx)).error, 'answered once');
  assert.ok(!(await T.memoryQuestionForgetTool.execute({ question_id: 'oq-2' }, ctx)).error);
  for (const t of ['memory_trust_review', 'memory_corrected_checked', 'memory_question_answer', 'memory_question_forget', 'open_in_code']) assert.ok(DEFAULT_AGENT_TOOLS.includes(t), t);
}));

test('Open in Code: projects and the data folder only; outside, links, keys and databases refused', async () => {
  const proj = join(dir, 'alpha'); mkdirSync(join(proj, '.girru'), { recursive: true });
  writeFileSync(join(proj, '.girru', 'tasks.md'), '# Tasks\n');
  writeFileSync(join(proj, 'main.ts'), 'x\n');
  writeFileSync(join(proj, '.env'), 'SECRET=1\n');
  const outside = join(dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'notes.md'), 'x\n');
  symlinkSync(join(outside, 'notes.md'), join(proj, 'link.md'));
  symlinkSync(outside, join(proj, 'linked-dir'));
  await createProject(OWNER, { name: 'Alpha', folder: proj });
  const t = await codeTarget(OWNER, { path: join(proj, '.girru', 'tasks.md'), line: 42 });
  assert.equal(t.folder, proj); assert.equal(t.file, '.girru/tasks.md'); assert.equal(t.line, 42); assert.equal(t.generated, true); assert.equal(t.project, 'Alpha');
  assert.equal((await codeTarget(OWNER, { path: join(proj, 'main.ts') })).generated, false);
  writeFileSync(join(dir, '.data', 'MEMORY.md'), 'notes\n');
  assert.equal((await codeTarget(OWNER, { path: join(dir, '.data', 'MEMORY.md') })).where, 'data');
  const refused = async (input, code) => { await assert.rejects(codeTarget(OWNER, input), (e) => e.code === code, JSON.stringify(input)); };
  await refused({ path: join(outside, 'notes.md') }, 'outside');
  await refused({ path: join(proj, 'link.md') }, 'outside');
  await refused({ path: join(proj, 'linked-dir', 'notes.md') }, 'outside');
  await refused({ path: join(proj, '..', 'outside', 'notes.md') }, 'outside');
  await refused({ path: '/etc/hosts' }, 'outside');
  await refused({ path: join(proj, '.env') }, 'not_allowed');
  await refused({ path: join(dir, '.data', 'agent-player.db') }, 'not_allowed');
  await refused({ path: proj }, 'not_allowed');
  await refused({ path: 'relative/file.md' }, 'invalid');
  await refused({ path: join(proj, 'main.ts'), line: 0 }, 'invalid');
  await refused({ path: join(proj, 'missing.ts') }, 'not_found');
  await assert.rejects(codeTarget(MEMBER, { path: join(proj, 'main.ts') }), (e) => e.code === 'outside', "another account's projects are not its own");
  // The agent tool: same check, owner gates, approval.
  assert.equal(approvalCategory({ name: 'open_in_code' }), 'other');
  const ok = await openInCodeTool.execute({ path: join(proj, '.girru', 'tasks.md'), line: 3 }, ctx);
  assert.ok(!ok.error, ok.content[0].text); assert.equal(ok.data.openInCode.line, 3);
  assert.match((await openInCodeTool.execute({ path: join(outside, 'notes.md') }, ctx)).error, /outside your projects/);
  assert.ok((await openInCodeTool.execute({ path: join(proj, 'main.ts') }, { ...ctx, toolPolicy: { channel: 'telegram', allowedTools: [] } })).error);
  assert.ok((await openInCodeTool.execute({ path: join(proj, 'main.ts') }, { ...ctx, userId: MEMBER })).error);
});
