// STORE-MAP-01 P2: one Girru section in AGENTS.md / CLAUDE.md / GEMINI.md (GIRRU_STORE_P2).
//  - the memory brief, the owner's rules (most binding first) and the task pointer share ONE section
//    with Girru markers in AGENTS.md; CLAUDE.md and GEMINI.md only point to AGENTS.md, so the rules
//    are loaded once;
//  - the two older sections (dpro-memory, girru:rules) are replaced in place; the owner's own text is
//    kept byte for byte; broken markers write nothing;
//  - the memory brief is in the files only where the owner turned memory files on;
//  - with the switch off again the earlier layout comes back on the next write.
// Run: node --import tsx --test test/one-girru-section.test.mjs
// Throwaway DB + cwd, random test-only secrets, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { clearEnv } from './helpers/switches.mjs';
const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-one-section-')));
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
for (const k of ['GIRRU_STORE_P2', 'GIRRU_STORE_PILOT', 'AGENT_PLAYER_DATA_DIR']) clearEnv(k);
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const { projectKeyOf } = await import(join(backendDir, 'src/memory/project-keys.ts')); // project memory key (id while GIRRU_STORE_P3 is on)
const db = getDatabase();
await db.initialize();
const OWNER = 'os-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, `${OWNER}@example.test`, OWNER);
const { createProject } = await import(join(backendDir, 'src/repositories/chat-conversations.ts'));
const { createRule } = await import(join(backendDir, 'src/services/agent-rules.ts'));
const { writeFiles, filesState } = await import(join(backendDir, 'src/services/agent-rule-files.ts'));
const { setBridgeEnv, filesPreview, filesApply, syncOwner } = await import(join(backendDir, 'src/memory/bridge/service.ts'));
const { newMemory, saveVersioned } = await import(join(backendDir, 'src/memory/learning.ts'));
setBridgeEnv({ home: dir, env: {} });

const folder = join(dir, 'alpha');
mkdirSync(folder, { recursive: true });
const project = await createProject(OWNER, { name: 'Alpha', folder });
await createRule({ text: 'In Alpha, release only on Tuesdays.', when: null, projectId: project.id, who: 'all', targets: [], paused: false }, OWNER);
await saveVersioned(newMemory(OWNER, { kind: 'project', key: projectKeyOf(project) }, { type: 'fact', importance: 7, content: 'Alpha deploys with scripts/release.sh.' }, {}), 'test', 'test');

const OWNER_TOP = '# Alpha\n\nMy own notes: tabs, not spaces.\n\n';
const OWNER_END = '\n## Owner footer\nKeep this.\n';
const OLD_MEMORY = '<!-- dpro-memory:start — managed by Dpro: old -->\n## Girru project memory: Alpha\nold brief\n<!-- dpro-memory:end -->\n';
const OLD_RULES = '<!-- girru:rules · written by Girru from Agents › Rules; change the rules there -->\n# Rules\n1. old rule\n<!-- /girru:rules -->';
const read = (n) => readFileSync(join(folder, n), 'utf8');
const count = (text, re) => (text.match(re) ?? []).length;
const p2 = async (fn) => { process.env.GIRRU_STORE_P2 = '1'; try { return await fn(); } finally { process.env.GIRRU_STORE_P2 = '0'; } };

test('rules files on: one section replaces both old ones in place; owner text kept; rules once', async () => {
  writeFileSync(join(folder, 'AGENTS.md'), `${OWNER_TOP}${OLD_MEMORY}\n${OLD_RULES}${OWNER_END}`);
  writeFileSync(join(folder, 'CLAUDE.md'), `My Claude notes.\n\n${OLD_RULES}\n`);
  await p2(() => writeFiles(project.id, 'private'));
  const agents = read('AGENTS.md');
  assert.equal(count(agents, /<!-- girru:start/g), 1);
  assert.equal(count(agents, /<!-- girru:end -->/g), 1);
  assert.equal(count(agents, /dpro-memory|girru:rules/g), 0, 'old sections removed');
  assert.ok(agents.startsWith(OWNER_TOP), 'owner text before is kept');
  assert.ok(agents.endsWith(OWNER_END), 'owner text after is kept');
  assert.match(agents, /### Rules from the owner/);
  assert.match(agents, /In Alpha, release only on Tuesdays\./);
  assert.match(agents, /earlier one wins/);
  assert.match(agents, /### Tasks\n\nThe project's tasks are in `\.girru\/tasks\.md`/);
  assert.doesNotMatch(agents, /Alpha deploys with scripts/, 'memory brief only where memory files are on');
  const claude = read('CLAUDE.md');
  assert.ok(claude.startsWith('My Claude notes.'));
  assert.match(claude, /@AGENTS\.md/);
  assert.doesNotMatch(claude, /@\.girru\/rules\.md/, 'rules are not imported twice');
  assert.match(read('GEMINI.md'), /@\.\/AGENTS\.md/);
  assert.match(read('.girru/rules.md'), /release only on Tuesdays/);
  const st = await p2(() => filesState(project.id));
  assert.equal(st.upToDate, true, JSON.stringify(st.files));
});

test('memory files on as well: the brief joins the same section (preview shows the change)', async () => {
  await p2(async () => {
    const pv = await filesPreview(OWNER, project.id);
    const agents = pv.files.find((f) => f.relative === 'AGENTS.md');
    assert.equal(agents.action, 'update');
    assert.match(agents.diff, /\+- Alpha deploys with scripts\/release\.sh\./);
    await filesApply(OWNER, project.id, { previewHash: pv.previewHash, confirm: true });
  });
  const agents = read('AGENTS.md');
  assert.equal(count(agents, /<!-- girru:start/g), 1);
  assert.match(agents, /Alpha deploys with scripts\/release\.sh\./);
  assert.match(agents, /In Alpha, release only on Tuesdays\./);
  // A rule change rewrites the one section (brief kept).
  await createRule({ text: 'Alpha uses PostgreSQL.', when: null, projectId: project.id, who: 'all', targets: [], paused: false }, OWNER);
  await p2(() => writeFiles(project.id));
  const after = read('AGENTS.md');
  assert.match(after, /Alpha uses PostgreSQL\./);
  assert.match(after, /Alpha deploys with scripts/);
  assert.equal(count(after, /<!-- girru:start/g), 1);
});

test('broken markers: nothing is written', async () => {
  const broken = `${OWNER_TOP}<!-- dpro-memory:start — x -->\nhalf a section\n`;
  writeFileSync(join(folder, 'AGENTS.md'), broken);
  await assert.rejects(p2(() => writeFiles(project.id)), /broken|Nothing written/);
  assert.equal(read('AGENTS.md'), broken);
});

test('switch off again: the next memory sync goes back to the earlier layout', async () => {
  writeFileSync(join(folder, 'AGENTS.md'), OWNER_TOP);
  await p2(() => writeFiles(project.id));
  assert.equal(count(read('AGENTS.md'), /<!-- girru:start/g), 1);
  db.prepare("UPDATE memory_bridge_folders SET brief_hash = 'stale' WHERE project_id = ?").run(project.id);
  await syncOwner(OWNER);
  const agents = read('AGENTS.md');
  assert.equal(count(agents, /<!-- girru:start/g), 0, 'the P2 section is removed');
  assert.equal(count(agents, /<!-- dpro-memory:start/g), 1, 'the memory section is back');
  assert.ok(agents.startsWith(OWNER_TOP));
});

test('back-flow reads only the owner’s text: none of Girru’s sections (old or new) comes back as a proposal', async () => {
  const { outsideManaged } = await import(join(backendDir, 'src/memory/bridge/managed-files.ts'));
  const text = `${OWNER_TOP}<!-- girru:start — x -->\nGirru brief\n<!-- girru:end -->\nmiddle\n${OLD_RULES}\n${OLD_MEMORY}${OWNER_END}`;
  const own = outsideManaged(text);
  assert.doesNotMatch(own, /Girru brief|old rule|old brief/);
  assert.match(own, /My own notes/);
  assert.match(own, /middle/);
  assert.match(own, /Keep this\./);
});
