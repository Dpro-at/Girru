// S0-Q.13: no open self-registration; only an active owner/admin creates accounts.
// S0-Q.14: /api/credentials* need an active owner/admin and are scoped to that
// user; the onboarding (terminal wizard) routes are not reachable anonymously.
// S0-Q.16: the owner sees and manages every user's credentials (masked only),
// and each such access is audit-logged; admins keep only their own.
// Run: node --import tsx --test test/register-credentials-auth.test.mjs
// No network: any fetch fails the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'ap-reg-cred-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir; // credential storage defaults to ~/.agent-player
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };

const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
const db = getDatabase();
await db.initialize();
const addUser = (id, role, status = 'active') =>
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, ?, 1)`)
    .run(id, `${id}@example.test`, id, role, status);
addUser('u-owner', 'owner');
addUser('u-admin', 'admin');
addUser('u-member', 'user');
addUser('u-off', 'owner', 'inactive');

const { default: Fastify } = await import('fastify');
const { authRoutes } = await import('../src/api/routes/auth.ts');
const { credentialsRoutes } = await import('../src/api/routes/credentials.ts');
const { onboardingRoutes } = await import('../src/api/routes/onboarding.ts');
const { getCredentialManager } = await import('../src/credentials/manager.ts');
const { generateToken } = await import('../src/auth/jwt.ts');
const { readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');

const app = Fastify();
await app.register(authRoutes);
await app.register(credentialsRoutes);
await app.register(onboardingRoutes); // registered here only to test its own guard
await app.ready();

test.after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const bearer = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const PASSWORD = 'Created-By-Owner-42!';
const newUser = (name, extra = {}) => ({ email: `${name}@example.test`, username: name, password: PASSWORD, ...extra });
const register = (payload, headers = {}) => app.inject({ method: 'POST', url: '/api/auth/register', payload, headers });
const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

test('S0-Q.13: anonymous, bad-token, member and inactive callers cannot register', async () => {
  const before = userCount();
  const anon = await register(newUser('anon1'));
  assert.equal(anon.statusCode, 401);
  assert.equal(anon.json().token, undefined);
  assert.equal((await register(newUser('anon2'), { authorization: 'Bearer not.a.jwt' })).statusCode, 401);
  assert.equal((await register(newUser('anon3'), bearer('u-member'))).statusCode, 403);
  assert.equal((await register(newUser('anon4'), bearer('u-off'))).statusCode, 403);
  assert.equal(userCount(), before);
});

test('S0-Q.13: an owner creates an account; no token is returned; the new user can log in', async () => {
  const res = await register(newUser('alice', { full_name: 'Alice' }), bearer('u-owner'));
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().token, undefined);
  assert.equal(res.json().user.role, 'user');
  assert.equal(res.json().user.password_hash, undefined);

  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'alice@example.test', password: PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(login.json().user.role, 'user');
});

test('S0-Q.13: role limits — nobody creates an owner; admins create only user/guest', async () => {
  assert.equal((await register(newUser('o2', { role: 'owner' }), bearer('u-owner'))).statusCode, 403);
  assert.equal((await register(newUser('a2', { role: 'admin' }), bearer('u-owner'))).statusCode, 201);
  assert.equal((await register(newUser('a3', { role: 'admin' }), bearer('u-admin'))).statusCode, 403);
  assert.equal((await register(newUser('g1', { role: 'guest' }), bearer('u-admin'))).statusCode, 201);
  assert.equal((await register(newUser('x1', { role: 'root' }), bearer('u-owner'))).statusCode, 403);
});

// ---- S0-Q.14: credentials -------------------------------------------------
const req = (method, url, headers = {}, payload) => app.inject({ method, url, headers, payload });
const cred = (name) => ({ name, type: 'api_key', value: `secret-value-${name}-${randomBytes(4).toString('hex')}` });

test('S0-Q.14: every credential route answers 401 without a token and 403 for a non-owner/admin', async () => {
  const sysCred = await getCredentialManager().create({ name: 'system-key', type: 'api_key', value: 'sys-secret-1234' });
  const routes = [
    ['GET', '/api/credentials'], ['GET', '/api/credentials?userId=u-owner'], ['GET', '/api/credentials/types'],
    ['GET', `/api/credentials/${sysCred.id}`], ['GET', `/api/credentials/${sysCred.id}/value`],
    ['POST', '/api/credentials', cred('anon')], ['PUT', `/api/credentials/${sysCred.id}`, { value: 'x' }],
    ['DELETE', `/api/credentials/${sysCred.id}`], ['POST', `/api/credentials/${sysCred.id}/test`],
    ['POST', '/api/credentials/export', {}], ['POST', '/api/credentials/import', { credentials: [] }],
  ];
  for (const [method, url, body] of routes) {
    assert.equal((await req(method, url, {}, body)).statusCode, 401, `${method} ${url} anonymous`);
    assert.equal((await req(method, url, { authorization: 'Bearer not.a.jwt' }, body)).statusCode, 401, `${method} ${url} bad token`);
    assert.equal((await req(method, url, bearer('u-member'), body)).statusCode, 403, `${method} ${url} member`);
    assert.equal((await req(method, url, bearer('u-off'), body)).statusCode, 403, `${method} ${url} inactive owner`);
  }
  assert.ok(await getCredentialManager().get(sysCred.id)); // nothing was deleted
});

test('S0-Q.14/16: admins are scoped to their own credentials; the owner sees all of them', async () => {
  const ownerCreate = await req('POST', '/api/credentials', bearer('u-owner'), { ...cred('owner-key'), userId: 'u-admin' });
  assert.equal(ownerCreate.statusCode, 200, ownerCreate.body);
  const ownerKey = ownerCreate.json().credential.id;
  const adminCreate = await req('POST', '/api/credentials', bearer('u-admin'), cred('admin-key'));
  assert.equal(adminCreate.statusCode, 200, adminCreate.body);
  const adminKey = adminCreate.json().credential.id;

  assert.equal((await getCredentialManager().get(ownerKey)).userId, 'u-owner'); // body userId ignored

  const names = async (id, query = '') =>
    (await req('GET', `/api/credentials${query}`, bearer(id))).json().credentials.map(c => c.name).sort();
  assert.deepEqual(await names('u-owner'), ['admin-key', 'owner-key', 'system-key']); // S0-Q.16
  assert.deepEqual(await names('u-admin'), ['admin-key']);
  assert.deepEqual(await names('u-admin', '?userId=u-owner'), ['admin-key']); // query userId ignored

  // The admin cannot read, change, test, reveal or delete the owner's or system credentials.
  const sys = (await getCredentialManager().list()).find(c => c.name === 'system-key');
  for (const id of [ownerKey, sys.id]) {
    assert.equal((await req('GET', `/api/credentials/${id}`, bearer('u-admin'))).statusCode, 404);
    assert.equal((await req('GET', `/api/credentials/${id}/value`, bearer('u-admin'))).statusCode, 404);
    assert.equal((await req('PUT', `/api/credentials/${id}`, bearer('u-admin'), { value: 'hijack' })).statusCode, 404);
    assert.equal((await req('POST', `/api/credentials/${id}/test`, bearer('u-admin'))).statusCode, 404);
    assert.equal((await req('DELETE', `/api/credentials/${id}`, bearer('u-admin'))).statusCode, 404);
    assert.ok(await getCredentialManager().get(id));
  }
  // S0-Q.16: the owner may read the admin's credential (covered in detail below).
  assert.equal((await req('GET', `/api/credentials/${adminKey}`, bearer('u-owner'))).statusCode, 200);
  assert.equal((await req('GET', `/api/credentials/${adminKey}`, bearer('u-admin'))).statusCode, 200);
  assert.equal((await req('GET', `/api/credentials/${sys.id}?decrypt=true`, bearer('u-owner'))).statusCode, 200);

  // Export only contains the caller's scope (body userId ignored).
  const exp = await req('POST', '/api/credentials/export', bearer('u-admin'), { userId: 'u-owner' });
  assert.equal(exp.statusCode, 200);
  const exported = JSON.parse(Buffer.from(exp.json().data, 'base64').toString('utf8'));
  assert.deepEqual(exported.map(c => c.name), ['admin-key']);

  // Import cannot overwrite another user's credential by id; it lands in the caller's scope.
  const forged = [{ ...exported[0], id: ownerKey, name: 'forged', userId: 'u-owner' }];
  const imp = await req('POST', '/api/credentials/import', bearer('u-admin'), { credentials: forged });
  assert.equal(imp.statusCode, 200, imp.body);
  assert.equal((await getCredentialManager().get(ownerKey)).name, 'owner-key');
  assert.deepEqual(await names('u-admin'), ['admin-key', 'forged']);
  assert.deepEqual(await names('u-owner'), ['admin-key', 'forged', 'owner-key', 'system-key']);

  // Delete of an in-scope credential works.
  assert.equal((await req('DELETE', `/api/credentials/${adminKey}`, bearer('u-admin'))).statusCode, 200);
});

// ---- S0-Q.16: owner manages every user's credentials, audited -------------
const auditRows = (action) => db.prepare(
  `SELECT event_type, user_id, resource_type, resource_id, action, metadata FROM audit_logs WHERE action = ? ORDER BY id`
).all(action);

test('S0-Q.16: owner lists/reads/updates/deletes another user\'s credential masked; each access is audited', async () => {
  const secret = `admin-only-secret-${randomBytes(6).toString('hex')}`;
  const created = await req('POST', '/api/credentials', bearer('u-admin'), { name: 'admin-q16', type: 'api_key', value: secret });
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().credential.id;
  const before = db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n;

  // The admin's own access is not a cross-user access: no audit entry.
  assert.equal((await req('GET', '/api/credentials?decrypt=true', bearer('u-admin'))).statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n, before);

  // List: the owner sees it, masked, with its owner user id.
  const list = await req('GET', '/api/credentials?decrypt=true', bearer('u-owner'));
  assert.equal(list.statusCode, 200);
  assert.doesNotMatch(list.body, new RegExp(secret));
  const row = list.json().credentials.find(c => c.id === id);
  assert.ok(row, 'owner sees the admin credential');
  assert.equal(row.userId, 'u-admin');
  assert.equal(row.value, `••••${secret.slice(-4)}`);
  const listAudit = auditRows('credentials.list.other_user').at(-1);
  assert.equal(listAudit.event_type, 'data.read');
  assert.equal(listAudit.user_id, 'u-owner');
  assert.ok(JSON.parse(listAudit.metadata).credentialIds.includes(id));
  assert.ok(JSON.parse(listAudit.metadata).ownerUserIds.includes('u-admin'));

  // Get / masked value: masked, audited.
  const one = await req('GET', `/api/credentials/${id}?decrypt=true`, bearer('u-owner'));
  assert.equal(one.statusCode, 200);
  assert.doesNotMatch(one.body, new RegExp(secret));
  const val = await req('GET', `/api/credentials/${id}/value`, bearer('u-owner'));
  assert.equal(val.statusCode, 200);
  assert.doesNotMatch(val.body, new RegExp(secret));
  assert.equal(auditRows('credentials.get.other_user').at(-1).resource_id, id);
  assert.equal(auditRows('credentials.value_masked.other_user').at(-1).resource_id, id);

  // Update: works, audited, ownership unchanged, no value in the audit log.
  const upd = await req('PUT', `/api/credentials/${id}`, bearer('u-owner'), { description: 'rotated by owner' });
  assert.equal(upd.statusCode, 200, upd.body);
  assert.equal((await getCredentialManager().get(id)).userId, 'u-admin');
  const updAudit = auditRows('credentials.update.other_user').at(-1);
  assert.equal(updAudit.event_type, 'data.update');
  assert.equal(updAudit.resource_type, 'credential');
  assert.equal(updAudit.resource_id, id);

  // The admin still cannot see the owner's credentials.
  const ownerKey = (await getCredentialManager().list('u-owner'))[0];
  assert.equal((await req('GET', `/api/credentials/${ownerKey.id}`, bearer('u-admin'))).statusCode, 404);

  // Delete: works, audited.
  const del = await req('DELETE', `/api/credentials/${id}`, bearer('u-owner'));
  assert.equal(del.statusCode, 200, del.body);
  assert.equal(await getCredentialManager().get(id), null);
  const delAudit = auditRows('credentials.delete.other_user').at(-1);
  assert.equal(delAudit.event_type, 'data.delete');
  assert.equal(delAudit.resource_id, id);

  // No secret value ever reaches the audit log.
  const all = db.prepare('SELECT * FROM audit_logs').all();
  assert.doesNotMatch(JSON.stringify(all), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(all), /admin-q16/);

  // The owner's own credentials are not audited as cross-user access.
  const n = auditRows('credentials.get.other_user').length;
  assert.equal((await req('GET', `/api/credentials/${ownerKey.id}`, bearer('u-owner'))).statusCode, 200);
  assert.equal(auditRows('credentials.get.other_user').length, n);
});

test('S0-Q.16: owner export carries no other user\'s ciphertext; owner import cannot write into another user', async () => {
  const created = await req('POST', '/api/credentials', bearer('u-admin'), { name: 'admin-export-q16', type: 'api_key', value: `v-${randomBytes(6).toString('hex')}` });
  assert.equal(created.statusCode, 200, created.body);
  const adminId = created.json().credential.id;
  const adminStored = await getCredentialManager().get(adminId);

  const exp = await req('POST', '/api/credentials/export', bearer('u-owner'), {});
  assert.equal(exp.statusCode, 200, exp.body);
  const decoded = Buffer.from(exp.json().data, 'base64').toString('utf8');
  const rows = JSON.parse(decoded);
  assert.ok(rows.length > 0);
  assert.ok(rows.every(r => !r.userId || r.userId === 'u-owner'), 'only own/system credentials exported');
  assert.ok(!rows.some(r => r.id === adminId));
  assert.ok(!decoded.includes(adminStored.encryptedValue), 'no other user ciphertext');
  const allowed = new Set(['id', 'name', 'type', 'encryptedValue', 'iv', 'authTag', 'description', 'skillId',
    'userId', 'refreshToken', 'expiresAt', 'scopes', 'createdAt', 'updatedAt', 'lastUsed']);
  for (const r of rows) for (const k of Object.keys(r)) assert.ok(allowed.has(k), `unexpected export field ${k}`);

  // Owner import naming the admin's id and userId: the admin's credential is untouched,
  // the imported record lands in the owner's own scope under a new id.
  const forged = [{ ...rows[0], id: adminId, userId: 'u-admin', name: 'owner-forged', extraField: 'x' }];
  const imp = await req('POST', '/api/credentials/import', bearer('u-owner'), { credentials: forged });
  assert.equal(imp.statusCode, 200, imp.body);
  const after = await getCredentialManager().get(adminId);
  assert.equal(after.name, 'admin-export-q16');
  assert.equal(after.userId, 'u-admin');
  assert.equal(after.encryptedValue, adminStored.encryptedValue);
  const landed = (await getCredentialManager().list('u-owner')).find(c => c.name === 'owner-forged');
  assert.ok(landed, 'imported into the owner scope');
  assert.notEqual(landed.id, adminId);
  assert.equal(landed.extraField, undefined);
  assert.equal((await getCredentialManager().list('u-admin')).some(c => c.name === 'owner-forged'), false);
});

// ---- S0-Q.14: onboarding (terminal wizard) -------------------------------
test('S0-Q.14: onboarding routes are not registered by the server and are owner-only', async () => {
  const serverSrc = readFileSync(fileURLToPath(new URL('../src/api/server-main.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(serverSrc, /^\s*await\s+fastify\.register\(\s*onboardingRoutes/m);

  for (const [method, url] of [['POST', '/api/onboarding/start'], ['POST', '/api/onboarding/resume'],
    ['POST', '/api/onboarding/skip'], ['GET', '/api/onboarding/status']]) {
    assert.equal((await req(method, url)).statusCode, 401, `${method} ${url} anonymous`);
    assert.equal((await req(method, url, bearer('u-admin'))).statusCode, 403, `${method} ${url} admin`);
    assert.equal((await req(method, url, bearer('u-member'))).statusCode, 403, `${method} ${url} member`);
  }
  // Owner path: status/skip only (start/resume would open the terminal wizard).
  assert.equal((await req('GET', '/api/onboarding/status', bearer('u-owner'))).statusCode, 200);
  assert.equal((await req('POST', '/api/onboarding/skip', bearer('u-owner'))).statusCode, 200);
});
