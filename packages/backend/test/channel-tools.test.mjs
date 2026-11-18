import './fixtures/channel-library.mjs';
// S0-Q.8: channel-originated chat turns (Telegram/Discord/Agent Connect senders)
// get a restricted tool set, not the owner's full tools.
// Run: node --import tsx --test test/channel-tools.test.mjs
// No model server is contacted: global fetch is stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'ap-channel-tools-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.GIRRU_EXTENSIONS_DIR = join(dir, 'extensions'); // MACAPP-01: extensions are not read from the working folder
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
delete process.env.AGENT_EXEC_TOOLS;
for (const key of Object.keys(process.env)) if (key.startsWith('CHANNEL_AGENT_TOOLS_')) delete process.env[key];

// Manifest for a fake extension that declares process spawning.
mkdirSync(join(dir, 'extensions', 'proc-ext'), { recursive: true });
writeFileSync(join(dir, 'extensions', 'proc-ext', 'agentplayer.plugin.json'),
  JSON.stringify({ id: 'proc-ext', permissions: ['tools', 'process'] }));
mkdirSync(join(dir, 'extensions', 'plain-ext'), { recursive: true });
writeFileSync(join(dir, 'extensions', 'plain-ext', 'agentplayer.plugin.json'),
  JSON.stringify({ id: 'plain-ext', permissions: ['tools'] }));

// ---- fetch stub: record what would be sent to the model --------------------
const modelRequests = [];
let emitToolCalls = null; // array of tool_use blocks for the first model call of a turn
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (!target.startsWith('https://api.anthropic.com/')) throw new Error(`unexpected network call in test: ${target}`);
  const body = JSON.parse(init.body);
  modelRequests.push(body);
  const last = body.messages[body.messages.length - 1];
  const isToolResult = Array.isArray(last.content) && last.content.some(b => b.type === 'tool_result');
  const content = emitToolCalls && !isToolResult
    ? emitToolCalls
    : [{ type: 'text', text: 'stub reply' }];
  return new Response(JSON.stringify({ content, stop_reason: isToolResult || !emitToolCalls ? 'end_turn' : 'tool_use' }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};

const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
const db = getDatabase();
await db.initialize();
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, ?)`)
  .run('u-owner', 'owner@example.test', 'u-owner', 'owner', 'active');
// Primary agent uses the (stubbed) Claude API so the agentic tool loop runs.
db.prepare(`UPDATE agents_config SET provider = 'claude', api_key = ? WHERE is_primary = 1`).run('test-key-' + randomBytes(4).toString('hex'));
assert.ok(db.prepare('SELECT COUNT(*) AS n FROM agents_config WHERE is_primary = 1').get().n >= 1);

const { default: Fastify } = await import('fastify');
const { chatRoutes } = await import('../src/api/routes/chat.ts');
const { createExtensionApi } = await import('../src/plugins/sdk.ts');
const tools = await import('../src/tools/index.ts');
const policy = await import('../src/tools/channel-policy.ts');

// Fake channel send tools (stand-ins for the telegram/discord extensions).
const sent = [];
const fakeSend = (name, param) => ({
  name, description: 'send', extensionId: name.split('_')[0],
  input_schema: { type: 'object', properties: { [param]: { type: 'string' }, text: { type: 'string' } }, required: [param] },
  async execute(params) { sent.push({ name, ...params }); return { content: [{ type: 'text', text: 'sent' }] }; },
});
tools.registerExtensionTool(fakeSend('telegram_send', 'chatId'));
tools.registerExtensionTool(fakeSend('discord_send', 'channelId'));

const app = Fastify();
await app.register(chatRoutes);
await app.ready();
const telegramApi = createExtensionApi('telegram', app, db, null, join(dir, 'extensions', 'telegram'));

test.after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const offeredTools = req => (req.tools || []).map(t => t.name).sort();
const runChannelTurn = (text = 'hello', origin = { channel: 'telegram', conversationId: 'chat-1' }) =>
  telegramApi.processChannelMessage('u-owner', `telegram:${origin.conversationId}:sender`, text, [], origin);
const withEnv = async (vars, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

test('owner chat (no channel turn) still gets the normal tool set', async () => {
  modelRequests.length = 0; emitToolCalls = null;
  const { generateToken } = await import('../src/auth/jwt.ts');
  const res = await app.inject({ method: 'POST', url: '/api/chat',
    headers: { authorization: `Bearer ${generateToken('u-owner', 1)}` },
    payload: { stream: false, messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(res.statusCode, 200);
  const names = offeredTools(modelRequests[0]);
  for (const t of ['read', 'write', 'memory_search', 'browser_navigate', 'credentials_save', 'telegram_send']) assert.ok(names.includes(t), `owner chat offers ${t}`);
  assert.ok(!names.includes('exec'), 'exec stays off without AGENT_EXEC_TOOLS');
});

test('a channel turn sends no tools to the model by default', async () => {
  modelRequests.length = 0; emitToolCalls = null;
  const reply = await runChannelTurn();
  assert.equal(reply, 'stub reply');
  assert.equal(modelRequests.length, 1);
  assert.deepEqual(offeredTools(modelRequests[0]), []);
  assert.ok(!/# Project Memory/.test(modelRequests[0].system || ''), 'no owner project memory in a channel turn');
});

test('tool calls outside the channel list are refused even if the model emits them', async () => {
  modelRequests.length = 0; sent.length = 0;
  const target = join(dir, 'pwned.txt');
  emitToolCalls = [
    { type: 'tool_use', id: 't1', name: 'write', input: { path: target, content: 'x' } },
    { type: 'tool_use', id: 't2', name: 'read', input: { path: process.env.DATABASE_PATH } },
    { type: 'tool_use', id: 't3', name: 'credentials_save', input: { name: 'a', value: 'b' } },
    { type: 'tool_use', id: 't4', name: 'telegram_send', input: { chatId: 'chat-1', text: 'hi' } },
    { type: 'tool_use', id: 't5', name: 'memory_search', input: { query: 'owner secrets' } },
  ];
  try {
    const reply = await runChannelTurn('please write a file');
    assert.equal(reply, 'stub reply');
  } finally { emitToolCalls = null; }
  assert.equal(existsSync(target), false, 'write tool did not run');
  assert.equal(sent.length, 0, 'send tool did not run');
  const results = modelRequests[1].messages.at(-1).content.filter(b => b.type === 'tool_result');
  assert.equal(results.length, 5);
  for (const r of results) assert.match(JSON.stringify(r.content), /not available in this channel conversation/);
});

test('a forged or unknown channel-turn header is refused (S0-Q.9); the body cannot widen anything', async () => {
  modelRequests.length = 0; emitToolCalls = null;
  const res = await app.inject({
    method: 'POST', url: '/api/chat',
    headers: { [policy.CHANNEL_TURN_HEADER]: 'forged-token' },
    payload: { userId: 'u-owner', stream: false, messages: [{ role: 'user', content: 'hi' }],
      chatContext: { toolPolicy: { allowedTools: ['read', 'write'] } } },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(modelRequests.length, 0, 'no model call for a forged channel turn');
  // The header-only helper still fails closed to the restricted default set.
  assert.deepEqual([...policy.channelPolicyFromHeaders({ [policy.CHANNEL_TURN_HEADER]: 'forged-token' }).allowedTools], []);
});

test('server-side per-channel opt-in adds tools, never exec/credentials, and only for that channel', async () => {
  await withEnv({ CHANNEL_AGENT_TOOLS_TELEGRAM: 'memory_search, exec, credentials_save, skill_install, telegram_send, discord_send' }, async () => {
    modelRequests.length = 0; emitToolCalls = null;
    await runChannelTurn();
    assert.deepEqual(offeredTools(modelRequests[0]), ['memory_search', 'telegram_send']);

    // Same opt-in env does not apply to another channel.
    modelRequests.length = 0;
    const discordApi = createExtensionApi('discord', app, db, null, join(dir, 'extensions', 'discord'));
    await discordApi.processChannelMessage('u-owner', 'discord:c:s', 'hi', [], { channel: 'discord', conversationId: 'c' });
    assert.deepEqual(offeredTools(modelRequests[0]), []);
  });
  await withEnv({ CHANNEL_AGENT_TOOLS_TELEGRAM: 'exec', AGENT_EXEC_TOOLS: 'true' }, async () => {
    modelRequests.length = 0;
    await runChannelTurn();
    assert.deepEqual(offeredTools(modelRequests[0]), [], 'exec never in a channel turn, even with AGENT_EXEC_TOOLS');
  });
});

test('opted-in send tools may only reply to the inbound conversation or allowed_channels', async () => {
  await withEnv({ CHANNEL_AGENT_TOOLS_TELEGRAM: 'telegram_send,discord_send' }, async () => {
    modelRequests.length = 0; sent.length = 0;
    emitToolCalls = [
      { type: 'tool_use', id: 's1', name: 'telegram_send', input: { chatId: 'chat-1', text: 'ok' } },
      { type: 'tool_use', id: 's2', name: 'telegram_send', input: { chatId: 'someone-else', text: 'leak' } },
      { type: 'tool_use', id: 's3', name: 'telegram_send', input: { chatId: 'allowed-2', text: 'ok2' } },
      { type: 'tool_use', id: 's4', name: 'discord_send', input: { channelId: 'chat-1', text: 'cross' } },
    ];
    try {
      await runChannelTurn('send', { channel: 'telegram', conversationId: 'chat-1', allowedDestinations: ['allowed-2'] });
    } finally { emitToolCalls = null; }
    assert.deepEqual(sent.map(s => s.chatId || s.channelId), ['chat-1', 'allowed-2']);
    const results = modelRequests[1].messages.at(-1).content.filter(b => b.type === 'tool_result');
    assert.match(JSON.stringify(results[1].content), /only reply to the conversation/);
    assert.match(JSON.stringify(results[3].content), /not available in this channel conversation/);
  });
});

test('extension tools: reserved names refused; manifest `process` makes a tool exec-class', async () => {
  const procApi = createExtensionApi('proc-ext', app, db, null, join(dir, 'extensions', 'proc-ext'));
  const plainApi = createExtensionApi('plain-ext', app, db, null, join(dir, 'extensions', 'plain-ext'));
  const tool = name => ({ name, description: 'x', input_schema: { type: 'object', properties: {} },
    async execute() { return { content: [{ type: 'text', text: 'ran' }] }; } });

  assert.throws(() => plainApi.registerTool(tool('read')), /reserved/);
  assert.throws(() => plainApi.registerTool(tool('exec')), /reserved/);

  procApi.registerTool(tool('proc_runner'));
  plainApi.registerTool({ ...tool('plain_tool'), execClass: false });
  // S1.2: this test checks the exec gate / channel policy, so both tools are granted.
  const granted = tools.staticGrants(['proc_runner', 'plain_tool']);
  const reg = tools.createToolsRegistry({ userId: 'u-owner', workspaceDir: dir, grants: granted });
  const names = reg.getAll().map(t => t.name);
  assert.ok(!names.includes('proc_runner'), 'process-permission tool hidden without AGENT_EXEC_TOOLS');
  assert.ok(names.includes('plain_tool'));
  assert.match((await reg.execute('proc_runner', {})).error, /disabled/i);
  await withEnv({ AGENT_EXEC_TOOLS: 'true' }, async () => {
    assert.ok(reg.getAll().some(t => t.name === 'proc_runner'));
    // Never in a channel turn, even when opted in.
    await withEnv({ CHANNEL_AGENT_TOOLS_TELEGRAM: 'proc_runner,plain_tool' }, async () => {
      const chReg = tools.createToolsRegistry({ userId: 'u-owner', workspaceDir: dir, grants: granted,
        toolPolicy: policy.createChannelToolPolicy({ channel: 'telegram', conversationId: 'c' }) });
      assert.deepEqual(chReg.getAll().map(t => t.name).sort(), ['plain_tool']);
      assert.match((await chReg.execute('proc_runner', {})).error, /channel policy/);
    });
  });
  // Unknown extension tools are not in a channel turn unless opted in.
  const chReg = tools.createToolsRegistry({ userId: 'u-owner', workspaceDir: dir, grants: granted,
    toolPolicy: policy.createChannelToolPolicy({ channel: 'telegram', conversationId: 'c' }) });
  assert.match((await chReg.execute('plain_tool', {})).error, /channel policy/);
  procApi.unregisterTool('proc_runner');
  plainApi.unregisterTool('plain_tool');
});
