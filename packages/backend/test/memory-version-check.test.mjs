// MEM-VER-01: an agent edit or delete made on an older version of a memory is refused (memory/learning.ts agentChange),
// and the versions an edit refers to are read in one step (memory/validity.ts currentVersionsStep).
// Run: node --import tsx --test test/memory-version-check.test.mjs
// Throwaway DB + cwd + HOME, random test-only secrets, no network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const backendDir = process.cwd();
const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-mem-version-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
console.log = () => {}; console.warn = () => {};

const { getDatabase } = await load('src/db/database.ts');
const db = getDatabase();
await db.initialize();
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES ('v-owner', 'v@example.test', 'v-owner', 'x', 'owner', 'active')`).run();
const { getMemoryStorage } = await load('src/memory/storage.ts');
const { agentChange } = await load('src/memory/learning.ts');
const { currentVersionsStep } = await load('src/memory/validity.ts');
const { sql } = await load('src/repositories/sql-steps.ts');
const storage = getMemoryStorage();
await storage.initialize();

const save = (id, content) => storage.save({ id, userId: 'v-owner', type: 'fact', content, drawer: { kind: 'project', key: 'falcon' }, memoryLayer: 'factual',
  importanceScore: 0.5, status: 'active', metadata: {}, createdAt: new Date(), accessCount: 0, expiryTimestamp: null });
const edit = (id, content, expectedVersion) => agentChange({ userId: 'v-owner', memoryId: id, op: 'update', updates: { content }, actor: 'agent:a1', agentId: 'a1',
  ...(expectedVersion !== undefined ? { expectedVersion } : {}) });
const versionOf = async (id) => (await sql().read(currentVersionsStep([id]))).get(id);

test('an edit on the version the agent read is applied; one on an older version is refused and shows the current text', async () => {
  await save('m-v1', 'Falcon deploys go out every Monday.');
  assert.equal(await versionOf('m-v1'), 0, 'a memory never edited is v0');
  const first = await edit('m-v1', 'Falcon deploys go out every Tuesday.', 0);
  assert.equal(first.status, 'applied');
  const now = await versionOf('m-v1');
  assert.ok(now > 0, 'the edit made a new version');
  // A second agent still holds v0 and tries to write over the newer text.
  const stale = await edit('m-v1', 'Falcon deploys go out every Friday.', 0);
  assert.equal(stale.status, 'refused');
  assert.match(stale.reason, new RegExp(`you read v0, it is now v${now}`));
  assert.match(stale.reason, /Tuesday/);
  assert.equal((await storage.getOwned('v-owner', 'm-v1')).content, 'Falcon deploys go out every Tuesday.', 'the newer text stays');
  // With the current version it goes through.
  assert.equal((await edit('m-v1', 'Falcon deploys go out every Friday.', now)).status, 'applied');
});

test('a delete on an older version is refused; without a version the old behaviour stays', async () => {
  await save('m-v2', 'Harbor uses OVH.');
  assert.equal((await edit('m-v2', 'Harbor uses Hetzner.')).status, 'applied', 'no version: applied as before');
  const del = await agentChange({ userId: 'v-owner', memoryId: 'm-v2', op: 'delete', actor: 'agent:a1', agentId: 'a1', expectedVersion: 0 });
  assert.equal(del.status, 'refused');
  assert.ok(await storage.getOwned('v-owner', 'm-v2'), 'still there');
});

test('versions of several memories are read in one step (unknown ids are v0)', async () => {
  const v = await sql().read(currentVersionsStep(['m-v1', 'm-v2', 'nope']));
  assert.ok(v.get('m-v1') > 0 && v.get('m-v2') > 0);
  assert.equal(v.get('nope'), 0);
});
