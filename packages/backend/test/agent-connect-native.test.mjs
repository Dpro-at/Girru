import './fixtures/channel-library.mjs';
// CHANNELS-01: the agent-connect extension hosts every catalog channel. Telegram and Discord get the
// library's Node transports, named in a switch; their settings live under channels.<id> of the one
// 'agent-connect' row, owner-only, with the token never shown. The connection is a fake: no network.
// Run: node --import tsx --test test/agent-connect-native.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { CHANNEL_CATALOG, TelegramTransport, DiscordTransport, PythonTransport } from 'agent-connect-dpro';
import { isNativeChannel, nativeTransport, registerChannelRoutes, stopChannel } from '../extensions/shared/channel-host.js';
import { registerAgentConnect } from './fixtures/agent-connect-legacy/index.js';

test('only telegram and discord get a native transport; any other id is refused before the database is touched', async () => {
  assert.deepEqual(['telegram', 'discord', 'slack', 'whatsapp', '__proto__', 'toString', 'constructor'].map(isNativeChannel),
    [true, true, false, false, false, false, false]);
  assert.ok(nativeTransport('telegram', 'fake-token') instanceof TelegramTransport);
  assert.ok(nativeTransport('discord', 'fake-token') instanceof DiscordTransport);
  for (const id of ['slack', '__proto__', 'toString']) assert.throws(() => nativeTransport(id, 'fake-token'), /No native transport/);
  const db = new Database(':memory:');
  db.exec('CREATE TABLE extension_configs (extension_id TEXT PRIMARY KEY, enabled INTEGER)');
  const app = Fastify();
  const api = { db, getConfig: () => ({}), authorizeChannelRequest: () => 'owner', log: () => {} };
  try {
    for (const id of ['whatsapp', '__proto__']) await assert.rejects(registerChannelRoutes(app, api, id), /No transport/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'channel_events'").get().n, 0);
  } finally { await app.close(); db.close(); }
});

async function host(channels) {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE extension_configs (extension_id TEXT PRIMARY KEY, enabled INTEGER); INSERT INTO extension_configs VALUES ('agent-connect', 1)");
  let root = { channels };
  const made = {}; const hooks = {}; const sends = []; const turns = []; const tools = {};
  const app = Fastify();
  const api = {
    db, getConfig: () => root, setConfig: value => { root = value; }, log() {},
    authorizeChannelRequest(request) {
      if (request.headers.authorization !== 'Bearer owner') throw new Error('Forbidden');
      return 'owner';
    },
    authorizeChannelUser(userId) { if (userId !== 'owner') throw new Error('Forbidden'); },
    async processChannelMessage(...args) { turns.push(args); return 'agent answer'; },
    registerRoutes(fn) { app.register(fn, { prefix: '/api/ext/agent-connect' }); },
    registerTool(tool) { tools[tool.name] = tool; },
  };
  await registerAgentConnect(api, {
    createConnector(id, transport, h) {
      made[id] = transport; hooks[id] = h.receive;
      return { state: 'disconnected', async connect() { this.state = 'connected'; }, async disconnect() { this.state = 'disconnected'; },
        async send(conversationId, text) { sends.push({ id, conversationId, text }); return { id: `sent-${sends.length}`, conversationId }; } };
    },
  });
  await app.ready();
  const auth = { authorization: 'Bearer owner' };
  const request = (url, method = 'GET', payload, headers = auth) => app.inject({ url: `/api/ext/agent-connect/${url}`, method, headers, ...(payload ? { payload } : {}) });
  return { db, app, request, made, hooks, sends, turns, tools, root: () => root,
    close: async () => { await Promise.allSettled(CHANNEL_CATALOG.map(c => stopChannel(c.id))); await app.close(); db.close(); } };
}

const fakeChannels = () => ({
  telegram: { bot_token: 'fake-telegram-token', allowed_users: ['sender'], auto_reply: true, owner_user_id: 'owner' },
  discord: { bot_token: 'fake-discord-token', allowed_users: ['sender'], allowed_channels: ['room'], auto_reply: true, owner_user_id: 'owner' },
});
const message = (channel, overrides = {}) => ({ channel, id: 'm1', conversationId: 'room', senderId: 'sender', senderName: 'Sender',
  text: 'hello', timestamp: new Date().toISOString(), guildId: 'guild', ...overrides });

test('every catalog channel is hosted; telegram and discord start on their native transport, the rest on Python', async () => {
  const h = await host(fakeChannels());
  try {
    for (const c of CHANNEL_CATALOG) assert.equal((await h.request(`${c.id}/status`)).statusCode, 200, c.id);
    for (const id of ['telegram', 'discord']) assert.equal((await h.request(`${id}/connect`, 'POST')).json().success, true, id);
    assert.ok(h.made.telegram instanceof TelegramTransport);
    assert.ok(h.made.discord instanceof DiscordTransport);
    assert.ok(!(h.made.telegram instanceof PythonTransport));
    assert.deepEqual(Object.keys(h.tools).sort(), ['discord_send', 'telegram_send']);
    // The removed Slack and WhatsApp extensions had public webhook routes; here no channel has one,
    // and every channel route is owner/admin only.
    for (const id of ['slack', 'whatsapp', 'telegram', 'discord']) {
      assert.equal((await h.request(`${id}/webhook`, 'POST', {}, {})).statusCode, 403, id);
      assert.equal((await h.request(`${id}/webhook`, 'POST', {})).statusCode, 410, id);
      assert.equal((await h.request(`${id}/messages`, 'GET', undefined, {})).statusCode, 403, id);
    }
  } finally { await h.close(); }
});

test('native settings are owner-only, under channels.<id>, and never show the token', async () => {
  const h = await host(fakeChannels());
  try {
    assert.equal((await h.request('telegram/config', 'GET', undefined, {})).statusCode, 403);
    assert.equal((await h.request('telegram/config', 'PUT', { config: { bot_token: 'x' } }, { authorization: 'Bearer member' })).statusCode, 403);
    const read = await h.request('telegram/config');
    assert.equal(read.json().hasToken, true);
    assert.ok(!read.body.includes('fake-telegram-token'));
    assert.ok(!(await h.request('discord/status')).body.includes('fake-discord-token'));
    // A blank token keeps the saved one; the saving account becomes the owner.
    assert.equal((await h.request('telegram/config', 'PUT', { config: { bot_token: '', allowed_users: 'sender,second' } })).statusCode, 200);
    assert.equal(h.root().channels.telegram.bot_token, 'fake-telegram-token');
    assert.equal(h.root().channels.telegram.allowed_users, 'sender,second');
    assert.equal(h.root().channels.discord.bot_token, 'fake-discord-token', 'other channels untouched');
    // Choosing an interpreter over HTTP is refused for every channel, native ones included.
    assert.equal((await h.request('telegram/config', 'PUT', { config: { python_executable: '/bin/sh' } })).statusCode, 400);
  } finally { await h.close(); }
});

test('channel senders: allow-lists, and the agent turn runs with the restricted channel origin', async () => {
  const h = await host(fakeChannels());
  try {
    for (const id of ['telegram', 'discord']) await h.request(`${id}/connect`, 'POST');
    await h.hooks.telegram(message('telegram', { senderId: 'stranger' }));
    await h.hooks.discord(message('discord', { conversationId: 'other-room' }));
    assert.equal(h.turns.length, 0, 'unknown sender and unlisted Discord channel are ignored');
    await h.hooks.telegram(message('telegram'));
    await h.hooks.discord(message('discord'));
    assert.equal(h.turns.length, 2);
    assert.deepEqual(h.turns.map(t => [t[0], t[1], t[4].channel, t[4].conversationId]),
      [['owner', 'telegram:room:sender', 'telegram', 'room'], ['owner', 'discord:room:sender', 'discord', 'room']]);
    assert.deepEqual(h.turns[1][4].allowedDestinations, ['room']);
    assert.deepEqual(h.sends.map(s => [s.id, s.text]), [['telegram', 'agent answer'], ['discord', 'agent answer']]);
  } finally { await h.close(); }
});

test('send tools act only for an owner/admin and report no secret on failure', async () => {
  const h = await host(fakeChannels());
  try {
    await h.request('telegram/connect', 'POST');
    const ok = await h.tools.telegram_send.execute({ chatId: 'room', text: 'hi' }, { userId: 'owner' });
    assert.match(ok.content[0].text, /Message delivered/);
    const denied = await h.tools.telegram_send.execute({ chatId: 'room', text: 'hi' }, { userId: 'member' });
    assert.ok(denied.error);
    assert.equal(h.sends.length, 1);
    assert.ok(!JSON.stringify(denied).includes('fake-telegram-token'));
    assert.deepEqual(h.tools.discord_send.input_schema.required, ['channelId', 'text']);
  } finally { await h.close(); }
});

test('core fallback metadata preserves provider requirements with reviewed setup wording',async()=>{
 const {CHANNEL_CATALOG:metadata}=await import('../extensions/shared/channel-catalog.js');
 assert.deepEqual(metadata,CHANNEL_CATALOG.map(c=>c.id==='ntfy'?{...c,prerequisites:'pip install httpx'}:c));
});
