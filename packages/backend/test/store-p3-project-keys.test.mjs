// STORE-MAP-01 P3 step 4: memory keeps projects by id (D3, D10, FD1).
//  - the move rewrites every project key (memories, versions, scope rows, pinned facts, groups) from the
//    slug to the chat project's id; a memory-only key becomes a real project (FD1b); a second run
//    changes nothing;
//  - project lists, recall and a project conversation's drawer use the id;
//  - deleting a project keeps its memory under its own id: a new project with the same name starts
//    empty (D10);
//  - an old slug (a link) still answers with the current project's id (one release);
//  - turning the switch off moves the keys back to slugs.
// Run: node --import tsx --test test/store-p3-project-keys.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { clearEnv } from './helpers/switches.mjs';
const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p3-keys-')));
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
for (const k of ['GIRRU_STORE_P3', 'AGENT_PLAYER_DATA_DIR']) clearEnv(k);
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
console.log = () => {}; console.info = () => {}; console.warn = () => {};

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const OWNER = 'keys-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, 'keys@example.test', OWNER);

const projects = await import(join(backendDir, 'src/repositories/chat-conversations.ts'));
const { newMemory, saveVersioned } = await import(join(backendDir, 'src/memory/learning.ts'));
const { getMemoryStorage } = await import(join(backendDir, 'src/memory/storage.ts'));
const store = await import(join(backendDir, 'src/memory/scopes/store.ts'));
const { addPinnedFact } = await import(join(backendDir, 'src/memory/scopes/pinned.ts'));
const keys = await import(join(backendDir, 'src/memory/project-keys.ts'));
const { projectDrawer } = await import(join(backendDir, 'src/memory/bridge/brief.ts'));
const { sql } = await import(join(backendDir, 'src/repositories/sql-steps.ts'));
const storage = getMemoryStorage();

const save = (key, content) => saveVersioned(newMemory(OWNER, { kind: 'project', key }, { type: 'fact', importance: 6, content }, { source: 'owner' }), OWNER, 'test');
const rows = (s, ...a) => db.prepare(s).all(...a);
const get = (s, ...a) => db.prepare(s).get(...a);

let alpha, m1, m2;
test('today (switch off): project memory is keyed by the slug', async () => {
  alpha = await projects.createProject(OWNER, { name: 'Alpha' });
  m1 = await save(alpha.slug, 'Alpha ships on Fridays.');
  m2 = await save('beta-notes', 'The beta list has 40 people.');
  await addPinnedFact(OWNER, { kind: 'project', id: alpha.slug }, 'Alpha uses SQLite.', OWNER);
  await sql().tx(() => store.upsertProjectRowStep(OWNER, 'beta-notes', { name: 'Beta notes' }, OWNER));
  assert.equal(get('SELECT drawer_key FROM memories WHERE id = ?', m1.id).drawer_key, 'alpha');
});

let beta;
test('the move rewrites every key to the project id and makes real projects', async () => {
  process.env.GIRRU_STORE_P3 = '1';
  const [r] = await keys.moveProjectKeys('id');
  assert.equal(r.created, 1, 'beta-notes becomes a real project');
  beta = get("SELECT * FROM chat_projects WHERE user_id = ? AND slug = 'beta-notes'", OWNER);
  assert.equal(beta.name, 'Beta notes');
  assert.equal(get('SELECT drawer_key FROM memories WHERE id = ?', m1.id).drawer_key, alpha.id);
  assert.equal(get('SELECT drawer_key FROM memories WHERE id = ?', m2.id).drawer_key, beta.id);
  assert.ok(rows("SELECT drawer_key FROM memory_versions WHERE memory_id = ?", m1.id).every((v) => v.drawer_key === alpha.id));
  assert.equal(get("SELECT scope_id FROM memory_pinned_facts WHERE scope_kind = 'project'").scope_id, alpha.id);
  assert.equal(get('SELECT slug FROM memory_project_scopes WHERE owner_id = ?', OWNER).slug, beta.id);
  assert.deepEqual(rows('SELECT slug, origin FROM memory_project_keys ORDER BY slug').map((x) => `${x.slug}|${x.origin}`), ['alpha|chat_project', 'beta-notes|memory_only']);
  const [again] = await keys.moveProjectKeys('id');
  assert.deepEqual({ ...again }, { direction: 'none', projects: 0, rows: 0, created: 0 }, 'idempotent');
});

test('lists, recall and a project conversation use the id', async () => {
  const list = await store.listProjects(OWNER);
  const a = list.find((p) => p.chatProjectId === alpha.id);
  assert.equal(a.slug, alpha.id);
  assert.equal(a.name, 'Alpha');
  assert.ok(list.find((p) => p.chatProjectId === beta.id));
  assert.equal(list.length, 2, 'no stray slug entries');
  assert.deepEqual(projectDrawer(alpha), { kind: 'project', key: alpha.id });
  const hits = await storage.search({ userId: OWNER, query: 'Alpha ships', drawers: [projectDrawer(alpha)], limit: 5 });
  assert.equal(hits[0]?.memory.id, m1.id);
});

test('a new project with the name of a deleted one starts empty (D10)', async () => {
  await projects.deleteProject(OWNER, alpha.id);
  const again = await projects.createProject(OWNER, { name: 'Alpha' });
  assert.notEqual(again.id, alpha.id);
  const hits = await storage.search({ userId: OWNER, query: 'Alpha ships', drawers: [projectDrawer(again)], limit: 5 });
  assert.equal(hits.length, 0, 'the old memory is not taken over');
  assert.equal(get('SELECT drawer_key FROM memories WHERE id = ?', m1.id).drawer_key, alpha.id, 'it stays with the deleted project');
  assert.equal(await keys.currentProjectKey(OWNER, again.slug), again.id, 'an old link opens the current project');
  assert.equal(await keys.currentProjectKey(OWNER, again.id), again.id);
  // FD1a: Girru can offer the old memory once; taking it over moves it to the new project.
  const offer = await keys.deletedProjectMemory(OWNER, again);
  assert.deepEqual({ key: offer.key, memories: offer.memories }, { key: alpha.id, memories: 1 });
  assert.equal(await keys.adoptProjectMemory(OWNER, offer.key, again.id) > 0, true);
  const back = await storage.search({ userId: OWNER, query: 'Alpha ships', drawers: [projectDrawer(again)], limit: 5 });
  assert.equal(back[0]?.memory.id, m1.id, '"Use its memory" brings it to the new project');
  assert.equal(await keys.deletedProjectMemory(OWNER, again), null, 'asked only once');
  // Put it back under the deleted project for the next test.
  await sql().tx(() => keys.rewriteStep(OWNER, again.id, alpha.id));
});

test('turning the switch off moves the keys back to slugs', async () => {
  process.env.GIRRU_STORE_P3 = '0';
  const [r] = await keys.moveProjectKeys('slug');
  assert.equal(r.direction, 'to_slug');
  assert.equal(get('SELECT drawer_key FROM memories WHERE id = ?', m2.id).drawer_key, 'beta-notes');
  assert.equal(get('SELECT drawer_key FROM memories WHERE id = ?', m1.id).drawer_key, alpha.id, 'a deleted project keeps its own key');
  assert.equal((await store.listProjects(OWNER)).find((p) => p.chatProjectId === beta.id).slug, 'beta-notes');
  const [none] = await keys.moveProjectKeys('slug');
  assert.equal(none.direction, 'none');
});
