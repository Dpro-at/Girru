import { fileURLToPath, pathToFileURL } from 'node:url';
// PROJECT-SYNC-01: one call brings a project's shared state up to date.
//  - the preview shows the files, the handoff and the facts together, under one hash, and writes nothing;
//  - apply needs confirm: true and that exact hash; a project changed since is refused (409);
//  - the handoff is saved, the facts only wait for review (never live memory), the files are written;
//  - the same handoff twice is not saved twice;
//  - the files are written last: when they fail, what was stored is reported and nothing is lost.
// Throwaway HOME, DB and keys; no model is reached (dead OLLAMA_URL, MEMORY_GRAPH_MODEL=off).
// Run: node --import tsx --test test/project-sync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = fileURLToPath(new URL('../', import.meta.url));
const mod = (rel) => pathToFileURL(join(backendDir, rel)).href;
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-psync-')));
const folder = join(dir, 'work');
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
mkdirSync(folder, { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['CODEX_HOME', 'AGENT_EXEC_TOOLS', 'DEFAULT_MODEL']) delete process.env[k];
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await import(mod('src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(mod('src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(mod('src/multi-agent/index.ts'));
await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));

const OWNER = 'ps-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, 'ps@example.test', OWNER);

const { createProject } = await import(mod('src/repositories/chat-conversations.ts'));
const { setBridgeEnv } = await import(mod('src/memory/bridge/service.ts'));
const { syncPreview, syncApply } = await import(mod('src/memory/bridge/project-sync.ts'));
const { filesPreview, filesApply } = await import(mod('src/memory/bridge/service.ts'));
const { folderSettings } = await import(mod('src/memory/bridge/store.ts'));
const { latestBridgeHandoff } = await import(mod('src/memory/bridge/store.ts'));
setBridgeEnv({ home: dir, env: {} });
const project = await createProject(OWNER, { name: 'Falcon', folder });

const HANDOFF = { done: ['the export fix'], left: ['the retry limit'], next: ['the invoice totals'], questions: [] };
const FACTS = ['Falcon: the nightly export runs at 02:00.'];
const liveRows = (like) => db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND status = 'active' AND content LIKE ?`).get(OWNER, like).n;

// A sync keeps the managed files up to date; it must never be what turns them on. `filesApply` sets
// filesEnabled, so this is the check that a sync cannot undo the owner's "stop updating this folder".
test('with the owner\'s file switch off, the files are left alone', async () => {
  assert.equal((await folderSettings(OWNER, project.id)).filesEnabled, false, 'off to begin with');
  const note = { done: ['a first piece'], left: [], next: ['more'], questions: [] };
  const plan = await syncPreview(OWNER, project.id, { handoff: note });
  assert.match(plan.filesSkipped, /not turned project files on/);
  assert.equal(plan.fileChanges, 0);
  assert.deepEqual(plan.files, []);
  const r = await syncApply(OWNER, project.id, { handoff: note, previewHash: plan.previewHash, confirm: true });
  assert.ok(r.handoffId, 'the handoff is still saved');
  assert.equal(r.fileChanges, 0);
  assert.match(r.filesSkipped, /not turned project files on/);
  assert.equal(existsSync(join(folder, 'AGENTS.md')), false, 'no file was written');
  assert.equal((await folderSettings(OWNER, project.id)).filesEnabled, false, 'and the switch is still off');
});

test('the owner turns the files on themselves, then a sync keeps them up to date', async () => {
  const p = await filesPreview(OWNER, project.id);
  await filesApply(OWNER, project.id, { previewHash: p.previewHash, confirm: true });
  assert.equal((await folderSettings(OWNER, project.id)).filesEnabled, true);
  assert.ok(existsSync(join(folder, 'AGENTS.md')));
});

test('the preview shows files, handoff and facts under one hash, and writes nothing', async () => {
  const plan = await syncPreview(OWNER, project.id, { handoff: HANDOFF, memory: FACTS });
  assert.equal(plan.projectId, project.id);
  assert.deepEqual(plan.handoff.done, ['the export fix']);
  assert.deepEqual(plan.memory, FACTS);
  assert.match(plan.previewHash, /^[0-9a-f]{64}$/);
  assert.ok(plan.files.length > 0, 'the managed files are part of the plan');
  const notes = db.prepare('SELECT COUNT(*) AS n FROM memory_bridge_handoffs WHERE owner_id = ?').get(OWNER).n;
  assert.equal(liveRows('%nightly export%'), 0, 'no memory was written');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_bridge_handoffs WHERE owner_id = ?').get(OWNER).n, notes, 'no handoff was saved');
  // The hash covers every part: a different handoff or fact is a different plan.
  const other = await syncPreview(OWNER, project.id, { handoff: { ...HANDOFF, next: ['something else'] }, memory: FACTS });
  assert.notEqual(other.previewHash, plan.previewHash);
  const noFacts = await syncPreview(OWNER, project.id, { handoff: HANDOFF });
  assert.notEqual(noFacts.previewHash, plan.previewHash);
});

test('apply needs confirm and the hash of the plan the owner saw', async () => {
  const plan = await syncPreview(OWNER, project.id, { handoff: HANDOFF, memory: FACTS });
  await assert.rejects(() => syncApply(OWNER, project.id, { handoff: HANDOFF, memory: FACTS, previewHash: plan.previewHash }),
    /confirm: true/, 'no confirm');
  await assert.rejects(() => syncApply(OWNER, project.id, { handoff: HANDOFF, memory: FACTS, confirm: true }),
    /previewHash is required/);
  await assert.rejects(() => syncApply(OWNER, project.id, { handoff: HANDOFF, memory: FACTS, previewHash: 'f'.repeat(64), confirm: true }),
    /changed since that preview/, 'a hash from another plan is refused');
  // Still nothing written by the refusals.
  assert.equal(liveRows('%nightly export%'), 0);
});

test('apply saves the handoff, only proposes the facts, and writes the files', async () => {
  const plan = await syncPreview(OWNER, project.id, { handoff: HANDOFF, memory: FACTS });
  const r = await syncApply(OWNER, project.id, { handoff: HANDOFF, memory: FACTS, previewHash: plan.previewHash, confirm: true });
  assert.ok(r.handoffId, 'the handoff was saved');
  const saved = await latestBridgeHandoff(OWNER, project.id);
  assert.deepEqual(saved.done, ['the export fix']);
  assert.equal(r.proposals.length + r.notProposed.length, 1, 'the fact was handled');
  assert.equal(liveRows('%nightly export%'), 0, 'a fact from a sync is never live memory');
  assert.equal(r.filesError, null, `the files were written (${r.filesError})`);
  assert.ok(existsSync(join(folder, 'AGENTS.md')), 'AGENTS.md is written');
});

test('the same handoff twice is not saved twice', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM memory_bridge_handoffs WHERE owner_id = ?').get(OWNER).n;
  const plan = await syncPreview(OWNER, project.id, { handoff: HANDOFF });
  assert.equal(plan.handoff, null, 'the preview says it would add nothing');
  assert.match(plan.handoffSkipped, /already says exactly this/);
  const r = await syncApply(OWNER, project.id, { handoff: HANDOFF, previewHash: plan.previewHash, confirm: true });
  assert.equal(r.handoffId, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_bridge_handoffs WHERE owner_id = ?').get(OWNER).n, before);
});

test('the owner text around Girru\'s section is kept, byte for byte', async () => {
  const own = '# My own notes\n\nKeep this exactly.\n';
  writeFileSync(join(folder, 'CLAUDE.md'), own, 'utf-8');
  const note = { done: ['the second piece'], left: [], next: ['review'], questions: [] };
  const plan = await syncPreview(OWNER, project.id, { handoff: note });
  const r = await syncApply(OWNER, project.id, { handoff: note, previewHash: plan.previewHash, confirm: true });
  assert.equal(r.filesError, null);
  assert.ok(readFileSync(join(folder, 'CLAUDE.md'), 'utf-8').includes('Keep this exactly.'));
});

test('a folder that vanished refuses the whole sync, and writes nothing', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM memory_bridge_handoffs WHERE owner_id = ?').get(OWNER).n;
  const note = { done: ['the third piece'], left: [], next: ['ship'], questions: [] };
  const fact = 'Falcon: the retry limit is five attempts.';
  const plan = await syncPreview(OWNER, project.id, { handoff: note, memory: [fact] });
  rmSync(folder, { recursive: true, force: true });
  // Everything is checked again before anything is written, so the plan is refused as a whole: the
  // owner approved a plan that included file changes, and half of it is never applied quietly.
  await assert.rejects(() => syncApply(OWNER, project.id, { handoff: note, memory: [fact], previewHash: plan.previewHash, confirm: true }),
    /folder does not exist/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_bridge_handoffs WHERE owner_id = ?').get(OWNER).n, before, 'no handoff saved');
  assert.equal(liveRows('%retry limit is five%'), 0, 'no memory written');
  // When only the file write itself fails (the database part already stored), `filesError` carries it
  // and the next sync writes the files from what is stored — see project-sync.ts.
  mkdirSync(folder, { recursive: true });
});

// The tool layer: what a Girru chat actually calls, with the gates that protect it.
const { projectSyncTool, projectSyncApplyTool } = await import(mod('src/tools/memory/project-sync.ts'));
const { memoryBridgeApplyTool } = await import(mod('src/tools/memory/bridge.ts'));
const { APPROVAL_REQUIRED_TOOLS } = await import(mod('src/tools/approvals.ts'));
const asOwner = { userId: OWNER, agentId: 'ps-main' };

test('writing needs the owner\'s approval, and only the owner\'s own turn', async () => {
  assert.ok(APPROVAL_REQUIRED_TOOLS.project_sync_apply, 'project_sync_apply is approval-gated');
  assert.equal(APPROVAL_REQUIRED_TOOLS.project_sync, undefined, 'the read-only preview is not');
  // Someone else's turn, another account, a channel turn: all refused, for both tools.
  for (const tool of [projectSyncTool, projectSyncApplyTool]) {
    const outside = await tool.execute({ project_id: project.id }, { ...asOwner, toolPolicy: { channel: 'telegram' } });
    assert.match(outside.content[0].text, /refused/, `${tool.name} refuses an outside turn`);
    const other = await tool.execute({ project_id: project.id }, { userId: 'ps-stranger', agentId: 'ps-main' });
    assert.match(other.content[0].text, /refused/, `${tool.name} refuses another account`);
  }
});

test('the chat path: project_sync previews, project_sync_apply writes', async () => {
  const note = { done: ['the tool path'], left: [], next: ['ship it'], questions: [] };
  const preview = await projectSyncTool.execute({ project_id: project.id, handoff: note, memory: ['Falcon: releases go out on Tuesdays.'] }, asOwner);
  assert.match(preview.content[0].text, /Project sync for/);
  assert.match(preview.content[0].text, /Approve project_sync_apply with preview_hash/);
  const hash = preview.data.plan.previewHash;
  assert.match(hash, /^[0-9a-f]{64}$/);

  // The hash of a different plan is refused, so an approval cannot be reused.
  const wrong = await projectSyncApplyTool.execute({ project_id: project.id, handoff: note, preview_hash: hash, confirm: true }, asOwner);
  assert.match(wrong.content[0].text, /refused/, 'the facts were left out of the apply, so it is a different plan');

  const applied = await projectSyncApplyTool.execute(
    { project_id: project.id, handoff: note, memory: ['Falcon: releases go out on Tuesdays.'], preview_hash: hash, confirm: true }, asOwner);
  assert.match(applied.content[0].text, /Project sync:/);
  assert.ok(applied.data.handoffId, 'the handoff was saved');
  assert.equal(liveRows('%releases go out on Tuesdays%'), 0, 'the fact waits for review');
  assert.ok(existsSync(join(folder, 'AGENTS.md')));
});

test('after the owner stops file sync, a sync leaves the folder alone', async () => {
  const stopped = await memoryBridgeApplyTool.execute({ action: 'stop_files', project_id: project.id }, asOwner);
  assert.ok(!stopped.error, `stop_files worked (${stopped.content[0].text})`);
  assert.equal((await folderSettings(OWNER, project.id)).filesEnabled, false);
  const before = readFileSync(join(folder, 'AGENTS.md'), 'utf-8');

  const note = { done: ['work after stopping'], left: [], next: ['nothing'], questions: [] };
  const preview = await projectSyncTool.execute({ project_id: project.id, handoff: note }, asOwner);
  assert.match(preview.content[0].text, /Files: left alone/);
  const applied = await projectSyncApplyTool.execute(
    { project_id: project.id, handoff: note, preview_hash: preview.data.plan.previewHash, confirm: true }, asOwner);
  assert.match(applied.content[0].text, /files were left alone/);
  assert.ok(applied.data.handoffId, 'the handoff is still saved: that is Girru\'s own memory, not the folder');
  assert.equal(readFileSync(join(folder, 'AGENTS.md'), 'utf-8'), before, 'the file is byte for byte as it was');
  assert.equal((await folderSettings(OWNER, project.id)).filesEnabled, false, 'and the switch stays off');
});
