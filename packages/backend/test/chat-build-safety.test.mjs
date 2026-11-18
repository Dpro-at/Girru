// CHAT-BUILD-01 stage 1: chat safety and correctness.
//  - a journal row left 'running' without a live run never locks the conversation;
//  - a retry with the same runId after a lost 202 gets the accepted turn back, never a second one.
// Throwaway DB/keys; the local model is stubbed (no network).
// Run: node --import tsx --test test/chat-build-safety.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-chat-build-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
for (const k of ['AGENT_EXEC_TOOLS', 'OLLAMA_THINK', 'DEFAULT_MODEL']) delete process.env[k];

const script = [];
const bodies = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== 'http://127.0.0.1:11434/api/chat') throw new Error(`unexpected network call in test: ${url}`);
  bodies.push(init.body);
  const lines = script.shift() ?? [{ message: { content: 'ok' }, done: true }];
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(enc.encode(JSON.stringify(l) + '\n')); c.close(); } }), { status: 200 });
};
const logged = [];
const capture = (...a) => { logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
console.log = capture; console.info = capture; console.warn = capture; console.error = capture;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(join(backendDir, 'src/multi-agent/index.ts'));
await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
for (const [id, role] of [['b-owner', 'owner'], ['b-other', 'user']]) {
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`).run(id, `${id}@example.test`, id, role);
}
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('b-agent', 'Build Agent', 'ollama', 'qwen-test', 1)`).run();

const tools = await import(join(backendDir, 'src/tools/index.ts'));
const grants = await import(join(backendDir, 'src/tools/grants.ts'));
const approvals = await import(join(backendDir, 'src/tools/approvals.ts'));
const sent = [];
tools.registerExtensionTool({ name: 'x_send_note', description: 'sends a note to someone', extensionId: 'x', requiresApproval: true,
  input_schema: { type: 'object', properties: { to: { type: 'string' } } },
  execute: async (p) => { sent.push(p.to); return { content: [{ type: 'text', text: `note sent to ${p.to}` }] }; } });
const avail = tools.createToolsRegistry({ workspaceDir: dir }).listRegistered();
await grants.setAgentGrants('b-agent', { grants: ['x_send_note'] }, 'b-owner', avail);
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { chatRuns } = await import(join(backendDir, 'src/services/chat-runs.ts'));
const recovery = await import(join(backendDir, 'src/repositories/chat-recovery.ts'));
const app = await buildServer({ logger: false });
await app.ready();
const as = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const call = (user, method, url, payload) => app.inject({ method, url, headers: as(user), ...(payload ? { payload } : {}) });
const ended = (runId) => new Promise((r) => { const run = chatRuns.get(runId); if (!run || run.status !== 'running') r(); else run.emitter.once('end', r); });
const rid = () => `run-${randomBytes(6).toString('hex')}`;
const newConversation = async () => (await call('b-owner', 'POST', '/api/chat/conversations', {})).json().conversation;
const journalState = (runId) => db.prepare('SELECT state FROM chat_run_journal WHERE run_id = ?').get(runId)?.state;

test('a journal row left running with no live run is reconciled; the next message is accepted', async () => {
  const c = await newConversation();
  const stale = rid();
  await recovery.acceptChatRun({ run_id: stale, session_id: c.id, user_id: 'b-owner', agent_id: null, started_at: Date.now() - 60_000 }, 'An earlier request');
  assert.equal(journalState(stale), 'running');
  const next = rid();
  const start = await call('b-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId: next, message: 'Hello again' });
  assert.equal(start.statusCode, 202, start.body);
  await ended(next);
  assert.equal(journalState(stale), 'interrupted');
  assert.equal(journalState(next), 'complete');
  const messages = (await call('b-owner', 'GET', `/api/chat/conversations/${c.id}/messages`)).json().messages;
  assert.deepEqual(messages.map((m) => [m.role, m.status]), [['user', 'complete'], ['assistant', 'error'], ['user', 'complete'], ['assistant', 'complete']]);
  assert.equal(messages[1].code, 'run_interrupted');
});

test('a live run still answers conversation_busy', async () => {
  const c = await newConversation();
  let release;
  const gate = new Promise((r) => { release = r; });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...a) => { await gate; return realFetch(...a); };
  const first = rid();
  try {
    assert.equal((await call('b-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId: first, message: 'Slow one' })).statusCode, 202);
    const busy = await call('b-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId: rid(), message: 'Second' });
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.json().code, 'conversation_busy');
    assert.equal(journalState(first), 'running');
  } finally { globalThis.fetch = realFetch; release(); }
  await ended(first);
  assert.equal(journalState(first), 'complete');
});

test('the same runId after a lost 202 returns the accepted turn and never adds a second one', async () => {
  const c = await newConversation();
  const runId = rid();
  // The first POST was accepted and finished; its in-memory run is gone (as after the TTL).
  await recovery.acceptChatRun({ run_id: runId, session_id: c.id, user_id: 'b-owner', agent_id: null, started_at: Date.now() }, 'Do it once');
  await recovery.finishChatRun(runId, 'complete');
  const retry = await call('b-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId, message: 'Do it once' });
  assert.equal(retry.statusCode, 202, retry.body);
  assert.equal(retry.json().replayed, true);
  assert.equal(retry.json().userMessage.content, 'Do it once');
  const users = db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ? AND role = 'user'").get(c.id).n;
  assert.equal(users, 1);
  // The same runId in another conversation is still refused.
  const other = await newConversation();
  const reused = await call('b-owner', 'POST', `/api/chat/conversations/${other.id}/runs`, { runId, message: 'Do it once' });
  assert.equal(reused.statusCode, 409);
  assert.equal(reused.json().code, 'run_id_reused');
});

test('an approval the owner decides returns into the chat: the conversation continues with the result', async () => {
  const c = await newConversation();
  script.push(
    [{ message: { content: '', tool_calls: [{ function: { name: 'x_send_note', arguments: { to: 'bob' } } }] } }, { done: true }],
    [{ message: { content: 'It waits for your approval.' } }, { done: true }],
  );
  const runId = rid();
  assert.equal((await call('b-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId, message: 'Send bob a note' })).statusCode, 202);
  await ended(runId);
  assert.deepEqual(sent, [], 'nothing runs before approval');
  const pending = db.prepare("SELECT id FROM tool_approvals WHERE session_id = ? AND status = 'pending'").all(c.id);
  assert.equal(pending.length, 1);
  const detail = await approvals.getApprovalDetail(pending[0].id);
  script.push([{ message: { content: 'Done: the note went to bob.' } }, { done: true }]);
  const before = bodies.length;
  await approvals.approveAndRun(detail.id, 'b-owner', detail.paramsHash);
  assert.deepEqual(sent, ['bob']);
  const cont = `approval-${detail.id}`;
  for (let i = 0; i < 50 && !chatRuns.get(cont); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(chatRuns.get(cont), 'a continuation turn started');
  await ended(cont);
  const messages = (await call('b-owner', 'GET', `/api/chat/conversations/${c.id}/messages`)).json().messages;
  assert.deepEqual(messages.slice(-2).map((m) => [m.role, m.content]), [['user', 'I decided the waiting approval. Continue the task with its result.'], ['assistant', 'Done: the note went to bob.']]);
  assert.match(bodies.slice(before).join('\n'), /note sent to bob/, 'the model got the approved result');
  assert.equal(sent.length, 1, 'the approved call never runs twice');
});

test('model choice: a picked Claude model is used as picked; only "auto" lets the router choose', async () => {
  const chat = await import(join(backendDir, 'src/api/routes/chat.ts'));
  assert.equal(chat.AUTO_MODEL, 'auto');
  const src = (await import('node:fs')).readFileSync(join(backendDir, 'src/agent/execution/chat-turn.ts'), 'utf8');
  assert.match(src, /if \(autoModel && \(provider === 'claude' \|\| provider === undefined\)\)/);
  assert.equal(chat.capMiddle('abc', 10), 'abc');
  const capped = chat.capMiddle('A'.repeat(5000) + 'END', 1000);
  assert.ok(capped.length <= 1000 && capped.startsWith('AAA') && capped.endsWith('END') && capped.includes('left out for size'));
});

test('long conversations open one page at a time (newest last) with earlier pages on request', async () => {
  const c = await newConversation();
  for (let i = 0; i < 7; i++) {
    const runId = rid();
    await recovery.acceptChatRun({ run_id: runId, session_id: c.id, user_id: 'b-owner', agent_id: null, started_at: Date.now() }, `message ${i}`);
    await recovery.finishChatRun(runId, 'complete');
  }
  const first = (await call('b-owner', 'GET', `/api/chat/conversations/${c.id}/messages?limit=3`)).json();
  assert.deepEqual(first.messages.map((m) => m.content), ['message 4', 'message 5', 'message 6']);
  assert.equal(first.hasMore, true);
  const second = (await call('b-owner', 'GET', `/api/chat/conversations/${c.id}/messages?limit=3&before=${first.messages[0].id}`)).json();
  assert.deepEqual(second.messages.map((m) => m.content), ['message 1', 'message 2', 'message 3']);
  const last = (await call('b-owner', 'GET', `/api/chat/conversations/${c.id}/messages?limit=3&before=${second.messages[0].id}`)).json();
  assert.deepEqual(last.messages.map((m) => m.content), ['message 0']);
  assert.equal(last.hasMore, false);
  assert.equal((await call('b-owner', 'GET', `/api/chat/conversations/${c.id}/messages`)).json().messages.length, 7, 'without paging the whole conversation (other callers)');
  assert.equal((await call('b-owner', 'GET', `/api/chat/conversations/${c.id}/messages?limit=0`)).statusCode, 400);
  assert.equal((await call('b-other', 'GET', `/api/chat/conversations/${c.id}/messages?limit=3`)).statusCode, 404);
});

test('stage 2: the chat list says who works and what waits; a chat can be archived and brought back', async () => {
  const c = await newConversation();
  const put = (body) => call('b-owner', 'PUT', `/api/chat/conversations/${c.id}`, body);
  assert.equal((await put({ archived: true })).json().conversation.archived, true);
  let row = (await call('b-owner', 'GET', '/api/chat/conversations')).json().conversations.find((x) => x.id === c.id);
  assert.equal(row.archived, true);
  assert.equal((await put({ archived: 'yes' })).statusCode, 400);
  assert.equal((await put({ archived: false })).json().conversation.archived, undefined);
  const reg = await tools.createAgentToolsRegistry({ workspaceDir: dir, userId: 'b-owner', sessionId: c.id, agentId: 'b-agent' });
  assert.equal((await reg.execute('x_send_note', { to: 'zed' })).details?.status, 'pending_approval');
  row = (await call('b-owner', 'GET', '/api/chat/conversations')).json().conversations.find((x) => x.id === c.id);
  assert.equal(row.waiting, 1);
  assert.equal(row.running, undefined);
  assert.equal((await call('b-other', 'PUT', `/api/chat/conversations/${c.id}`, { archived: true })).statusCode, 404);
});

test('stage 2: the sidebar layout is saved per person; bad values are refused', async () => {
  assert.deepEqual((await call('b-owner', 'GET', '/api/chat/sidebar')).json().sidebar, { order: ['scheduled', 'running', 'pinned', 'projects', 'other', 'archived'], hidden: ['running', 'archived'], folded: [] });
  const saved = (await call('b-owner', 'PUT', '/api/chat/sidebar', { order: ['pinned', 'other'], hidden: [], folded: ['proj-1'] })).json().sidebar;
  assert.deepEqual(saved.order.slice(0, 2), ['pinned', 'other']);
  assert.equal(saved.order.length, 6);
  assert.deepEqual((await call('b-other', 'GET', '/api/chat/sidebar')).json().sidebar.hidden, ['running', 'archived'], 'another person keeps the usual layout');
  for (const bad of [{}, { order: ['nope'] }, { folded: ['../x'] }, { theme: 'x' }]) assert.equal((await call('b-owner', 'PUT', '/api/chat/sidebar', bad)).statusCode, 400);
});

test('stage 3: Mode, Thinking and waiting messages are saved per chat; a waiting message never keeps a raw secret', async () => {
  const c = await newConversation();
  const put = (body) => call('b-owner', 'PUT', `/api/chat/conversations/${c.id}`, body);
  const r = (await put({ mode: 'plan', thinking: 'deep', queued: [{ key: 'q-12345678', text: 'Next: deploy with ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8' }] })).json().conversation;
  assert.equal(r.mode, 'plan'); assert.equal(r.thinking, 'deep');
  assert.equal(r.queued.length, 1);
  assert.match(r.queued[0].text, /\[SECRET:github_token:/);
  assert.ok(!JSON.stringify(db.prepare('SELECT queued FROM chat_sessions WHERE id = ?').get(c.id)).includes('A1b2C3d4'), 'no raw secret stored');
  const listed = (await call('b-owner', 'GET', '/api/chat/conversations')).json().conversations.find((x) => x.id === c.id);
  assert.equal(listed.queued, undefined, 'waiting messages travel with the open chat only');
  assert.equal(listed.mode, 'plan');
  for (const bad of [{ mode: 'yolo' }, { thinking: 'max' }, { queued: 'x' }, { queued: [{ key: 'k', text: 'x' }] }]) assert.equal((await put(bad)).statusCode, 400, JSON.stringify(bad));
  assert.equal((await put({ mode: 'auto', thinking: 'normal', queued: [] })).json().conversation.mode, undefined);
});

test('stage 3: in "Ask me" a tool that changes something asks first; reading does not', async () => {
  const context = await import(join(backendDir, 'src/services/chat-run-context.ts'));
  const { changesSomething } = await import(join(backendDir, 'src/tools/registry.ts'));
  assert.equal(changesSomething({ name: 'read' }), false);
  assert.equal(changesSomething({ name: 'memory_save' }), false);
  assert.equal(changesSomething({ name: 'x_send_note' }), true);
  assert.equal(changesSomething({ name: 'file_write' }), true);
  assert.equal(changesSomething({ name: 'git_commit', extensionId: 'x' }), true, 'an extension tool changes something unless it only reads');
  assert.equal(changesSomething({ name: 'x_list_items', extensionId: 'x' }), false);
  assert.equal(changesSomething({ name: 'board_comment' }), true);
  const made = (await call('b-owner', 'POST', '/api/chat/conversations', { mode: 'plan', thinking: 'quick' })).json().conversation;
  assert.deepEqual([made.mode, made.thinking], ['plan', 'quick'], 'a new chat is created with its Mode, never run in auto first');
  assert.equal((await call('b-owner', 'POST', '/api/chat/conversations', { mode: 'yolo' })).statusCode, 400);
  const c = await newConversation();
  tools.registerExtensionTool({ name: 'x_rename_file', description: 'renames a file', extensionId: 'x', requiresApproval: false, input_schema: { type: 'object' }, execute: async () => ({ content: [{ type: 'text', text: 'renamed' }] }) });
  await grants.setAgentGrants('b-agent', { grants: ['x_send_note', 'x_rename_file'] }, 'b-owner', tools.createToolsRegistry({ workspaceDir: dir }).listRegistered());
  const reg = await tools.createAgentToolsRegistry({ workspaceDir: dir, userId: 'b-owner', sessionId: c.id, agentId: 'b-agent' });
  const ctx = (chatMode) => ({ reviewTools: false, chatMode, beforeTool: async () => 'i', afterTool: async () => {} });
  assert.equal((await context.withChatRun(ctx('auto'), () => reg.execute('x_rename_file', {}))).content[0].text, 'renamed');
  assert.equal((await context.withChatRun(ctx('ask'), () => reg.execute('x_rename_file', {}))).details?.status, 'pending_approval');
  assert.equal((await context.withChatRun(ctx('plan'), () => reg.execute('x_rename_file', {}))).details?.status, 'pending_approval');
});

test('stage 3: projects keep added folders; variables are encrypted, listed by name only, refused for reserved names', async () => {
  const { mkdtempSync } = await import('node:fs');
  const main = mkdtempSync(join(dir, 'main-')), extra = mkdtempSync(join(dir, 'brand-'));
  const p = (await call('b-owner', 'POST', '/api/chat/projects', { name: 'Site', folder: main, folders: [{ path: extra, write: true }, { path: main }] })).json().project;
  assert.deepEqual(p.folders.map((f) => f.write), [true], 'the main folder is never added twice');
  const v = (await call('b-owner', 'PUT', `/api/chat/projects/${p.id}/variables/API_URL`, { value: 'https://api.example.test/token-value' })).json();
  assert.deepEqual(v.variables, ['API_URL']);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM credentials').all()).includes('token-value'), 'stored encrypted');
  assert.equal((await call('b-owner', 'PUT', `/api/chat/projects/${p.id}/variables/PATH`, { value: '/tmp' })).statusCode, 400);
  assert.equal((await call('b-owner', 'PUT', `/api/chat/projects/${p.id}/variables/lower`, { value: 'x' })).statusCode, 400);
  assert.equal((await call('b-owner', 'PUT', `/api/chat/projects/${p.id}/variables/ZDOTDIR`, { value: '/tmp' })).statusCode, 400, 'shell start-up names are refused');
  const env = await (await import(join(backendDir, 'src/services/project-variables.ts'))).variablesEnv('b-owner', p.id);
  assert.deepEqual(env, { API_URL: 'https://api.example.test/token-value' });
  assert.equal((await call('b-other', 'GET', `/api/chat/projects/${p.id}/variables`)).statusCode, 403);
  assert.equal((await call('b-owner', 'DELETE', `/api/chat/projects/${p.id}`)).statusCode, 200);
  assert.deepEqual(await (await import(join(backendDir, 'src/services/project-variables.ts'))).listVariables('b-owner', p.id), [], 'variables go with the project');
});

test('images: saved with the chat (checked by their bytes), kept on the message, sent to a model that can see, removed with the chat', async () => {
  const { existsSync } = await import('node:fs');
  const c = await newConversation();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]).toString('base64');
  const up = await call('b-owner', 'POST', `/api/chat/conversations/${c.id}/images`, { data: png, name: 'screen/shot.png' });
  assert.equal(up.statusCode, 201, up.body);
  const img = up.json().image;
  assert.equal(img.type, 'image/png'); assert.equal(img.name, 'screen shot.png');
  for (const body of [{ data: Buffer.from('<svg onload=alert(1)>').toString('base64') }, { data: 'not base64!' }, { data: png, path: '/etc' }]) assert.equal((await call('b-owner', 'POST', `/api/chat/conversations/${c.id}/images`, body)).statusCode, 400, JSON.stringify(body).slice(0, 40));
  assert.equal((await call('b-other', 'POST', `/api/chat/conversations/${c.id}/images`, { data: png })).statusCode, 404, 'not someone else’s chat');
  assert.equal((await call('b-other', 'GET', `/api/chat/conversations/${c.id}/images/${img.id}`)).statusCode, 404);
  assert.equal((await call('b-owner', 'GET', `/api/chat/conversations/${c.id}/images/${img.id}`)).json().image.data, png);
  assert.equal((await call('b-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId: rid(), message: 'x', images: ['f'.repeat(32)] })).statusCode, 400, 'only images of this chat');
  const before = bodies.length, runId = rid();
  assert.equal((await call('b-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId, message: 'What is in the picture?', images: [img.id] })).statusCode, 202);
  await ended(runId);
  const sent = JSON.parse(bodies.slice(before).find((x) => x.includes('What is in the picture?')));
  assert.deepEqual(sent.messages.at(-1).images, [png], 'the local model gets the image');
  const user = (await call('b-owner', 'GET', `/api/chat/conversations/${c.id}/messages?limit=5`)).json().messages.find((m) => m.role === 'user');
  assert.deepEqual(user.parts, [{ kind: 'images', images: [{ id: img.id, type: 'image/png', name: 'screen shot.png' }] }]);
  const folder = join(dir, '.data', 'chat-images', c.id);
  assert.ok(existsSync(folder));
  assert.equal((await call('b-owner', 'DELETE', `/api/chat/conversations/${c.id}`)).statusCode, 200);
  assert.equal(existsSync(folder), false, 'removed with the chat');
});

test('chat settings: the done-in-the-background notice is on by default and saved per person', async () => {
  assert.deepEqual((await call('b-owner', 'GET', '/api/chat/settings')).json(), { settings: { notifyDone: true } });
  assert.equal((await call('b-owner', 'PUT', '/api/chat/settings', { notifyDone: false })).statusCode, 200);
  assert.deepEqual((await call('b-owner', 'GET', '/api/chat/settings')).json(), { settings: { notifyDone: false } });
  assert.deepEqual((await call('b-other', 'GET', '/api/chat/settings')).json(), { settings: { notifyDone: true } });
  for (const body of [{}, { notifyDone: 'no' }, { notifyDone: true, x: 1 }]) assert.equal((await call('b-owner', 'PUT', '/api/chat/settings', body)).statusCode, 400);
});

test('the chat that was open is kept per person; only an existing chat of the caller', async () => {
  const c = await newConversation();
  assert.deepEqual((await call('b-owner', 'GET', '/api/chat/last')).json(), { last: null });
  assert.equal((await call('b-owner', 'PUT', '/api/chat/last', { last: c.id })).statusCode, 200);
  assert.deepEqual((await call('b-owner', 'GET', '/api/chat/last')).json(), { last: c.id });
  assert.deepEqual((await call('b-other', 'GET', '/api/chat/last')).json(), { last: null }, 'another person keeps their own');
  assert.equal((await call('b-other', 'PUT', '/api/chat/last', { last: c.id })).statusCode, 404, 'not someone else’s chat');
  for (const body of [{}, { last: '../x' }, { last: c.id, more: 1 }]) assert.equal((await call('b-owner', 'PUT', '/api/chat/last', body)).statusCode, 400);
  assert.equal((await call('b-owner', 'DELETE', `/api/chat/conversations/${c.id}`)).statusCode, 200);
  assert.deepEqual((await call('b-owner', 'GET', '/api/chat/last')).json(), { last: null }, 'a deleted chat is not opened');
  assert.equal((await call('b-owner', 'PUT', '/api/chat/last', { last: null })).statusCode, 200);
});

test('the folder is fixed after the first message: moving to a project on another folder is refused', async () => {
  const { mkdtempSync } = await import('node:fs');
  const one = (await call('b-owner', 'POST', '/api/chat/projects', { name: 'One', folder: mkdtempSync(join(dir, 'one-')) })).json().project;
  const two = (await call('b-owner', 'POST', '/api/chat/projects', { name: 'Two', folder: mkdtempSync(join(dir, 'two-')) })).json().project;
  const c = (await call('b-owner', 'POST', '/api/chat/conversations', { projectId: one.id })).json().conversation;
  assert.equal((await call('b-owner', 'PUT', `/api/chat/conversations/${c.id}`, { projectId: two.id })).statusCode, 200, 'no message yet: it may still move');
  assert.equal((await call('b-owner', 'PUT', `/api/chat/conversations/${c.id}`, { projectId: one.id })).statusCode, 200);
  const { addUserMessage } = await import(join(backendDir, 'src/repositories/chat-conversations.ts'));
  await addUserMessage(c.id, 'Start here', rid());
  for (const projectId of [two.id, null]) {
    const r = await call('b-owner', 'PUT', `/api/chat/conversations/${c.id}`, { projectId });
    assert.equal(r.statusCode, 409, `to ${projectId ?? 'no project'}`);
    assert.equal(r.json().code, 'folder_fixed');
  }
  assert.equal((await call('b-owner', 'PUT', `/api/chat/conversations/${c.id}`, { projectId: one.id, pinned: true })).statusCode, 200, 'same project: other changes still save');
});

test('stage 4: a chat on a schedule sends its message at the time, once; the list shows the next run', async () => {
  const c = await newConversation();
  const sched = await import(join(backendDir, 'src/services/chat-schedules.ts'));
  const { sendScheduled } = await import(join(backendDir, 'src/api/routes/chat-conversations.ts'));
  const nx = sched.nextRun('daily', '09:00', null, new Date(2026, 9, 27, 10, 0));
  assert.deepEqual([nx.getDate(), nx.getHours()], [28, 9]);
  assert.equal(sched.nextRun('weekly', '08:30', 1, new Date(2026, 9, 27, 10, 0)).getDay(), 1);
  const put = await call('b-owner', 'PUT', `/api/chat/conversations/${c.id}/schedule`, { every: 'daily', at: '09:00', message: 'Check the site' });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal((await call('b-owner', 'PUT', `/api/chat/conversations/${c.id}/schedule`, { every: 'daily', at: '25:00', message: 'x' })).statusCode, 400);
  assert.equal((await call('b-other', 'GET', `/api/chat/conversations/${c.id}/schedule`)).statusCode, 403);
  const listed = (await call('b-owner', 'GET', '/api/chat/conversations')).json().conversations.find((x) => x.id === c.id);
  assert.ok(listed.schedule && listed.schedule.paused === false && listed.schedule.next);
  db.prepare('UPDATE chat_schedules SET next_run = ? WHERE session_id = ?').run(new Date(Date.now() - 60_000).toISOString(), c.id);
  const n = await sched.runDueSchedules(sendScheduled);
  assert.equal(n, 1);
  assert.equal(await sched.runDueSchedules(sendScheduled), 0, 'never twice for one time');
  const runId = db.prepare("SELECT run_id FROM chat_messages WHERE session_id = ? AND role = 'user' AND content = 'Check the site'").get(c.id)?.run_id;
  assert.ok(runId, 'the message was sent to the chat');
  await ended(runId);
  // Tokens by model: the stored reply keeps its model and estimates.
  const usage = (await call('b-owner', 'GET', `/api/chat/conversations/${c.id}/usage`)).json().usage;
  assert.equal(usage.length, 1); assert.ok(usage[0].tokensIn > 0 && usage[0].replies === 1);
  assert.equal((await call('b-owner', 'DELETE', `/api/chat/conversations/${c.id}/schedule`)).statusCode, 200);
});

test('stage 4: panel layout per person; team list; Stop for the whole chat', async () => {
  assert.deepEqual((await call('b-owner', 'GET', '/api/chat/panel')).json().panel.order, ['place', 'team', 'results', 'memory', 'mcp']);
  assert.deepEqual((await call('b-owner', 'PUT', '/api/chat/panel', { order: ['results'], folded: ['mcp'] })).json().panel, { order: ['results', 'place', 'team', 'memory', 'mcp'], folded: ['mcp'], diff: 'unified' });
  assert.equal((await call('b-owner', 'PUT', '/api/chat/panel', { order: ['nope'] })).statusCode, 400);
  // CH4/CH8: the diff view is kept with the panel, alone, without touching order or folds; only two values.
  assert.deepEqual((await call('b-owner', 'PUT', '/api/chat/panel', { diff: 'split' })).json().panel, { order: ['results', 'place', 'team', 'memory', 'mcp'], folded: ['mcp'], diff: 'split' });
  assert.equal((await call('b-owner', 'GET', '/api/chat/panel')).json().panel.diff, 'split');
  assert.equal((await call('b-owner', 'PUT', '/api/chat/panel', { order: ['team'] })).json().panel.diff, 'split', 'saving the order keeps the diff view');
  for (const diff of ['wide', 1, null]) assert.equal((await call('b-owner', 'PUT', '/api/chat/panel', { diff })).statusCode, 400, String(diff));
  assert.equal((await call('b-other', 'GET', '/api/chat/panel')).json().panel.diff, 'unified', 'per person');
  const c = await newConversation();
  assert.deepEqual((await call('b-owner', 'GET', `/api/chat/conversations/${c.id}/team`)).json().team, []);
  assert.deepEqual((await call('b-owner', 'POST', `/api/chat/conversations/${c.id}/stop`)).json(), { ok: true, stopped: 0 });
  assert.equal((await call('b-other', 'POST', `/api/chat/conversations/${c.id}/stop`)).statusCode, 404);
});

test('coding apps: Team lists each one an agent started, with its own Stop; Stop for the chat ends them too', async () => {
  const { startCodingRun } = await import('../src/services/coding-runs.ts');
  const c = await newConversation();
  const run = startCodingRun(c.id, 'Claude Code', null, 'Check the hero at phone width\nmore detail');
  const apps = (await call('b-owner', 'GET', `/api/chat/conversations/${c.id}/team`)).json().apps;
  assert.equal(apps.length, 1);
  assert.deepEqual({ id: apps[0].id, app: apps[0].app, agentName: apps[0].agentName, about: apps[0].about }, { id: run.id, app: 'Claude Code', agentName: null, about: 'Check the hero at phone width' });
  assert.equal((await call('b-other', 'POST', `/api/chat/conversations/${c.id}/apps/${run.id}/stop`)).statusCode, 404, 'not someone else’s chat');
  assert.equal(run.signal.aborted, false);
  assert.deepEqual((await call('b-owner', 'POST', `/api/chat/conversations/${c.id}/apps/${run.id}/stop`)).json(), { ok: true });
  assert.equal(run.signal.aborted, true);
  run.done();
  assert.deepEqual((await call('b-owner', 'GET', `/api/chat/conversations/${c.id}/team`)).json().apps, []);
  assert.equal((await call('b-owner', 'POST', `/api/chat/conversations/${c.id}/apps/${run.id}/stop`)).statusCode, 404, 'gone once it ended');
  const two = startCodingRun(c.id, 'Codex', null, 'x');
  assert.equal((await call('b-owner', 'POST', `/api/chat/conversations/${c.id}/stop`)).json().stopped, 1);
  assert.equal(two.signal.aborted, true);
  two.done();
});

test('CH6: the team list carries the live step of each delegated agent (empty when none works)', async () => {
  const c = await newConversation();
  assert.deepEqual((await call('b-owner', 'GET', `/api/chat/conversations/${c.id}/team`)).json().steps, []);
  const { readFileSync } = await import('node:fs');
  const team = readFileSync(join(backendDir, 'src/tools/tasks/team.ts'), 'utf8');
  assert.match(team, /execute: async \(name, args\) => \{ setStep\(session, target\.id, name\); try \{ return await registry\.execute\(name, args\); \} finally \{ setStep\(session, target\.id, 'thinking'\); \} \}/);
  assert.match(team, /finally \{ active\.delete\(key\); setStep\(session, params\.agent_id as string, null\);/);
});

test('images: Codex gets the chat\'s own image files with -i; nothing outside the images folder, at most 4', async () => {
  const { subscriptionArgs, chatImageFiles } = await import('../src/services/subscription-chat.ts');
  const { dataPath } = await import('../src/config/data-root.ts');
  const base = dataPath('chat-images');
  const ok = [1, 2, 3, 4, 5].map(n => join(base, 'chat-1', `${'a'.repeat(31)}${n}.png`));
  assert.deepEqual(chatImageFiles([...ok, '/etc/passwd', join(base, '..', 'x.png'), 'relative.png', join(base, 'c', 'y.svg')]), ok.slice(0, 4));
  const args = subscriptionArgs('codex', undefined, undefined, true, false, false, [], [ok[0], '/etc/hosts.png']);
  assert.deepEqual(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2), ['-i', ok[0]]);
  assert.equal(args.filter(a => a === '-i').length, 1);
  assert.equal(args.at(-1), '-', 'the prompt still comes on stdin');
  assert.ok(!subscriptionArgs('claude', undefined, undefined, true, false, false, [], [ok[0]]).includes(ok[0]), 'Claude Code is not given files');
});

test('a continuation after an approval is reminded of the plan steps still open, so its Tasks list can end finished', async () => {
  const { openPlanReminder } = await import(join(backendDir, 'src/api/routes/chat-conversations.ts'));
  const plan = (statuses) => ({ role: 'assistant', parts: [{ kind: 'tools', step: 1, calls: [{ id: 'p', name: 'plan_steps', input: JSON.stringify({ steps: statuses.map((status, i) => ({ title: `Step ${i + 1}`, status })) }), output: 'ok' }] }] });
  const text = { role: 'assistant', parts: [{ kind: 'text', text: 'Final report' }] };
  assert.equal(openPlanReminder([plan(['done', 'done', 'done', 'active', 'pending', 'pending']), text]),
    ' Your plan shows 3 of 6 done (open: Step 4; Step 5; Step 6). Update it with plan_steps as each step finishes, and mark every step done or skipped before your final answer.');
  assert.equal(openPlanReminder([plan(['done', 'skipped'])]), '', 'a finished plan needs no reminder');
  assert.equal(openPlanReminder([plan(['active', 'pending']), plan(['done', 'done'])]), '', 'only the latest plan counts');
  assert.equal(openPlanReminder([text, { role: 'user', parts: [] }]), '', 'no plan, no reminder');
});
