// MEM-HIST-01: a question about a past state also reads replaced facts, labelled as no longer current;
// a question about now never gets a replaced fact. Same path as a chat reply (qualityRecall, P9 + P9B).
// Run: node --import tsx --test test/memory-history-recall.test.mjs
// Throwaway DB + cwd + HOME, random test-only secrets, no network, hash embeddings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const backendDir = process.cwd();
const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-mem-history-')));
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
process.env.GIRRU_STORE_P9 = '1';
process.env.GIRRU_STORE_P9B = '1';
delete process.env.GIRRU_RECALL_PAST;
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
console.log = () => {}; console.warn = () => {};

const { getDatabase } = await load('src/db/database.ts');
const db = getDatabase();
await db.initialize();
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES ('h-owner', 'h@example.test', 'h-owner', 'x', 'owner', 'active')`).run();
const { getMemoryStorage } = await load('src/memory/storage.ts');
const { qualityRecall } = await load('src/memory/quality/recall.ts');
const { asksAboutThePast } = await load('src/memory/quality/intent.ts');
const storage = getMemoryStorage();
await storage.initialize();
const save = (id, content, createdAt) => storage.save({ id, userId: 'h-owner', type: 'fact', content, drawer: { kind: 'project', key: 'falcon' }, memoryLayer: 'factual',
  importanceScore: 0.5, status: 'active', metadata: {}, createdAt: new Date(createdAt), accessCount: 0, expiryTimestamp: null });
await save('h-old', 'Falcon server database is MySQL.', '2026-01-12T09:00:00Z');
await save('h-new', 'Falcon server database is now PostgreSQL since March.', '2026-03-20T09:00:00Z');
db.prepare("UPDATE memories SET status = 'replaced', superseded_by = 'h-new' WHERE id = 'h-old'").run();
const drawers = [{ kind: 'owner' }, { kind: 'project', key: 'falcon' }];
const ids = (r) => r.items.map((it) => it.memory.id);

test('questions about a past state are recognised in English, Arabic, Iraqi and German; current ones are not', () => {
  for (const q of ['What was the Falcon server database in January 2026?', 'Which database did we use before the switch?', 'بشباط شنو چانت خطتنا؟', 'ما كانت قاعدة البيانات قبل التغيير؟', 'Was war früher die Datenbank?']) assert.ok(asksAboutThePast(q), q);
  for (const q of ['Which database does the Falcon server use now?', 'ما قاعدة بيانات الخادم حالياً؟', 'Welche Datenbank nutzt der Server?']) assert.ok(!asksAboutThePast(q), q);
});

test('a past question finds the replaced fact (status replaced); a current question never does', async () => {
  const past = await qualityRecall({ userId: 'h-owner', drawers, query: 'What was the Falcon server database in January, before the switch?', limit: 6, ask: false });
  assert.ok(ids(past).includes('h-old'), 'the replaced fact is found');
  assert.equal(past.items.find((it) => it.memory.id === 'h-old').memory.status, 'replaced', 'and keeps its status for the label');
  const now = await qualityRecall({ userId: 'h-owner', drawers, query: 'Which database does the Falcon server use now?', limit: 6, ask: false });
  assert.ok(ids(now).includes('h-new'));
  assert.ok(!ids(now).includes('h-old'), 'never as current');
});

test('GIRRU_RECALL_PAST=0 and past:false keep replaced facts out', async () => {
  const q = { userId: 'h-owner', drawers, query: 'What was the Falcon server database in January, before the switch?', limit: 6, ask: false };
  assert.ok(!ids(await qualityRecall({ ...q, past: false })).includes('h-old'));
  process.env.GIRRU_RECALL_PAST = '0';
  assert.ok(!ids(await qualityRecall(q)).includes('h-old'));
  delete process.env.GIRRU_RECALL_PAST;
});
