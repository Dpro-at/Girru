// B2.2b-3 / B2.2b-4: no ported module may reach a synchronous SQLite
// transaction (or any raw better-sqlite3 call) on the PostgreSQL path. Their SQL runs through
// repositories/sql-steps.ts, which is the only place that opens a SQLite
// transaction for them (and only when the driver is SQLite).
// Run: node --import tsx --test test/pg-ported-transactions.test.mjs
//
// Two parts:
//  1. a static scan of the ported modules (comments stripped): no
//     getDatabase / getDb / .prepare / .transaction / withSqliteTransaction,
//     no rowid or lastInsertRowid, no raw SQLite-only SQL forms
//     (datetime(, strftime(, INSERT OR ...) outside the dialect helpers;
//  2. the switch itself: with AGENT_PLAYER_DB=postgres the step runner,
//     withTransaction and the synchronous grant loader all take the
//     PostgreSQL path (no database is opened: without a PostgreSQL URL the
//     PostgreSQL path fails with PgConfigError, never with a SQLite result).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const movedTelephony=new Set(['src/api/routes/telephony.ts','src/services/telephony-service.ts','src/telephony/ivr-engine.ts','src/telephony/voice-handler.ts']);
const sourcePath=rel=>movedTelephony.has(rel)?join(backend,'test/fixtures/legacy-apps',rel):join(backend,rel);

// Every store under a temp folder: importing the modules below may open the
// main SQLite database at the default path (<cwd>/.data, the real .data when
// run from the main checkout).
const startDir = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), 'ap-pg-ported-'));
process.chdir(tmp);
process.env.HOME = tmp;
process.env.AGENT_PLAYER_DATA_DIR = join(tmp, 'data');
process.env.DATABASE_PATH = join(tmp, 'data', 'agent-player.db');
test.after(() => {
  process.chdir(startDir);
  rmSync(tmp, { recursive: true, force: true });
});

/** Every module ported to the driver-neutral SQL steps (B2.2b-3, B2.2b-4 memory). */
export const PORTED = [
  'src/repositories/agents.ts',
  'src/repositories/agents-config.ts',
  'src/repositories/task-runs.ts',
  'src/services/agent-names.ts',
  'src/services/personality-store.ts',
  'src/services/personality-evolution.ts',
  'src/services/evolution-proposals.ts',
  'src/services/task-runs.ts',
  'src/services/task-contracts.ts',
  'src/services/task-run-executor.ts',
  'src/services/cost-budget.ts',
  'src/services/small-agent.ts',
  'src/services/agent-cron.ts',
  'src/tools/grants.ts',
  'src/tools/approvals.ts',
  'src/credentials/authority.ts',
  'src/llm/model-call.ts',
  // B2.2b-4: memory
  'src/repositories/memory.ts',
  'src/repositories/memory-recall.ts',
  'src/repositories/memory-owner.ts',
  'src/repositories/memory-shared.ts',
  'src/memory/drawers.ts',
  'src/memory/storage.ts',
  'src/memory/versions.ts',
  'src/memory/learning.ts',
  'src/memory/memory-files.ts',
  'src/memory/forget.ts',
  'src/memory/retention.ts',
  'src/memory/weekly-summary.ts',
  'src/memory/reembed.ts',
  'src/memory/retrieval.ts',
  'src/memory/indexer-pg.ts',
  'src/memory/import/pipeline.ts',
  'src/services/memory-tiers.ts',
  'src/services/memory-consolidation.ts',
  'src/services/memory-deduplication.ts',
  'src/services/memory-enrichment.ts',
  'src/services/memory-quality-scorer.ts',
  // B2.2b-4: remaining readers of ported tables
  'src/api/routes/chat.ts',
  'src/api/routes/multi-agent.ts',
  'src/tools/tasks/task-create.tool.ts',
  'src/tools/tasks/task-list.tool.ts',
  // B2.2c part 1: scheduler, MCP discovery, settings, notifications, audit, sign-in throttle
  'src/scheduler/store.ts',
  'src/scheduler/engine.ts',
  'src/api/routes/scheduler.ts',
  'src/memory/jobs.ts',
  'src/mcp-client/store.ts',
  'src/mcp-client/service.ts',
  'src/mcp-client/tools.ts',
  'src/mcp-client/grant-binding.ts',
  'src/settings/settings-manager.ts',
  'src/services/notification-service.ts',
  'src/api/routes/notifications.ts',
  'src/tools/notifications/create-reminder.tool.ts',
  'src/services/extension-analytics.ts',
  'src/auth/account-lockout.ts',
  'src/repositories/pg/login-throttle.ts',
  'src/repositories/login-throttle.ts',
  // B2.2c part 2: evolution services and route
  'src/services/agent-learning-engine.js',
  'src/services/agent-evolution-scheduler.js',
  'src/services/agent-performance-analyzer.js',
  'src/services/agent-evolution-orchestrator.js',
  'src/api/routes/evolution.ts',
  // B2.2c part 2: credential-adjacent modules
  'src/webhooks/manager.ts',
  'src/webhooks/delivery.ts',
  'src/webhooks/index.ts',
  'src/api/routes/webhooks.ts',
  'src/services/telephony-service.ts',
  'src/telephony/voice-handler.ts',
  'src/telephony/ivr-engine.ts',
  'src/telephony/credentials.ts',
  'src/onboarding/web-wizard.ts',
  'src/api/routes/onboarding-web.ts',
  // B2.2c part 2: raw-SQL routes
  'src/api/routes/dashboard.ts',
  'src/api/routes/evaluation.ts',
  'src/api/routes/profile.ts',
  'src/api/routes/setup.ts',
  'src/api/routes/worlds.ts',
  'src/api/routes/world-bots.ts',
  'src/api/routes/multiverse.ts',
  'src/api/routes/extensions.ts',
  'src/api/routes/telephony.ts',
  'src/api/routes/avatar.ts',
];

/** Ported modules without SQL of their own (they compose ported services). */
const NO_SQL = new Set(['src/repositories/agents.ts', 'src/repositories/task-runs.ts', 'src/repositories/memory-owner.ts', 'src/memory/retrieval.ts',
  // B2.2c: compose the cron store
  'src/scheduler/engine.ts', 'src/api/routes/scheduler.ts',
  'src/api/routes/notifications.ts', 'src/tools/notifications/create-reminder.tool.ts', 'src/repositories/pg/login-throttle.ts',
  'src/repositories/login-throttle.ts',
  // B2.2c part 2: compose the webhook store / the wizard
  'src/webhooks/index.ts', 'src/api/routes/webhooks.ts', 'src/api/routes/onboarding-web.ts']);

const FORBIDDEN = [
  [/\bgetDatabase\s*\(/, 'getDatabase() (a raw SQLite handle)'],
  [/\.getDb\s*\(/, 'getDb() (the raw better-sqlite3 handle)'],
  [/\.prepare\s*\(/, '.prepare() (a better-sqlite3 statement)'],
  [/\.transaction\s*\(/, '.transaction() (a synchronous SQLite transaction)'],
  [/\bwithSqliteTransaction\b/, 'withSqliteTransaction (SQLite only)'],
  [/\.immediate\s*\(/, '.immediate() (BEGIN IMMEDIATE, SQLite only)'],
  [/\browid\b/i, 'rowid (SQLite only; order by a key instead)'],
  [/\blastInsertRowid\b/, 'lastInsertRowid (use RETURNING id)'],
  [/\bdatetime\s*\(/, "datetime( (use nowText / nowPlusText / tsParam)"],
  [/\bstrftime\s*\(/, 'strftime( (use nowIsoText / epochSeconds)'],
  [/\bINSERT\s+OR\s+(IGNORE|REPLACE)\b/i, 'INSERT OR ... (use insertOrIgnore / ON CONFLICT)'],
  // B2.2b-4
  [/\bjson_\w+\s*\(/, 'json_*() (SQLite JSON functions: do the JSON work in JS)'],
  [/\bsqlite_master\b/, 'sqlite_master (use tableExists from sql-steps)'],
  [/PRAGMA\s+table_info|pragma_table_info/i, 'PRAGMA table_info (use columnExists from sql-steps)'],
];

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/[^'"`\n]*$/gm, '$1');
}

/**
 * The paper-trading cron ledger in the scheduler is SQLite-only by design: it runs only
 * while the process driver is SQLite and is unavailable on PostgreSQL. Its blocks are
 * cut out before the scan, and each one must keep its SQLite-only guard.
 */
const PAPER_BLOCKS = ['private paperAvailable(', 'private registerPaper(', 'registerOwnedPaperJob(', 'private executePaper(', 'if(this.#paperOnly){'];
function withoutPaperLedger(rel, code) {
  if (rel !== 'src/scheduler/engine.ts') return code;
  for (const head of PAPER_BLOCKS) {
    const start = code.indexOf(head);
    assert.ok(start >= 0, `${rel}: ${head} not found`);
    let depth = 0, end = code.indexOf('{', start);
    for (; end < code.length; end++) { if (code[end] === '{') depth++; else if (code[end] === '}' && --depth === 0) break; }
    code = code.slice(0, start) + code.slice(end + 1);
  }
  return code;
}

test('the paper-trading cron ledger runs only on SQLite', () => {
  const engine = stripComments(readFileSync(join(backend, 'src/scheduler/engine.ts'), 'utf8'));
  assert.match(engine, /private paperAvailable\(\)[^{]*\{[^}]*dbDriver\(\)==='sqlite'/);
  assert.match(engine, /if\(this\.#paperOnly\)\{[\s\S]{0,200}dbDriver\(\)!=='sqlite'/);
  for (const fn of ['private registerPaper(', 'registerOwnedPaperJob(', 'private executePaper(']) {
    const body = engine.slice(engine.indexOf(fn), engine.indexOf('\n  }\n', engine.indexOf(fn)));
    assert.match(body, /paperAvailable\(\)|paperCurrent\(/, `${fn} checks the SQLite-only guard`);
  }
});

test('ported modules never call SQLite directly or use SQLite-only SQL', () => {
  const offenders = [];
  for (const rel of PORTED) {
    const code = withoutPaperLedger(rel, stripComments(readFileSync(sourcePath(rel), 'utf8')));
    for (const [re, what] of FORBIDDEN) {
      if (re.test(code)) offenders.push(`${rel}: ${what}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('ported modules take their SQL helpers from sql-steps (one runner per driver)', () => {
  const missing = PORTED.filter((rel) => {
    // Modules that only compose the ported services (scope checks, no SQL of their own).
    if (NO_SQL.has(rel)) return false;
    return !/from '(?:\.\.?\/)+(?:src\/)?(?:repositories\/)?sql-steps\.js'/.test(readFileSync(sourcePath(rel), 'utf8'));
  });
  assert.deepEqual(missing, []);
});

test('sql-steps is the only SQLite transaction left, and only on the SQLite runner', () => {
  const src = stripComments(readFileSync(join(backend, 'src/repositories/sql-steps.ts'), 'utf8'));
  const txCalls = src.match(/\.transaction\s*\(/g) ?? [];
  assert.equal(txCalls.length, 2, 'sqliteOp (atomic) and sqliteSteps.tx');
  // The PostgreSQL runner and the PostgreSQL op driver use withPgTransaction only.
  const pgPart = src.slice(src.indexOf('async function pgOp'), src.indexOf('function driveSync'));
  assert.match(pgPart, /withPgTransaction/);
  assert.doesNotMatch(pgPart, /getDatabase|\.transaction\(/);
  const pgSteps = src.slice(src.indexOf('export const pgSteps'), src.indexOf('export function stepsFor'));
  assert.match(pgSteps, /withPgTransaction\(\(\) => driveAsync/);
  assert.doesNotMatch(pgSteps, /getDatabase|driveSync|\.transaction\(/);
});

test('with AGENT_PLAYER_DB=postgres every ported path takes PostgreSQL', async () => {
  const saved = { db: process.env.AGENT_PLAYER_DB, url: process.env.AGENT_PLAYER_PG_URL };
  const steps = await import('../src/repositories/sql-steps.ts');
  const { withTransaction } = await import('../src/repositories/transaction.ts');
  const { loadAgentGrantsSync } = await import('../src/tools/grants.ts');
  const { PgConfigError } = await import('../src/db/pg/config.ts');
  const { closePgPool } = await import('../src/db/pg/pool.ts');
  const owner = { kind: 'user', userId: 'pt-owner', role: 'owner' };
  try {
    process.env.AGENT_PLAYER_DB = 'postgres';
    delete process.env.AGENT_PLAYER_PG_URL;
    assert.equal(steps.sql().dialect, 'postgres');
    assert.equal(steps.sql(), steps.pgSteps);
    assert.throws(() => steps.sqliteSync(steps.one('SELECT 1')), steps.SyncOnPostgresError);
    assert.throws(() => loadAgentGrantsSync('main-agent', []), steps.SyncOnPostgresError);
    // The PostgreSQL transaction is chosen (async fn allowed); no URL -> PgConfigError, not a SQLite result.
    await assert.rejects(() => withTransaction(owner, async () => 1), (e) => e instanceof PgConfigError);
    await assert.rejects(() => steps.sql().tx(() => steps.one('SELECT 1')), (e) => e instanceof PgConfigError);
    await assert.rejects(() => steps.sql().read(steps.one('SELECT 1')), (e) => e instanceof PgConfigError);
  } finally {
    if (saved.db === undefined) delete process.env.AGENT_PLAYER_DB; else process.env.AGENT_PLAYER_DB = saved.db;
    if (saved.url !== undefined) process.env.AGENT_PLAYER_PG_URL = saved.url;
    await closePgPool();
  }
  assert.equal(steps.sql().dialect, 'sqlite');
  assert.equal(steps.sql(), steps.sqliteSteps);
});

test('rowid tie-breaks are replaced by time-ordered primary keys (same order on both drivers)', async () => {
  const { orderedId } = await import('../src/repositories/ordered-id.ts');
  const ids = Array.from({ length: 3000 }, () => orderedId());
  assert.deepEqual([...ids].sort(), ids, 'lexicographic order = creation order, also within one millisecond');
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids.slice(0, 20)) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // The row ids that break created_at ties come from orderedId().
  for (const rel of ['src/services/task-runs.ts', 'src/services/personality-store.ts', 'src/services/evolution-proposals.ts']) {
    assert.match(readFileSync(sourcePath(rel), 'utf8'), /const id = orderedId\(\)/, rel);
  }
});

test('B2.2b-4: MCP grant bindings are written and read with the grants (SQL steps, one transaction)', () => {
  const grants = stripComments(readFileSync(join(backend, 'src/tools/grants.ts'), 'utf8'));
  assert.match(grants, /yield\* writeMcpBindingsStep\(/, 'bindings written inside the grants step');
  assert.match(grants, /yield\* isMcpGrantBoundStep\(/, 'bindings read inside the grants step');
  assert.doesNotMatch(grants, /\bwriteMcpBindings\(|\bisMcpGrantBound\(/);
  const gb = stripComments(readFileSync(join(backend, 'src/mcp-client/grant-binding.ts'), 'utf8'));
  // B2.2c: the MCP discovery read is a step too; no raw handle is left.
  assert.doesNotMatch(gb, /getDatabase|\.prepare\(|sqliteSync/);
  assert.match(gb, /function\* isMcpGrantBoundStep[\s\S]*yield\* currentMcpToolStep\(/, 'the fingerprint is read in the binding step');
  assert.match(grants, /yield\* currentMcpToolStep\(/, 'grant validation reads discovery in the grants step');
  for (const fn of ['isMcpGrantBoundStep', 'writeMcpBindingsStep', 'revokeMcpGrantsStep']) {
    const body = gb.slice(gb.indexOf(`function* ${fn}`), gb.indexOf('\n}\n', gb.indexOf(`function* ${fn}`)));
    assert.ok(body.length > 0, fn);
    assert.doesNotMatch(body, /getDatabase|\.prepare\(/, fn);
  }
});

test('B2.2b-4: with AGENT_PLAYER_DB=postgres the memory paths take PostgreSQL', async () => {
  const saved = { db: process.env.AGENT_PLAYER_DB, url: process.env.AGENT_PLAYER_PG_URL };
  const { PgConfigError } = await import('../src/db/pg/config.ts');
  const { closePgPool } = await import('../src/db/pg/pool.ts');
  const { getMemoryStorage } = await import('../src/memory/storage.ts');
  const versions = await import('../src/memory/versions.ts');
  const forget = await import('../src/memory/forget.ts');
  const files = await import('../src/memory/memory-files.ts');
  const pipeline = await import('../src/memory/import/pipeline.ts');
  const retention = await import('../src/memory/retention.ts');
  const { MemoryTiersService } = await import('../src/services/memory-tiers.ts');
  const pgErr = (e) => e instanceof PgConfigError;
  try {
    process.env.AGENT_PLAYER_DB = 'postgres';
    delete process.env.AGENT_PLAYER_PG_URL;
    await assert.rejects(() => getMemoryStorage().getOwned('u-1', 'm-1'), pgErr);
    await assert.rejects(() => getMemoryStorage().getByDrawers('u-1', [{ kind: 'owner' }]), pgErr);
    await assert.rejects(() => versions.memoryVersions('u-1', 'm-1'), pgErr);
    await assert.rejects(() => forget.listTombstones('u-1'), pgErr);
    await assert.rejects(() => forget.forgetMemory('u-1', 'm-1', 'u-1'), pgErr);
    await assert.rejects(() => files.listProposals('u-1'), pgErr);
    await assert.rejects(() => files.rejectProposal('u-1', 'p-1', 'u-1', 'a'.repeat(64)), pgErr);
    await assert.rejects(() => pipeline.listImports('u-1'), pgErr);
    await assert.rejects(() => retention.getRetentionConfig('u-1'), pgErr);
    await assert.rejects(() => MemoryTiersService.getLayerStats('u-1'), pgErr);
  } finally {
    if (saved.db === undefined) delete process.env.AGENT_PLAYER_DB; else process.env.AGENT_PLAYER_DB = saved.db;
    if (saved.url !== undefined) process.env.AGENT_PLAYER_PG_URL = saved.url;
    await closePgPool();
  }
});

test('B2.2c part 1: with AGENT_PLAYER_DB=postgres the scheduler, MCP, settings, notifications, audit reads, analytics and sign-in throttle take PostgreSQL', async () => {
  const saved = { db: process.env.AGENT_PLAYER_DB, url: process.env.AGENT_PLAYER_PG_URL };
  const { PgConfigError } = await import('../src/db/pg/config.ts');
  const { closePgPool } = await import('../src/db/pg/pool.ts');
  const cron = await import('../src/scheduler/store.ts');
  const mcpStore = await import('../src/mcp-client/store.ts');
  const mcpSvc = await import('../src/mcp-client/service.ts');
  const mcpTools = await import('../src/mcp-client/tools.ts');
  const binding = await import('../src/mcp-client/grant-binding.ts');
  const { SettingsManager } = await import('../src/settings/settings-manager.ts');
  const notif = await import('../src/services/notification-service.ts');
  const auditLog = await import('../src/services/audit-logger.ts');
  const analytics = await import('../src/services/extension-analytics.ts');
  const lockout = await import('../src/auth/account-lockout.ts');
  const { pgLoginThrottle, sqliteLoginThrottle } = await import('../src/repositories/login-throttle.ts');
  const pgErr = (e) => e instanceof PgConfigError;
  try {
    process.env.AGENT_PLAYER_DB = 'postgres';
    delete process.env.AGENT_PLAYER_PG_URL;
    await assert.rejects(() => cron.listEnabledJobs(), pgErr);
    await assert.rejects(() => cron.claimRun('j-1', new Date()), pgErr);
    await assert.rejects(() => cron.ensureNamedJob('j-1', { name: 'n', description: null, cronExpression: '* * * * *', actionType: 'custom', actionData: {} }), pgErr);
    await assert.rejects(() => mcpStore.listServerRows(), pgErr);
    await assert.rejects(() => mcpSvc.listServers(), pgErr);
    await assert.rejects(() => binding.currentMcpTool('mcp__a__b'), pgErr);
    mcpTools.invalidateMcpTools();
    assert.deepEqual(await mcpTools.getMcpTools(), [], 'no database: no MCP tools (not cached)');
    assert.deepEqual(mcpTools.getMcpToolsSync(), [], 'PostgreSQL: the synchronous registry uses the cache only');
    const settings = new SettingsManager(); // no SQLite DDL on PostgreSQL
    await assert.rejects(() => settings.getSettings(), pgErr);
    await assert.rejects(() => settings.updateSettings({ provider: 'local' }), pgErr);
    // B2.2c part 2: the synchronous getters were removed (no caller left).
    assert.equal(settings.getSettingsSync, undefined);
    await assert.rejects(() => notif.notify({ userId: 'u-1', title: 't' }), pgErr);
    await assert.rejects(() => notif.getNotificationSettings('u-1'), pgErr);
    await assert.rejects(() => notif.processScheduledNotifications(), pgErr);
    await assert.rejects(() => auditLog.queryAuditLogs(), pgErr);
    await assert.rejects(() => auditLog.cleanupAuditLogs(30), pgErr);
    await assert.rejects(() => analytics.getExtensionAnalytics('e-1'), pgErr);
    await assert.rejects(() => lockout.checkLoginThrottle('a@b.test', '10.0.0.1'), pgErr);
    await assert.rejects(() => pgLoginThrottle.prune(), pgErr);
  } finally {
    if (saved.db === undefined) delete process.env.AGENT_PLAYER_DB; else process.env.AGENT_PLAYER_DB = saved.db;
    if (saved.url !== undefined) process.env.AGENT_PLAYER_PG_URL = saved.url;
    await closePgPool();
  }
  // The SQLite store is bound to the SQLite runner, whatever the process driver.
  assert.equal(typeof sqliteLoginThrottle.check, 'function');
});

test('B2.2c part 1: the cron engine claims each tick on PostgreSQL; the MCP service has no SQLite-only branch left', () => {
  const engine = stripComments(readFileSync(join(backend, 'src/scheduler/engine.ts'), 'utf8'));
  assert.match(engine, /await claimRun\(job\.id, tickSlot\(job\.cronExpression\)\)/);
  assert.ok(engine.indexOf('claimRun(') < engine.indexOf("this.executeJob(job.id, 'scheduled')"), 'claim before the run');
  const svc = stripComments(readFileSync(join(backend, 'src/mcp-client/service.ts'), 'utf8'));
  assert.doesNotMatch(svc, /grantsOnPg|revokeMcpGrantsSync|dialect === 'postgres'/);
  for (const fn of ['createServer', 'updateServer', 'deleteServer', 'refreshServer']) {
    const body = svc.slice(svc.indexOf(`export async function ${fn}`), svc.indexOf('\n}\n', svc.indexOf(`export async function ${fn}`)));
    assert.match(body, /sql\(\)\.tx\(/, `${fn}: one transaction`);
    assert.match(body, /revokeMcpGrantsStep\(/, `${fn}: grants revoked inside it`);
  }
});

test('B2.2c part 2: with AGENT_PLAYER_DB=postgres the evolution services take PostgreSQL', async () => {
  const saved = { db: process.env.AGENT_PLAYER_DB, url: process.env.AGENT_PLAYER_PG_URL };
  const { PgConfigError } = await import('../src/db/pg/config.ts');
  const { closePgPool } = await import('../src/db/pg/pool.ts');
  const analyzer = await import('../src/services/agent-performance-analyzer.js');
  const learning = await import('../src/services/agent-learning-engine.js');
  const orch = await import('../src/services/agent-evolution-orchestrator.js');
  const evoSched = await import('../src/services/agent-evolution-scheduler.js');
  const cron = await import('../src/scheduler/store.ts');
  const pgErr = (e) => e instanceof PgConfigError;
  try {
    process.env.AGENT_PLAYER_DB = 'postgres';
    delete process.env.AGENT_PLAYER_PG_URL;
    await assert.rejects(() => analyzer.analyzeAgentPerformance('a-1', new Date(0), new Date()), pgErr);
    await assert.rejects(() => analyzer.getAgentPerformanceSummary('a-1'), pgErr);
    await assert.rejects(() => learning.getAgentInsights('a-1'), pgErr);
    await assert.rejects(() => learning.markInsightAsApplied('i-1'), pgErr);
    await assert.rejects(() => orch.getEvolutionHistory('a-1'), pgErr);
    await assert.rejects(() => orch.evolveAgent('a-1'), pgErr);
    await assert.rejects(() => evoSched.getEvolutionSchedule('a-1'), pgErr);
    await assert.rejects(() => cron.upsertNamedJob('j-1', { name: 'n', description: null, cronExpression: '* * * * *', actionType: 'custom', actionData: {} }), pgErr);
    await assert.rejects(() => cron.deleteJobByName('n'), pgErr);
  } finally {
    if (saved.db === undefined) delete process.env.AGENT_PLAYER_DB; else process.env.AGENT_PLAYER_DB = saved.db;
    if (saved.url !== undefined) process.env.AGENT_PLAYER_PG_URL = saved.url;
    await closePgPool();
  }
});

test('B2.2c part 2: the evolution scheduler writes cron_jobs only through the cron store', () => {
  const src = stripComments(readFileSync(join(backend, 'src/services/agent-evolution-scheduler.js'), 'utf8'));
  assert.doesNotMatch(src, /\b(INSERT INTO|UPDATE|DELETE FROM)\s+cron_jobs\b/);
  assert.match(src, /upsertNamedJob\(/);
  assert.match(src, /deleteJobByName\(/);
  // S0-Q.23: no Evolution service writes capabilities.
  for (const rel of ['src/services/agent-learning-engine.js', 'src/services/agent-evolution-orchestrator.js', 'src/services/agent-performance-analyzer.js']) {
    assert.doesNotMatch(stripComments(readFileSync(sourcePath(rel), 'utf8')), /UPDATE\s+agents_config/i, rel);
  }
});

test('B2.2c part 2: with AGENT_PLAYER_DB=postgres webhooks, telephony and the onboarding wizard take PostgreSQL', async () => {
  const saved = { db: process.env.AGENT_PLAYER_DB, url: process.env.AGENT_PLAYER_PG_URL };
  const { PgConfigError } = await import('../src/db/pg/config.ts');
  const { closePgPool } = await import('../src/db/pg/pool.ts');
  const { WebhookManager } = await import('../src/webhooks/manager.ts');
  const tel = await import('../src/telephony/credentials.ts');
  const { getTelephonyService } = await import('./fixtures/legacy-apps/src/services/telephony-service.ts');
  const wizard = await import('../src/onboarding/web-wizard.ts');
  const authority = await import('../src/credentials/authority.ts');
  const pgErr = (e) => e instanceof PgConfigError;
  try {
    process.env.AGENT_PLAYER_DB = 'postgres';
    delete process.env.AGENT_PLAYER_PG_URL;
    // No SQLite file is opened for the webhook store on PostgreSQL.
    await assert.rejects(() => new WebhookManager().initialize('/nonexistent/never-created/webhooks.db'), pgErr);
    await assert.rejects(() => tel.getTelephonyOwnerId(), pgErr);
    await assert.rejects(() => getTelephonyService().releasePhoneNumber('n-1'), pgErr);
    await assert.rejects(() => wizard.getWizardState('u-1'), pgErr);
    await assert.rejects(() => wizard.completeWizard('u-1', true), pgErr);
    assert.equal(authority.getGlobalProviderApiKeySync, undefined, 'the synchronous key getter is gone');
  } finally {
    if (saved.db === undefined) delete process.env.AGENT_PLAYER_DB; else process.env.AGENT_PLAYER_DB = saved.db;
    if (saved.url !== undefined) process.env.AGENT_PLAYER_PG_URL = saved.url;
    await closePgPool();
  }
});

test('B2.2c part 2: camelCase column aliases are quoted in the ported routes (PostgreSQL folds unquoted names)', () => {
  for (const rel of ['src/api/routes/telephony.ts', 'src/api/routes/avatar.ts']) {
    const code = stripComments(readFileSync(sourcePath(rel), 'utf8'));
    // An unquoted SQL alias like `phone_number as phoneNumber` would come back as `phonenumber`.
    assert.doesNotMatch(code, /\b[a-z_]+\.?[a-z_]* as [a-z]+[A-Z]\w*\b(?!['"])/, rel);
  }
});

test('B2.2c part 2: on PostgreSQL the SQLite admin surfaces answer 501 not_supported_on_postgres; stats take PostgreSQL', async () => {
  const saved = { db: process.env.AGENT_PLAYER_DB, url: process.env.AGENT_PLAYER_PG_URL };
  const { default: Fastify } = await import('fastify');
  const { databaseRoutes, SQLITE_ONLY_DATABASE_ROUTES } = await import('../src/api/routes/database.ts');
  const { closePgPool } = await import('../src/db/pg/pool.ts');
  const app = Fastify();
  await app.register(databaseRoutes);
  await app.ready();
  try {
    process.env.AGENT_PLAYER_DB = 'postgres';
    delete process.env.AGENT_PLAYER_PG_URL;
    for (const url of ['/api/database/backup', '/api/database/vacuum', '/api/database/restore']) {
      const res = await app.inject({ method: 'POST', url, payload: url.endsWith('restore') ? { filename: 'x.db' } : {} });
      assert.equal(res.statusCode, 501, url);
      assert.equal(res.json().code, 'not_supported_on_postgres');
      assert.match(res.json().error, /pg_dump/);
    }
    assert.ok(SQLITE_ONLY_DATABASE_ROUTES.has('/api/database/query'), 'raw SQLite SQL is refused too');
  } finally {
    if (saved.db === undefined) delete process.env.AGENT_PLAYER_DB; else process.env.AGENT_PLAYER_DB = saved.db;
    if (saved.url !== undefined) process.env.AGENT_PLAYER_PG_URL = saved.url;
    await app.close();
    await closePgPool();
  }
});
