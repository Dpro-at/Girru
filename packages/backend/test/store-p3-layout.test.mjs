// STORE-MAP-01 P3 step 3: an older Girru never opens newer data (OPS2), and a failed update step
// names itself with an error id (OPS1).
//  - with the switch on, start-up records the level and the version that opened the data;
//  - data with an update step this build does not know is refused before anything is written
//    (no schema, no migration, no default user); with the switch off it is only logged;
//  - a failing update step rolls back, is named, and gets an error id; the marker line the desktop
//    reads round-trips.
// Run: node --import tsx --test test/store-p3-layout.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p3-layout-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.GIRRU_APP_VERSION = '1.6.0-test';
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const warnings = [];
console.log = () => {}; console.info = () => {}; console.warn = (...a) => warnings.push(a.join(' ')); console.error = () => {};

const { DatabaseManager } = await import(join(backendDir, 'src/db/database.ts'));
const layout = await import(join(backendDir, 'src/db/layout.ts'));
const open = async (path) => { const m = new DatabaseManager({ path }); try { await m.initialize(); return m; } finally { m.close?.(); } };
const fresh = join(dir, 'fresh.db');

test('start-up records the level and the version that opened the data', async () => {
  process.env.GIRRU_STORE_P3 = '1';
  await open(fresh);
  const db = new Database(fresh, { readonly: true });
  const row = db.prepare('SELECT level, written_by FROM schema_layout WHERE id = 1').get();
  const top = readdirSync(join(backendDir, 'src/db/migrations')).filter((f) => f.endsWith('.sql')).map((f) => f.split('_')[0]).sort().pop();
  db.close();
  assert.deepEqual({ ...row }, { level: top, written_by: '1.6.0-test' });
});

test('data from a newer Girru is refused before anything is written', async () => {
  const newer = join(dir, 'newer.db');
  copyFileSync(fresh, newer);
  const db = new Database(newer);
  db.prepare("INSERT INTO migrations (id, name) VALUES ('999', '999_from_the_future')").run();
  db.prepare("UPDATE schema_layout SET written_by = '1.7.0' WHERE id = 1").run();
  db.prepare("DELETE FROM users WHERE id = 'mock-user'").run();
  db.close();
  const before = statSync(newer).mtimeMs;
  await assert.rejects(open(newer), (err) => err instanceof layout.StartProblem && err.kind === 'layout_newer'
    && err.details.writtenBy === '1.7.0' && err.details.unknown.join() === '999' && /newer Girru \(1\.7\.0\)/.test(err.message));
  const after = new Database(newer, { readonly: true });
  assert.equal(after.prepare("SELECT COUNT(*) AS n FROM users WHERE id = 'mock-user'").get().n, 0, 'the default user was not added: nothing written');
  after.close();
  assert.equal(statSync(newer).mtimeMs, before);
  delete process.env.GIRRU_STORE_P3;
  warnings.length = 0;
  await open(newer);
  assert.ok(warnings.some((w) => w.includes('999')), 'switch off: only logged');
});

test('a failing update step is named, rolled back, and has an error id', async () => {
  process.env.GIRRU_STORE_P3 = '1';
  const broken = join(dir, 'broken.db');
  const db = new Database(broken);
  db.exec(`CREATE TABLE migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  // A table the first migration creates already exists with another shape: that step fails.
  db.exec('CREATE TABLE avatar_settings (junk TEXT)');
  db.close();
  let caught;
  await open(broken).catch((err) => { caught = err; });
  assert.ok(caught instanceof layout.StartProblem, String(caught));
  assert.equal(caught.kind, 'migration_failed');
  assert.match(caught.details.errorId, /^E-[0-9A-F]{4}-[0-9A-F]{2}$/);
  assert.ok(caught.details.step);
  const check = new Database(broken, { readonly: true });
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM migrations WHERE name = ?').get(caught.details.step).n, 0, 'the failed step is not recorded');
  check.close();
  const lines = [];
  assert.equal(layout.reportStartProblem(caught, (l) => lines.push(l)), true);
  const parsed = layout.parseStartProblem(lines[0]);
  assert.equal(parsed.kind, 'migration_failed');
  assert.equal(parsed.errorId, caught.details.errorId);
  assert.equal(layout.reportStartProblem(new Error('other')), false);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
