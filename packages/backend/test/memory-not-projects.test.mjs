// MEM-READ-01 MR3: library folders are never projects.
//  - the detector knows the Go module folder (pkg/mod, name@vX.Y.Z), node_modules, vendor, Pods…;
//  - the document scan and the folder-key rule skip them;
//  - existing projects made from them move to "Not projects" on their own (once), are hidden from
//    recall, and the owner's "It's a project" brings one back and is never undone automatically;
//  - a chat project is always a project.
// Run: node --import tsx --test test/memory-not-projects.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const backendDir = process.cwd();
const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-not-projects-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const L = await load('src/memory/import/library-folders.ts');
const { rootDrawerKey } = await load('src/memory/import/local-agents.ts');
const { scanRoot } = await load('src/memory/docs/scan.ts');

test('detector: Go module folder, node_modules, vendor, Pods; real projects are not libraries', () => {
  const home = '/Users/owner';
  for (const p of [`${home}/go/pkg/mod/github.com/charmbracelet/bubbletea@v1.3.10`, `${home}/go/pkg/mod/github.com/charmbracelet/x/ansi@v0.0.0-20230315-abcdef`,
    `${home}/Projects/app/node_modules/react`, `${home}/Projects/site/vendor/laravel/framework`, `${home}/Projects/ios/Pods/Alamofire`,
    `${home}/.venv/lib/python3.12/site-packages/requests`, 'C:\\Users\\owner\\go\\pkg\\mod\\golang.org\\x\\sys@v0.20.0']) assert.equal(L.isLibraryPath(p), true, p);
  for (const p of [`${home}/Projects/grenzer`, `${home}/Projects/agent_player/packages/backend`, `${home}/Projects/go-tools`, `${home}/Projects/vendor-portal`]) assert.equal(L.isLibraryPath(p), false, p);
  assert.equal(L.libraryProjectKey('bubbletea-v1-3-10'), true);
  assert.equal(L.libraryProjectKey('ansi-v0-0-0-20230315-abcdef'), true);
  assert.equal(L.libraryProjectKey('grenzer'), false);
  assert.equal(L.libraryProjectKey('agent-player'), false);
  assert.equal(L.libraryShortName('bubbletea-v1-3-10'), 'bubbletea');
  assert.equal(L.libraryKindOf(`${home}/go/pkg/mod/x@v1.0.0`), 'Go library');
  assert.equal(L.libraryKindOf(`${home}/a/node_modules/b`), 'JavaScript package');
  // The folder-key rule never makes a project drawer for a library folder.
  assert.equal(rootDrawerKey(`${home}/go/pkg/mod/github.com/charmbracelet/bubbletea@v1.3.10`, home), null);
  assert.equal(rootDrawerKey(`${home}/Projects/grenzer`, home), 'grenzer');
});

test('document scan skips the Go module folder and node_modules', async () => {
  const root = join(dir, 'scan-root');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'guide.md'), '# Guide\n');
  mkdirSync(join(root, 'pkg', 'mod', 'github.com', 'x', 'lib@v1.2.3'), { recursive: true });
  writeFileSync(join(root, 'pkg', 'mod', 'github.com', 'x', 'lib@v1.2.3', 'README.md'), '# lib\n');
  mkdirSync(join(root, 'tools', 'thing@v0.0.0-2023'), { recursive: true });
  writeFileSync(join(root, 'tools', 'thing@v0.0.0-2023', 'README.md'), '# thing\n');
  const r = await scanRoot(root);
  assert.deepEqual(r.files.map(f => f.rel), [join('docs', 'guide.md')]);
});

const { getDatabase } = await load('src/db/database.ts');
const db = getDatabase();
await db.initialize();
const OWNER = 'np-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, `${OWNER}@example.test`, OWNER);
const K = await load('src/memory/scopes/project-kinds.ts');
const S = await load('src/memory/scopes/store.ts');
const { createProject } = await load('src/repositories/chat-conversations.ts');
const { projectKeyOf } = await load('src/memory/project-keys.ts');

const addMemory = (key, content) => db.prepare(`INSERT INTO memories (id, user_id, type, content, drawer_kind, drawer_key, created_at)
  VALUES (?, ?, 'fact', ?, 'project', ?, ?)`).run(`m-${key}-${Math.random().toString(36).slice(2, 8)}`, OWNER, content, key, new Date().toISOString());

test('existing library projects move to Not projects once; It\'s a project brings one back for good', async () => {
  addMemory('bubbletea-v1-3-10', 'Bubbletea is a TUI framework');
  addMemory('ansi-v0-0-0-20230315-abcdef', 'ANSI helpers');
  addMemory('grenzer', 'Grenzer runs on a VPS');
  addMemory('react', 'React from node_modules');
  db.exec('CREATE TABLE IF NOT EXISTS discovery_computer_roots (user_id TEXT NOT NULL, root TEXT NOT NULL, PRIMARY KEY (user_id, root))');
  db.prepare('INSERT INTO discovery_computer_roots (user_id, root) VALUES (?, ?)').run(OWNER, join(dir, 'Projects', 'app', 'node_modules', 'react'));
  K.resetProjectKindCache();
  assert.equal(await K.classifyLibraryProjects(OWNER, { force: true }), 3);
  const list = await S.listProjects(OWNER);
  const by = Object.fromEntries(list.map(p => [p.slug, p]));
  assert.equal(by['bubbletea-v1-3-10'].notProject, true);
  assert.equal(by['bubbletea-v1-3-10'].notProjectReason, 'Go library');
  assert.equal(by['react'].notProject, true);
  assert.equal(by['react'].notProjectReason, 'JavaScript package');
  assert.equal(by['grenzer'].notProject, false);
  assert.equal((await S.getProject(OWNER, 'ansi-v0-0-0-20230315-abcdef')).notProject, true);
  // Hidden from recall like an archived project.
  const archived = await S.archivedProjects(OWNER);
  assert.ok(archived.has('bubbletea-v1-3-10') && !archived.has('grenzer'));
  const visible = db.prepare(`SELECT drawer_key AS k FROM memories WHERE user_id = ? AND ${S.NOT_ARCHIVED_SQL}`).all(OWNER).map(r => r.k);
  assert.deepEqual([...new Set(visible)].sort(), ['grenzer']);
  // Lists (All memories, kind:project) leave library memories out; the library's own drawer still opens.
  const T = await load('src/memory/scopes/tree.ts');
  const all = await T.exploreScope(OWNER, { scope: 'company', limit: '50' });
  assert.deepEqual([...new Set(all.items.map(i => i.drawerId))].sort(), ['project:grenzer']);
  const own = await T.exploreScope(OWNER, { scope: 'project:bubbletea-v1-3-10', limit: '50' });
  assert.equal(own.items.length, 1);
  // It's a project: kept, and automatic detection never changes it again.
  const out = await K.setProjectKind(OWNER, 'bubbletea-v1-3-10', 'project', OWNER);
  assert.deepEqual(out, { slug: 'bubbletea-v1-3-10', kind: 'project', before: 'library' });
  assert.equal(await K.classifyLibraryProjects(OWNER, { force: true }), 0);
  assert.equal((await S.getProject(OWNER, 'bubbletea-v1-3-10')).notProject, false);
  // Not a project again (owner choice) and back.
  await K.setProjectKind(OWNER, 'grenzer', 'library', OWNER);
  assert.equal((await S.getProject(OWNER, 'grenzer')).notProject, true);
  await K.setProjectKind(OWNER, 'grenzer', 'project', OWNER);
  await assert.rejects(K.setProjectKind(OWNER, 'nope-unknown', 'project', OWNER), /Unknown project/);
  await assert.rejects(K.setProjectKind(OWNER, 'grenzer', 'maybe', OWNER), /kind must be/);
});

test('id keys (store P3): a memory-only project is still found by its old folder key', async () => {
  const id = '11111111-2222-4333-8444-555555555555';
  db.prepare('INSERT INTO chat_projects (id, user_id, name, slug) VALUES (?, ?, ?, ?)').run(id, OWNER, 'lipgloss-v0-9-1', 'lipgloss-v0-9-1');
  db.prepare("INSERT INTO memory_project_keys (owner_id, slug, project_id, origin) VALUES (?, ?, ?, 'memory_only')").run(OWNER, 'lipgloss-v0-9-1', id);
  addMemory(id, 'Lipgloss styles');
  K.resetProjectKindCache();
  await K.classifyLibraryProjects(OWNER, { force: true });
  const p = (await S.listProjects(OWNER)).find(x => x.slug === id || x.chatProjectId === id);
  assert.equal(p.memoryOnly, true);
  assert.equal(p.notProject, true);
  assert.equal(p.notProjectReason, 'Go library');
  // It's a project, then Undo (Not a project): the reason comes from its name, not the id key.
  await K.setProjectKind(OWNER, id, 'project', OWNER);
  await K.setProjectKind(OWNER, id, 'library', OWNER);
  assert.equal((await S.getProject(OWNER, id)).notProjectReason, 'Go library');
});

test('a chat project is always a project', async () => {
  const project = await createProject(OWNER, { name: 'tool-v1-2-3' });
  const key = projectKeyOf(project);
  addMemory(key, 'my own tool');
  K.resetProjectKindCache();
  await K.classifyLibraryProjects(OWNER, { force: true });
  assert.equal((await S.getProject(OWNER, key)).notProject, false);
  await assert.rejects(K.setProjectKind(OWNER, key, 'library', OWNER), /chat project/);
});
