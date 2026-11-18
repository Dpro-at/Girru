// The owner intentionally chooses an arbitrary existing project folder; no file contents are exposed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join, parse} from 'node:path';
import {randomBytes} from 'node:crypto';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'girru-project-selection-')));
const folder = join(dir, 'Owner project'); mkdirSync(folder);
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'config');
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.AGENT_PLAYER_BACKGROUND = 'off';
const {getDatabase, closeDatabase} = await import('../src/db/database.ts');
const db = getDatabase(); await db.initialize();
for (const [id, role] of [['folder-owner', 'owner'], ['folder-user', 'user']]) {
  db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,'synthetic',?,'active')").run(id, `${id}@example.test`, id, role);
}
const {registerAuthGate} = await import('../src/auth/auth-gate.ts');
const {deviceCoopRoutes} = await import('../src/api/routes/device-coop.ts');
const {generateToken} = await import('../src/auth/jwt.ts');
const {default: Fastify} = await import('fastify');
const app = Fastify(); registerAuthGate(app); await app.register(deviceCoopRoutes); await app.ready();
test.after(async () => { await app.close(); closeDatabase(); rmSync(dir, {recursive: true, force: true}); });
const call = (who, payload) => app.inject({method: 'POST', url: '/api/computers/works-on/folder', headers: who ? {authorization: `Bearer ${generateToken(who, 1)}`} : {}, payload});

test('folder selection requires an authenticated owner and explicit confirmation', async () => {
  assert.equal((await call(null, {folder, confirmed: true})).statusCode, 401);
  assert.equal((await call('folder-user', {folder, confirmed: true})).statusCode, 403);
  for (const payload of [{folder}, {folder, confirmed: false}, {folder, confirmed: true, extra: true}]) {
    assert.equal((await call('folder-owner', payload)).statusCode, 409);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_projects').get().n, 0);
});

test('folder selection refuses relative paths, nonexistent paths, files, the disk root and the whole home directory', async () => {
  const file = join(dir, 'note.txt'); writeFileSync(file, 'private fixture contents');
  for (const invalid of ['.', '..', join(dir, 'missing'), file, parse(folder).root, homedir()]) {
    const response = await call('folder-owner', {folder: invalid, confirmed: true});
    assert.equal(response.statusCode, 409, invalid);
    assert.doesNotMatch(response.body, /private fixture contents/);
  }
});

test('confirmed folder selection stores only the owner project and reuses the canonical folder', async () => {
  const response = await call('folder-owner', {folder, confirmed: true});
  assert.equal(response.statusCode, 200, response.body);
  const project = response.json(); assert.deepEqual(Object.keys(project).sort(), ['id', 'name']);
  const same = await call('folder-owner', {folder: join(folder, '.'), confirmed: true});
  assert.deepEqual(same.json(), project);
  const stored = db.prepare('SELECT user_id,folder FROM chat_projects WHERE id=?').get(project.id);
  assert.equal(stored.user_id, 'folder-owner'); assert.equal(stored.folder, realpathSync.native(folder));
});
