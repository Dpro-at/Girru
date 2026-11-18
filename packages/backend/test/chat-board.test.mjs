// CHAT-PRO-02 I step 2: a chat task becomes a board card.
//  - owner only (others 401/403); the conversation and board must be the owner's;
//  - the card keeps the conversation, lands in "To do" by default, with its agents;
//  - moves, comments (owner and agent) and "done" are logged and shown to the chat;
//  - the card panel reads its conversation and the agents' progress (replies, plans, running);
//  - an agent can only suggest a card (board_suggest_card writes nothing).
// Throwaway DB/keys; the local model is stubbed (no network).
// Run: node --import tsx --test test/chat-board.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { offeredNames, expectedNumCtx, expectedNumPredict, p2bOn } from './helpers/p2b.mjs';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-chat-board-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
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
  bodies.push(JSON.parse(init.body));
  const lines = script.shift() ?? [{ message: { content: 'ok' }, done: true }];
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(enc.encode(JSON.stringify(l) + '\n')); c.close(); } }), { status: 200 });
};
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(join(backendDir, 'src/multi-agent/index.ts'));
await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
for (const [id, role] of [['cb-owner', 'owner'], ['cb-admin', 'admin'], ['cb-user', 'user']]) {
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`).run(id, `${id}@example.test`, id, role);
}
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('cb-main', 'Main', 'ollama', 'qwen-test', 1)`).run();
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('cb-writer', 'Writer', 'ollama', 'qwen-test', 0)`).run();
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('cb-coder', 'Coder', 'ollama', 'qwen-test', 0)`).run();

const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { chatRuns } = await import(join(backendDir, 'src/services/chat-runs.ts'));
const { addAssistantMessage } = await import(join(backendDir, 'src/repositories/chat-conversations.ts'));
const { agentComment, agentMove } = await import(join(backendDir, 'src/services/task-board.ts'));
const { cardSuggestion, boardSuggestCardTool } = await import(join(backendDir, 'src/tools/board/board-suggest.ts'));
const app = await buildServer({ logger: false });
await app.ready();
const as = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const call = (user, method, url, payload) => app.inject({ method, url, headers: as(user), ...(payload ? { payload } : {}) });
const ended = (runId) => new Promise((r) => { const run = chatRuns.get(runId); if (run.status !== 'running') r(); else run.emitter.once('end', r); });

const boards = (await call('cb-owner', 'GET', '/api/boards')).json().boards;
let board = (await call('cb-owner', 'GET', `/api/boards/${boards[0].id}`)).json();
const col = (name) => board.columns.find((c) => c.name === name).id;
const conv = (await call('cb-owner', 'POST', '/api/chat/conversations', { title: 'Launch plan' })).json().conversation;
const cardsUrl = `/api/chat/conversations/${conv.id}/cards`;
let card;

test('only the owner turns a chat task into a card', async () => {
  assert.equal((await app.inject({ method: 'GET', url: cardsUrl })).statusCode, 401);
  for (const who of ['cb-admin', 'cb-user']) {
    assert.equal((await call(who, 'GET', cardsUrl)).statusCode, 403, who);
    assert.equal((await call(who, 'POST', cardsUrl, { boardId: board.id, title: 'x' })).statusCode, 403, who);
    assert.equal((await call(who, 'GET', `/api/boards/${board.id}/cards/x/chat`)).statusCode, 403, who);
  }
});

test('a card made from the chat keeps the conversation, lands in "To do" with its agents', async () => {
  const r = await call('cb-owner', 'POST', cardsUrl, { boardId: board.id, title: 'Launch the newsletter', description: 'From the chat: plan and write it.', agents: ['cb-writer', 'cb-coder'], priority: 'high' });
  assert.equal(r.statusCode, 201, r.body);
  card = r.json().card;
  assert.equal(card.conversationId, conv.id);
  assert.equal(card.columnId, col('To do'));
  assert.deepEqual(card.agents, ['cb-coder', 'cb-writer']);
  board = (await call('cb-owner', 'GET', `/api/boards/${board.id}`)).json();
  assert.equal(board.cards.find((c) => c.id === card.id).conversationId, conv.id, 'the board shows the link back');
  const list = (await call('cb-owner', 'GET', cardsUrl)).json();
  assert.equal(list.cards.length, 1);
  assert.deepEqual([list.cards[0].column, list.cards[0].done, list.cards[0].boardName], ['To do', false, board.name]);
  assert.deepEqual(list.cards[0].activity.map((a) => [a.kind, a.actorKind, a.detail]), [['created', 'user', 'To do']]);
  // A chosen column is kept; a card made on the board has no conversation.
  const idea = (await call('cb-owner', 'POST', cardsUrl, { boardId: board.id, columnId: col('Ideas'), title: 'Later idea' })).json().card;
  assert.equal(idea.columnId, col('Ideas'));
  const plain = (await call('cb-owner', 'POST', `/api/boards/${board.id}/cards`, { columnId: col('Backlog'), title: 'Plain' })).json();
  assert.equal(plain.conversationId, null);
  assert.deepEqual((await call('cb-owner', 'GET', `/api/boards/${board.id}/cards/${plain.id}/chat`)).json().conversation, null);
});

test('bad requests are refused; other ids look missing', async () => {
  for (const [payload, status, why] of [
    [{ title: 'x' }, 400, 'no board'], [{ boardId: board.id, title: '' }, 400, 'empty title'], [{ boardId: board.id, title: 'x', agents: ['ghost'] }, 400, 'unknown agent'],
    [{ boardId: board.id, title: 'x', conversationId: 'y' }, 400, 'extra field'], [{ boardId: 'nope', title: 'x' }, 404, 'unknown board'],
    [{ boardId: board.id, columnId: 'nope', title: 'x' }, 404, 'unknown column'],
  ]) assert.equal((await call('cb-owner', 'POST', cardsUrl, payload)).statusCode, status, why);
  assert.equal((await call('cb-owner', 'POST', '/api/chat/conversations/no-such-conversation/cards', { boardId: board.id, title: 'x' })).statusCode, 404);
  assert.equal((await call('cb-owner', 'GET', '/api/chat/conversations/no-such-conversation/cards')).statusCode, 404);
  assert.equal((await call('cb-owner', 'GET', `/api/boards/${board.id}/cards/nope/chat`)).statusCode, 404);
  // The board route itself never takes a conversation id.
  assert.equal((await call('cb-owner', 'POST', `/api/boards/${board.id}/cards`, { columnId: col('Backlog'), title: 'x', conversationId: conv.id })).statusCode, 400);
});

test('moves, comments and "done" from the board appear in the chat', async () => {
  const put = (patch) => call('cb-owner', 'PUT', `/api/boards/${board.id}/cards/${card.id}`, { expectedVersion: card.version, ...patch });
  card = (await put({ columnId: col('In progress') })).json();
  await call('cb-owner', 'POST', `/api/boards/${board.id}/cards/${card.id}/comments`, { body: 'Please keep it short.' });
  await agentComment('cb-owner', 'cb-writer', card.id, 'First draft is ready.');
  await agentMove('cb-owner', 'cb-writer', card.id, 'Review');
  card = (await call('cb-owner', 'GET', `/api/boards/${board.id}`)).json().cards.find((c) => c.id === card.id);
  card = (await put({ columnId: col('Done') })).json();
  const c = (await call('cb-owner', 'GET', cardsUrl)).json().cards.find((x) => x.id === card.id);
  assert.deepEqual(c.activity.map((a) => [a.kind, a.actorKind, a.actorId, a.detail]), [
    ['created', 'user', 'cb-owner', 'To do'], ['moved', 'user', 'cb-owner', 'In progress'], ['comment', 'user', 'cb-owner', 'Please keep it short.'],
    ['comment', 'agent', 'cb-writer', 'First draft is ready.'], ['moved', 'agent', 'cb-writer', 'Review'], ['done', 'user', 'cb-owner', 'Done'],
  ]);
  assert.equal(c.done, true); assert.equal(c.comments, 2);
  card = (await put({ archived: true })).json();
  const archived = (await call('cb-owner', 'GET', cardsUrl)).json().cards.find((x) => x.id === card.id);
  assert.equal(archived.archived, true, 'an archived card stays in the chat, marked');
  assert.equal(archived.activity.at(-1).kind, 'archived');
});

test('the card shows who works on it and how far they are (replies, plans)', async () => {
  const plan = JSON.stringify({ steps: [{ title: 'Outline', status: 'done' }, { title: 'Draft', status: 'active' }, { title: 'Polish', status: 'pending' }] });
  await addAssistantMessage(conv.id, { runId: 'run-cb-1', content: 'Working on it.', parts: [{ kind: 'tools', step: 0, calls: [{ id: 't1', name: 'plan_steps', input: plan }] }], status: 'complete', durationMs: 10, agentId: 'cb-writer' });
  await addAssistantMessage(conv.id, { runId: 'run-cb-2', content: 'Hello.', parts: [], status: 'complete', durationMs: 5 });
  const r = (await call('cb-owner', 'GET', `/api/boards/${board.id}/cards/${card.id}/chat`)).json();
  assert.deepEqual(r.conversation, { id: conv.id, title: 'Launch plan' });
  const by = Object.fromEntries(r.progress.agents.map((a) => [a.agentId, a]));
  assert.deepEqual([by['cb-writer'].replies, by['cb-writer'].plan.done, by['cb-writer'].plan.total, by['cb-writer'].plan.active], [1, 1, 3, 'Draft']);
  assert.deepEqual([by['cb-coder'].replies, by['cb-coder'].plan], [0, null], 'assigned, not started yet');
  assert.equal(by['cb-main'].replies, 1, 'a reply without a writer is the main agent');
  assert.equal(r.progress.running, false);
  const chat = (await call('cb-owner', 'GET', cardsUrl)).json();
  assert.ok(chat.progress.agents.some((a) => a.agentId === 'cb-writer' && a.plan?.active === 'Draft'));
});

test('an agent only suggests a card; the suggestion travels in the run and nothing is created', async () => {
  assert.equal(typeof cardSuggestion({}), 'string');
  assert.deepEqual(cardSuggestion({ title: '  Ship  it ', agents: ['@Writer', 'Writer', 'Coder'], priority: 'asap' }), { title: 'Ship it', description: '', agents: ['Writer', 'Coder'], priority: 'normal' });
  assert.equal(boardSuggestCardTool.selfOnly, true);
  const before = (await call('cb-owner', 'GET', `/api/boards/${board.id}`)).json().cards.length;
  const c = (await call('cb-owner', 'POST', '/api/chat/conversations', {})).json().conversation;
  script.push(
    [{ message: { content: '', tool_calls: [{ function: { name: 'board_suggest_card', arguments: { title: 'Website relaunch', agents: ['Writer'], description: 'New pages' } } }] } }, { done: true }],
    [{ message: { content: 'I suggested a card.' } }, { done: true }],
  );
  const runId = `run-${randomBytes(6).toString('hex')}`;
  assert.equal((await call('cb-owner', 'POST', `/api/chat/conversations/${c.id}/runs`, { runId, message: 'Plan the website relaunch with the team' })).statusCode, 202);
  await ended(runId);
  assert.ok(offeredNames(bodies.at(-2)).includes('board_suggest_card'), 'offered in chat runs without a grant');
  const m = (await call('cb-owner', 'GET', `/api/chat/conversations/${c.id}/messages`)).json().messages.at(-1);
  const callPart = m.parts.find((p) => p.kind === 'tools').calls[0];
  assert.equal(callPart.name, 'board_suggest_card');
  assert.match(callPart.output, /Card suggestion shown to the owner/);
  assert.equal((await call('cb-owner', 'GET', `/api/boards/${board.id}`)).json().cards.length, before, 'no card was created');
});
