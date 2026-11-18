// B2.2b-2 (SQLite mode, no PostgreSQL needed):
//  - the runtime DDL sources of migrations-pg r001-r003 (scripts/pg/runtime)
//    equal the DDL the TypeScript runs on SQLite, so the two cannot drift
//    (B2.2b-4: r004/r005, the memory hybrid index and its FTS5 table, too);
//  - the SQLite DDL of the vault/key tables is unchanged ('credentials', 'keys');
//  - team invitation rows have one expires_at shape on both drivers;
//  - the shutdown audit flush is bounded and never rejects.
// Run: node --import tsx --test test/pg-runtime-ddl.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-pg-runtime-ddl-'));
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
delete process.env.AGENT_PLAYER_DB;

const { CREDENTIALS_INDEXES_SQL } = await import(join(backendDir, 'src/credentials/storage.ts'));
const { vaultSchemaSql, vaultTableFor } = await import(join(backendDir, 'src/encryption/credential-vault.ts'));
const { keysSchemaSql, keysTableFor } = await import(join(backendDir, 'src/encryption/key-manager.ts'));
const teams = await import(join(backendDir, 'src/repositories/teams.ts'));
const audit = await import(join(backendDir, 'src/services/audit-logger.ts'));
const { INDEXER_TABLES_SQL, INDEXER_FTS_SQL } = await import(join(backendDir, 'src/memory/indexer.ts'));
const { APP_SETTINGS_SQL } = await import(join(backendDir, 'src/settings/settings-manager.ts'));
const auditStorage = await import(join(backendDir, 'src/audit/audit-storage.ts'));
const { WEBHOOKS_SCHEMA_SQL } = await import(join(backendDir, 'src/webhooks/manager.ts'));
const { orchestratorSchemaSql, orchestratorTablesFor } = await import(join(backendDir, 'src/multi-agent/orchestrator.ts'));

test.after(() => {
  process.chdir(backendDir);
  rmSync(dir, { recursive: true, force: true });
});

/** Statements without comments, whitespace collapsed (the comparison unit). */
function statements(sql) {
  return sql.replace(/--[^\n]*/g, '').split(';').map((s) => s.replace(/\s+/g, ' ').replace(/\s*\(\s*/g, '(').replace(/\s*\)\s*/g, ')').trim()).filter(Boolean);
}
const runtime = (f) => readFileSync(join(backendDir, 'scripts', 'pg', 'runtime', f), 'utf8');

test('r001 equals the credentials indexes storage.ts creates on SQLite', () => {
  assert.deepEqual(statements(runtime('r001_credentials_indexes.sql')), statements(CREDENTIALS_INDEXES_SQL));
});

test('r002 equals the vault DDL for vault_credentials; SQLite keeps `credentials`', () => {
  assert.equal(vaultTableFor('postgres'), 'vault_credentials');
  assert.equal(vaultTableFor('sqlite'), 'credentials');
  assert.deepEqual(statements(runtime('r002_vault_credentials.sql')), statements(vaultSchemaSql('vault_credentials')));
  assert.match(vaultSchemaSql(), /CREATE TABLE IF NOT EXISTS credentials \(/);
  assert.match(vaultSchemaSql(), /idx_cred_owner ON credentials\(owner_id, owner_type\)/);
});

test('r003 equals the key manager DDL for vault_keys; SQLite keeps `keys`', () => {
  assert.equal(keysTableFor('postgres'), 'vault_keys');
  assert.equal(keysTableFor('sqlite'), 'keys');
  assert.deepEqual(statements(runtime('r003_vault_keys.sql')), statements(keysSchemaSql('vault_keys')));
  assert.match(keysSchemaSql(), /CREATE TABLE IF NOT EXISTS keys \(/);
});

test('the generated migrations-pg r001-r003 exist and name the PostgreSQL tables', () => {
  const pg = (f) => readFileSync(join(backendDir, 'src', 'db', 'migrations-pg', f), 'utf8');
  assert.match(pg('r001_credentials_indexes.sql'), /CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_name_user ON credentials \(name, user_id\)/);
  assert.match(pg('r002_vault_credentials.sql'), /CREATE TABLE IF NOT EXISTS vault_credentials \(/);
  assert.match(pg('r003_vault_keys.sql'), /CREATE TABLE IF NOT EXISTS vault_keys \(/);
  assert.doesNotMatch(pg('r002_vault_credentials.sql') + pg('r003_vault_keys.sql'), /PRAGMA|datetime\(/i);
});

test('r004/r005 equal the hybrid index DDL indexer.ts runs on SQLite; r005 is the tsvector override', () => {
  assert.deepEqual(statements(runtime('r004_memory_index.sql')), statements(INDEXER_TABLES_SQL));
  assert.deepEqual(statements(runtime('r005_memory_fts.sql')), statements(INDEXER_FTS_SQL));
  assert.match(INDEXER_FTS_SQL, /CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5\(/);
  const pg = (f) => readFileSync(join(backendDir, 'src', 'db', 'migrations-pg', f), 'utf8');
  assert.match(pg('r004_memory_index.sql'), /CREATE TABLE IF NOT EXISTS memory_index \(/);
  assert.match(pg('r004_memory_index.sql'), /embedding bytea/);
  const fts = pg('r005_memory_fts.sql');
  assert.match(fts, /HAND-WRITTEN override: scripts\/pg\/overrides\/r005_memory_fts\.sql/);
  assert.match(fts, /ADD COLUMN IF NOT EXISTS fts tsvector\s+GENERATED ALWAYS AS \(to_tsvector\('simple', /);
  assert.match(fts, /CREATE INDEX IF NOT EXISTS idx_memory_index_fts ON memory_index USING gin \(fts\)/);
  assert.doesNotMatch(statements(fts).join(';'), /CREATE EXTENSION|VIRTUAL|fts5/i, 'no extension, no FTS5 on PostgreSQL');
});

test('B2.2c: r006 equals the settings manager DDL; r007 equals the security event store DDL for PostgreSQL', () => {
  assert.deepEqual(statements(runtime('r006_app_settings.sql')), statements(APP_SETTINGS_SQL));
  assert.equal(auditStorage.auditEventsTableFor('postgres'), 'security_audit_events');
  assert.equal(auditStorage.auditEventsTableFor('sqlite'), 'audit_events');
  assert.deepEqual(statements(runtime('r007_security_audit_events.sql')), statements(auditStorage.auditEventsSchemaSql('security_audit_events')));
  // SQLite keeps its table and index names in its own file.
  const sqliteDdl = auditStorage.auditEventsSchemaSql();
  assert.match(sqliteDdl, /CREATE TABLE IF NOT EXISTS audit_events \(/);
  assert.match(sqliteDdl, /CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events\(timestamp\)/);
  const pg = (f) => readFileSync(join(backendDir, 'src', 'db', 'migrations-pg', f), 'utf8');
  assert.match(pg('r006_app_settings.sql'), /CREATE TABLE IF NOT EXISTS app_settings \(/);
  assert.match(pg('r007_security_audit_events.sql'), /CREATE TABLE IF NOT EXISTS security_audit_events \(/);
  assert.doesNotMatch(pg('r007_security_audit_events.sql'), /idx_audit_/, 'no clash with the audit_logs indexes');
});

test('B2.2c: the SQLite security event store (own file) stores, queries, counts and cleans up synchronously', async () => {
  const store = new auditStorage.AuditStorage(join(dir, 'audit-test', 'audit.db'), { retentionDays: 1, maxEvents: 1000 });
  const s = { ...console };
  console.log = () => {};
  try { await store.initialize(); } finally { Object.assign(console, s); }
  const ev = (id, ms, action = 'login_failed') => ({
    id, timestamp: new Date(ms), category: 'auth', action, severity: 'medium',
    actor: { type: 'user', id: 'u1' }, result: 'failure', details: { note: `Note ${id}` },
  });
  try {
    assert.equal(store.store(ev('e1', Date.now())), undefined, 'synchronous on SQLite');
    store.store(ev('e1', Date.now())); // a duplicate id is ignored
    store.store(ev('e2', Date.now() - 3 * 86_400_000, 'execute_blocked'));
    const q = store.query({ search: 'NOTE E1' });
    assert.ok(Array.isArray(q), 'plain array on SQLite');
    assert.deepEqual(q.map((e) => e.id), ['e1'], 'search ignores case');
    assert.equal(store.getById('e1').actor.id, 'u1');
    assert.equal(store.getById('missing'), null);
    const st = store.getStats();
    assert.equal(st.totalEvents, 2);
    assert.equal(st.failedLogins24h, 1);
    assert.equal(st.blockedExecutions24h, 0);
    assert.equal(store.cleanup(), 1, 'older than the retention removed');
    assert.deepEqual(JSON.parse(store.exportToJson()).map((e) => e.id), ['e1']);
  } finally {
    store.close();
  }
});

test('invitationRow: PostgreSQL timestamptz text becomes the ISO string; SQLite rows are unchanged', () => {
  const iso = '2026-10-21T16:05:07.123Z';
  const sqliteRow = { id: 'i1', expires_at: iso, created_at: '2026-10-14 16:05:07' };
  assert.equal(teams.invitationRow('sqlite', sqliteRow), sqliteRow);
  const pgRow = { id: 'i1', expires_at: '2026-10-21 16:05:07.123', created_at: '2026-10-14 16:05:07' };
  const out = teams.invitationRow('postgres', pgRow);
  assert.deepEqual(out, { ...pgRow, expires_at: iso });
  assert.equal(teams.invitationRow('postgres', { id: 'i2', expires_at: '2026-10-21 16:05:07' }).expires_at, '2026-10-21T16:05:07.000Z');
  assert.equal(teams.invitationRow('postgres', undefined), undefined);
  assert.deepEqual(teams.invitationRow('postgres', { id: 'x' }), { id: 'x' });
});

test('SQLite invite(): expires_at is the ISO string (the shape PostgreSQL now matches)', async () => {
  const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
  const { userActor } = await import(join(backendDir, 'src/repositories/actor.ts'));
  const db = getDatabase();
  const s = { ...console };
  console.log = () => {};
  try { await db.initialize(); } finally { Object.assign(console, s); }
  try {
    for (const [id, role] of [['rt-owner', 'owner'], ['rt-user', 'user']]) {
      db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`).run(id, `${id}@example.test`, id, role);
    }
    const owner = userActor({ id: 'rt-owner', role: 'owner' });
    const team = await teams.sqliteTeams.createTeam(owner, { name: 'RT' });
    const inv = await teams.sqliteTeams.invite(owner, team.id, { email: 'rt-user@example.test', role: 'user' });
    assert.match(inv.invitation.expires_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const listed = await teams.sqliteTeams.teamInvitations(owner, team.id);
    assert.equal(listed[0].expires_at, inv.invitation.expires_at);
  } finally {
    closeDatabase();
  }
});

test('flushAuditWritesWithin: true when the writes finish, false after the bound, never rejects', async () => {
  assert.equal(await audit.flushAuditWritesWithin(500), true); // nothing pending on SQLite
  assert.equal(await audit.flushAuditWritesWithin(500, async () => {}), true);
  const t0 = Date.now();
  assert.equal(await audit.flushAuditWritesWithin(100, () => new Promise(() => {})), false);
  const took = Date.now() - t0;
  assert.ok(took >= 90 && took < 1000, `bounded wait, took ${took} ms`);
  assert.equal(await audit.flushAuditWritesWithin(500, async () => { throw new Error('db down'); }), false);
  assert.equal(await audit.flushAuditWritesWithin(500, () => { throw new Error('sync throw'); }), false);
  assert.equal(audit.SHUTDOWN_AUDIT_FLUSH_MS, 2000);
});

test('server shutdown path calls the bounded flush after fastify.close()', () => {
  const src = readFileSync(join(backendDir, 'src', 'api', 'server-main.ts'), 'utf8');
  const close = src.indexOf('await fastify.close();');
  const flush = src.indexOf('await flushAuditWritesWithin(SHUTDOWN_AUDIT_FLUSH_MS)');
  // BACKUP-01: the exit code is 0, or the restart code a restore asks for.
  const exit = src.indexOf('process.exit(code);', close);
  assert.ok(close > 0 && flush > close && exit > flush, 'close -> bounded flush -> exit');
});

test('B2.2c part 2: r008 equals the webhook store DDL (its own SQLite file; the main database on PostgreSQL)', () => {
  assert.deepEqual(statements(runtime('r008_webhooks.sql')), statements(WEBHOOKS_SCHEMA_SQL));
  const pg = readFileSync(join(backendDir, 'src', 'db', 'migrations-pg', 'r008_webhooks.sql'), 'utf8');
  for (const t of ['webhooks', 'inbound_webhooks', 'webhook_deliveries']) assert.match(pg, new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`));
  assert.doesNotMatch(pg, /PRAGMA|datetime\(/i);
});

test('B2.2d-15: r009 equals the orchestrator DDL for the orchestrator_* tables; SQLite keeps agents/teams/tasks', () => {
  assert.deepEqual(orchestratorTablesFor('postgres'), { agents: 'orchestrator_agents', teams: 'orchestrator_teams', tasks: 'orchestrator_tasks' });
  assert.deepEqual(statements(runtime('r009_orchestrator.sql')), statements(orchestratorSchemaSql(orchestratorTablesFor('postgres'))));
  const pg = readFileSync(join(backendDir, 'src', 'db', 'migrations-pg', 'r009_orchestrator.sql'), 'utf8');
  for (const t of ['orchestrator_agents', 'orchestrator_teams', 'orchestrator_tasks']) assert.match(pg, new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`));
  assert.match(pg, /idx_orchestrator_tasks_status ON orchestrator_tasks/);
  // The main schema's own `teams` table is not touched.
  assert.doesNotMatch(pg, /CREATE TABLE IF NOT EXISTS teams \(/);
});
