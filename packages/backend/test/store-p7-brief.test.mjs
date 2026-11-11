// STORE-MAP-01 P7 (GIRRU_STORE_P7), A3/M6 and S4:
//  - the brief explains the task file, when to resume with project_brief/latest_handoff and when
//    to call handoff_write, and carries a small topic index (topic keys + graph clusters, stable
//    order, size cap) with the details left to memory_search;
//  - owner, people and personal drawers never reach a project file: the brief only reads the
//    project's drawer, and a brief that holds anything else is refused by both file writers;
//  - G8: Claude Code's own auto memory never reaches a Girru-launched run (it comes back as review proposals only);
//  - P7 off: the brief text is the same as before.
// Run: node --import tsx --test test/store-p7-brief.test.mjs
// Throwaway DB/keys/folders; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { clearEnv } from './helpers/switches.mjs';
const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-store-p7-brief-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
for (const k of ['GIRRU_STORE_P2', 'GIRRU_STORE_P3', 'GIRRU_STORE_P6', 'GIRRU_STORE_P7', 'GIRRU_STORE_PILOT']) clearEnv(k);
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {}; console.log = quiet; console.info = quiet; console.warn = quiet; console.error = quiet;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const OWNER = 'b7-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, 'b7@example.test', 'b7', 'x', 'owner', 'active', 1)`).run(OWNER);
const folder = mkdtempSync(join(dir, 'proj-'));
db.prepare(`INSERT INTO chat_projects (id, user_id, name, slug, folder) VALUES ('p-b7', ?, 'Beta', 'beta', ?)`).run(OWNER, folder);

const brief = await import(join(backendDir, 'src/memory/bridge/brief.ts'));
const { previewFiles, ManagedFileError } = await import(join(backendDir, 'src/memory/bridge/managed-files.ts'));
const { learn } = await import(join(backendDir, 'src/memory/learning.ts'));
const { addPinnedFact } = await import(join(backendDir, 'src/memory/scopes/pinned.ts'));
const { findProject } = await import(join(backendDir, 'src/repositories/chat-conversations.ts'));
const project = await findProject(OWNER, 'p-b7');

const drawer = { kind: 'project', key: 'beta' };
await learn({ userId: OWNER, actor: `owner:${OWNER}`, candidates: [
  { content: 'Beta deploys with scripts/ship.sh on Fridays', type: 'fact', drawer, origin: 'owner', topicKey: 'deploy-flow' },
  { content: 'Beta keeps its API in packages/api', type: 'fact', drawer, origin: 'owner', topicKey: 'api-layout' },
  { content: 'Beta release notes are written in English', type: 'fact', drawer, origin: 'owner' },
] });
// About you, a person and an agent's experience: never in a project file.
await learn({ userId: OWNER, actor: `owner:${OWNER}`, candidates: [
  { content: 'The owner lives in Vienna and prefers tea', type: 'preference', drawer: { kind: 'owner' }, origin: 'owner', topicKey: 'home-city' },
  { content: 'Sara from sales has a private phone number', type: 'fact', drawer: { kind: 'people', key: 'sara' }, origin: 'owner' },
] }).catch(() => {});
await addPinnedFact(OWNER, { kind: 'company', id: 'company' }, 'We review every change.', OWNER);

const withP7 = async (fn) => { process.env.GIRRU_STORE_P7 = '1'; try { return await fn(); } finally { process.env.GIRRU_STORE_P7 = '0'; } };

test('P7 off: no topic index and no work guide; the brief is as before', async () => {
  const b = await brief.projectBrief(OWNER, project);
  assert.equal(b.topics, undefined);
  const md = brief.briefMarkdown(b);
  assert.ok(!md.includes('### Topics in this project'));
  assert.ok(!md.includes('### Working with tasks and handoffs'));
});

test('P7 on: work guide (task format, resume, handoff_write) and a stable topic index', async () => {
  await withP7(async () => {
    const b = await brief.projectBrief(OWNER, project);
    assert.deepEqual(b.topics.filter((t) => t.kind === 'topic').map((t) => t.key), ['api-layout', 'deploy-flow']);
    const md = brief.briefMarkdown(b);
    assert.match(md, /### Working with tasks and handoffs/);
    assert.match(md, /\.girru\/tasks\.md/);
    assert.match(md, /## T-<number> · <title>/);
    assert.match(md, /call `project_brief` and `latest_handoff` first/);
    assert.match(md, /Call `handoff_write` when you stop/);
    assert.match(md, /### Topics in this project's memory\nTitles only\. Get the details with `memory_search` and the topic\.\n- api-layout\n- deploy-flow/);
    // Titles only: the memory text itself is in the memory list, not the index; the owner's topic never shows.
    assert.ok(!md.includes('home-city') && !md.includes('Vienna') && !md.includes('Sara'));
    // Stable: the same data gives the same text (prompt caches keep working).
    assert.equal(brief.briefMarkdown(await brief.projectBrief(OWNER, project)), md);
  });
});

test('P7 on: the topic index has a size cap', async () => {
  await withP7(async () => {
    const many = Array.from({ length: brief.MAX_TOPICS + 15 }, (_, i) => ({ content: `Beta topic number ${i} is about part ${i}`, type: 'fact', drawer, origin: 'owner', topicKey: `topic-${String(i).padStart(3, '0')}-${'x'.repeat(40)}` }));
    await learn({ userId: OWNER, actor: `owner:${OWNER}`, candidates: many });
    const t = await brief.topicIndex(OWNER, project);
    assert.ok(t.length <= brief.MAX_TOPICS);
    assert.ok(t.map((x) => `- ${x.key}`).join('\n').length <= brief.MAX_TOPIC_INDEX_CHARS);
    assert.deepEqual(t.map((x) => x.key), [...t.map((x) => x.key)].sort());
  });
});

test('S4: the brief reads only the project drawer and allowed pinned scopes', async () => {
  await withP7(async () => {
    const b = await brief.projectBrief(OWNER, project);
    assert.ok(b.memories.length > 0);
    for (const m of b.memories) assert.equal(m.drawer, 'project:beta');
    assert.doesNotThrow(() => brief.assertProjectFilesOnly(b));
  });
});

test('S4: a brief with an owner, people or other project item is refused by the file writer', async () => {
  await withP7(async () => {
    const good = await brief.projectBrief(OWNER, project);
    const bad = [
      { ...good, memories: [...good.memories, { id: 'x1', type: 'fact', importance: 5, content: 'About you', drawer: 'owner' }] },
      { ...good, memories: [...good.memories, { id: 'x2', type: 'fact', importance: 5, content: 'A person', drawer: 'people:sara' }] },
      { ...good, memories: [...good.memories, { id: 'x3', type: 'fact', importance: 5, content: 'Other project', drawer: 'project:other' }] },
      { ...good, facts: [...good.facts, { id: 'f1', scope: 'owner', content: 'Private' }] },
      { ...good, facts: [...good.facts, { id: 'f2', scope: 'project:other', content: 'Other project fact' }] },
    ];
    for (const b of bad) {
      assert.throws(() => brief.assertProjectFilesOnly(b), brief.ProjectFilesScopeError);
      assert.throws(() => previewFiles(project.id, b, folder, true), (err) => err instanceof ManagedFileError && err.code === 'private_drawer');
    }
    assert.ok(!existsSync(join(folder, 'AGENTS.md')));
    // The good brief passes the same writer.
    assert.ok(previewFiles(project.id, good, folder, true).files.length > 0);
  });
});

test('G8: Claude Code\'s own auto memory stays out of Girru-launched runs with P7 on', async () => {
  const { untrustedMemoryEnv } = await import(join(backendDir, 'src/services/subscription-chat.ts'));
  assert.deepEqual(untrustedMemoryEnv('claude'), {}, 'P7 off: unchanged');
  await withP7(async () => {
    assert.deepEqual(untrustedMemoryEnv('claude'), { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    assert.deepEqual(untrustedMemoryEnv('codex'), {});
    assert.deepEqual(untrustedMemoryEnv('gemini'), {});
  });
});
