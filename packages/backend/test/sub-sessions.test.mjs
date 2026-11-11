// CHAT-ORCH-01: the main agent starts sub-sessions (new chats under this one)
// only after the owner approves; it lists, reads, messages and stops them;
// only the owner's coordinators may; depth stops at 2.
// Temp folder + temp SQLite; the model is a stubbed local Ollama answer.
// Run: node --import tsx --test test/sub-sessions.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backend = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'sub-sessions-'));
mkdirSync(join(dir, '.data'));
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
process.env.AGENT_PLAYER_BACKGROUND = 'off';
console.log = () => {}; console.warn = () => {};
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).startsWith('http://127.0.0.1:11434')) return new Response(JSON.stringify({ message: { role: 'assistant', content: 'Report: five slogans written.' }, done: true }), { status: 200 });
  return new Response('{}', { status: 404 });
};
const { getDatabase, closeDatabase } = await import(join(backend, 'src/db/database.ts'));
const db = getDatabase(); await db.initialize();
for (const [id, role] of [['owner', 'owner'], ['member', 'user']]) db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,'x',?,'active')").run(id, `${id}@example.test`, id, role);
db.prepare('UPDATE agents_config SET is_primary=0').run();
db.prepare("INSERT INTO agents_config(id,name,is_primary,provider,model) VALUES('main','Main Agent',1,'ollama','qwen3:4b')").run();
db.prepare("INSERT INTO agents_config(id,name,is_primary,provider,model) VALUES('milo','Milo',0,'ollama','qwen3:4b')").run();
const { createConversation, findConversation } = await import(join(backend, 'src/repositories/chat-conversations.ts'));
const { createAgentToolsRegistry } = await import(join(backend, 'src/tools/index.ts'));
const s = await import(join(backend, 'src/tools/tasks/sessions.ts'));
const { chatRuns } = await import(join(backend, 'src/services/chat-runs.ts'));
const parent = await createConversation('owner', { title: 'Coffee shop launch', agentId: 'main' });
const ctx = (extra = {}) => ({ workspaceDir: dir, agentId: 'main', userId: 'owner', sessionId: parent.id, chatPlan: true, memoryDrawers: [], ...extra });
const text = (r) => r.content.map((b) => b.text).join('\n');
const settle = async () => { for (let i = 0; i < 200 && chatRuns.runningCount('owner') > 0; i++) await new Promise((r) => setTimeout(r, 25)); };
test.after(async () => { await settle(); globalThis.fetch = fetchOriginal; closeDatabase(); process.chdir(backend); rmSync(dir, { recursive: true, force: true }); });

test('the session tools are offered in an owner chat without a grant; starting asks the owner first', async () => {
  const registry = await createAgentToolsRegistry(ctx());
  const names = registry.listRegistered().map((t) => t.name);
  for (const n of s.SESSION_TOOLS) assert.ok(names.includes(n), `${n} is offered`);
  const r = await registry.execute('session_start', { agent_id: 'milo', task: 'Write 5 slogans' });
  assert.equal(r.details?.status, 'pending_approval');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_sessions WHERE parent_id = ?').get(parent.id).n, 0, 'nothing starts before the approval');
});

test('a start makes a chat under this one with the agent and the task; list, read and message reach it', async () => {
  const r = await s.sessionStartTool.execute({ agent_id: 'milo', task: 'Write 5 slogans', title: 'Slogans' }, ctx());
  assert.equal(r.error, undefined, text(r));
  const id = r.details.session.id;
  const child = await findConversation('owner', id);
  assert.equal(child.parentId, parent.id); assert.equal(child.agentId, 'milo'); assert.equal(child.title, 'Slogans');
  assert.equal(child.mode, 'ask', 'a sub-session never gets a looser mode than Ask me');
  await settle();
  const list = await s.sessionListTool.execute({}, ctx());
  assert.equal(list.details.sessions.length, 1);
  assert.equal(list.details.sessions[0].agent, 'Milo');
  assert.ok(['done', 'failed'].includes(list.details.sessions[0].state), list.details.sessions[0].state);
  const read = await s.sessionReadTool.execute({ session_id: id }, ctx());
  assert.match(text(read), /Slogans/);
  const asked = await (await createAgentToolsRegistry(ctx())).execute('session_message', { session_id: id, text: 'Also one in Arabic' });
  assert.equal(asked.details?.status, 'pending_approval', 'a message to a session asks the owner first');
  const msg = await s.sessionMessageTool.execute({ session_id: id, text: 'Also one in Arabic' }, ctx());
  assert.equal(msg.error, undefined, text(msg));
  await settle();
  assert.match(text(await s.sessionStopTool.execute({ session_id: id }, ctx())), /not working|Stopped/);
});

test('refused: other agents, members, channels, unknown chats, too deep', async () => {
  assert.ok((await s.sessionStartTool.execute({ agent_id: 'nobody', task: 'x' }, ctx())).error);
  assert.ok((await s.sessionStartTool.execute({ agent_id: 'main', task: 'x' }, ctx())).error, 'not itself');
  assert.ok((await s.sessionStartTool.execute({ agent_id: 'milo', task: 'x' }, ctx({ userId: 'member' }))).error, 'only the owner');
  assert.ok((await s.sessionStartTool.execute({ agent_id: 'milo', task: 'x' }, ctx({ toolPolicy: { channel: 'telegram' } }))).error, 'never in a channel');
  assert.ok((await s.sessionReadTool.execute({ session_id: parent.id }, ctx())).error, 'only its own sub-sessions');
  const other = await createConversation('owner', { title: 'Elsewhere', agentId: 'main' });
  assert.ok((await s.sessionStopTool.execute({ session_id: other.id }, ctx())).error, 'not a chat outside its family');
  const a = await createConversation('owner', { title: 'A', agentId: 'main', parentId: parent.id });
  const b = await createConversation('owner', { title: 'B', agentId: 'main', parentId: a.id });
  const deep = await s.sessionStartTool.execute({ agent_id: 'milo', task: 'x' }, ctx({ sessionId: b.id }));
  assert.match(text(deep), /deep/);
});
