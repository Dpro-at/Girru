// STORE-MAP-01 P5: an agent's MEMORY.md becomes its own drawer; agent packages (untrusted import).
//  - switch off: nothing changes (the file is read; no import; no package routes);
//  - switch on: MEMORY.md and its .memory-versions history are imported once (CX1); prompts read the drawer;
//    the owner saves over the version read; a file changed outside Girru is never overwritten;
//    no search and no owner list ever returns an agent's notes;
//  - packages: export → preview → import round trip; permissions, hooks, memory and secrets never come in;
//    names, sizes, hashes and the schema version are checked; nothing is fetched, online or offline.
// Run: node --import tsx --test test/store-p5.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-p5-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.GIRRU_STORE_P5 = '0'; process.env.GIRRU_STORE_P4 = '0';
let fetches = 0;
const offline = async (url) => { fetches++; throw new Error(`offline: ${url}`); };
globalThis.fetch = offline;
console.log = () => {}; console.info = () => {}; console.warn = () => {};

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const O = 'p5-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(O, 'p5@example.test', O);
db.prepare(`INSERT INTO agents_config (id, name, provider, model, system_prompt) VALUES ('p5-noor', 'Noor', 'ollama', 'm', 'Answer in short lines.')`).run();

const files = await import(join(backendDir, 'src/services/agent-files.ts'));
const drawer = await import(join(backendDir, 'src/memory/agent-drawer.ts'));
const pack = await import(join(backendDir, 'src/services/agent-package.ts'));
const library = await import(join(backendDir, 'src/services/agent-file-library.ts'));
const { getMemoryStorage } = await import(join(backendDir, 'src/memory/storage.ts'));
const { memoryDisplayPage } = await import(join(backendDir, 'src/memory/display-page.ts'));
const count = (s, ...a) => db.prepare(s).get(...a).n;
const memFile = (id) => readFileSync(join(dir, '.data', 'agents', id, 'MEMORY.md'), 'utf8');

test('switch off: the file is read and nothing is imported', async () => {
  await files.initializeAgentDir('p5-noor');
  const first = await files.readMemorySnapshot('p5-noor');
  const v1 = await files.writeMemoryCAS('p5-noor', '# Notes\nThe owner likes short answers.', first.hash);
  await files.writeMemoryCAS('p5-noor', '# Notes\nThe owner likes short answers.\nRelease on Fridays.', v1.hash);
  assert.match(await drawer.agentMemoryForPrompt('p5-noor'), /Release on Fridays/);
  assert.equal(await drawer.importAgentMemory('p5-noor'), false);
  assert.equal(count("SELECT COUNT(*) AS n FROM memories WHERE drawer_kind = 'agent'"), 0);
});

let notes;
test('switch on: MEMORY.md and its history are imported once into the agent drawer', async () => {
  process.env.GIRRU_STORE_P5 = '1';
  const n = await drawer.importAllAgentMemory();
  assert.ok(n >= 1);
  assert.equal(await drawer.importAgentMemory('p5-noor'), false, 'once');
  assert.equal(await drawer.agentsWithoutImportedMemory(), 0);
  const rows = db.prepare("SELECT id, user_id, drawer_key, source, trust FROM memories WHERE drawer_kind = 'agent' AND drawer_key = 'p5-noor'").all();
  assert.equal(rows.length, 1); assert.equal(rows[0].user_id, O); assert.equal(rows[0].trust, 'imported');
  const history = db.prepare('SELECT change, content FROM memory_versions WHERE memory_id = ? ORDER BY version').all(rows[0].id);
  assert.deepEqual(history.map((h) => h.change), ['baseline', 'update', 'update'], 'template, first save, second save');
  assert.match(history[0].content, /Agent Memory/); assert.match(history[2].content, /Release on Fridays/);
  notes = await drawer.agentNotes('p5-noor');
  assert.match(notes.content, /Release on Fridays/);
  assert.match(await drawer.agentMemoryForPrompt('p5-noor'), /Release on Fridays/);
  const status = await drawer.agentMemoryStatus('p5-noor');
  assert.deepEqual(status, { imported: true, versions: 3, outsideChange: false });
});

test('the owner saves over the version read; the file is written from the drawer', async () => {
  const saved = await drawer.saveAgentNotes('p5-noor', `${notes.content}\nNever deploy on Sunday.`, notes.hash, O);
  assert.match(memFile('p5-noor'), /Never deploy on Sunday/);
  await assert.rejects(drawer.saveAgentNotes('p5-noor', 'x', notes.hash, O), drawer.AgentMemoryConflict);
  const hidden = await drawer.saveAgentNotes('p5-noor', 'password = "fictional-secret-12345678901234567890"', saved.hash, O);
  assert.equal(hidden.redacted, true); assert.doesNotMatch(hidden.content, /fictional-secret/);
  // Files › What it keeps in mind reads and saves the drawer too.
  const mind = await library.readFile('p5-noor', 'MEMORY.md');
  assert.equal(mind.hash, hidden.hash);
  await library.saveFile('p5-noor', 'MEMORY.md', '# Notes\nBack to plain notes.', mind.hash);
  assert.equal((await drawer.agentNotes('p5-noor')).content, '# Notes\nBack to plain notes.');
});

test('a MEMORY.md changed outside Girru is never overwritten', async () => {
  writeFileSync(join(dir, '.data', 'agents', 'p5-noor', 'MEMORY.md'), 'Edited by a coding app.', { mode: 0o600 });
  assert.equal((await drawer.agentMemoryStatus('p5-noor')).outsideChange, true);
  assert.equal(await drawer.writeAgentNotesView('p5-noor'), 'outside_change');
  assert.equal(memFile('p5-noor'), 'Edited by a coding app.');
  assert.equal(await drawer.agentMemoryForPrompt('p5-noor'), '# Notes\nBack to plain notes.', 'the prompt keeps the drawer');
});

test('an agent’s notes never come back from a search or the owner’s memory list', async () => {
  const storage = getMemoryStorage();
  db.prepare(`INSERT INTO memories (id, user_id, type, content, embedding, memory_layer, status, metadata, importance_score, created_at, drawer_kind, drawer_key) VALUES ('p5-own', ?, 'fact', 'Owner keeps plain notes in a notebook.', '[]', 'factual', 'active', '{}', 0.5, ?, 'owner', '')`).run(O, new Date().toISOString());
  const found = await storage.search({ userId: O, query: 'plain notes', limit: 20 });
  assert.ok(found.some((r) => r.memory?.id === 'p5-own'), 'the owner memory is found');
  assert.equal(found.filter((r) => /Back to plain notes/.test(r.memory?.content ?? '')).length, 0, 'the agent notes are not');
  const page = await memoryDisplayPage(O);
  assert.ok(page.memories.some((m) => m.id === 'p5-own'));
  assert.equal(page.memories.filter((m) => /Back to plain notes/.test(m.content)).length, 0);
});

let exported;
test('export: one JSON package with its schema version and hash; no memory, no permissions', async () => {
  await library.addFile('p5-noor', 'release-checklist.md', '# Checklist\n1. Tests green', true);
  exported = await pack.exportAgentPackage('p5-noor');
  assert.equal(exported.format, 'girru.agent'); assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.packageHash, pack.packageHashOf(exported));
  assert.equal(exported.instructions, 'Answer in short lines.');
  assert.deepEqual(exported.knowledge.map((k) => k.name), ['release-checklist.md']);
  const text = JSON.stringify(exported);
  for (const word of ['plain notes', 'Back to plain', 'memory_read', 'grants', 'api_key']) assert.ok(!text.includes(word), word);
});

test('preview of an untrusted package: refused fields, names, secrets, versions and hashes', async () => {
  const hostile = { ...exported, permissions: { memoryRead: ['owner'] }, hooks: { postinstall: 'rm -rf /' }, memory: 'private', agent: { ...exported.agent, apiKey: 'x' },
    knowledge: [...exported.knowledge, { name: '../escape.md', content: 'x' }, { name: 'link.md', content: 'x', symlink: '/etc/passwd' }] };
  delete hostile.packageHash;
  const plan = await pack.planAgentPackage(hostile);
  const fields = plan.refused.map((r) => r.field);
  for (const f of ['permissions', 'hooks', 'memory', 'agent.apiKey', 'knowledge:../escape.md', 'knowledge:link.md']) assert.ok(fields.includes(f), f);
  assert.deepEqual(plan.knowledge.map((k) => k.name), ['release-checklist.md']);
  await assert.rejects(pack.planAgentPackage({ ...hostile, instructions: 'token: ghp_0123456789abcdefghijklmnopqrstuvwxyz0123' }), (e) => e.code === 'secret_found');
  await assert.rejects(pack.planAgentPackage({ ...exported, schemaVersion: 2 }), (e) => e.code === 'newer_package');
  await assert.rejects(pack.planAgentPackage({ ...exported, instructions: 'changed after export' }), (e) => e.code === 'hash_mismatch');
  await assert.rejects(pack.planAgentPackage({ format: 'other' }), (e) => e.code === 'not_an_agent_package');
  await assert.rejects(pack.planAgentPackage('x'.repeat(pack.MAX_PACKAGE_BYTES + 1)), (e) => e.code === 'too_large');
});

test('import offline: a new agent with safe default permissions, its knowledge and its instructions; once', async () => {
  fetches = 0; globalThis.fetch = offline;
  const plan = await pack.planAgentPackage({ ...exported, permissions: { memoryRead: ['owner', 'project', 'people'] } , packageHash: undefined });
  const { agentId } = await pack.importAgentPackage({ ...exported, permissions: { memoryRead: ['owner', 'project', 'people'] }, packageHash: undefined }, O, { expectedPackageHash: plan.packageHash });
  assert.notEqual(agentId, 'p5-noor');
  const row = db.prepare('SELECT name, system_prompt FROM agents_config WHERE id = ?').get(agentId);
  assert.equal(row.system_prompt, 'Answer in short lines.'); assert.notEqual(row.name, 'Noor', 'a new name: Noor is taken');
  const perms = db.prepare('SELECT memory_read FROM agent_permissions WHERE agent_id = ?').get(agentId);
  assert.ok(!JSON.parse(perms.memory_read).includes('people'), 'permissions never imported');
  assert.equal(count("SELECT COUNT(*) AS n FROM memories WHERE drawer_kind = 'agent' AND drawer_key = ?", agentId), 0, 'no private notes come in');
  assert.match((await library.readFile(agentId, 'release-checklist.md')).content, /Tests green/);
  assert.equal(count('SELECT COUNT(*) AS n FROM agent_package_imports WHERE agent_id = ?', agentId), 1);
  await assert.rejects(pack.importAgentPackage({ ...exported, permissions: { memoryRead: ['owner', 'project', 'people'] }, packageHash: undefined }, O, { expectedPackageHash: plan.packageHash }), (e) => e.code === 'already_imported');
  await assert.rejects(pack.importAgentPackage(exported, O, { expectedPackageHash: 'f'.repeat(64) }), (e) => e.code === 'preview_changed');
  assert.equal(fetches, 0, 'nothing fetched');
});

test('import online: still nothing is fetched; a dependency this computer lacks is listed, not downloaded', async () => {
  fetches = 0; globalThis.fetch = async () => { fetches++; return new Response('{}'); };
  const pkg = { ...exported, specialties: [{ id: 'x', name: 'Rare specialty', revision: 1, contentHash: 'a'.repeat(64) }], packageHash: undefined };
  const plan = await pack.planAgentPackage(pkg);
  assert.deepEqual(plan.missing, [{ kind: 'specialty', name: 'Rare specialty' }]);
  const { agentId } = await pack.importAgentPackage(pkg, O, { expectedPackageHash: plan.packageHash, again: true });
  assert.equal(count('SELECT COUNT(*) AS n FROM agent_specialties WHERE agent_id = ?', agentId), 0);
  assert.equal(fetches, 0, 'nothing fetched');
  globalThis.fetch = offline;
});

test('with the personality record on, the import carries the text into version 1 of the new record', async () => {
  process.env.GIRRU_STORE_P4 = '1';
  const pkg = { ...exported, personality: { ...exported.personality, text: 'Calm and exact.' }, packageHash: undefined };
  const plan = await pack.planAgentPackage(pkg);
  const { agentId } = await pack.importAgentPackage(pkg, O, { expectedPackageHash: plan.packageHash, again: true });
  const { recordText } = await import(join(backendDir, 'src/services/personality-record.ts'));
  assert.equal((await recordText(agentId)).text, 'Calm and exact.');
  process.env.GIRRU_STORE_P4 = '0';
});

test('switch off again: the prompt reads the file', async () => {
  process.env.GIRRU_STORE_P5 = '0';
  assert.equal(await drawer.agentMemoryForPrompt('p5-noor'), 'Edited by a coding app.');
});

test('security: an agent’s notes are never opened by id through the shared memory paths', async () => {
  process.env.GIRRU_STORE_P5 = '1';
  const id = db.prepare("SELECT id FROM memories WHERE drawer_kind = 'agent' AND drawer_key = 'p5-noor'").get().id;
  const storage = getMemoryStorage();
  assert.equal(await storage.get(id), null);
  assert.equal(await storage.getOwned(O, id), null);
  process.env.GIRRU_STORE_P5 = '0';
});

test('P5a/P5b screens: history of the notes; MEMORY.md changed outside Girru waits for the owner (Use it / Keep Girru’s)', async () => {
  process.env.GIRRU_STORE_P5 = '0';
  assert.equal(await drawer.agentNotesHistory('p5-noor'), null, 'off: no history route');
  assert.equal(await drawer.agentNotesOutside('p5-noor'), null);
  process.env.GIRRU_STORE_P5 = '1';
  const history = await drawer.agentNotesHistory('p5-noor');
  assert.ok(history.length >= 2 && history[0].version > history[1].version, 'newest first');
  // 'Edited by a coding app.' is on disk and differs from what Girru wrote.
  let out = await drawer.agentNotesOutside('p5-noor');
  assert.ok(out && out.file === 'Edited by a coding app.' && out.notes !== out.file);
  await assert.rejects(drawer.settleAgentNotesOutside('p5-noor', 'use', 'a'.repeat(64), O), /changed/);
  await assert.rejects(drawer.settleAgentNotesOutside('p5-noor', 'merge', out.fileHash, O), drawer.AgentMemoryInputError);
  const kept = out.notes;
  const r = await drawer.settleAgentNotesOutside('p5-noor', 'keep', out.fileHash, O);
  assert.equal(r.hash, r.previousHash);
  assert.equal(memFile('p5-noor'), kept, 'Keep Girru’s writes the file back');
  assert.equal(await drawer.agentNotesOutside('p5-noor'), null);
  assert.equal((await drawer.agentMemoryStatus('p5-noor')).outsideChange, false);
  writeFileSync(join(dir, '.data', 'agents', 'p5-noor', 'MEMORY.md'), 'Written by hand. token=sk-live-abcdefghijklmnopqrstuvwx');
  out = await drawer.agentNotesOutside('p5-noor');
  const before = (await drawer.agentNotesHistory('p5-noor')).length;
  const used = await drawer.settleAgentNotesOutside('p5-noor', 'use', out.fileHash, O);
  const now = await drawer.agentNotes('p5-noor');
  assert.equal(now.hash, used.hash);
  assert.match(now.content, /^Written by hand\./);
  assert.doesNotMatch(now.content, /sk-live-abcdefghijklmnopqrstuvwx/, 'secrets hidden');
  assert.equal((await drawer.agentNotesHistory('p5-noor')).length, before + 1, 'one new version (Undo = the one before)');
  assert.equal((await drawer.agentMemoryStatus('p5-noor')).outsideChange, false);
  process.env.GIRRU_STORE_P5 = '0';
});

test('the Memory window scope lists never show an agent’s own notes (they have their own row on the agent page)', async () => {
  process.env.GIRRU_STORE_P5 = '1';
  const { exploreScope, scopeTree } = await import(join(backendDir, 'src/memory/scopes/tree.ts'));
  for (const scope of ['company', 'agent:p5-noor']) {
    const page = await exploreScope(O, { scope });
    assert.ok(!page.items.some((i) => String(i.drawerId).startsWith('agent')), `${scope}: no agent drawer rows`);
  }
  const tree = await scopeTree(O, { fresh: true });
  assert.doesNotMatch(JSON.stringify(tree), /"agent:p5-noor"/);
  process.env.GIRRU_STORE_P5 = '0';
});

test('an older 0755 agents folder is tightened to 0700 and its notes are imported; a folder others can write to is refused', { skip: process.platform === 'win32' }, async () => {
  const { chmodSync, statSync, mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
  process.env.GIRRU_STORE_P5 = '1';
  db.prepare(`INSERT INTO agents_config (id, name, provider, model, system_prompt) VALUES ('p5-old', 'Old', 'ollama', 'm', 'x')`).run();
  const agents = join(dir, '.data', 'agents');
  mk(join(agents, 'p5-old'), { recursive: true, mode: 0o700 });
  wf(join(agents, 'p5-old', 'MEMORY.md'), 'Kept from an older install.', { mode: 0o600 });
  chmodSync(agents, 0o775);
  assert.equal(await drawer.importAgentMemory('p5-old'), false, 'group-writable: refused');
  assert.equal(statSync(agents).mode & 0o777, 0o775, 'and left as it was');
  chmodSync(agents, 0o755);
  assert.equal(await drawer.importAgentMemory('p5-old'), true);
  assert.equal(statSync(agents).mode & 0o777, 0o700);
  assert.match((await drawer.agentNotes('p5-old')).content, /Kept from an older install/);
});
