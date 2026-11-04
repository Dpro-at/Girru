// STORE-MAP-01 P9 (GIRRU_STORE_P9) D10, S8, PRIV4: backups that really restore, and the forget ledger.
//  - switch off: a backup has no restoreTest and the status no restoreTested (as before);
//  - switch on: every backup is restored into a scratch folder and checked before it is signed;
//    a copy that does not hold what was saved fails the test and the backup is not "checked";
//  - files 0600, folders 0700; the signing key, the ledger key and the replay marker are never
//    in a backup; the ledger is (for a new computer);
//  - forget writes a ledger line with ids and a keyed hash only (never the text);
//  - restoring a backup made before a forget brings the memory back, and the next start's replay
//    forgets it again, plus the very same text saved under another id; the marker then goes;
//  - pgDumpStatus finds a recent dump file in the backups folder.
// Run: node --import tsx --test test/store-p9-backups.test.mjs
// Throwaway DB/keys/folders + HOME; no network.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-store-p9-backups-'));
const data = join(dir, '.data');
const outside = join(dir, 'Girru Backups');
mkdirSync(join(data, 'agents', 'g-lead'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = data;
process.env.DATABASE_PATH = join(data, 'agent-player.db');
process.env.GIRRU_BACKUPS_DIR = outside;
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.GIRRU_STORE_P9 = '0';
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {}; console.log = quiet; console.info = quiet; console.warn = quiet;
after(() => rmSync(dir, { recursive: true, force: true }));

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
let db = getDatabase();
await db.initialize();
const OWNER = 'p9b-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', 'owner', 'active')`).run(OWNER, `${OWNER}@example.test`, OWNER);
writeFileSync(join(data, 'agents', 'g-lead', 'rules.md'), 'be kind\n');

const B = await import(join(backendDir, 'src/services/backups.ts'));
const L = await import(join(backendDir, 'src/memory/forget-ledger.ts'));
const { forgetMemory } = await import(join(backendDir, 'src/memory/forget.ts'));
const { getMemoryStorage } = await import(join(backendDir, 'src/memory/storage.ts'));
const storage = getMemoryStorage();
await storage.initialize();
const manifest = (id) => JSON.parse(readFileSync(join(B.workspaceBackupsDir(), id, 'manifest.json'), 'utf8'));
const save = (id, content) => storage.save({ id, userId: OWNER, type: 'fact', content, memoryLayer: 'factual', importanceScore: 0.5, status: 'active', metadata: {}, createdAt: new Date(), drawer: { kind: 'owner' } });
const has = (id) => !!getDatabase().prepare('SELECT 1 FROM memories WHERE id = ?').get(id);

test('switch off: nothing new in a backup', async () => {
  const b = await B.backUpNow('manual');
  assert.equal(b.checked, true);
  assert.equal(manifest(b.id).restoreTest, undefined);
  assert.equal('restoreTested' in b, false);
});

test('switch on: a backup is restored for real into a scratch folder before it is signed', async () => {
  process.env.GIRRU_STORE_P9 = '1';
  await save('mem-keep', 'The office opens at nine.');
  const b = await B.backUpNow('manual', new Date(Date.now() + 2000));
  const m = manifest(b.id);
  assert.equal(m.restoreTest.ok, true);
  assert.ok(m.restoreTest.tables > 50);
  assert.equal(m.restoreTest.memories, 1);
  assert.equal(b.restoreTested, true);
  assert.equal(b.checked, true);
  assert.match(m.mac, /^[0-9a-f]{64}$/);
  // Owner-only files and folders.
  const bdir = join(B.workspaceBackupsDir(), b.id);
  assert.equal(statSync(B.workspaceBackupsDir()).mode & 0o777, 0o700);
  assert.equal(statSync(bdir).mode & 0o777, 0o700);
  for (const e of m.entries) assert.equal(statSync(join(bdir, e.root, e.path)).mode & 0o077, 0, e.path);
  // A copy that does not hold what was saved fails.
  const main = m.entries.find((e) => e.type === 'sqlite' && e.path === 'agent-player.db');
  const bad = await B.restoreTest(bdir, main, { tables: m.restoreTest.tables, memories: 99 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /does not hold/);
  const changed = await B.restoreTest(bdir, { ...main, sha256: '0'.repeat(64) }, null);
  assert.equal(changed.ok, false);
  assert.match(changed.error, /checksum/);
  // No scratch folder is left behind.
  assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith('girru-restore-test-')).every((n) => !existsSync(join(tmpdir(), n, 'restored.db'))), true);
  process.env.GIRRU_STORE_P9 = '0';
});

test('forget writes ids and a keyed hash only; a restore brings it back and the replay forgets it again', async () => {
  process.env.GIRRU_STORE_P9 = '1';
  await save('mem-secret', 'My bank PIN hint is the blue door.');
  await save('mem-twin', 'Project Falcon ships on Friday.');
  const before = await B.backUpNow('manual', new Date(Date.now() + 4000));
  assert.equal(manifest(before.id).restoreTest.memories, 3);

  assert.ok(await forgetMemory(OWNER, 'mem-secret', OWNER));
  // The same text as mem-twin under another id: deleted plainly, saved again, then forgotten.
  getDatabase().prepare("DELETE FROM memories WHERE id = 'mem-twin'").run();
  await save('mem-twin-2', 'Project Falcon ships on Friday.');
  assert.ok(await forgetMemory(OWNER, 'mem-twin-2', OWNER));
  assert.equal(has('mem-secret'), false);

  const ledgerText = readFileSync(join(data, L.LEDGER_FILE), 'utf8');
  assert.doesNotMatch(ledgerText, /PIN|blue door|Falcon|Friday/);
  const lines = L.readLedger();
  assert.deepEqual(lines.map((l) => l.memoryId).sort(), ['mem-secret', 'mem-twin-2']);
  assert.ok(lines.every((l) => /^[0-9a-f]{64}$/.test(l.mac) && l.userId === OWNER && l.kind === 'memory'));
  assert.equal(statSync(join(data, L.LEDGER_FILE)).mode & 0o077, 0);

  // The next backup carries the ledger but never its key or a replay marker.
  const later = await B.backUpNow('manual', new Date(Date.now() + 6000));
  const paths = manifest(later.id).entries.map((e) => e.path);
  assert.ok(paths.includes(L.LEDGER_FILE));
  for (const p of [L.LEDGER_KEY_FILE, L.REPLAY_MARKER, 'backups.key']) assert.ok(!paths.includes(p), p);

  // Restore the backup from before the forget.
  await B.requestRestore(before.id);
  closeDatabase();
  const done = await B.applyPendingRestore();
  assert.equal(done.ok, true, done.error);
  assert.ok(L.replayPending(), 'the replay marker is left for the next start');
  assert.equal(L.readLedger().length, 2, 'the current ledger stays');
  db = getDatabase();
  await db.initialize();
  assert.equal(has('mem-secret'), true, 'the old backup holds it');
  assert.equal(has('mem-twin'), true);

  const r = await L.replayForgetLedger();
  assert.equal(r.failed, 0);
  assert.equal(has('mem-secret'), false, 'forgotten again');
  assert.equal(has('mem-twin'), false, 'the same text under another id goes too');
  assert.equal(has('mem-keep'), true);
  assert.equal(L.replayPending(), false);
  assert.ok(L.readLedger().some((l) => l.memoryId === 'mem-twin'), 'the twin forgotten by the replay has its own line');
  const again = await L.replayForgetLedger();
  assert.equal(again.forgotten, 0, 'idempotent');
  process.env.GIRRU_STORE_P9 = '0';
});

test('a new computer: the backup ledger lines are added to an empty current ledger', () => {
  const copy = join(dir, 'ledger-from-backup.jsonl');
  writeFileSync(copy, readFileSync(join(data, L.LEDGER_FILE)));
  const n = L.readLedger().length; // the replay added the twin it forgot
  rmSync(join(data, L.LEDGER_FILE));
  L.mergeLedgerAfterRestore(copy);
  assert.equal(L.readLedger().length, n);
  assert.ok(L.replayPending());
  rmSync(join(data, L.REPLAY_MARKER));
  // A broken line is skipped, never fatal.
  writeFileSync(copy, '{"v":1,"at":"x","userId":"../etc","memoryId":"m","kind":"memory"}\nnot json\n');
  L.mergeLedgerAfterRestore(copy);
  assert.equal(L.readLedger().length, n);
  rmSync(join(data, L.REPLAY_MARKER));
});

test('pgDumpStatus: a recent dump file in the backups folder', () => {
  const now = new Date();
  assert.equal(B.pgDumpStatus(now).fresh, false);
  const f = join(B.backupsFolder(), 'girru-2026-11-03.dump');
  writeFileSync(f, 'PGDMP');
  assert.equal(B.pgDumpStatus(now).fresh, true);
  const old = new Date(now.getTime() - 3 * 86_400_000);
  utimesSync(f, old, old);
  const st = B.pgDumpStatus(now);
  assert.equal(st.fresh, false);
  assert.ok(st.ageHours > 70);
});
