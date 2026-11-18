// S0-Q.17 (review fix for S0-Q.11): the memory `type`, `id` and `userId` become
// markdown file path segments. POST/PUT /api/memory accept only known types,
// PUT edits only allow-listed fields, and storage refuses any path outside
// <memoryDir>/<userId>.
// Run: node --import tsx --test test/memory-path-safety.test.mjs
// No network: fetch is stubbed (embedding calls fail fast).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'ap-mem-path-'));
// Memory storage writes to `../../.data/memory` relative to cwd: keep it inside `dir`.
const cwd = join(dir, 'a', 'b');
mkdirSync(cwd, { recursive: true });
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(cwd);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.OLLAMA_URL = 'http://127.0.0.1:9'; // never reached: fetch is stubbed

const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network disabled in test'); };

const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
const db = getDatabase();
await db.initialize();
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES ('u-alice', 'a@example.test', 'alice', 'x', 'user', 'active', 1)`).run();

const { default: Fastify } = await import('fastify');
const { memoryRoutes } = await import('../src/api/routes/memory.ts');
const { getMemoryStorage } = await import('../src/memory/storage.ts');
const { generateToken } = await import('../src/auth/jwt.ts');

const app = Fastify();
await app.register(memoryRoutes);
await app.ready();

test.after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const alice = { authorization: `Bearer ${generateToken('u-alice', 1)}` };
const req = (method, url, payload) => app.inject({ method, url, headers: alice, payload });
const memoryDir = join(dir, '.data', 'memory');
const outsideFiles = () => readdirSync(dir).filter(n => !['a', '.data'].includes(n));

test('POST /api/memory refuses unknown and path-like types; nothing written', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM memories').get().n;
  for (const type of ['../../../evil', '../x', 'fact/../../x', 'goal', 'FACT', '', 42, ['fact']]) {
    const res = await req('POST', '/api/memory', { type, content: 'x' });
    assert.equal(res.statusCode, 400, `type ${JSON.stringify(type)}: ${res.body}`);
  }
  for (const body of [{ type: 'fact', content: 'x', importance: 99 }, { type: 'fact', content: 'x', metadata: [1] }, { type: 'fact', content: { a: 1 } }]) {
    assert.equal((await req('POST', '/api/memory', body)).statusCode, 400, JSON.stringify(body));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, before);
  assert.deepEqual(outsideFiles(), []);
});

test('PUT /api/memory/:id: type validated, only allow-listed fields change', async () => {
  const created = await req('POST', '/api/memory', { type: 'fact', content: 'alice likes tea', importance: 5 });
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().memory.id;
  assert.ok(existsSync(join(memoryDir, 'u-alice', `fact-${id}.md`)));

  assert.equal((await req('PUT', `/api/memory/${id}`, { type: '../../../../evil' })).statusCode, 400);
  assert.equal((await req('PUT', `/api/memory/${id}`, { type: 'nope' })).statusCode, 400);
  assert.equal((await req('PUT', `/api/memory/${id}`, { tags: [1] })).statusCode, 400);

  const row0 = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  const res = await req('PUT', `/api/memory/${id}`, {
    content: 'alice likes green tea', type: 'preference', tags: ['drink'],
    id: 'other-id', userId: 'u-bob', status: 'deleted', memoryLayer: 'factual', createdAt: '1999-01-01T00:00:00Z',
    accessCount: 9999, expiryTimestamp: 1, consolidationStatus: 'consolidated', embedding: [1, 2, 3],
  });
  assert.equal(res.statusCode, 200, res.body);
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  assert.equal(row.user_id, 'u-alice');
  assert.equal(row.content, 'alice likes green tea');
  assert.equal(row.type, 'preference');
  assert.equal(row.tags, JSON.stringify(['drink']));
  for (const col of ['status', 'memory_layer', 'created_at', 'expiry_timestamp', 'consolidation_status']) {
    assert.equal(row[col], row0[col], col);
  }
  assert.ok(row.access_count < 10, 'access_count not taken from the body'); // storage.get counts reads
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE id = 'other-id'`).get().n, 0);
  // File renamed with the type; old file removed; nothing outside the user dir.
  assert.deepEqual(readdirSync(join(memoryDir, 'u-alice')).filter(n => n.includes(id)), [`preference-${id}.md`]);
  assert.deepEqual(readdirSync(memoryDir), ['u-alice']);
  assert.deepEqual(outsideFiles(), []);
});

test('storage refuses ids, user ids and types that leave the memory directory', async () => {
  const storage = getMemoryStorage();
  const base = { content: 'x', status: 'active', createdAt: new Date(), accessCount: 0, metadata: {}, embedding: [0] };
  for (const bad of [
    { id: 'm1', userId: '../escape', type: 'fact' },
    { id: 'm1', userId: '..', type: 'fact' },
    { id: '../../m1', userId: 'u-alice', type: 'fact' },
    { id: 'm/1', userId: 'u-alice', type: 'fact' },
    { id: 'm1', userId: 'u-alice', type: '../../x' },
    { id: 'm1', userId: 'u-alice', type: 'Fact/..' },
    { id: 'm1', userId: '/etc', type: 'fact' },
  ]) {
    await assert.rejects(storage.save({ ...base, ...bad }), /Invalid|escapes/, JSON.stringify(bad));
  }
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE id IN ('m1', '../../m1', 'm/1')`).get().n, 0);
  assert.deepEqual(outsideFiles(), []);
  // The memory_save tool's own types still work.
  await storage.save({ ...base, id: 'm-conv', userId: 'u-alice', type: 'conversation' });
  assert.ok(existsSync(join(memoryDir, 'u-alice', 'conversation-m-conv.md')));
});
