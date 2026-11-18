import './fixtures/channel-library.mjs';
// CHANNELS-01: the old telegram/discord extension settings move once to agent-connect → channels.<id>,
// after a before-update backup (no backup, no change), in one transaction: never over a channel
// already configured there, agent-connect on when either old one was on, old rows deleted, empty
// old channel tables dropped and tables with rows kept. Fake tokens only.
// Run: node --import tsx --test test/channel-carry-over.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-channel-carry-over-'));
const data = join(dir, '.data');
mkdirSync(data, { recursive: true });
process.env.AGENT_PLAYER_DATA_DIR = data;
process.env.DATABASE_PATH = join(data, 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
const quiet = () => {}; console.log = quiet; console.warn = quiet;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
const { carryOverChannels, CARRIED_OVER } = await import(join(backendDir, 'src/services/channel-carry-over.ts'));

const row = (id) => db.prepare('SELECT config_json, enabled FROM extension_configs WHERE extension_id = ?').get(id);
const host = () => { const r = row('agent-connect'); return r && { enabled: r.enabled, ...JSON.parse(r.config_json) }; };
const table = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const put = (id, config, enabled) => db.prepare('INSERT OR REPLACE INTO extension_configs (extension_id, config_json, enabled) VALUES (?, ?, ?)').run(id, JSON.stringify(config), enabled);
function reset() {
  for (const t of ['telegram_messages', 'telegram_config', 'discord_messages', 'discord_config', 'slack_messages', 'whatsapp_messages']) db.exec(`DROP TABLE IF EXISTS ${t}`);
  db.prepare("DELETE FROM extension_configs WHERE extension_id IN ('agent-connect', 'telegram', 'discord')").run();
  db.prepare('DELETE FROM extension_migrations').run();
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(CARRIED_OVER);
}
const telegram = { bot_token: 'fake-telegram-token', allowed_users: '111,222', auto_reply: true, owner_user_id: 'owner-1', extra_key: 'kept' };
const discord = { bot_token: 'fake-discord-token', allowed_users: ['333'], allowed_channels: ['room'], guild_id: 'g1', client_id: 'c1', auto_reply: false, owner_user_id: 'owner-1' };

test('a data folder with nothing old: no backup, marked done', async () => {
  reset();
  let backups = 0;
  const result = await carryOverChannels({ backup: async () => { backups++; } });
  assert.equal(backups, 0);
  assert.deepEqual(result, { channels: [], skipped: [], dropped: [], kept: [] });
  assert.ok(db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(CARRIED_OVER));
  assert.equal(row('agent-connect'), undefined, 'no row is made when nothing moved');
  assert.equal(await carryOverChannels({ backup: async () => { backups++; } }), null, 'runs once');
});

test('no backup, no change: tried again at the next start', async () => {
  reset();
  put('telegram', telegram, 1);
  assert.equal(await carryOverChannels({ backup: async () => { throw new Error('disk full'); } }), null);
  assert.ok(row('telegram'));
  assert.equal(row('agent-connect'), undefined);
  assert.equal(db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(CARRIED_OVER), undefined);
});

test('settings move whole under agent-connect, which turns on; old rows go; siblings nobody turned on stay off', async () => {
  reset();
  put('telegram', { ...telegram, enabled: true }, 1);
  put('discord', discord, 0);
  put('agent-connect', { channels: { ntfy: { configured: true, environment: { NTFY_TOPIC: 'x' } } } }, 0);
  db.prepare("INSERT INTO extension_migrations (extension_id, filename) VALUES ('telegram', '001_telegram_messages.sql'), ('agent-connect', 'x.sql')").run();
  const order = [];
  const result = await carryOverChannels({ backup: async () => { order.push(row('telegram') ? 'backup-before-move' : 'backup-after-move'); } });
  assert.deepEqual(order, ['backup-before-move']);
  assert.deepEqual(result.channels, ['telegram', 'discord']);
  const h = host();
  assert.equal(h.enabled, 1, 'on because telegram was on');
  assert.deepEqual(h.channels.telegram, { ...telegram, enabled: true });
  assert.deepEqual(h.channels.discord, { ...discord, enabled: false }, 'discord was off and stays off');
  assert.equal(h.channels.ntfy.enabled, false, 'a saved channel nobody turned on is not switched on');
  assert.equal(row('telegram'), undefined);
  assert.equal(row('discord'), undefined);
  assert.deepEqual(db.prepare('SELECT extension_id FROM extension_migrations').all().map((r) => r.extension_id), ['agent-connect']);
});

test('a channel already configured under agent-connect is not overwritten', async () => {
  reset();
  put('telegram', telegram, 1);
  put('agent-connect', { channels: { telegram: { bot_token: 'fake-newer-token', allowed_users: ['999'], enabled: false } } }, 1);
  const result = await carryOverChannels({ backup: async () => {} });
  assert.deepEqual(result.skipped, ['telegram']);
  assert.deepEqual(host().channels.telegram, { bot_token: 'fake-newer-token', allowed_users: ['999'], enabled: false });
  assert.equal(row('telegram'), undefined, 'the old copy is not kept beside it');
});

test('old channel tables: dropped when empty, kept when they hold rows', async () => {
  reset();
  db.exec('CREATE TABLE telegram_messages (id TEXT PRIMARY KEY, content TEXT); CREATE INDEX idx_telegram_messages_x ON telegram_messages(content)');
  db.exec('CREATE TABLE telegram_config (id INTEGER PRIMARY KEY, bot_token TEXT)');
  db.exec("CREATE TABLE discord_messages (id TEXT PRIMARY KEY, content TEXT); INSERT INTO discord_messages VALUES ('m1', 'keep me')");
  db.exec('CREATE TABLE slack_messages (id TEXT)');
  db.prepare("INSERT INTO extension_migrations (extension_id, filename) VALUES ('telegram', '001.sql'), ('discord', '001.sql'), ('slack', '001.sql')").run();
  let backups = 0;
  const result = await carryOverChannels({ backup: async () => { backups++; } });
  assert.equal(backups, 1, 'tables alone also need the backup');
  assert.deepEqual(result.dropped.sort(), ['slack_messages', 'telegram_config', 'telegram_messages']);
  assert.deepEqual(result.kept, ['discord_messages']);
  assert.equal(table('telegram_messages'), false);
  assert.equal(table('discord_messages'), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM discord_messages').get().n, 1);
  assert.deepEqual(db.prepare('SELECT extension_id FROM extension_migrations ORDER BY extension_id').all().map((r) => r.extension_id), ['discord'],
    'recorded migrations stay only for an extension whose table was kept');
});
