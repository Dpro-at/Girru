// S0-Q.18: extension routes under /api/ext/<id> are owner/admin-only by
// default. A manifest may declare "routeAccess" ("authenticated" / "public")
// and "publicRoutes" (route patterns that skip the check, e.g. webhooks).
// Run: node --import tsx --test test/extension-route-access.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'ap-extension-route-access-'));
const backendDir = process.cwd();
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only

const extensionCode = `export default {
  async register(api) {
    api.registerRoutes(async (fastify) => {
      fastify.get('/data', async () => ({ ok: true }));
      fastify.post('/webhook', async () => ({ received: true }));
      fastify.get('/items/:id', async (request) => ({ id: request.params.id }));
    });
  },
};
`;
const fakeExtensions = {
  'private-ext': {},
  'hook-ext': { publicRoutes: ['/webhook', 'no-leading-slash', 42] },
  'member-ext': { routeAccess: 'authenticated' },
  'open-ext': { routeAccess: 'public' }, // no whole-extension public level -> owner/admin
  'typo-ext': { routeAccess: 'PUBLIC' }, // unknown value -> owner/admin
};
for (const [id, extra] of Object.entries(fakeExtensions)) {
  const extDir = join(dir, 'extensions', id);
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(extDir, 'agentplayer.plugin.json'), JSON.stringify({
    id, name: id, version: '1.0.0', type: 'extension', description: 'test', main: 'index.js',
    permissions: ['routes'], ...extra,
  }));
  writeFileSync(join(extDir, 'index.js'), extensionCode);
}

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { ExtensionRunner } = await import(join(backendDir, 'src/plugins/extension-runner.ts'));
const { getExtensionRouteAccess } = await import(join(backendDir, 'src/plugins/extension-route-access.ts'));
const { default: Fastify } = await import('fastify');

const db = getDatabase();
await db.initialize();
const addUser = (id, role, status = 'active') => db.prepare(
  `INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, ?)`
).run(id, `${id}@example.test`, id, role, status);
addUser('u-owner', 'owner');
addUser('u-admin', 'admin');
addUser('u-user', 'user');
addUser('u-suspended', 'user', 'suspended');
const token = id => `Bearer ${generateToken(id, 1)}`;
for (const id of Object.keys(fakeExtensions)) {
  db.prepare(`INSERT OR REPLACE INTO extension_configs (extension_id, enabled) VALUES (?, 1)`).run(id);
}

const app = Fastify();
await new ExtensionRunner(join(dir, 'extensions')).initialize(app, {});
await app.ready();

test.after(async () => {
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const call = (method, url, who) => app.inject({ method, url, headers: who ? { authorization: token(who) } : {} });

test('default (no routeAccess, or an unknown value): owner/admin only', async () => {
  for (const id of ['private-ext', 'typo-ext']) {
    for (const url of [`/api/ext/${id}/data`, `/api/ext/${id}/items/7`]) {
      assert.equal((await call('GET', url)).statusCode, 401, url);
      assert.equal((await call('GET', url, 'u-user')).statusCode, 403, url);
    }
    assert.equal((await call('POST', `/api/ext/${id}/webhook`)).statusCode, 401);
    // Unknown paths reach no handler (plain 404, nothing leaked).
    assert.equal((await call('GET', `/api/ext/${id}/missing`)).statusCode, 404);
    assert.equal((await call('GET', `/api/ext/${id}/data`, 'u-owner')).statusCode, 200);
    assert.equal((await call('GET', `/api/ext/${id}/data`, 'u-admin')).statusCode, 200);
  }
});

test('publicRoutes: only the declared route pattern skips the check', async () => {
  assert.equal((await call('POST', '/api/ext/hook-ext/webhook')).statusCode, 200);
  for (const url of [
    '/api/ext/hook-ext/data',
    '/api/ext/hook-ext/data?x=/webhook',
    '/api/ext/hook-ext/items/webhook',
    '/api/ext/hook-ext/items/%2Fwebhook',
  ]) {
    assert.equal((await call('GET', url)).statusCode, 401, url);
  }
  // Malformed entries are ignored, not treated as wildcards.
  assert.equal((await call('GET', '/api/ext/hook-ext/data', 'u-user')).statusCode, 403);
});

test('routeAccess "authenticated": any active signed-in user', async () => {
  assert.equal((await call('GET', '/api/ext/member-ext/data')).statusCode, 401);
  assert.equal((await call('GET', '/api/ext/member-ext/data', 'u-suspended')).statusCode, 401);
  assert.equal((await call('GET', '/api/ext/member-ext/data', 'u-user')).statusCode, 200);
  assert.equal((await call('GET', '/api/ext/member-ext/data', 'u-owner')).statusCode, 200);
});

test('routeAccess "public" is not a level: the extension stays owner/admin', async () => {
  assert.equal((await call('GET', '/api/ext/open-ext/data')).statusCode, 401);
  assert.equal((await call('GET', '/api/ext/open-ext/data', 'u-user')).statusCode, 403);
  assert.equal((await call('GET', '/api/ext/open-ext/data', 'u-owner')).statusCode, 200);
});

test('no real extension declares a blanket public level', () => {
  for (const id of ['agent-connect', 'call-center', 'trading']) {
    const manifest = JSON.parse(readFileSync(join(backendDir, 'extensions', id, 'agentplayer.plugin.json'), 'utf8'));
    assert.notEqual(manifest.routeAccess, 'public', id);
    assert.ok(['owner-admin', 'authenticated'].includes(getExtensionRouteAccess(manifest)), id);
  }
});

test('the real channel extension stays owner/admin (default) and its manifest parses', () => {
  for (const id of ['agent-connect']) {
    const manifest = JSON.parse(readFileSync(join(backendDir, 'extensions', id, 'agentplayer.plugin.json'), 'utf8'));
    assert.equal(getExtensionRouteAccess(manifest), 'owner-admin', id);
    assert.equal(manifest.publicRoutes, undefined, id);
  }
});
