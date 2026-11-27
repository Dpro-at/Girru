// BACKUP-02 slice 3: off-site destinations. The owner adds a folder (external drive
// / NAS) as a place; a push encrypts the backup, copies it there, reads it back and
// checks the hash. The place holds ONLY ciphertext, and a restore from it rebuilds
// the backup. Owner only; throwaway data dir + keys; no network.
// Run: node --import tsx --test test/backup-destinations.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-dest-'));
const data = join(dir, '.data');
const outside = join(dir, 'Girru Backups');
const drive = join(dir, 'External Drive'); // stands in for a mounted drive / NAS folder
mkdirSync(join(data, 'encryption'), { recursive: true });
mkdirSync(join(data, 'agents', 'g-lead'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = data;
process.env.DATABASE_PATH = join(data, 'agent-player.db');
process.env.GIRRU_BACKUPS_DIR = outside;
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString('base64'); // throwaway, test only
process.env.NODE_ENV = 'test';
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {}; console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
for (const [id, role] of [['d-owner', 'owner'], ['d-user', 'user']]) {
  db.prepare(`INSERT INTO users (id, email, username, full_name, password_hash, role, status, email_verified) VALUES (?, ?, ?, ?, 'x', ?, 'active', 1)`).run(id, `${id}@example.test`, id, id, role);
}
const marker = 'OFFSITE-SECRET-xyz789';
writeFileSync(join(data, 'agents', 'g-lead', 'rules.md'), `be kind\n${marker}\n`);

const { getKeyManager } = await import(join(backendDir, 'src/encryption/key-manager.ts'));
await getKeyManager().initialize(join(data, 'encryption', 'keys.db'));
const Arch = await import(join(backendDir, 'src/services/backup-archive.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const app = await buildServer({ logger: false });
await app.ready();
const call = (user, method, url, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${generateToken(user, 1)}` }, ...(payload ? { payload } : {}) });
const ok = async (r, code = 200) => { const x = await r; assert.equal(x.statusCode, code, x.body); return x.json(); };
after(async () => { const { rmSync } = await import('node:fs'); rmSync(dir, { recursive: true, force: true }); });

/** Find the one .gbk blob a push wrote under the drive folder. */
function findBlob(root) {
  const out = [];
  const visit = (d) => { for (const n of readdirSync(d)) { const f = join(d, n); statSync(f).isDirectory() ? visit(f) : out.push(f); } };
  visit(root);
  return out;
}

test('add a folder place, push, and the place holds only ciphertext that restores', async () => {
  // First a real backup to send.
  const backup = (await ok(call('d-owner', 'POST', '/api/backups', {}))).backup;
  assert.equal(backup.checked, true);

  // The owner adds the drive as a place.
  const added = (await ok(call('d-owner', 'POST', '/api/backups/destinations', { type: 'folder', label: 'My drive', folder: drive }))).destination;
  assert.equal(added.type, 'folder');
  assert.ok(added.config.folder.endsWith('External Drive'), 'the folder is saved');
  assert.ok(added.id.length >= 36);

  const list = (await ok(call('d-owner', 'GET', '/api/backups/destinations'))).destinations;
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'My drive');

  // Push the backup to the place.
  const pushed = (await ok(call('d-owner', 'POST', `/api/backups/destinations/${added.id}/push`))).destination;
  assert.ok(pushed.status.lastOkAt, 'push succeeded');
  assert.ok(pushed.status.lastVerifiedAt, 'remote verify ran');
  assert.equal(pushed.status.lastError, null);
  assert.equal(pushed.status.backups, 1);

  // The place holds the encrypted blob + sidecar, and NO plaintext.
  const files = findBlob(drive);
  const blob = files.find((f) => f.endsWith('.gbk'));
  const sidecar = files.find((f) => f.endsWith('.gbk.meta.json'));
  assert.ok(blob && sidecar, 'blob and sidecar written');
  assert.equal(statSync(blob).mode & 0o777, 0o600, 'owner-only on the place');
  const bytes = readFileSync(blob);
  assert.ok(!bytes.includes(Buffer.from(marker)), 'no plaintext memory on the place');
  assert.ok(!bytes.includes(Buffer.from('rules.md')), 'no plaintext file names on the place');
  assert.ok(!bytes.includes(Buffer.from('SQLite format 3')), 'no readable database header on the place');

  // A restore from the place rebuilds the backup folder exactly.
  const meta = Arch.readArchiveMeta(sidecar);
  const restored = join(dir, 'from-place');
  await Arch.decryptBackupArchive(blob, meta, restored, getKeyManager(), meta.id);
  assert.equal(readFileSync(join(restored, 'data', 'agents', 'g-lead', 'rules.md'), 'utf8'), `be kind\n${marker}\n`);
  assert.ok(existsSync(join(restored, 'manifest.json')));
});

test('a place is owner-only, validated, and coming types are honest', async () => {
  // Only the owner.
  assert.equal((await call('d-user', 'GET', '/api/backups/destinations')).statusCode, 403);
  assert.equal((await call('d-user', 'POST', '/api/backups/destinations', { type: 'folder', folder: drive })).statusCode, 403);
  // A folder inside the data folder is refused.
  assert.equal((await call('d-owner', 'POST', '/api/backups/destinations', { type: 'folder', folder: join(data, 'x') })).statusCode, 400);
  // Not-yet-available types are refused, not faked.
  for (const type of ['sftp', 'webdav', 's3']) assert.equal((await call('d-owner', 'POST', '/api/backups/destinations', { type, folder: drive })).statusCode, 400, type);
});

test('removing a place forgets it but leaves the backups on it', async () => {
  const list = (await ok(call('d-owner', 'GET', '/api/backups/destinations'))).destinations;
  const id = list[0].id;
  const before = findBlob(drive).length;
  await ok(call('d-owner', 'DELETE', `/api/backups/destinations/${id}`));
  assert.equal((await ok(call('d-owner', 'GET', '/api/backups/destinations'))).destinations.length, 0);
  assert.equal(findBlob(drive).length, before, 'the blobs already on the place stay');
  // A push to a forgotten place is a 404.
  assert.equal((await call('d-owner', 'POST', `/api/backups/destinations/${id}/push`)).statusCode, 404);
});
