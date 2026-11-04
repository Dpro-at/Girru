// STORE-MAP-01 P4 (D8): the old memory index file is deleted only after a verified backup.
//  - no file: nothing happens;
//  - a backup that fails, or does not hold the file: the file is kept;
//  - a checked backup that holds it: the file (and its -wal/-shm) goes, and the backup still has it;
//  - forget still works once it is gone.
// Run: node --import tsx --test test/store-p4-legacy-index.test.mjs
// Throwaway data and backups folders; never the real .data.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-p4-legacy-'));
const data = join(dir, '.data');
mkdirSync(join(data, 'memory'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = data;
process.env.DATABASE_PATH = join(data, 'agent-player.db');
process.env.GIRRU_BACKUPS_DIR = join(dir, 'Girru Backups');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.GIRRU_STORE_P4 = '1';
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
console.log = () => {}; console.info = () => {}; console.warn = () => {};
after(() => rmSync(dir, { recursive: true, force: true }));

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
await getDatabase().initialize();
const L = await import(join(backendDir, 'src/memory/legacy-index.ts'));
const B = await import(join(backendDir, 'src/services/backups.ts'));
await B.loadBackupsFolder();

const makeOld = () => { const d = new Database(L.legacyIndexFile()); d.exec('CREATE TABLE IF NOT EXISTS memory_index (id TEXT, content TEXT)'); d.prepare('INSERT INTO memory_index VALUES (?, ?)').run('m1', 'Old index text'); d.close(); };

test('no file: nothing to do', async () => {
  assert.deepEqual(await L.retireLegacyIndex(), { state: 'none' });
});

test('without a verified backup the file is kept', async () => {
  makeOld();
  assert.equal((await L.retireLegacyIndex({ backUp: async () => { throw new Error('no folder'); } })).state, 'kept');
  assert.equal((await L.retireLegacyIndex({ backUp: async () => ({ id: 'x', checked: false }) })).state, 'kept');
  assert.equal((await L.retireLegacyIndex({ backUp: async () => ({ id: 'x', checked: true }), holds: async () => false })).state, 'kept');
  assert.ok(existsSync(L.legacyIndexFile()));
});

test('a checked backup that holds it: the file goes, the backup keeps it', async () => {
  writeFileSync(L.legacyIndexFile() + '-shm', 'x');
  const r = await L.retireLegacyIndex();
  assert.equal(r.state, 'retired', r.reason);
  assert.ok(!existsSync(L.legacyIndexFile()) && !existsSync(L.legacyIndexFile() + '-shm'));
  assert.equal(await B.backupHolds(r.backupId, 'memory/memory.db'), true);
  assert.deepEqual(await L.retireLegacyIndex(), { state: 'none' }, 'once');
});

test('forget works once the file is gone', async () => {
  const { forgetMemory } = await import(join(backendDir, 'src/memory/forget.ts'));
  const { newMemory, saveVersioned } = await import(join(backendDir, 'src/memory/learning.ts'));
  getDatabase().prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES ('o1', 'o1@example.test', 'o1', 'x', 'owner', 'active', 1)`).run();
  const m = await saveVersioned(newMemory('o1', { kind: 'owner', key: '' }, { type: 'fact', importance: 5, content: 'Forget me.' }, {}), 'o1', 'test');
  const out = await forgetMemory('o1', m.id, 'o1');
  assert.equal(out.memoryId, m.id);
});
