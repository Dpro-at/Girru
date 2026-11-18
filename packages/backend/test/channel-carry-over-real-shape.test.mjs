import './fixtures/channel-library.mjs';
// CHANNELS-01 on the shape of a real Girru database from before the update: telegram and discord
// on in extension_configs with their bot settings (fake tokens here), their recorded migrations,
// their four tables empty, channel_events empty. The startup carry-over makes a real before-update
// backup first, moves the settings unchanged under agent-connect, turns it on, drops the empty old
// tables (a table with rows is kept), runs once, and both channels then start in the agent-connect
// extension on a fake connection: no network.
// The schema is test/fixtures/channels-real-shape.sql; CHANNELS_REAL_SHAPE_SQL may name a full schema dump instead.
// Run: node --import tsx --test test/channel-carry-over-real-shape.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-channel-real-shape-'));
const data = join(dir, '.data');
mkdirSync(data, { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_DATA_DIR = data;
process.env.DATABASE_PATH = join(data, 'agent-player.db');
process.env.GIRRU_BACKUPS_DIR = join(dir, 'Girru Backups');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
const quiet = () => {}; console.log = quiet; console.warn = quiet; console.error = quiet;

// SQLite's own tables in a full dump are made by SQLite itself.
const shape = readFileSync(process.env.CHANNELS_REAL_SHAPE_SQL || join(backendDir, 'test/fixtures/channels-real-shape.sql'), 'utf8')
  .replace(/CREATE TABLE sqlite_\w+\s*\([^;]*\);/g, '');
const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const manager = getDatabase();
const db = manager.getDb();
db.exec(shape); // the real shape, not Girru's current schema: no initialize()
const { carryOverChannels, CARRIED_OVER } = await import(join(backendDir, 'src/services/channel-carry-over.ts'));
const { workspaceBackupsDir } = await import(join(backendDir, 'src/services/backups.ts'));
const { default: Database } = await import('better-sqlite3');
const { registerAgentConnect } = await import(join(backendDir, 'test/fixtures/agent-connect-legacy/index.js'));
const { stopChannel } = await import(join(backendDir, 'extensions/shared/channel-host.js'));
const { TelegramTransport, DiscordTransport } = await import('agent-connect-dpro');
const { default: Fastify } = await import('fastify');

// Fake bot settings in the shape the old extensions saved them (the native activation route added enabled/owner).
const TELEGRAM = { bot_token: '000000:fake-telegram-token-for-tests', allowed_users: '1001,1002', auto_reply: true, owner_user_id: 'owner-1', enabled: true };
const DISCORD = { bot_token: 'fake.discord.token-for-tests', client_id: '42', guild_id: '7', allowed_users: ['2001'], allowed_channels: ['3001'], auto_reply: false, owner_user_id: 'owner-1' };
function facts() {
  const put = db.prepare("INSERT OR REPLACE INTO extension_configs (extension_id, config_json, enabled) VALUES (?, ?, 1)");
  put.run('telegram', JSON.stringify(TELEGRAM));
  put.run('discord', JSON.stringify(DISCORD));
  db.prepare("INSERT OR IGNORE INTO extension_migrations (extension_id, filename) VALUES ('discord', '001_discord_messages.sql'), ('telegram', '001_telegram_messages.sql')").run();
  db.prepare("INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('backups.state', '{}', 1), ('ui.theme', '\"dark\"', 1)").run();
}
const backupsMade = () => { try { return readdirSync(workspaceBackupsDir()).filter((n) => /^\d{8}-\d{6}-/.test(n)).sort(); } catch { return []; } };
const table = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const row = (id) => db.prepare('SELECT config_json, enabled FROM extension_configs WHERE extension_id = ?').get(id);

test('the real shape: backup first, settings identical under agent-connect, agent-connect on, empty old tables dropped, once', async () => {
  facts();
  assert.deepEqual(['telegram_messages', 'telegram_config', 'discord_messages', 'discord_config'].map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n), [0, 0, 0, 0]);
  const result = await carryOverChannels();
  const backups = backupsMade();
  assert.equal(backups.length, 1, 'one backup');
  assert.match(backups[0], /-before-update$/);
  // The backup holds the old rows and tables: it was made before the move.
  const saved = join(workspaceBackupsDir(), backups[0], 'data', 'agent-player.db');
  const copy = join(dir, 'backup-copy.db');
  const bytes = readFileSync(saved); // the database is stored compressed
  writeFileSync(copy, bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes);
  const old = new Database(copy, { readonly: true });
  try {
    assert.deepEqual(JSON.parse(old.prepare("SELECT config_json FROM extension_configs WHERE extension_id = 'telegram'").get().config_json), TELEGRAM);
    assert.ok(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'discord_config'").get());
  } finally { old.close(); }

  assert.deepEqual(result.channels, ['telegram', 'discord']);
  const host = row('agent-connect');
  assert.equal(host.enabled, 1);
  const channels = JSON.parse(host.config_json).channels;
  assert.deepEqual(channels.telegram, TELEGRAM, 'telegram settings identical');
  assert.deepEqual(channels.discord, { ...DISCORD, enabled: true }, 'discord settings identical, on as it was');
  assert.equal(row('telegram'), undefined);
  assert.equal(row('discord'), undefined);
  assert.deepEqual(result.dropped.sort(), ['discord_config', 'discord_messages', 'telegram_config', 'telegram_messages']);
  assert.deepEqual(result.kept, []);
  for (const t of result.dropped) assert.equal(table(t), false, t);
  assert.equal(table('channel_events'), true, 'channel_events stays');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM extension_migrations WHERE extension_id IN ('telegram', 'discord')").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key IN ('backups.state', 'ui.theme')").get().n, 2, 'other settings untouched');

  assert.equal(await carryOverChannels(), null, 'runs once');
  assert.equal(backupsMade().length, 1, 'no second backup');
});

test('both moved channels start in the agent-connect extension (native transports, fake connection)', async () => {
  const app = Fastify();
  const started = {};
  const read = () => JSON.parse(row('agent-connect').config_json);
  const api = {
    db, getConfig: read, setConfig: (value) => db.prepare("UPDATE extension_configs SET config_json = ? WHERE extension_id = 'agent-connect'").run(JSON.stringify(value)),
    log() {}, authorizeChannelRequest: () => 'owner-1', authorizeChannelUser() {}, async processChannelMessage() { return 'ok'; },
    registerRoutes(fn) { app.register(fn, { prefix: '/api/ext/agent-connect' }); }, registerTool() {},
  };
  await registerAgentConnect(api, {
    createConnector(id, transport) {
      started[id] = transport;
      return { state: 'disconnected', async connect() { this.state = 'connected'; }, async disconnect() { this.state = 'disconnected'; }, async send() { return { id: 'x' }; } };
    },
  });
  await app.ready();
  try {
    for (const id of ['telegram', 'discord']) {
      const res = await app.inject({ method: 'POST', url: `/api/ext/agent-connect/${id}/connect` });
      assert.equal(res.statusCode, 200, `${id}: ${res.body}`);
      assert.equal(res.json().success, true, id);
      const status = (await app.inject({ url: `/api/ext/agent-connect/${id}/status` })).json();
      assert.equal(status.connected, true, id);
      assert.ok(!JSON.stringify(status).includes('fake'), 'no token in the status');
    }
    assert.ok(started.telegram instanceof TelegramTransport);
    assert.ok(started.discord instanceof DiscordTransport);
  } finally {
    await stopChannel('telegram'); await stopChannel('discord'); await app.close();
  }
});

test('a pre-existing agent-connect telegram config is not overwritten; an old table with rows is kept', async () => {
  // A second data folder state: the old rows and tables are back, the move not done yet.
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(CARRIED_OVER);
  db.exec(shape.split(';').filter((s) => /CREATE (TABLE|INDEX)[\s\S]*(telegram|discord)_(messages|config)/.test(s)).join(';') + ';');
  facts();
  db.prepare("INSERT INTO telegram_messages (id, chat_id, content, timestamp) VALUES ('m1', 'c1', 'an old message', '2026-01-01T00:00:00Z')").run();
  const mine = { bot_token: 'fake-owner-saved-later', allowed_users: ['9'], enabled: false };
  const root = JSON.parse(row('agent-connect').config_json);
  db.prepare("UPDATE extension_configs SET config_json = ? WHERE extension_id = 'agent-connect'").run(JSON.stringify({ ...root, channels: { ...root.channels, telegram: mine } }));
  const result = await carryOverChannels();
  // Both are configured under agent-connect by now (discord from the first move): neither is overwritten.
  assert.deepEqual(result.skipped, ['telegram', 'discord']);
  assert.deepEqual(JSON.parse(row('agent-connect').config_json).channels.telegram, mine);
  assert.deepEqual(result.kept, ['telegram_messages']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_messages').get().n, 1);
  assert.ok(result.dropped.includes('telegram_config') && result.dropped.includes('discord_messages'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM extension_migrations WHERE extension_id = 'telegram'").get().n, 1, 'kept with its table');
});
