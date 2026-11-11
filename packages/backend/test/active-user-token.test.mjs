// S0-A.3: getUserIdFromRequest (used by ~115 "any signed-in user" routes)
// refuses tokens of users whose status is not 'active', so a disabled
// account loses access immediately instead of when its 7-day token expires.
// The route plugins are mounted WITHOUT the global gate here, so this checks
// the per-route second line on its own.
// Run: node --import tsx --test test/active-user-token.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-active-user-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const addUser = (id, role, status = 'active') =>
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, ?, 1)`)
    .run(id, `${id}@example.test`, id, role, status);
addUser('a-on', 'owner');
addUser('a-off', 'owner', 'inactive');
addUser('a-susp', 'user', 'suspended');

const { generateToken, getUserIdFromRequest, getUserIdFromRequestSafe } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');
const { profileRoutes } = await import(join(backendDir, 'src/api/routes/profile.ts'));
const { databaseRoutes } = await import(join(backendDir, 'src/api/routes/database.ts'));

const app = Fastify();
await app.register(profileRoutes);
await app.register(databaseRoutes);
await app.ready();

test.after(async () => {
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const headers = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const fakeRequest = (id) => ({ headers: headers(id) });

test('getUserIdFromRequest accepts active users and refuses inactive/suspended ones', () => {
  assert.equal(getUserIdFromRequest(fakeRequest('a-on')), 'a-on');
  assert.throws(() => getUserIdFromRequest(fakeRequest('a-off')), /not active/);
  assert.throws(() => getUserIdFromRequest(fakeRequest('a-susp')), /not active/);
  assert.equal(getUserIdFromRequestSafe(fakeRequest('a-off')), null);
});

test('a disabled user is refused by profile and database routes on their own', async () => {
  for (const url of ['/api/profile', '/api/database/stats']) {
    for (const id of ['a-off', 'a-susp']) {
      const res = await app.inject({ method: 'GET', url, headers: headers(id) });
      assert.equal(res.statusCode, 401, `${id} ${url} -> ${res.statusCode}`);
    }
    const ok = await app.inject({ method: 'GET', url, headers: headers('a-on') });
    assert.notEqual(ok.statusCode, 401, `active owner ${url}`);
  }
});

test('deactivating an account cuts off an already-issued token', async () => {
  addUser('a-later', 'user');
  const h = headers('a-later');
  assert.notEqual((await app.inject({ method: 'GET', url: '/api/profile', headers: h })).statusCode, 401);
  db.prepare(`UPDATE users SET status = 'inactive' WHERE id = 'a-later'`).run();
  assert.equal((await app.inject({ method: 'GET', url: '/api/profile', headers: h })).statusCode, 401);
});
