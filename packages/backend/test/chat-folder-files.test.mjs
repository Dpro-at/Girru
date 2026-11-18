// CHAT-LIVE-01 (LW6): in the owner's project chat, edit and write change the
// project's real files (no separate grant), "Auto" asks the owner first, and
// protected files stay closed; a member's chat keeps the private draft.
// Temp folder + temp SQLite; no network.
// Run: node --import tsx --test test/chat-folder-files.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backend = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chat-folder-files-')));
mkdirSync(join(dir, '.data'));
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.AGENT_PLAYER_BACKGROUND = 'off';
console.log = () => {}; console.warn = () => {};
const project = join(dir, 'shop');
mkdirSync(join(project, 'notes'), { recursive: true });
writeFileSync(join(project, 'notes', 'shop.md'), '# Shop\nName: TBD\n');
const { getDatabase, closeDatabase } = await import(join(backend, 'src/db/database.ts'));
const db = getDatabase(); await db.initialize();
for (const [id, role] of [['owner', 'owner'], ['member', 'user']]) db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,'x',?,'active')").run(id, `${id}@example.test`, id, role);
db.prepare('UPDATE agents_config SET is_primary=0').run();
db.prepare("INSERT INTO agents_config(id,name,is_primary,provider,model) VALUES('main','Main Agent',1,'ollama','qwen3:4b')").run();
const { createConversation, createProject } = await import(join(backend, 'src/repositories/chat-conversations.ts'));
const { createAgentToolsRegistry } = await import(join(backend, 'src/tools/index.ts'));
const { writeTool } = await import(join(backend, 'src/tools/core/write.ts'));
const { editTool } = await import(join(backend, 'src/tools/core/edit.ts'));
const p = await createProject('owner', { name: 'Shop', folder: project });
const chat = await createConversation('owner', { title: 'Shop', agentId: 'main', projectId: p.id });
const ctx = (extra = {}) => ({ workspaceDir: project, fileReadRoot: project, agentId: 'main', userId: 'owner', sessionId: chat.id, chatPlan: true, memoryDrawers: [], ...extra });
const text = (r) => r.content.map((b) => b.text).join('\n');
test.after(() => { closeDatabase(); process.chdir(backend); rmSync(dir, { recursive: true, force: true }); });

test('in the owner\'s project chat, edit and write are offered without a grant; Auto asks first', async () => {
  const registry = await createAgentToolsRegistry(ctx());
  const names = registry.getAll().map((t) => t.name);
  assert.ok(names.includes('edit') && names.includes('write'));
  const r = await registry.execute('write', { path: 'notes/new.md', content: 'hello' });
  assert.equal(r.details?.status, 'pending_approval', 'nothing is written before the owner allows it');
  assert.equal(existsSync(join(project, 'notes', 'new.md')), false);
  const outside = await createAgentToolsRegistry(ctx({ chatPlan: false }));
  assert.ok(!outside.getAll().some((t) => t.name === 'edit'), 'not outside a chat');
});

test('an allowed write and edit change the real project files; protected files stay closed', async () => {
  const w = await writeTool.execute({ path: 'notes/new.md', content: 'hello' }, ctx());
  assert.equal(w.error, undefined, text(w));
  assert.equal(w.details.projectFile, true);
  assert.equal(readFileSync(join(project, 'notes', 'new.md'), 'utf8'), 'hello');
  const e = await editTool.execute({ path: 'notes/shop.md', before: '# Shop\nName: TBD\n', after: '# Shop\nName: Little Ember\n' }, ctx());
  assert.equal(e.error, undefined, text(e));
  assert.equal(readFileSync(join(project, 'notes', 'shop.md'), 'utf8'), '# Shop\nName: Little Ember\n');
  assert.ok((await writeTool.execute({ path: '.env', content: 'X=1' }, ctx())).error);
  assert.ok((await writeTool.execute({ path: '../escape.md', content: 'x' }, ctx())).error);
});

test('a member\'s chat keeps the private draft and says the project is not changed', async () => {
  const w = await writeTool.execute({ path: 'notes/shop.md', content: 'member text' }, ctx({ userId: 'member' }));
  assert.equal(w.error, undefined, text(w));
  assert.match(text(w), /private draft/);
  assert.equal(readFileSync(join(project, 'notes', 'shop.md'), 'utf8'), '# Shop\nName: Little Ember\n');
});

test('outside the owner\'s chat turn (a task run, a hand-off, a channel) write stays a private draft', async () => {
  for (const extra of [{ taskId: 'task-1' }, { delegatedFrom: ['main'] }, { toolPolicy: { channel: 'telegram' } }, { chatPlan: false }]) {
    const w = await writeTool.execute({ path: 'notes/shop.md', content: 'not here' }, ctx(extra));
    assert.match(text(w), /private draft/, JSON.stringify(extra));
  }
  assert.equal(readFileSync(join(project, 'notes', 'shop.md'), 'utf8'), '# Shop\nName: Little Ember\n');
});
