// STORE-MAP-01 P3 (FD4a): "Restore and open the version you had" across the desktop updater and
// this backend's start-up restore. Throwaway DB/keys/folders; no network.
// Run: node --import tsx --test test/store-p3-restore.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-p3-restore-'));
const data = join(dir, '.data');
const outside = join(dir, 'Girru Backups');
mkdirSync(join(data, 'multi-agent'), { recursive: true });
mkdirSync(join(data, 'encryption'), { recursive: true });
mkdirSync(join(data, 'agents', 'g-lead'), { recursive: true });
mkdirSync(join(data, 'logs'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = data;
process.env.DATABASE_PATH = join(data, 'agent-player.db');
process.env.GIRRU_BACKUPS_DIR = outside;
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {}; console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
for (const [id, role] of [['b-owner', 'owner'], ['b-user', 'user']]) {
  db.prepare(`INSERT INTO users (id, email, username, full_name, password_hash, role, status, email_verified) VALUES (?, ?, ?, ?, 'x', ?, 'active', 1)`).run(id, `${id}@example.test`, id, id, role);
}
// Other stores of the data folder: keys and audit (SQLite, WAL), plain files.
for (const f of ['encryption/keys.db', 'audit/audit.db']) {
  mkdirSync(join(data, f, '..'), { recursive: true });
  const s = new Database(join(data, f)); s.pragma('journal_mode = WAL'); s.exec('CREATE TABLE t (v TEXT)'); s.prepare('INSERT INTO t VALUES (?)').run(f); s.close();
}
writeFileSync(join(data, 'agents', 'g-lead', 'rules.md'), 'be kind\n');
writeFileSync(join(data, 'secrets.env'), 'JWT_SECRET=throwaway\n');
writeFileSync(join(data, 'logs', 'backend.log'), 'not saved\n');

const B = await import(join(backendDir, 'src/services/backups.ts'));
after(async () => { const { rmSync } = await import('node:fs'); rmSync(dir, { recursive: true, force: true }); });

// // The desktop updater (packages/desktop/src/app-update.cjs) keeps the replaced app and the backup it
// made before the update; restorePrevious writes the restore request in the data folder, and this
// backend's start-up restore puts the data back before any store opens.
test('P3: after a failed update, the data before the update comes back and the version you had returns', async () => {
  const { createRequire } = await import('node:module');
  const { createHash } = await import('node:crypto');
  const req = createRequire(import.meta.url);
  const { createUpdater } = req(join(backendDir, '../desktop/src/app-update.cjs'));
  const rules = join(data, 'agents', 'g-lead', 'rules.md');
  writeFileSync(rules, 'be kind\n');
  const b = await B.backUpNow('before-update');
  assert.ok(b.checked);
  // The (fake) update: the new app replaces the old one; the backup answer carries its folder.
  const apps = join(dir, 'Applications'); mkdirSync(join(apps, 'Girru.app', 'Contents', 'MacOS'), { recursive: true }); writeFileSync(join(apps, 'Girru.app', 'version.txt'), '1.5.0');
  const settings = join(dir, 'desktop-settings'); mkdirSync(settings, { recursive: true });
  const zipBytes = Buffer.from('zip'); const sum = createHash('sha256').update(zipBytes).digest('hex');
  const P = 'mac-arm64';
  const release = { tag_name: 'v1.6.0', draft: false, prerelease: false, published_at: '2026-11-03T09:00:00Z', html_url: 'https://github.com/Dpro-at/Girru/releases/tag/v1.6.0', body: '',
    assets: [{ name: `Girru-1.6.0-${P}.zip`, browser_download_url: `https://github.com/Dpro-at/Girru/releases/download/v1.6.0/Girru-1.6.0-${P}.zip` }, { name: `SHA256SUMS-${P}.txt`, browser_download_url: `https://github.com/Dpro-at/Girru/releases/download/v1.6.0/SHA256SUMS-${P}.txt` }] };
  let relaunched = 0;
  const u = createUpdater({ currentVersion: '1.5.0', settingsDir: settings, platform: 'darwin', arch: 'arm64', execPath: join(apps, 'Girru.app', 'Contents', 'MacOS', 'Girru'), keepPrevious: true,
    fetchRelease: async () => release,
    download: async (url, o = {}) => { if (!o.file) return `${sum}  Girru-1.6.0-${P}.zip\n`; writeFileSync(o.file, zipBytes); return sum; },
    backUp: async () => ({ ok: true, id: b.id, folder: B.workspaceBackupsDir() }),
    unpack: async (_z, to) => { mkdirSync(join(to, 'Girru.app')); writeFileSync(join(to, 'Girru.app', 'version.txt'), '1.6.0'); },
    readApp: async () => ({ id: 'app.dpro.desktop', version: '1.6.0' }), relaunch: () => { relaunched++; } });
  await u.check(); await u.install();
  assert.equal(readFileSync(join(apps, 'Girru.app', 'version.txt'), 'utf8'), '1.6.0');
  // The new version changed the data, then an update step failed at its first start.
  writeFileSync(rules, 'changed by the failed update\n');
  assert.equal(u.previous().version, '1.5.0');
  u.restorePrevious(data);
  assert.equal(readFileSync(join(apps, 'Girru.app', 'version.txt'), 'utf8'), '1.5.0', 'the version you had is back');
  assert.equal(relaunched, 2, 'started again after the update and after the restore');
  // The earlier version starts: the restore runs before any store opens.
  const done = await B.applyPendingRestore();
  assert.equal(done.ok, true, done.error);
  assert.equal(readFileSync(rules, 'utf8'), 'be kind\n', 'the data from before the update');
});
