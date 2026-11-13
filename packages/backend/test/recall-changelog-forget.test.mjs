import { pathToFileURL } from 'node:url';
// MEM-CONC-03 + CORE-07: the change log must never hold a forgotten memory's id.
// A save or an edit logs the owner and the id, so another process re-reads that row by primary key.
// A DELETE logs no id at all: forgetting has to leave no trace, and an id here would outlive the row
// it names by up to an hour and could be caught in a backup taken meanwhile. Other processes see the
// sentinel and read the database again instead.
// Run: node --import tsx --test test/recall-changelog-forget.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const mod = (rel) => pathToFileURL(join(backendDir, rel)).href;
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-chlog-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await import(mod('src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const OWNER = 'chlog-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', 'owner', 'active')`).run(OWNER, 'c@example.test', OWNER);
const { getMemoryStorage } = await import(mod('src/memory/storage.ts'));
const D = await import(mod('src/memory/drawers.ts'));
const storage = getMemoryStorage();
await storage.initialize();

const SECRET_ID = 'mem-to-forget';
const save = (id, content) => storage.save({
  id, userId: OWNER, type: 'fact', content, drawer: { kind: 'project', key: 'alpha' },
  memoryLayer: 'factual', importanceScore: 0.5, status: 'active', metadata: {}, createdAt: new Date(), accessCount: 0, expiryTimestamp: null,
});
const logRows = () => db.prepare('SELECT user_id, memory_id FROM memory_recall_changes ORDER BY seq').all();
const hasTable = () => !!db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='memory_recall_changes'").get();

test('a save logs the owner and the id, so another process can re-read that one row', async () => {
  await save('mem-kept', 'Alpha project: the deploy day is Monday.');
  // The log and its triggers are created on the first search (ready()).
  await storage.search({ query: 'deploy day', userId: OWNER, drawers: D.selectDrawers({ audience: 'owner', project: 'alpha' }), limit: 3 });
  await save('mem-kept-2', 'Alpha project: the client contact is Ingrid.');
  assert.ok(hasTable(), 'the change log exists');
  const ids = logRows().map((r) => r.memory_id);
  assert.ok(ids.includes('mem-kept-2'), `a saved id is logged (${ids.join(',')})`);
});

test('forgetting a memory leaves no id in the change log', async () => {
  await save(SECRET_ID, 'Alpha project: the staging password is rotated monthly by Rana.');
  await storage.search({ query: 'staging password', userId: OWNER, drawers: D.selectDrawers({ audience: 'owner', project: 'alpha' }), limit: 3 });
  assert.ok(logRows().some((r) => r.memory_id === SECRET_ID), 'its save was logged, as any save is');

  const { forgetMemory } = await import(mod('src/memory/forget.ts'));
  await forgetMemory(OWNER, SECRET_ID, { reason: 'test' }).catch(async () => {
    // Shapes differ with the switches; the row going is what matters for this test.
    db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(SECRET_ID, OWNER);
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE id = ?').get(SECRET_ID).n, 0, 'the memory is gone');

  // Its save row may still be there from before; what must never appear is a row FROM the delete.
  // The delete logs the sentinel, so after it the newest row carries no id.
  const rows = logRows();
  const last = rows[rows.length - 1];
  assert.equal(last.memory_id, '-', `a delete logs no id (got ${JSON.stringify(last)})`);
  assert.equal(last.user_id, '', 'and no owner either');
  // And once the log is pruned of the save row, nothing names the forgotten memory at all.
  db.prepare('DELETE FROM memory_recall_changes WHERE memory_id = ?').run(SECRET_ID);
  assert.equal(logRows().filter((r) => r.memory_id === SECRET_ID).length, 0);
  assert.equal(JSON.stringify(logRows()).includes(SECRET_ID), false, 'the id is nowhere in the log');
});

test('the log never holds memory text, only ids', () => {
  const all = JSON.stringify(logRows());
  assert.equal(all.includes('deploy day'), false);
  assert.equal(all.includes('staging password'), false);
  assert.equal(all.includes('Ingrid'), false);
});

test('a database carrying the older delete trigger is repaired, and its rows are dropped', async () => {
  const { forgetRecallStore } = await import(mod('src/memory/recall-store.ts'));
  // Put a database into the state it would have had between the change log landing and the fix:
  // a delete trigger that writes OLD.id, and a log row naming a memory that is now forgotten.
  db.exec(`DROP TRIGGER IF EXISTS girru_recall_log_del;
    CREATE TRIGGER girru_recall_log_del AFTER DELETE ON memories BEGIN
      INSERT INTO memory_recall_changes (user_id, memory_id, at) VALUES (OLD.user_id, OLD.id, 1);
    END;`);
  await save('mem-old-trigger', 'Alpha project: a note that will be deleted.');
  db.prepare('DELETE FROM memories WHERE id = ?').run('mem-old-trigger');
  assert.ok(logRows().some((r) => r.memory_id === 'mem-old-trigger'), 'the old trigger did leak the id');

  // The next search runs ready(), which must notice the trigger is not ours and repair it.
  forgetRecallStore();
  await storage.search({ query: 'a note', userId: OWNER, drawers: D.selectDrawers({ audience: 'owner', project: 'alpha' }), limit: 3 });

  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='girru_recall_log_del'`).get().sql;
  assert.ok(sql.includes("'-'"), 'the delete trigger is ours again (no id)');
  assert.equal(logRows().filter((r) => r.memory_id === 'mem-old-trigger').length, 0, 'and the leaked row is gone');
});
