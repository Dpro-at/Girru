// STORE-MAP-01 P7 (GIRRU_STORE_P7): the project folder layout with a preview.
//  - the dry run writes nothing and lists AGENTS.md (one Girru section with brief, rules and the task
//    pointer), CLAUDE.md / GEMINI.md pointers, .girru/rules.md, .girru/tasks.md and the Git exclude list;
//  - apply needs confirm + the preview hash; a stale hash or a conflict (a linked file) writes nothing
//    and leaves the switches as they were;
//  - apply turns the project's files on with the task file in one step (no separate Rules step), the
//    files match the preview, and a second preview shows nothing left to change;
//  - an existing task file is the owner's and is kept byte for byte;
//  - the routes exist only with the switch on; the layout needs the one Girru section (P2).
// Run: node --import tsx --test test/store-p7-layout.test.mjs
// Throwaway DB + cwd, random test-only secrets, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const backendDir = process.cwd();
const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p7-layout-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['GIRRU_STORE_P2', 'GIRRU_STORE_P6', 'GIRRU_STORE_P7', 'GIRRU_STORE_PILOT', 'AGENT_PLAYER_DATA_DIR']) delete process.env[k];
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await load('src/db/database.ts');
const { projectKeyOf } = await load('src/memory/project-keys.ts');
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await load('src/credentials/storage.ts');
await getCredentialStorage().initialize();
const OWNER = 'p7-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, `${OWNER}@example.test`, OWNER);
const { createProject } = await load('src/repositories/chat-conversations.ts');
const { createRule } = await load('src/services/agent-rules.ts');
const { setBridgeEnv } = await load('src/memory/bridge/service.ts');
const { folderSettings } = await load('src/memory/bridge/store.ts');
const { layoutPreview, layoutApply } = await load('src/memory/bridge/layout.ts');
const { taskFileOn } = await load('src/services/task-file.ts');
const { newMemory, saveVersioned } = await load('src/memory/learning.ts');
setBridgeEnv({ home: dir, env: {} });

const on = async (fn, extra = {}) => {
  const keys = { GIRRU_STORE_P2: '1', GIRRU_STORE_P7: '1', ...extra };
  for (const [k, v] of Object.entries(keys)) process.env[k] = v;
  try { return await fn(); } finally { for (const k of Object.keys(keys)) delete process.env[k]; }
};
async function makeProject(name) {
  const folder = join(dir, name);
  mkdirSync(join(folder, '.git', 'info'), { recursive: true });
  const project = await createProject(OWNER, { name, folder });
  await createRule({ text: `In ${name}, release only on Tuesdays.`, when: null, projectId: project.id, who: 'all', targets: [], paused: false }, OWNER);
  await saveVersioned(newMemory(OWNER, { kind: 'project', key: projectKeyOf(project) }, { type: 'fact', importance: 7, content: `${name} deploys with scripts/release.sh.` }, {}), 'test', 'test');
  return { project, folder };
}
const listing = (folder) => readdirSync(folder).sort();

test('switches: the layout needs P7 and the one Girru section', async () => {
  const { project } = await makeProject('Gate');
  await assert.rejects(layoutPreview(OWNER, project.id), (e) => e.code === 'p7_off' && e.status === 409);
  process.env.GIRRU_STORE_P7 = '1';
  try { await assert.rejects(layoutPreview(OWNER, project.id), (e) => e.code === 'p2_off'); } finally { delete process.env.GIRRU_STORE_P7; }
  await on(async () => {
    await assert.rejects(layoutPreview('someone-else', project.id), (e) => e.status === 404);
    await assert.rejects(layoutPreview(OWNER, 'nope'), (e) => e.status === 404);
  });
});

test('dry run writes nothing and lists every file of the layout', async () => {
  const { project, folder } = await makeProject('Alpha');
  const before = listing(folder);
  const p = await on(() => layoutPreview(OWNER, project.id));
  assert.deepEqual(listing(folder), before, 'nothing written by the preview');
  const byName = Object.fromEntries(p.files.map((f) => [f.relative, f]));
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.girru/rules.md', '.girru/tasks.md', '.git/info/exclude']) assert.equal(byName[f]?.action, 'create', f);
  assert.equal(p.conflicts, 0);
  assert.equal(p.changes, p.files.length);
  assert.match(byName['AGENTS.md'].diff, /Alpha deploys with scripts\/release\.sh/);
  assert.match(byName['AGENTS.md'].diff, /In Alpha, release only on Tuesdays/);
  assert.match(byName['AGENTS.md'].diff, /\.girru\/tasks\.md/);
  assert.match(byName['AGENTS.md'].diff, /Before you start, read \.girru\/tasks\.md/, 'the task rule the write adds is shown');
  assert.equal(byName['.girru/brief.md'], undefined, 'brief sync only with P6');
  const p6 = await on(() => layoutPreview(OWNER, project.id), { GIRRU_STORE_P6: '1' });
  assert.equal(p6.files.find((f) => f.relative === '.girru/brief.md')?.by, 'brief-sync');
});

test('apply: confirm and a fresh hash; then the files match the preview and the task file is on', async () => {
  const { project, folder } = await makeProject('Beta');
  const p = await on(() => layoutPreview(OWNER, project.id));
  await assert.rejects(on(() => layoutApply(OWNER, project.id, { previewHash: p.previewHash })), (e) => e.code === 'confirm_required');
  await assert.rejects(on(() => layoutApply(OWNER, project.id, { previewHash: 'x'.repeat(64), confirm: true })), (e) => e.code === 'preview_stale');
  assert.equal(existsSync(join(folder, 'AGENTS.md')), false);
  assert.equal(await taskFileOn(project.id), false);

  const r = await on(() => layoutApply(OWNER, project.id, { previewHash: p.previewHash, confirm: true }));
  assert.equal(r.changes, 0, 'nothing left to change after the write');
  assert.ok(r.files.every((f) => f.action === 'unchanged'), JSON.stringify(r.files.filter((f) => f.action !== 'unchanged')));
  const agents = readFileSync(join(folder, 'AGENTS.md'), 'utf8');
  assert.equal((agents.match(/<!-- girru:start/g) ?? []).length, 1);
  assert.match(agents, /Beta deploys with scripts\/release\.sh/);
  assert.match(agents, /In Beta, release only on Tuesdays/);
  assert.match(readFileSync(join(folder, 'CLAUDE.md'), 'utf8'), /@AGENTS\.md/);
  assert.match(readFileSync(join(folder, '.girru', 'tasks.md'), 'utf8'), /^# /);
  assert.match(readFileSync(join(folder, '.git', 'info', 'exclude'), 'utf8'), /\/AGENTS\.md/);
  assert.equal(await taskFileOn(project.id), true, 'the task file is on with the project files');
  assert.equal((await folderSettings(OWNER, project.id)).filesEnabled, true);
});

test('with the brief sync on (P6), apply writes .girru/brief.md and nothing is left to change', async () => {
  const { project, folder } = await makeProject('Zeta');
  const p6 = { GIRRU_STORE_P6: '1' };
  const p = await on(() => layoutPreview(OWNER, project.id), p6);
  assert.equal(p.files.find((f) => f.relative === '.girru/brief.md').action, 'create');
  const r = await on(() => layoutApply(OWNER, project.id, { previewHash: p.previewHash, confirm: true }), p6);
  assert.equal(r.changes, 0, JSON.stringify(r.files.filter((f) => f.action !== 'unchanged')));
  assert.match(readFileSync(join(folder, '.girru', 'brief.md'), 'utf8'), /Zeta deploys with scripts\/release\.sh/);
});

test('an existing task file is kept byte for byte', async () => {
  const { project, folder } = await makeProject('Gamma');
  mkdirSync(join(folder, '.girru'));
  const mine = '# Tasks\n\n## T-1 · My own task\n\nState: Doing\n';
  writeFileSync(join(folder, '.girru', 'tasks.md'), mine);
  const p = await on(() => layoutPreview(OWNER, project.id));
  assert.equal(p.files.find((f) => f.relative === '.girru/tasks.md').action, 'unchanged');
  await on(() => layoutApply(OWNER, project.id, { previewHash: p.previewHash, confirm: true }));
  assert.equal(readFileSync(join(folder, '.girru', 'tasks.md'), 'utf8'), mine);
});

test('a conflict (a linked file) writes nothing and leaves the switches as they were', { skip: process.platform === 'win32' && 'symlinks need rights on Windows' }, async () => {
  const { project, folder } = await makeProject('Delta');
  const outside = join(dir, 'outside-delta');
  mkdirSync(outside);
  writeFileSync(join(outside, 'x.md'), 'keep');
  symlinkSync(join(outside, 'x.md'), join(folder, 'GEMINI.md'));
  const p = await on(() => layoutPreview(OWNER, project.id));
  assert.equal(p.conflicts, 1);
  await assert.rejects(on(() => layoutApply(OWNER, project.id, { previewHash: p.previewHash, confirm: true })), (e) => e.code === 'conflict');
  assert.equal(existsSync(join(folder, 'AGENTS.md')), false);
  assert.equal(readFileSync(join(outside, 'x.md'), 'utf8'), 'keep');
  assert.equal(await taskFileOn(project.id), false);
  assert.equal((await folderSettings(OWNER, project.id)).filesEnabled, false);
});

test('routes: only with the switch on, owner only', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerAuthGate } = await load('src/auth/auth-gate.ts');
  const { memoryBridgeRoutes } = await load('src/api/routes/memory-bridge.ts');
  const { generateToken } = await load('src/auth/jwt.ts');
  const { project } = await makeProject('Epsilon');
  const auth = { authorization: `Bearer ${generateToken(OWNER, 1)}` };
  const server = async () => { const app = Fastify(); registerAuthGate(app); await app.register(memoryBridgeRoutes); await app.ready(); return app; };
  const url = `/api/memory-bridge/projects/${project.id}/layout`;
  const off = await server();
  try { assert.equal((await off.inject({ method: 'GET', url, headers: auth })).statusCode, 404); } finally { await off.close(); }
  await on(async () => {
    const app = await server();
    try {
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
      const r = await app.inject({ method: 'GET', url, headers: auth });
      assert.equal(r.statusCode, 200, r.body);
      const preview = JSON.parse(r.body).preview;
      assert.ok(preview.files.length >= 5);
      const w = await app.inject({ method: 'POST', url, headers: auth, payload: { previewHash: preview.previewHash, confirm: true } });
      assert.equal(w.statusCode, 200, w.body);
      assert.equal(JSON.parse(w.body).result.changes, 0);
    } finally { await app.close(); }
  });
});
