// MEM-ACC-02: the chat's recall query uses the owner's projects and graph names (memory/context/entities.ts).
//  - a project's scope name and its graph aliases are its names; another owner's names are never used;
//  - the conversation's latest mention, or the open project, is added to the query; GIRRU_RECALL_CONTEXT=0 keeps the message;
//  - forget drops the cached names.
// Run: node --import tsx --test test/chat-recall-query.test.mjs
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
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-recall-query-')));
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
delete process.env.GIRRU_RECALL_CONTEXT;
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
console.log = () => {}; console.warn = () => {};

const { getDatabase } = await load('src/db/database.ts');
const db = getDatabase();
await db.initialize();
for (const u of ['q-owner', 'q-other']) db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', 'owner', 'active')`).run(u, `${u}@example.test`, u);
db.prepare(`INSERT INTO memory_project_scopes (owner_id, slug, name) VALUES ('q-owner', 'falcon', 'Falcon'), ('q-owner', 'harbor', 'Harbor'), ('q-other', 'secret-x', 'Secret X')`).run();
const ent = db.prepare(`INSERT INTO memory_graph_entities (id, user_id, kind, name, norm_name, aliases) VALUES (?, ?, ?, ?, ?, ?)`);
ent.run('e1', 'q-owner', 'project', 'Falcon', 'falcon', JSON.stringify(['فالكون']));
ent.run('e2', 'q-owner', 'person', 'Amira Saeed', 'amira saeed', JSON.stringify(['Amira', 'أميرة']));
ent.run('e3', 'q-other', 'person', 'Zoltan Kiss', 'zoltan kiss', '[]');
const E = await load('src/memory/context/entities.ts');
const { forgetRecallIndex } = await load('src/memory/recall-index.ts');

test('names come from the owner\'s scopes and graph aliases, never another owner\'s', async () => {
  const { entities, openProject } = await E.contextEntities('q-owner', 'falcon');
  assert.equal(openProject.names[0], 'Falcon');
  assert.ok(openProject.names.includes('فالكون'), 'the graph alias joins the scope');
  const all = entities.flatMap((e) => e.names);
  assert.ok(all.includes('Harbor') && all.includes('أميرة'));
  assert.ok(!all.includes('Secret X') && !all.includes('Zoltan Kiss'));
});

test('the conversation or the open project goes into the query; the switch turns it off', async () => {
  const { query: q1 } = await E.chatRecallQuery({ ownerId: 'q-owner', message: 'Why did we change it?', history: ['We talked about Harbor and its server.', 'ok'], openProjectSlug: 'falcon' });
  assert.match(q1, /^Why did we change it\?\n\(Harbor/);
  const { query: q2 } = await E.chatRecallQuery({ ownerId: 'q-owner', message: 'متى الموعد النهائي؟', history: [], openProjectSlug: 'falcon' });
  assert.match(q2, /Falcon/);
  assert.match(q2, /فالكون/);
  process.env.GIRRU_RECALL_CONTEXT = '0';
  assert.equal((await E.chatRecallQuery({ ownerId: 'q-owner', message: 'Why did we change it?', history: ['Harbor'], openProjectSlug: 'falcon' })).query, 'Why did we change it?');
  delete process.env.GIRRU_RECALL_CONTEXT;
  const multi = await E.chatRecallQuery({ ownerId: 'q-owner', message: 'Who is our contact at the client of the project whose server runs on ClickHouse?', history: [], openProjectSlug: 'falcon' });
  assert.equal(multi.parts.length, 1, 'the head of a question with a relative clause is searched too');
  assert.match(multi.parts[0], /^Who is our contact at the client of the project\n\(Falcon/);
});

test('forget drops the cached names (a removed scope is gone at once)', async () => {
  await E.contextEntities('q-owner', null);
  db.prepare(`DELETE FROM memory_project_scopes WHERE owner_id = 'q-owner' AND slug = 'harbor'`).run();
  forgetRecallIndex('q-owner');
  const { entities } = await E.contextEntities('q-owner', null);
  assert.ok(!entities.some((e) => e.names.includes('Harbor')));
});
