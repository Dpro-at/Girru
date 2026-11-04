// STORE-MAP-01 P3 step 5: memory vectors packed as Float32.
//  - pack/unpack keep the numbers (to Float32 precision); bad bytes are refused;
//  - with the switch on a save writes the packed copy and recall reads it; off, a save clears it so
//    it never goes stale;
//  - the background job fills older rows in batches, can run again, and reports how far it is.
// Run: node --import tsx --test test/store-p3-vectors.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p3-vec-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
process.env.GIRRU_STORE_P3 = '0';
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
console.log = () => {}; console.info = () => {}; console.warn = () => {};

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const OWNER = 'vec-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, 'vec@example.test', OWNER);
const V = await import(join(backendDir, 'src/memory/vectors.ts'));
const { newMemory, saveVersioned, updateVersioned } = await import(join(backendDir, 'src/memory/learning.ts'));
const { getMemoryStorage } = await import(join(backendDir, 'src/memory/storage.ts'));
const storage = getMemoryStorage();
const drawer = { kind: 'owner', key: '' };
const save = (content) => saveVersioned(newMemory(OWNER, drawer, { type: 'fact', importance: 5, content }, { source: 'owner' }), OWNER, 'test');
const vec = (id) => db.prepare('SELECT embedding_vec FROM memories WHERE id = ?').get(id).embedding_vec;

test('pack and unpack', () => {
  const v = [0.5, -1.25, 3.0000001, 0];
  const back = V.unpackVector(V.packVector(v));
  assert.equal(back.length, 4);
  back.forEach((x, i) => assert.ok(Math.abs(x - v[i]) < 1e-6));
  assert.equal(V.packVector(v).length, 16, '4 bytes a number');
  assert.equal(V.unpackVector(Buffer.alloc(3)), null);
  assert.equal(V.unpackVector(Buffer.alloc(0)), null);
});

let older;
test('switch off: nothing packed; the job fills older rows when it runs', async () => {
  older = [await save('Rafid prefers PostgreSQL on servers.'), await save('The office opens at nine.'), await save('Samir likes short answers.')];
  assert.ok(older.every((m) => vec(m.id) === null));
  process.env.GIRRU_STORE_P3 = '1';
  assert.deepEqual(await V.vectorJobStatus(), { done: 0, total: 3 });
  assert.equal(await V.backfillVectors(2), 3);
  assert.deepEqual(await V.vectorJobStatus(), { done: 3, total: 3 });
  assert.equal(await V.backfillVectors(2), 0, 'runs again with nothing to do');
  const json = JSON.parse(db.prepare('SELECT embedding FROM memories WHERE id = ?').get(older[0].id).embedding);
  assert.equal(vec(older[0].id).length, json.length * 4);
});

test('switch on: recall reads the packed vector and finds the same memory', async () => {
  const fresh = await save('Alpha ships on Fridays.');
  assert.ok(vec(fresh.id), 'a save writes the packed copy');
  const hits = await storage.search({ userId: OWNER, query: 'Alpha ships', drawers: [drawer], limit: 3 });
  assert.equal(hits[0].memory.id, fresh.id);
  process.env.GIRRU_STORE_P3 = '0';
  const same = await storage.search({ userId: OWNER, query: 'Alpha ships', drawers: [drawer], limit: 3 });
  assert.deepEqual(same.map((h) => h.memory.id), hits.map((h) => h.memory.id), 'the same order with the switch off');
});

test('switch off again: an edit clears the packed copy so it never goes stale', async () => {
  await updateVersioned(OWNER, older[1].id, { content: 'The office opens at ten.' }, OWNER, 'test');
  assert.equal(vec(older[1].id), null);
});
