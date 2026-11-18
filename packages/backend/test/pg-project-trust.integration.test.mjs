// REPO-TRUST-01 on PostgreSQL (migration 186): a cloned foreign repository is outside, a project made
// here is trusted, the owner's choice is kept and undone, an owner he adds counts as his own.
// Runs ONLY when AGENT_PLAYER_PG_TEST_URL names a THROWAWAY database on 127.0.0.1 with the
// migrations-pg applied (scripts/pg/integration.sh). Rows are tagged and removed afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const URL_ = process.env.AGENT_PLAYER_PG_TEST_URL;
const skip = URL_ ? false : 'AGENT_PLAYER_PG_TEST_URL is not set (PostgreSQL integration test)';

let m = {};
let dir;
if (URL_) {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-pg-repo-trust-')));
  mkdirSync(join(dir, '.data'), { recursive: true });
  process.chdir(dir);
  process.env.HOME = dir;
  process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
  process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
  process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
  process.env.MEMORY_EMBEDDINGS = 'hash';
  process.env.MEMORY_GRAPH_MODEL = 'off';
  process.env.AGENT_PLAYER_DB = 'postgres';
  process.env.AGENT_PLAYER_PG_URL = URL_;
  delete process.env.GIRRU_REPO_TRUST;
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
    T: await import('../src/memory/project-trust.ts'),
  };
}

const tag = randomBytes(4).toString('hex');
const S = {};

test.before(async () => {
  if (!URL_) return;
  const owner = await m.users.create({ email: `owner-${tag}@pg.test`, username: `owner_${tag}`, password: `pw-${randomBytes(8).toString('hex')}`, role: 'owner' });
  S.owner = owner.id;
  const mine = join(dir, 'mine'); mkdirSync(mine, { recursive: true });
  const foreign = join(dir, 'foreign'); mkdirSync(join(foreign, '.git'), { recursive: true });
  writeFileSync(join(foreign, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:stranger/tool.git\n');
  S.mine = await m.projects.createProject(S.owner, { name: `Mine ${tag}`, folder: mine });
  S.foreign = await m.projects.createProject(S.owner, { name: `Foreign ${tag}`, folder: foreign });
});

test.after(async () => {
  if (!URL_) return;
  for (const t of ['project_trust', 'project_trust_owners']) await m.pool.pgRun(`DELETE FROM ${t} WHERE owner_id = ?`, S.owner).catch(() => {});
  await m.pool.pgRun('DELETE FROM chat_projects WHERE user_id = ?', S.owner).catch(() => {});
  await m.pool.pgRun('DELETE FROM users WHERE id = ?', S.owner).catch(() => {});
  await m.closeDatabase?.();
  await m.pool.closePgPool?.();
  rmSync(dir, { recursive: true, force: true });
});

test('outside projects on PostgreSQL: detection, the owner\'s choice, own owners', { skip }, async () => {
  assert.equal(await m.T.isOutsideProject(S.owner, S.mine.id), false);
  assert.equal(await m.T.isOutsideProject(S.owner, S.foreign.id), true);
  const v = await m.T.checkProjectTrust(S.owner, S.foreign.id);
  assert.deepEqual(v.remote, { host: 'github.com', owner: 'stranger' });
  await m.T.setProjectOutside(S.owner, S.foreign.id, false);
  assert.equal(await m.T.isOutsideProject(S.owner, S.foreign.id), false);
  assert.equal((await m.pool.pgOne('SELECT source FROM project_trust WHERE owner_id = ? AND project_id = ?', S.owner, S.foreign.id)).source, 'owner');
  await m.T.resetProjectTrust(S.owner, S.foreign.id);
  m.T.clearProjectTrustCache();
  assert.equal(await m.T.isOutsideProject(S.owner, S.foreign.id), true);
  await m.T.addOwnOwner(S.owner, 'stranger');
  await m.T.addOwnOwner(S.owner, 'stranger'); // twice: kept once
  assert.equal(Number((await m.pool.pgOne('SELECT COUNT(*) AS n FROM project_trust_owners WHERE owner_id = ?', S.owner)).n), 1);
  assert.equal(await m.T.isOutsideProject(S.owner, S.foreign.id), false);
  await m.T.removeOwnOwner(S.owner, 'stranger');
  assert.equal(await m.T.isOutsideProject(S.owner, S.foreign.id), true);
  assert.deepEqual([...await m.T.outsideProjectIds(S.owner)], [S.foreign.id]);
});
