// STORE-MAP-01 P4 (G1): the old skill marketplace answers 410 retired while the switch is on;
// the skill list and everything else still answer. Throwaway DB, no network.
// Run: node --import tsx --test test/store-p4-marketplace.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-p4-market-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.GIRRU_STORE_P4 = '0';
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
console.log = () => {}; console.info = () => {}; console.warn = () => {};

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
await getDatabase().initialize();
getDatabase().prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES ('mk-owner', 'mk@example.test', 'mk', 'x', 'owner', 'active', 1)`).run();
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const app = await buildServer({ logger: false });
await app.ready();
const get = (url) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${generateToken('mk-owner', 1)}` } });

test('switch off: the marketplace route answers as before', async () => {
  assert.notEqual((await get('/api/skills/marketplace/stats')).statusCode, 410);
});

test('switch on: retired with 410; the skill list still answers', async () => {
  process.env.GIRRU_STORE_P4 = '1';
  const r = await get('/api/skills/marketplace/stats');
  assert.equal(r.statusCode, 410);
  assert.equal(r.json().code, 'retired');
  assert.equal((await get('/api/skills/marketplace/available')).statusCode, 410);
  assert.equal((await get('/api/skills')).statusCode, 200);
  process.env.GIRRU_STORE_P4 = '0';
  await app.close();
});
