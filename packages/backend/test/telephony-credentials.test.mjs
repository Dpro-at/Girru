// F-04: telephony credentials go through the CredentialManager (encrypted,
// owner-owned, masked in responses, masked value on save keeps the secret).
// Run: node --import tsx --test test/telephony-credentials.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'ap-telephony-creds-'));
process.chdir(dir);
process.env.HOME = dir; // credential storage defaults to ~/.agent-player
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
delete process.env.PUBLIC_URL;

const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
const { default: Fastify } = await import('fastify');
const { registerTelephonyRoutes } = await import('./fixtures/legacy-apps/src/api/routes/telephony.ts');
const { getCredentialStorage } = await import('../src/credentials/storage.ts');
const { generateToken } = await import('../src/auth/jwt.ts');
const tel = await import('../src/telephony/credentials.ts');

const db = getDatabase();
await db.initialize();
await getCredentialStorage().initialize();

const addUser = (id, role, status = 'active') =>
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status)
    VALUES (?, ?, ?, 'x', ?, ?)`).run(id, `${id}@example.test`, id, role, status);
addUser('tel-owner', 'owner');
addUser('tel-admin', 'admin');
addUser('tel-user', 'user');
const auth = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });

const app = Fastify();
await app.register(registerTelephonyRoutes);
await app.ready();

test.after(async () => {
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const SID = 'AC' + randomBytes(16).toString('hex');
const TOKEN = randomBytes(16).toString('hex');
const GOOGLE_JSON = JSON.stringify({ private_key: randomBytes(24).toString('hex') });
const URL_ = '/api/telephony/settings/credentials';

test('settings routes need an active owner/admin token', async () => {
  for (const [method, url] of [['GET', URL_], ['PUT', URL_], ['POST', '/api/telephony/settings/test-connection']]) {
    const anon = await app.inject({ method, url, payload: {} });
    assert.equal(anon.statusCode, 401, `${method} ${url} without token`);
    const user = await app.inject({ method, url, payload: {}, headers: auth('tel-user') });
    assert.equal(user.statusCode, 403, `${method} ${url} as plain user`);
  }
});

test('save stores encrypted, owner-owned records; read returns masked values (no 500)', async () => {
  const empty = await app.inject({ method: 'GET', url: URL_, headers: auth('tel-owner') });
  assert.equal(empty.statusCode, 200, empty.body);
  assert.equal(empty.json().credentials.twilio.configured, false);

  // An admin saves: the records still belong to the owner (system telephony config).
  const put = await app.inject({
    method: 'PUT', url: URL_, headers: auth('tel-admin'),
    payload: { twilioAccountSid: SID, twilioAuthToken: TOKEN, googleProjectId: 'proj-1',
      googleCredentialsJson: GOOGLE_JSON, publicUrl: 'https://calls.example.test' },
  });
  assert.equal(put.statusCode, 200, put.body);

  const rows = db.prepare("SELECT * FROM credentials WHERE name LIKE 'telephony.%'").all();
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.equal(row.user_id, 'tel-owner');
    assert.equal(row.skill_id, 'telephony');
    for (const secret of [SID, TOKEN, GOOGLE_JSON]) assert.ok(!row.encrypted_value.includes(secret));
  }

  const res = await app.inject({ method: 'GET', url: URL_, headers: auth('tel-owner') });
  assert.equal(res.statusCode, 200, res.body);
  for (const secret of [SID, TOKEN, GOOGLE_JSON]) assert.ok(!res.body.includes(secret), 'secret leaked');
  const c = res.json().credentials;
  assert.equal(c.twilio.configured, true);
  assert.equal(c.twilio.accountSid, '••••' + SID.slice(-4));
  assert.match(c.twilio.authToken, /•/);
  assert.equal(c.google.configured, true);
  assert.equal(c.google.projectId, 'proj-1');
  assert.match(c.google.credentialsJson, /•/);
  assert.equal(c.publicUrl, 'https://calls.example.test');

  assert.equal(await tel.getTelephonySecret(tel.TELEPHONY_KEYS.twilioAuthToken), TOKEN);
});

test('masked or empty values on save keep the stored secret; new values replace it', async () => {
  const masked = (await app.inject({ method: 'GET', url: URL_, headers: auth('tel-owner') })).json().credentials;
  const put = await app.inject({
    method: 'PUT', url: URL_, headers: auth('tel-owner'),
    payload: { twilioAccountSid: masked.twilio.accountSid, twilioAuthToken: masked.twilio.authToken,
      googleCredentialsJson: '', publicUrl: '' },
  });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal(await tel.getTelephonySecret(tel.TELEPHONY_KEYS.twilioAccountSid), SID);
  assert.equal(await tel.getTelephonySecret(tel.TELEPHONY_KEYS.twilioAuthToken), TOKEN);
  assert.equal(await tel.getTelephonySecret(tel.TELEPHONY_KEYS.googleCredentialsJson), GOOGLE_JSON);

  const NEW_TOKEN = randomBytes(16).toString('hex');
  await app.inject({ method: 'PUT', url: URL_, headers: auth('tel-owner'), payload: { twilioAuthToken: NEW_TOKEN } });
  assert.equal(await tel.getTelephonySecret(tel.TELEPHONY_KEYS.twilioAuthToken), NEW_TOKEN);
  const count = db.prepare("SELECT COUNT(*) AS n FROM credentials WHERE name = 'telephony.twilio.auth_token'").get().n;
  assert.equal(count, 1, 'update must not create a duplicate record');
});

test('test-connection reads stored Google credentials (no external call)', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/telephony/settings/test-connection', headers: auth('tel-owner'),
    payload: { provider: 'google' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().details.projectId, 'proj-1');
  assert.ok(!res.body.includes(GOOGLE_JSON));
});
