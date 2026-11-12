// Phone Settings (phone boards P33–P39, phone/settings.ts): settings.read and settings.change.
//  - only the seven sections; anything else is bad_format;
//  - reads are small reviewed views (no tokens, no raw route bodies);
//  - permissions changes need the app's fresh Face ID confirmation, and allowing money,
//    installs or deleting also needs the risky confirmation, as on the desktop grid;
//  - approval rules and computers are read-only on the phone.
// Throwaway DB and keys; no network.
// Run: node --import tsx --import ../../scripts/test-temp-root.mjs --test test/phone-settings.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-phone-settings-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.AGENT_PLAYER_BACKGROUND = 'off';
globalThis.WebSocket = class { constructor(url) { throw new Error(`no network in this test: ${url}`); } };
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES ('st-owner', 'st-owner@example.test', 'st-owner', 'x', 'owner', 'active', 1)`).run();
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('st-main', 'Main', 'ollama', 'qwen-test', 1)`).run();
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const B = await import(join(backendDir, 'src/phone/ui-bridge.ts'));
const { runCommand } = await import(join(backendDir, 'src/phone/commands.ts'));
const app = await buildServer({ logger: false });
await app.ready();
B.bindPhoneApi(app);
test.after(async () => { B.bindPhoneApi(null); await app.close(); });

const ctx = { deviceId: 'st-phone', ownerId: 'st-owner', push: () => true, now: () => Date.now() };
const run = (body) => runCommand(ctx, body);
const code = async (p) => { try { await p; return 'ok'; } catch (e) { return e.code ?? String(e); } };

test('only the seven sections, and only the known fields', async () => {
  assert.equal(await code(run({ type: 'settings.read', section: 'backups' })), 'bad_format');
  assert.equal(await code(run({ type: 'settings.read', section: 'permissions', path: '/api/backups' })), 'bad_format');
  assert.equal(await code(run({ type: 'settings.change', section: 'general' })), 'bad_format');
});

test('permissions: a small view; changes need Face ID, risky ones also the extra check', async () => {
  const view = await run({ type: 'settings.read', section: 'permissions' });
  assert.deepEqual(view.actions, ['browser', 'network', 'message', 'delete', 'install', 'money', 'settings']);
  const main = view.agents.find(a => a.id === 'st-main');
  assert.ok(main, 'the agent is listed');
  assert.deepEqual(Object.keys(main).sort(), ['id', 'modes', 'name', 'version']);

  const change = { agentId: 'st-main', action: 'network', mode: 'allow' };
  assert.equal(await code(run({ type: 'settings.change', section: 'permissions', change })), 'confirmation_required');
  assert.equal(await code(run({ type: 'settings.change', section: 'permissions', change, confirmed: true })), 'ok');
  const after = (await run({ type: 'settings.read', section: 'permissions' })).agents.find(a => a.id === 'st-main');
  assert.equal(after.modes.network, 'allow');

  const risky = { agentId: 'st-main', action: 'money', mode: 'allow' };
  assert.equal(await code(run({ type: 'settings.change', section: 'permissions', change: risky, confirmed: true })), 'risky_confirmation_required');
  assert.equal(await code(run({ type: 'settings.change', section: 'permissions', change: { ...change, mode: 'everything' }, confirmed: true })), 'bad_format');
});

test('phones and account changes are sensitive; approval rules and computers stay on the computer', async () => {
  assert.equal(await code(run({ type: 'settings.change', section: 'phones', change: { forget: 'other-phone' } })), 'confirmation_required');
  assert.equal(await code(run({ type: 'settings.change', section: 'account', change: { signOut: 'some-session' } })), 'confirmation_required');
  assert.equal(await code(run({ type: 'settings.change', section: 'approval-rules', change: { id: 'r1', on: false }, confirmed: true })), 'on_the_computer');
  assert.equal(await code(run({ type: 'settings.change', section: 'computers', change: { forget: 'pc' }, confirmed: true })), 'on_the_computer');
});

test('general reads and changes the long-work notice without Face ID', async () => {
  const before = await run({ type: 'settings.read', section: 'general' });
  assert.equal(typeof before.notifyDone, 'boolean');
  assert.equal(await code(run({ type: 'settings.change', section: 'general', change: { notifyDone: false } })), 'ok');
  assert.equal((await run({ type: 'settings.read', section: 'general' })).notifyDone, false);
  assert.equal(await code(run({ type: 'settings.change', section: 'general', change: { notifyDone: false, extra: 1 } })), 'bad_format');
});

test('phones lists paired phones without keys', async () => {
  const view = await run({ type: 'settings.read', section: 'phones' });
  assert.ok(Array.isArray(view.phones));
  for (const p of view.phones) assert.deepEqual(Object.keys(p).sort(), ['id', 'lastUsedAt', 'model', 'name', 'status', 'thisPhone']);
});

test('approval rules without account verification say so instead of failing', async () => {
  const view = await run({ type: 'settings.read', section: 'approval-rules' });
  assert.deepEqual(view.rules, []);
  assert.equal(view.needsVerification, true);
});

test('computers reads the top-level devices list', async () => {
  const view = await run({ type: 'settings.read', section: 'computers' }).catch((e) => ({ code: e.code }));
  if (view.code) assert.ok(['unavailable', 'not_found'].includes(view.code), view.code);
  else for (const c of view.computers) assert.deepEqual(Object.keys(c).sort(), ['id', 'name', 'thisPhonesComputer']);
});

test('account sessions without a device name are named after this computer when it has one', async () => {
  const view = await run({ type: 'settings.read', section: 'account' });
  assert.ok(Array.isArray(view.sessions));
  for (const x of view.sessions) assert.notEqual(x.label, '');
});
