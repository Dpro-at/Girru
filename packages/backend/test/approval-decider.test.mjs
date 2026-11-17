// SEC-GATE-02: every approval records WHO decided it (human / rule / model / system).
// Throwaway DB, no network. Proves the decided_by_kind column, its migration and the deny wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-decider-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.HOME = join(dir, 'home'); mkdirSync(process.env.HOME);
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
const quiet = { log: console.log, warn: console.warn };
console.log = () => {}; console.warn = () => {};

const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
const db = getDatabase();
await db.initialize();
const { denyApproval, getApproval } = await import('../src/tools/approvals.ts');
console.log = quiet.log; console.warn = quiet.warn;

test.after(() => { closeDatabase(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

function insertPending() {
  const id = randomUUID();
  db.prepare(`INSERT INTO tool_approvals (id, status, agent_id, user_id, session_id, tool_name, category,
      params_encrypted, params_iv, params_tag, params_preview, params_hash, params_salt)
    VALUES (?, 'pending', 'a1', 'owner-1', 's1', 'run_command_owner', 'other', 'x', 'y', 'z', '{}', 'h', 's')`).run(id);
  return id;
}

test('the migration adds decided_by_kind to tool_approvals', () => {
  const cols = db.prepare('PRAGMA table_info(tool_approvals)').all().map((c) => c.name);
  assert.ok(cols.includes('decided_by_kind'), 'decided_by_kind column exists');
});

test('a pending approval has no decider yet; an owner deny records "human"', async () => {
  const id = insertPending();
  const before = await getApproval(id);
  assert.equal(before.status, 'pending');
  assert.equal(before.decidedByKind, null, 'not decided yet');

  const record = await denyApproval(id, 'owner-1');
  assert.equal(record.status, 'denied');
  assert.equal(record.decidedBy, 'owner-1');
  assert.equal(record.decidedByKind, 'human', 'an owner decision is a human decider');
});
