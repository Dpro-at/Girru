// STORE-MAP-01 P10 on PostgreSQL (migration 182): a project rename writes a change event (the brief
// follows it); a brief Girru wrote but did not record before a crash (its pending hash) is adopted, not
// taken for an outside edit; two edits of one memory on the same version give one write and one refusal.
// Runs ONLY when AGENT_PLAYER_PG_TEST_URL names a THROWAWAY database on 127.0.0.1 with the
// migrations-pg applied (scripts/pg/integration.sh). Rows are tagged and removed afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const URL_ = process.env.AGENT_PLAYER_PG_TEST_URL;
const skip = URL_ ? false : 'AGENT_PLAYER_PG_TEST_URL is not set (PostgreSQL integration test)';

let m = {};
let dir;
if (URL_) {
  dir = mkdtempSync(join(tmpdir(), 'ap-pg-store-p10-'));
  mkdirSync(join(dir, '.data'), { recursive: true });
  process.chdir(dir);
  process.env.HOME = dir;
  process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
  process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
  process.env.MEMORY_EMBEDDINGS = 'hash';
  process.env.MEMORY_GRAPH_MODEL = 'off';
  process.env.AGENT_PLAYER_DB = 'postgres';
  process.env.AGENT_PLAYER_PG_URL = URL_;
  const quiet = { log: console.log, warn: console.warn };
  console.log = () => {}; console.warn = () => {};
  const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
  await getDatabase({ path: process.env.DATABASE_PATH }).initialize();
  console.log = quiet.log; console.warn = quiet.warn;
  m = {
    closeDatabase,
    pool: await import('../src/db/pg/pool.ts'),
    users: (await import('../src/repositories/pg/users-store.ts')).pgUsersStore,
    projects: await import('../src/repositories/chat-conversations.ts'),
    learning: await import('../src/memory/learning.ts'),
    events: await import('../src/memory/outbox/events.ts'),
    projection: await import('../src/memory/outbox/projection.ts'),
    keys: await import('../src/memory/project-keys.ts'),
  };
}

const tag = randomBytes(4).toString('hex');
const all = (sql, ...p) => m.pool.pgAll(sql, ...p);
const S = {};

test.before(async () => {
  if (!URL_) return;
  const owner = await m.users.create({ email: `owner-${tag}@pg.test`, username: `owner_${tag}`, password: `pw-${randomBytes(8).toString('hex')}`, role: 'owner' });
  S.owner = owner.id;
  S.folder = join(dir, 'alpha');
  mkdirSync(S.folder, { recursive: true });
  S.project = await m.projects.createProject(S.owner, { name: `Alpha ${tag}`, folder: S.folder });
  S.scope = await m.events.enableScope(S.owner, S.project);
  S.drawer = { kind: 'project', key: m.keys.projectKeyOf(S.project) };
});

test.after(async () => {
  if (!URL_) return;
  for (const t of ['change_events', 'projection_state']) await m.pool.pgRun(`DELETE FROM ${t} WHERE scope LIKE ?`, `%${tag}%`).catch(() => {});
  await m.pool.pgRun('DELETE FROM change_scopes WHERE owner_id = ?', S.owner).catch(() => {});
  await m.pool.pgRun('DELETE FROM memory_versions WHERE user_id = ?', S.owner).catch(() => {});
  await m.pool.pgRun('DELETE FROM memories WHERE user_id = ?', S.owner).catch(() => {});
  await m.pool.pgRun('DELETE FROM chat_projects WHERE user_id = ?', S.owner).catch(() => {});
  await m.pool.pgRun('DELETE FROM users WHERE id = ?', S.owner).catch(() => {});
  await m.closeDatabase?.();
  await m.pool.closePgPool?.();
  rmSync(dir, { recursive: true, force: true });
});

const save = (content) => m.learning.saveVersioned(m.learning.newMemory(S.owner, S.drawer, { type: 'fact', importance: 6, content }, {}), 'test', 'test');

test('a project rename writes a change event; the brief follows it', { skip }, async () => {
  await save(`Alpha ${tag} ships on Tuesdays.`);
  assert.equal((await m.projection.runBriefProjection(S.scope)).status, 'up_to_date');
  const before = (await all('SELECT seq FROM change_events WHERE scope = ?', S.scope)).length;
  await m.projects.patchProject(S.owner, S.project.id, { name: `Orchard ${tag}` });
  const ev = await all('SELECT entity, op FROM change_events WHERE scope = ? ORDER BY seq', S.scope);
  assert.equal(ev.length, before + 1);
  assert.deepEqual([ev.at(-1).entity, ev.at(-1).op], ['project', 'update']);
  await m.projects.patchProject(S.owner, S.project.id, { name: `Orchard ${tag}` });
  assert.equal((await all('SELECT seq FROM change_events WHERE scope = ?', S.scope)).length, before + 1, 'the same name again is no change');
  assert.equal((await m.projection.runBriefProjection(S.scope)).wrote, true);
  assert.match(readFileSync(join(S.folder, '.girru', 'brief.md'), 'utf8'), new RegExp(`Orchard ${tag}`));
});

test('a brief written but not recorded before a crash is adopted, not an outside edit', { skip }, async () => {
  const brief = join(S.folder, '.girru', 'brief.md');
  // What a killed run leaves: the file on disk and its hash as pending_hash; the state still the old one.
  const text = readFileSync(brief, 'utf8').replace('Tuesdays', 'Wednesdays');
  writeFileSync(brief, text);
  await m.pool.pgRun('UPDATE projection_state SET pending_hash = ? WHERE scope = ?', createHash('sha256').update(text).digest('hex'), S.scope);
  await save(`Alpha ${tag} adds a staging server.`);
  const r = await m.projection.runBriefProjection(S.scope);
  assert.equal(r.status, 'up_to_date', r.reason);
  assert.equal((await all('SELECT pending_hash FROM projection_state WHERE scope = ?', S.scope))[0].pending_hash, null);
  assert.match(readFileSync(brief, 'utf8'), /staging server/);
});

test('two edits of one memory on the same version: one write, one refusal', { skip }, async () => {
  const mem = await save(`Alpha ${tag} release is in May.`);
  const v = Number((await all('SELECT MAX(version) AS v FROM memory_versions WHERE memory_id = ?', mem.id))[0].v);
  const edit = (content) => m.learning.updateVersioned(S.owner, mem.id, { content }, 'test', 'test', v).then(() => 'ok', (e) => e.status);
  const results = await Promise.all([edit(`Alpha ${tag} release is in June.`), edit(`Alpha ${tag} release is in July.`)]);
  assert.deepEqual(results.sort(), [409, 'ok']);
});
