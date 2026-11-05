// S0-Q.18 review fixes: no extension is blanket public. Only listed webhook /
// callback routes skip the token check, and each verifies the provider:
// Twilio signature (call-center). Trading takes the user only from a verified token (header or the
// stream's ?token=). The real extensions are loaded through the runner; all
// network and provider credentials are stubbed. CHANNELS-01: the Slack and WhatsApp extensions are
// gone; those channels run in Agent Connect over the provider's own connection, with no webhook route.
// Run: node --import tsx --test test/extension-webhooks.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'ap-extension-webhooks-'));
const backendDir = process.cwd();
process.chdir(dir);
const legacyRoot=join(backendDir,'test/fixtures/legacy-apps/extensions');process.env.GIRRU_EXTENSIONS_DIR=legacyRoot;
symlinkSync(legacyRoot, join(dir, 'extensions'), 'dir'); // permission check reads <cwd>/extensions
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.PUBLIC_URL = 'https://agent.example.test';

// No real network: record outbound fetches and answer from a stub.
const outbound = [];
globalThis.fetch = async (url) => {
  outbound.push(String(url));
  return new Response(JSON.stringify({ access_token: 'stub-access', refresh_token: 'stub-refresh' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { ExtensionRunner } = await import(join(backendDir, 'src/plugins/extension-runner.ts'));
const { getCredentialManager } = await import(join(backendDir, 'src/credentials/index.ts'));
const { twilioSignature } = await import(join(backendDir, 'extensions/shared/webhook-verify.js'));
const { internalAuthHeaders } = await import(join(backendDir, 'extensions/shared/internal-auth.js'));
const { default: Fastify } = await import('fastify');

const db = getDatabase();
await db.initialize();
const addUser = (id, role, status = 'active') => db.prepare(
  `INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, ?)`
).run(id, `${id}@example.test`, id, role, status);
addUser('u-owner', 'owner');
addUser('u-user', 'user');
addUser('u-suspended', 'admin', 'suspended');
const token = id => `Bearer ${generateToken(id, 1)}`;

// Provider credentials come from the credential manager; stub the lookup.
const TWILIO_TOKEN = 'twilio-auth-token-for-tests';
let twilioConfigured = false;
getCredentialManager().getValueByName = async (name) => {
  if (name === 'telephony.twilio.auth_token' && twilioConfigured) return TWILIO_TOKEN;
  throw new Error(`Credential '${name}' not found`);
};

for (const id of ['call-center', 'trading']) {
  db.prepare(`INSERT OR REPLACE INTO extension_configs (extension_id, enabled) VALUES (?, 1)`).run(id);
}
const app = Fastify();
app.decorate('db', db);
const runner = new ExtensionRunner(legacyRoot);
await runner.initialize(app, { register() {}, unregister() {} });
await app.ready();

test.after(async () => {
  for (const [, ext] of runner.getLoadedExtensions()) {
    try { await ext.onDisable?.({ log() {}, unregisterTool() {} }); } catch {}
  }
  await app.close();
  closeDatabase();
  unlinkSync(join(dir, 'extensions')); // remove the link only, never its target
  rmSync(dir, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

const inject = (opts) => app.inject(opts);
const form = (params) => new URLSearchParams(params).toString();
const FORM = 'application/x-www-form-urlencoded';

test('every target extension loaded', () => {
  const loaded = [...runner.getLoadedExtensions().keys()];
  for (const id of ['call-center', 'trading']) assert.ok(loaded.includes(id), `${id} loaded: ${loaded}`);
});

test('call-center: provider webhooks need a valid Twilio signature; other routes owner/admin', async () => {
  assert.equal((await inject({ method: 'GET', url: '/api/ext/call-center/numbers' })).statusCode, 401);
  const params = { CallSid: 'CA1', CallStatus: 'completed', CallDuration: '5' };
  const send = (path, signature) => inject({
    method: 'POST', url: `/api/ext/call-center/webhooks/${path}`, payload: form(params),
    headers: { 'content-type': FORM, ...(signature ? { 'x-twilio-signature': signature } : {}) },
  });
  for (const path of ['call-status', 'recording-status']) {
    const url = `https://agent.example.test/api/ext/call-center/webhooks/${path}`;
    twilioConfigured = false;
    assert.equal((await send(path, twilioSignature(TWILIO_TOKEN, url, params))).statusCode, 403, `${path}: no token configured`);
    twilioConfigured = true;
    assert.equal((await send(path, null)).statusCode, 403, `${path}: unsigned`);
    assert.equal((await send(path, twilioSignature('wrong', url, params))).statusCode, 403, `${path}: wrong token`);
    const ok = await send(path, twilioSignature(TWILIO_TOKEN, url, params));
    assert.equal(ok.statusCode, 200, `${path}: ${ok.body}`);
  }
});

test('trading: user only from a verified token; x-user-id is ignored; stream verifies ?token=', async () => {
  assert.equal((await inject({ method: 'GET', url: '/api/ext/trading/portfolio', headers: { 'x-user-id': 'u-owner' } })).statusCode, 401);
  assert.equal((await inject({ method: 'GET', url: '/api/ext/trading/accounts', headers: { authorization: token('u-user') } })).statusCode, 403);
  const own = await inject({ method: 'GET', url: '/api/ext/trading/accounts', headers: { authorization: token('u-owner'), 'x-user-id': 'someone-else' } });
  assert.equal(own.statusCode, 200, own.body);

  assert.equal((await inject({ method: 'GET', url: '/api/ext/trading/stream', headers: { 'x-user-id': 'u-owner' } })).statusCode, 401);
  assert.equal((await inject({ method: 'GET', url: '/api/ext/trading/stream?token=forged' })).statusCode, 401);
  assert.equal((await inject({ method: 'GET', url: `/api/ext/trading/stream?token=${generateToken('u-user', 1)}` })).statusCode, 403);
  // Verified owner token: passes the guard (no trading account in this DB -> 404 from the handler).
  assert.equal((await inject({ method: 'GET', url: `/api/ext/trading/stream?token=${generateToken('u-owner', 1)}` })).statusCode, 404);
  // ?token= is only honoured on the declared stream route.
  assert.equal((await inject({ method: 'GET', url: `/api/ext/trading/accounts?token=${generateToken('u-owner', 1)}` })).statusCode, 401);
});

test('tools calling their own routes send a short-lived token for the turn user', async () => {
  const headers = internalAuthHeaders('u-owner');
  assert.equal((await inject({ method: 'GET', url: '/api/ext/trading/accounts', headers: { authorization: headers.Authorization } })).statusCode, 200);
  assert.throws(() => internalAuthHeaders('u-suspended'));
  assert.throws(() => internalAuthHeaders(undefined));
  assert.equal((await inject({ method: 'GET', url: '/api/ext/trading/accounts', headers: { authorization: internalAuthHeaders('u-user').Authorization } })).statusCode, 403);
});
