// STORE-MAP-01 P3 step 2: where a memory came from, trust, still true (FD3, D11).
//  - switch off: nothing is stamped and a topic update overwrites in place, as before;
//  - switch on: the owner's memory is "checked", an agent's "unchecked" with the agent, an import "imported";
//  - a new fact on a known topic replaces the old one: the old row stays (status replaced, valid_to,
//    superseded_by), is hidden from search, the topic lookup and the explorer, and shows with
//    "Show replaced facts";
//  - "Mark as checked" and its undo;
//  - an owner edit based on an older version is refused with the current version (nothing overwritten);
//  - the backfill fills existing rows once and can run again.
// Run: node --import tsx --test test/store-p3-validity.test.mjs
// Throwaway DB + cwd, random test-only secrets, no network, hash embeddings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p3-val-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['GIRRU_STORE_P3', 'AGENT_PLAYER_DATA_DIR']) delete process.env[k];
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
console.log = () => {}; console.info = () => {}; console.warn = () => {};

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const OWNER = 'val-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, 'val@example.test', OWNER);
db.prepare(`INSERT INTO agents_config (id, name, provider, model) VALUES ('val-agent', 'Rafid', 'ollama', 'm')`).run();

const { learn, newMemory, saveVersioned } = await import(join(backendDir, 'src/memory/learning.ts'));
const { memoryRepository } = await import(join(backendDir, 'src/repositories/memory.ts'));
const { getMemoryStorage } = await import(join(backendDir, 'src/memory/storage.ts'));
const { exploreScope } = await import(join(backendDir, 'src/memory/scopes/tree.ts'));
const validity = await import(join(backendDir, 'src/memory/validity.ts'));
const storage = getMemoryStorage();
await storage.initialize?.();

const owner = { kind: 'user', userId: OWNER, role: 'owner' };
const row = (id) => db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
const drawer = { kind: 'owner', key: '' };
const agentLearn = (content, topicKey) => learn({ userId: OWNER, actor: 'agent:val-agent', agentId: 'val-agent', candidates: [{ content, type: 'fact', importance: 5, origin: 'agent', drawer, topicKey }] });

let oldTopic;
test('switch off: nothing stamped, a topic update overwrites in place', async () => {
  const out = await agentLearn('The team meets on Mondays.', 'team-meeting');
  oldTopic = out.saved[0];
  assert.equal(row(oldTopic.id).source, null);
  const upd = await agentLearn('The team meets on Tuesdays.', 'team-meeting');
  assert.equal(upd.updated[0].id, oldTopic.id, 'same row, new version');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE topic_key = 'team-meeting'").get().n, 1);
});

test('switch on: source and trust for owner, agent and import', async () => {
  process.env.GIRRU_STORE_P3 = '1';
  const mine = await memoryRepository.create(owner, newMemory(OWNER, drawer, { type: 'preference', importance: 6, content: 'Samir likes short answers.' }, { source: 'owner' }), 'test');
  assert.deepEqual({ s: row(mine.id).source, t: row(mine.id).trust }, { s: 'owner', t: 'checked' });
  const agentMem = (await agentLearn('Rafid prefers PostgreSQL for servers.', null)).saved[0];
  assert.deepEqual({ s: row(agentMem.id).source, r: row(agentMem.id).source_ref, t: row(agentMem.id).trust }, { s: 'agent', r: 'val-agent', t: 'unchecked' });
  const imported = await saveVersioned(newMemory(OWNER, drawer, { type: 'fact', importance: 5, content: 'Imported: the office opens at 9.' }, { source: 'import' }), OWNER, 'test');
  assert.equal(row(imported.id).trust, 'imported', 'an import is data only even when the owner ran it');
  assert.ok(row(mine.id).valid_from);
});

let newer;
test('a new fact on a known topic replaces the old one, which stays in History', async () => {
  const out = await agentLearn('The team meets on Wednesdays.', 'team-meeting');
  newer = out.saved[0] ?? out.updated[0];
  assert.notEqual(newer.id, oldTopic.id, 'a new row');
  const old = row(oldTopic.id);
  assert.equal(old.status, 'replaced');
  assert.equal(old.superseded_by, newer.id);
  assert.ok(old.valid_to);
  assert.equal(old.content, 'The team meets on Tuesdays.', 'the old text is kept');
  assert.equal((await storage.getByTopicKey(OWNER, drawer, 'team-meeting')).id, newer.id);
  const hits = await storage.search({ userId: OWNER, query: 'team meets', drawers: [drawer], limit: 10 });
  assert.ok(!hits.some((h) => h.memory.id === oldTopic.id), 'agents never get the replaced fact');
  assert.ok(hits.some((h) => h.memory.id === newer.id));
  const page = await exploreScope(OWNER, { scope: 'company' });
  assert.ok(!page.items.some((i) => i.id === oldTopic.id), 'hidden from lists by default');
  const shown = await exploreScope(OWNER, { scope: 'company', replaced: 'show' });
  const it = shown.items.find((i) => i.id === oldTopic.id);
  assert.ok(it, 'Show replaced facts');
  assert.equal(it.supersededBy, newer.id);
  const v = await validity.validityOf(OWNER, newer.id);
  assert.deepEqual(v.replaces, [oldTopic.id]);
});

test('Mark as checked, and undo', async () => {
  assert.equal(await validity.setChecked(OWNER, newer.id, true), 'checked');
  assert.equal(row(newer.id).trust, 'checked');
  assert.equal(await validity.setChecked(OWNER, newer.id, false), 'unchecked');
});

test('an edit based on an older version is refused with the current version', async () => {
  const v = (await validity.validityOf(OWNER, newer.id)).version;
  await memoryRepository.update(owner, newer.id, { content: 'The team meets on Thursdays.' }, 'api', v);
  await assert.rejects(memoryRepository.update(owner, newer.id, { content: 'Stale text from another window.' }, 'api', v),
    (err) => err.status === 409 && err.current?.content === 'The team meets on Thursdays.' && err.current?.version === v + 1);
  assert.equal(row(newer.id).content, 'The team meets on Thursdays.', 'nothing overwritten');
});

test('the backfill fills existing rows once', async () => {
  db.prepare('UPDATE memories SET source = NULL, trust = NULL').run();
  const n = await validity.backfillProvenance(2);
  assert.ok(n >= 5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE source IS NULL').get().n, 0);
  assert.equal(await validity.backfillProvenance(2), 0);
  assert.equal(row(oldTopic.id).source, 'agent');
});
