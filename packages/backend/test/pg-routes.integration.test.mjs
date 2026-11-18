// B2.2c part 2: the evolution services and history route, webhooks (register,
// deliver, signature, inbound), telephony (credential masking, call points),
// the dashboard, world bots and multiverse, a public chat room (anonymous
// visitor, S0-A.14 outsider-memory rule), avatar CRUD, the onboarding wizard
// and the database admin routes (stats from the PostgreSQL catalog, backup
// refused with 501), on PostgreSQL, end to end.
// Runs ONLY when AGENT_PLAYER_PG_TEST_URL names a THROWAWAY database on
// 127.0.0.1 that the PostgreSQL runner has already migrated (it writes test
// rows and never cleans up: drop the database afterwards). Otherwise every
// test skips. scripts/pg/integration.sh runs it.
//
// The SQLite file (a temp file, never the real .data) is watched: any
// statement on a table of a module ported here that reaches SQLite is a
// failure (last test). The only network use is a webhook receiver on an
// ephemeral 127.0.0.1 port inside this test; model calls are stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const URL_ = process.env.AGENT_PLAYER_PG_TEST_URL;
const skip = URL_ ? false : 'AGENT_PLAYER_PG_TEST_URL is not set (PostgreSQL integration test)';

const PORTED_TABLES = /\b(agent_performance_metrics|agent_learning_insights|agent_evolution_history|agent_evolution_config|agent_capability_usage|webhooks|inbound_webhooks|webhook_deliveries|phone_numbers|call_points|call_sessions|call_messages|onboarding_state|dashboard_widgets|user_dashboard_layouts|user_worlds|world_bots|public_chat_rooms|public_chat_messages|public_chat_participants|avatar_settings|user_avatars|user_animations|extension_configs|extension_migrations)\b/i;
const sqliteHits = [];

const MEMORY_MARK = 'SECRET-MEMORY-' + randomBytes(4).toString('hex');
const PERSONALITY_MARK = 'PERSONA-' + randomBytes(4).toString('hex');

// Model calls are stubbed (they record the prompt); everything else is real.
const prompts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (target.endsWith('/api/chat')) { // Ollama (public rooms)
    prompts.push(String(init.body || ''));
    return new Response(JSON.stringify({ message: { content: 'stub reply' }, done: true }) + '\n', { status: 200 });
  }
  if (target.startsWith('http://127.0.0.1:')) return realFetch(url, init); // the webhook receiver below
  throw new Error(`unexpected network call in test: ${target}`);
};

let m = {};
let dir;
if (URL_) {
  dir = mkdtempSync(join(tmpdir(), 'ap-pg-routes-'));
  mkdirSync(join(dir, '.data'), { recursive: true });
  process.chdir(dir);
  process.env.HOME = dir;
  // SQLite still backs the modules that are not ported yet: a temp file, never the real .data.
  process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
  process.env.AUDIT_DB_PATH = join(dir, '.data', 'audit', 'audit.db');
  process.env.ENCRYPTION_DB_PATH = join(dir, '.data', 'encryption', 'credentials.db');
  process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
  process.env.AGENT_PLAYER_DB = 'postgres';
  process.env.AGENT_PLAYER_PG_URL = URL_;
  process.env.AGENT_PLAYER_PG_POOL_MAX = '8';
  process.env.AGENT_PLAYER_BACKGROUND = 'off';
  process.env.NODE_ENV = 'test';
  delete process.env.OUTSIDER_AGENT_MEMORY;
  delete process.env.AGENT_EXEC_TOOLS;
  delete process.env.PUBLIC_URL;

  // B2.2d-17: no SQLite at all. Any code path that still reaches the main
  // SQLite database throws SqliteOnPostgresError, and the file must never appear.
  const { closeDatabase } = await import('../src/db/database.ts');
  m = {
    closeDatabase,
    Fastify: (await import('fastify')).default,
    pool: await import('../src/db/pg/pool.ts'),
    users: (await import('../src/repositories/pg/users-store.ts')).pgUsersStore,
    jwt: await import('../src/auth/jwt.ts'),
    gate: await import('../src/auth/auth-gate.ts'),
    errors: await import('../src/api/error-handler.ts'),
    audit: await import('../src/services/audit-logger.ts'),
    securityAudit: await import('../src/audit/index.ts'),
    credStorage: await import('../src/credentials/storage.ts'),
    settings: await import('../src/settings/index.ts'),
    agentFiles: await import('../src/services/agent-files.ts'),
    analyzer: await import('../src/services/agent-performance-analyzer.js'),
    learning: await import('../src/services/agent-learning-engine.js'),
    orch: await import('../src/services/agent-evolution-orchestrator.js'),
    evoSched: await import('../src/services/agent-evolution-scheduler.js'),
    engine: await import('../src/scheduler/engine.ts'),
    webhooks: await import('../src/webhooks/index.ts'),
    tel: await import('../src/telephony/credentials.ts'),
    wizard: await import('../src/onboarding/web-wizard.ts'),
    routes: {
      evolution: (await import('../src/api/routes/evolution.ts')).default,
      webhooks: (await import('../src/api/routes/webhooks.ts')).webhooksRoutes,
      telephony: (await import('./fixtures/legacy-apps/src/api/routes/telephony.ts')).registerTelephonyRoutes,
      dashboard: (await import('../src/api/routes/dashboard.ts')).registerDashboardRoutes,
      worldBots: (await import('../src/api/routes/world-bots.ts')).worldBotsRoutes,
      multiverse: (await import('../src/api/routes/multiverse.ts')).multiverseRoutes,
      avatar: (await import('../src/api/routes/avatar.ts')).registerAvatarRoutes,
      database: (await import('../src/api/routes/database.ts')).databaseRoutes,
      databaseStats: (await import('../src/api/routes/database-stats.ts')).databaseStatsRoutes,
    },
  };
}

const tag = randomBytes(4).toString('hex');
const one = (sql, ...p) => m.pool.pgOne(sql, ...p);
const all = (sql, ...p) => m.pool.pgAll(sql, ...p);
const pgRun = (sql, ...p) => m.pool.pgRun(sql, ...p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = async (fn) => {
  const s = { log: console.log, warn: console.warn, info: console.info };
  console.log = () => {}; console.warn = () => {}; console.info = () => {};
  try { return await fn(); } finally { Object.assign(console, s); }
};
async function waitFor(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const TEXT_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const u = {};
const apps = [];
/** A Fastify app with the global error handler and the auth gate, plus `plugin`. */
async function appWith(...plugins) {
  const app = m.Fastify();
  m.errors.registerGlobalErrorHandler(app);
  m.gate.registerAuthGate(app);
  for (const p of plugins) await app.register(p);
  await app.ready();
  apps.push(app);
  return app;
}
const bearer = (id) => ({ authorization: `Bearer ${m.jwt.generateToken(id, 1)}` });
const inject = (app, opts) => silent(() => app.inject(opts));

test.before(async () => {
  if (!URL_) return;
  const mk = (name, role) => m.users.create({ email: `${name}-${tag}@pg.test`, username: `${name}_${tag}`, password: `pw-${randomBytes(8).toString('hex')}`, role });
  u.owner = await mk('rowner', 'owner');
  u.admin = await mk('radmin', 'admin');
  u.member = await mk('rmember', 'user');
  u.other = await mk('rother', 'user');
  await silent(() => m.securityAudit.initializeAudit());
  await silent(() => m.credStorage.getCredentialStorage().initialize());
});

test.after(async () => {
  if (!URL_) return;
  globalThis.fetch = realFetch;
  for (const app of apps) await app.close();
  m.webhooks.shutdownWebhooks();
  await m.engine.getCronEngine().stop();
  await m.audit.flushAuditWrites();
  await m.pool.closePgPool();
  m.closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Evolution
// ---------------------------------------------------------------------------

test('evolution: analyzer round trip, concurrent analyses keep every capability count, insights, history and the route', { skip }, async () => {
  const agentId = `evo-${tag}`;
  await pgRun(`INSERT INTO agents_config (id, name, system_prompt, capabilities) VALUES (?, ?, 'p', ?)`,
    agentId, `Agent ${tag}`, JSON.stringify({ webSearch: false, fileOperations: true }));
  await pgRun(`INSERT INTO agent_evolution_config (agent_id, enabled, min_confidence_threshold, min_sample_size, evolution_frequency) VALUES (?, 1, 0.7, 10, 'weekly')`, agentId);
  const at = new Date(Date.now() - 60_000).toISOString();
  const act = (type, tool, meta) => pgRun(`INSERT INTO agent_activity (id, agent_id, action_type, tool_name, summary, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(), agentId, type, tool, `${type} ${tool ?? ''}`, JSON.stringify(meta), at);
  for (let i = 0; i < 3; i++) await act('task_completed', null, {});
  for (let i = 0; i < 12; i++) await act('task_failed', null, { error: 'timeout' });
  for (let i = 0; i < 4; i++) await act('tool_call', 'web_fetch', {});
  for (let i = 0; i < 2; i++) await act('tool_call', 'web_fetch', { error: 'http' });

  const start = new Date(Date.now() - 3_600_000);
  const end = new Date();
  const perf = await m.analyzer.analyzeAgentPerformance(agentId, start, end);
  assert.equal(perf.sampleSize, 21);
  assert.equal(perf.metrics.taskSuccessRate.total, 15);
  assert.equal(perf.metrics.taskSuccessRate.completed, 3);
  assert.equal(perf.metrics.toolEfficiency.byTool.web_fetch.total, 6);
  // Two analyses at the same time: one upsert per tool, no lost increment.
  await Promise.all([m.analyzer.analyzeAgentPerformance(agentId, start, end), m.analyzer.analyzeAgentPerformance(agentId, start, end)]);
  const usage = await one('SELECT usage_count, success_count, failure_count FROM agent_capability_usage WHERE agent_id = ? AND capability_name = ?', agentId, 'web_fetch');
  assert.deepEqual(usage, { usage_count: 18, success_count: 12, failure_count: 6 });
  assert.equal((await one('SELECT COUNT(*) AS n FROM agent_performance_metrics WHERE agent_id = ?', agentId)).n, 9, '3 analyses x 3 metrics with data');

  const summary = await m.analyzer.getAgentPerformanceSummary(agentId);
  assert.equal(summary.metrics.task_success_rate.value, 0.2);
  assert.equal(summary.metrics.task_success_rate.sampleSize, 21);
  assert.equal(summary.metrics.task_success_rate.metadata.total, 15);
  assert.match(summary.lastAnalyzed, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  assert.equal(summary.capabilities[0].capability_name, 'web_fetch');

  // Insights: filters, order, evidence parsed, applied as 1.
  const ins = (id, type, conf) => pgRun(`INSERT INTO agent_learning_insights (id, agent_id, insight_type, title, description, confidence, evidence) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id, agentId, type, `t-${id}`, 'd', conf, JSON.stringify([{ n: 1 }]));
  await ins(`i1-${tag}`, 'failure_pattern', 0.9);
  await ins(`i2-${tag}`, 'optimization', 0.6);
  const insights = await m.learning.getAgentInsights(agentId, { applied: false, minConfidence: 0.5 });
  assert.deepEqual(insights.map((i) => i.id), [`i1-${tag}`, `i2-${tag}`]);
  assert.deepEqual(insights[0].evidence, [{ n: 1 }]);
  await m.learning.markInsightAsApplied(`i1-${tag}`, 0.4);
  const applied = await one('SELECT applied, impact_score, applied_at FROM agent_learning_insights WHERE id = ?', `i1-${tag}`);
  assert.equal(applied.applied, 1);
  assert.equal(applied.impact_score, 0.4);
  assert.ok(applied.applied_at);
  assert.deepEqual((await m.learning.getAgentInsights(agentId, { applied: false })).map((i) => i.id), [`i2-${tag}`]);

  // History: newest first, insight_ids parsed; the route reads it (admin).
  const hist = (id, ts) => pgRun(`INSERT INTO agent_evolution_history (id, agent_id, evolution_type, change_description, trigger_reason, insight_ids, created_at) VALUES (?, ?, 'prompt_update', 'c', 'r', ?, ?)`,
    id, agentId, JSON.stringify([`i1-${tag}`]), ts);
  await hist(`h1-${tag}`, new Date(Date.now() - 120_000).toISOString());
  await hist(`h2-${tag}`, new Date(Date.now() - 60_000).toISOString());
  const history = await m.orch.getEvolutionHistory(agentId, { limit: 5 });
  assert.deepEqual(history.map((h) => h.id), [`h2-${tag}`, `h1-${tag}`]);
  assert.deepEqual(history[0].insight_ids, [`i1-${tag}`]);

  const app = await appWith(m.routes.evolution);
  const res = await inject(app, { method: 'GET', url: `/api/evolution/${agentId}/history`, headers: bearer(u.admin.id) });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().total, 2);
  const status = await inject(app, { method: 'GET', url: `/api/evolution/${agentId}/status`, headers: bearer(u.admin.id) });
  assert.equal(status.statusCode, 200, status.body);
  assert.ok(Array.isArray(status.json().config.allowed_evolutions));
  assert.equal(status.json().status, 'active');
  const cfg = await inject(app, { method: 'PUT', url: `/api/evolution/${agentId}/config`, headers: bearer(u.owner.id), payload: { min_sample_size: 12 } });
  assert.equal(cfg.statusCode, 200, cfg.body);
  assert.equal(cfg.json().config.min_sample_size, 12);
  assert.equal((await inject(app, { method: 'GET', url: `/api/evolution/${agentId}/history`, headers: bearer(u.member.id) })).statusCode, 403);
  // S0-Q.23: nothing here changed the agent's capabilities.
  assert.deepEqual(JSON.parse((await one('SELECT capabilities FROM agents_config WHERE id = ?', agentId)).capabilities), { webSearch: false, fileOperations: true });
});

test('evolution scheduler: two concurrent schedules make one cron job (cron store, name lock); unschedule deletes it', { skip }, async () => {
  const agentId = `evo-${tag}`;
  const name = `agent-evolution-${agentId}`;
  await silent(() => Promise.all([m.evoSched.scheduleAgentEvolution(agentId, 'weekly'), m.evoSched.scheduleAgentEvolution(agentId, 'weekly')]));
  const rows = await all('SELECT id, action_type, action_data, cron_expression FROM cron_jobs WHERE name = ?', name);
  assert.equal(rows.length, 1, 'one job');
  assert.equal(rows[0].action_type, 'evolve-agent');
  assert.deepEqual(JSON.parse(rows[0].action_data), { agentId });
  const sched = await m.evoSched.getEvolutionSchedule(agentId);
  assert.equal(sched.frequency, 'weekly');
  assert.equal(sched.enabled, true);
  assert.ok(sched.createdAt instanceof Date && !Number.isNaN(sched.createdAt.getTime()));
  await silent(() => m.evoSched.scheduleAgentEvolution(agentId, 'daily'));
  assert.equal((await one('SELECT cron_expression FROM cron_jobs WHERE id = ?', rows[0].id)).cron_expression, '0 3 * * *', 'updated in place');
  await silent(() => m.evoSched.unscheduleAgentEvolution(agentId));
  assert.equal((await one('SELECT COUNT(*) AS n FROM cron_jobs WHERE name = ?', name)).n, 0);
  assert.equal(await m.evoSched.getEvolutionSchedule(agentId), null);
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

test('webhooks: register, deliver with a valid signature, delivery row, masked list; inbound signature and concurrent counts', { skip }, async () => {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push({ headers: req.headers, body }); res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { manager } = await silent(() => m.webhooks.initializeWebhooks());
    const hook = await manager.create({ name: `hook ${tag}`, url: `http://127.0.0.1:${server.address().port}/hook`, events: ['agent.message'], retry: { enabled: false } });
    assert.match(hook.secret, /^whsec/);
    const stored = await one('SELECT events, secret, created_at FROM webhooks WHERE id = ?', hook.id);
    assert.deepEqual(JSON.parse(stored.events), ['agent.message']);
    assert.equal(stored.created_at, hook.createdAt.toISOString(), 'ISO text on both drivers');

    const out = await silent(() => m.webhooks.triggerWebhooks('agent.message', { text: `hi ${tag}` }, { type: 'test', id: tag }));
    assert.deepEqual(out.webhookIds, [hook.id]);
    await waitFor(() => received.length === 1, 'the delivery');
    const got = received[0];
    const sig = createHmac('sha256', hook.secret).update(got.body).digest('hex');
    assert.equal(got.headers['x-webhook-signature'], sig, 'HMAC-SHA256 of the body with the webhook secret');
    assert.equal(got.headers['x-webhook-signature-256'], `sha256=${sig}`);
    assert.equal(JSON.parse(got.body).data.text, `hi ${tag}`);
    const del = await waitFor(async () => {
      const r = await one('SELECT status, response_status, attempt FROM webhook_deliveries WHERE webhook_id = ?', hook.id);
      return r?.status === 'success' ? r : null;
    }, 'the delivery row');
    assert.deepEqual(del, { status: 'success', response_status: 200, attempt: 1 });
    const deliveries = await m.webhooks.getDeliveryService().getDeliveries(hook.id);
    assert.equal(deliveries.length, 1);
    assert.ok(deliveries[0].timestamp instanceof Date);
    // An event without hooks triggers nothing; another process would see the same hooks (read from the table).
    assert.equal((await m.webhooks.triggerWebhooks('session.created', {}, { type: 'test', id: tag })).triggered, 0);
    const stats = await manager.getStats();
    assert.equal(typeof stats.avgResponseTime, 'number');
    assert.ok(stats.deliveries24h >= 1);

    // Update locks and writes in one transaction; the events filter follows.
    const upd = await manager.update(hook.id, { events: ['agent.error'] });
    assert.deepEqual(upd.events, ['agent.error']);
    assert.equal((await manager.getWebhooksForEvent('agent.message')).length, 0);
    assert.equal(await manager.update(`wh_missing_${tag}`, { name: 'x' }), null);

    const app = await appWith(m.routes.webhooks);
    const list = await inject(app, { method: 'GET', url: '/api/webhooks', headers: bearer(u.admin.id) });
    assert.equal(list.statusCode, 200, list.body);
    const mine = list.json().webhooks.find((w) => w.id === hook.id);
    assert.equal(mine.secret, '********');
    assert.ok(!list.body.includes(hook.secret), 'secret never listed');
    assert.equal((await inject(app, { method: 'GET', url: '/api/webhooks', headers: bearer(u.member.id) })).statusCode, 403);

    // Inbound: signed body accepted, bad signature refused; concurrent triggers all counted.
    const inbound = await manager.createInbound({ name: `in ${tag}`, handler: { type: 'log' } });
    const body = JSON.stringify({ n: tag });
    const sign = (b) => createHmac('sha256', inbound.secret).update(b).digest('hex');
    const post = (sig) => inject(app, { method: 'POST', url: inbound.path, headers: { 'content-type': 'application/json', 'x-webhook-signature': sig }, payload: body });
    assert.equal((await post('0'.repeat(64))).statusCode, 403);
    assert.equal((await post(sign(body))).statusCode, 200);
    const many = await Promise.all([1, 2, 3, 4, 5].map(() => post(`sha256=${sign(body)}`)));
    assert.deepEqual(many.map((r) => r.statusCode), [200, 200, 200, 200, 200]);
    const row = await one('SELECT trigger_count, last_triggered FROM inbound_webhooks WHERE id = ?', inbound.id);
    assert.equal(row.trigger_count, 6);
    assert.match(row.last_triggered, /Z$/);
    assert.equal(await manager.delete(hook.id), true);
    assert.equal((await one('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id = ?', hook.id)).n, 0, 'deliveries cascade with the hook');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------------------
// Telephony
// ---------------------------------------------------------------------------

test('telephony: credentials stored encrypted for the owner and read back masked; call points with camelCase fields', { skip }, async () => {
  const app = await appWith(m.routes.telephony);
  const URL_C = '/api/telephony/settings/credentials';
  const SID = 'AC' + randomBytes(16).toString('hex');
  const TOKEN = randomBytes(16).toString('hex');
  assert.equal((await inject(app, { method: 'GET', url: URL_C, headers: bearer(u.member.id) })).statusCode, 403);
  const put = await inject(app, { method: 'PUT', url: URL_C, headers: bearer(u.admin.id), payload: { twilioAccountSid: SID, twilioAuthToken: TOKEN } });
  assert.equal(put.statusCode, 200, put.body);
  const ownerId = await m.tel.getTelephonyOwnerId();
  assert.ok(ownerId, 'an active owner');
  const rows = await all(`SELECT user_id, encrypted_value FROM credentials WHERE name IN ('telephony.twilio.account_sid', 'telephony.twilio.auth_token') AND user_id = ?`, ownerId);
  assert.equal(rows.length, 2);
  for (const r of rows) for (const s of [SID, TOKEN]) assert.ok(!r.encrypted_value.includes(s), 'encrypted at rest');
  const res = await inject(app, { method: 'GET', url: URL_C, headers: bearer(u.owner.id) });
  assert.equal(res.statusCode, 200, res.body);
  for (const s of [SID, TOKEN]) assert.ok(!res.body.includes(s), 'secret leaked');
  const c = res.json().credentials;
  assert.equal(c.twilio.configured, true);
  assert.equal(c.twilio.accountSid, '••••' + SID.slice(-4));
  // A masked value echoed back keeps the stored secret.
  await inject(app, { method: 'PUT', url: URL_C, headers: bearer(u.owner.id), payload: { twilioAuthToken: c.twilio.authToken } });
  assert.equal(await m.tel.getTelephonySecret(m.tel.TELEPHONY_KEYS.twilioAuthToken), TOKEN);

  // Call points: camelCase aliases survive PostgreSQL (quoted), toggle + read-back in one transaction.
  const numberId = `pn-${tag}`;
  await pgRun(`INSERT INTO phone_numbers (id, phone_number, provider, status) VALUES (?, ?, 'twilio', 'active')`, numberId, `+1555${tag.slice(0, 7)}`);
  const cp = await inject(app, { method: 'POST', url: '/api/telephony/call-points', headers: bearer(u.admin.id), payload: { name: `cp ${tag}`, phoneNumberId: numberId } });
  assert.equal(cp.statusCode, 200, cp.body);
  const list = await inject(app, { method: 'GET', url: '/api/telephony/call-points', headers: bearer(u.admin.id) });
  assert.equal(list.statusCode, 200, list.body);
  const point = (list.json().callPoints ?? []).find((p) => p.id === cp.json().id);
  assert.ok(point, list.body.slice(0, 300));
  assert.equal(point.phoneNumberId, numberId);
  assert.equal(point.phoneNumber, `+1555${tag.slice(0, 7)}`);
  const upd = await inject(app, { method: 'PUT', url: `/api/telephony/call-points/${point.id}`, headers: bearer(u.admin.id), payload: { name: `cp2 ${tag}` } });
  assert.equal(upd.statusCode, 200, upd.body);
  assert.match((await one('SELECT updated_at FROM call_points WHERE id = ?', point.id)).updated_at, TEXT_TS);
  const tog = await inject(app, { method: 'PATCH', url: `/api/telephony/call-points/${point.id}/toggle`, headers: bearer(u.admin.id) });
  assert.equal(tog.statusCode, 200, tog.body);
  assert.equal(tog.json().enabled, false);
  // A live call: its duration is computed by the database from the TEXT start time.
  const sessionId = `cs-${tag}`;
  await pgRun(`INSERT INTO call_sessions (id, call_point_id, direction, from_number, to_number, call_sid, provider, status, started_at) VALUES (?, ?, 'inbound', '+1', '+2', ?, 'twilio', 'in-progress', to_char(((now() - interval '30 seconds') AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS'))`, sessionId, point.id, `CA${tag}`);
  const active = await inject(app, { method: 'GET', url: '/api/telephony/calls/active', headers: bearer(u.admin.id) });
  assert.equal(active.statusCode, 200, active.body);
  const live = active.json().activeCalls.find((x) => x.id === sessionId);
  assert.ok(live.durationSeconds >= 29 && live.durationSeconds < 120, String(live.durationSeconds));
  assert.equal(live.callSid, `CA${tag}`);
  const delS = await inject(app, { method: 'DELETE', url: `/api/telephony/sessions/${sessionId}`, headers: bearer(u.admin.id) });
  assert.equal(delS.statusCode, 200, delS.body);
  assert.equal((await one('SELECT COUNT(*) AS n FROM call_sessions WHERE id = ?', sessionId)).n, 0);
});

// ---------------------------------------------------------------------------
// Dashboard, world bots, multiverse
// ---------------------------------------------------------------------------

test('dashboard: quick stats are numbers, a layout save is one transaction', { skip }, async () => {
  const app = await appWith(m.routes.dashboard);
  const qs = await inject(app, { method: 'GET', url: '/api/dashboard/widgets/quick-stats', headers: bearer(u.member.id) });
  assert.equal(qs.statusCode, 200, qs.body);
  assert.equal(qs.json().stats.length, 4);
  for (const s of qs.json().stats) assert.equal(typeof s.value, 'number', s.label);
  assert.ok(qs.json().stats[1].value >= 1, 'agents_config rows');
  for (const w of [[{ id: 'a' }], [{ id: 'b' }, { id: 'c' }]]) {
    const put = await inject(app, { method: 'PUT', url: '/api/dashboard/layout', headers: bearer(u.member.id), payload: { widgets: w } });
    assert.equal(put.statusCode, 200, put.body);
  }
  const lay = await inject(app, { method: 'GET', url: '/api/dashboard/layout', headers: bearer(u.member.id) });
  assert.deepEqual(lay.json().widgets, [{ id: 'b' }, { id: 'c' }]);
  assert.equal((await one('SELECT COUNT(*) AS n FROM user_dashboard_layouts WHERE user_id = ? AND is_active = 1', u.member.id)).n, 1);
  const tasks = await inject(app, { method: 'GET', url: '/api/dashboard/widgets/agent-performance', headers: bearer(u.member.id) });
  assert.equal(tasks.statusCode, 200, tasks.body);
  for (const d of tasks.json().chart.data) assert.equal(typeof d.value, 'number');
  const del = await inject(app, { method: 'DELETE', url: '/api/dashboard/layout', headers: bearer(u.member.id) });
  assert.equal(del.statusCode, 200);
  assert.deepEqual((await inject(app, { method: 'GET', url: '/api/dashboard/layout', headers: bearer(u.member.id) })).json().widgets, []);
});

test('world bots: create with TEXT timestamps, update writes updated_at (no datetime("now") bug), owner checks, delete', { skip }, async () => {
  const agentId = `wb-agent-${tag}`;
  await pgRun(`INSERT INTO agents_config (id, name) VALUES (?, ?)`, agentId, `World agent ${tag}`);
  const worldId = `w-${tag}`;
  await pgRun(`INSERT INTO user_worlds (id, user_id, name, glb_file_id) VALUES (?, ?, ?, 'g')`, worldId, u.member.id, `World ${tag}`);
  const app = await appWith(m.routes.worldBots);
  const base = `/api/multiverse/${worldId}/bots`;
  const created = await inject(app, { method: 'POST', url: base, headers: bearer(u.member.id), payload: { agent_id: agentId, position_x: 1.5 } });
  assert.equal(created.statusCode, 200, created.body);
  const bot = created.json().bot;
  assert.equal(bot.agent_name, `World agent ${tag}`);
  assert.equal(bot.position_x, 1.5);
  assert.match(bot.created_at, TEXT_TS);
  assert.match(bot.updated_at, TEXT_TS);
  assert.equal((await inject(app, { method: 'POST', url: base, headers: bearer(u.other.id), payload: { agent_id: agentId } })).statusCode, 404, 'not the owner');
  assert.equal((await inject(app, { method: 'POST', url: base, headers: bearer(u.member.id), payload: {} })).statusCode, 400);
  await sleep(1100); // updated_at has whole seconds
  const upd = await inject(app, { method: 'PUT', url: `${base}/${bot.id}`, headers: bearer(u.member.id), payload: { rotation_y: 90, is_active: false } });
  assert.equal(upd.statusCode, 200, upd.body);
  const after = upd.json().bot;
  assert.equal(after.rotation_y, 90);
  assert.equal(after.is_active, 0);
  assert.match(after.updated_at, TEXT_TS);
  assert.ok(after.updated_at > bot.updated_at, 'updated_at moved forward');
  const list = await inject(app, { method: 'GET', url: base, headers: bearer(u.member.id) });
  assert.deepEqual(list.json().bots.map((b) => b.id), [bot.id]);
  assert.equal((await inject(app, { method: 'DELETE', url: `${base}/${bot.id}`, headers: bearer(u.other.id) })).statusCode, 404);
  assert.equal((await inject(app, { method: 'DELETE', url: `${base}/${bot.id}`, headers: bearer(u.member.id) })).statusCode, 200);
  assert.equal((await inject(app, { method: 'DELETE', url: `${base}/${bot.id}`, headers: bearer(u.member.id) })).statusCode, 404);
});

test('multiverse: world create/update/delete with owner checks, bots added concurrently, TEXT updated_at', { skip }, async () => {
  const app = await appWith(m.routes.multiverse);
  const agentId = `wb-agent-${tag}`;
  const w = await inject(app, { method: 'POST', url: '/api/multiverse', headers: bearer(u.member.id), payload: { name: `MV ${tag}`, glb_file_id: 'g2' } });
  assert.equal(w.statusCode, 200, w.body);
  const world = w.json().world;
  assert.equal((await inject(app, { method: 'PUT', url: `/api/multiverse/${world.id}`, headers: bearer(u.other.id), payload: { name: 'x' } })).statusCode, 403);
  const upd = await inject(app, { method: 'PUT', url: `/api/multiverse/${world.id}`, headers: bearer(u.member.id), payload: { name: `MV2 ${tag}`, is_public: true } });
  assert.equal(upd.statusCode, 200, upd.body);
  assert.equal(upd.json().world.name, `MV2 ${tag}`);
  assert.equal(upd.json().world.is_public, 1);
  assert.match(upd.json().world.updated_at, TEXT_TS);
  const adds = await Promise.all([1, 2].map((i) => inject(app, { method: 'POST', url: `/api/multiverse/${world.id}/bots`, headers: bearer(u.member.id), payload: { agent_id: agentId, position_x: i } })));
  assert.deepEqual(adds.map((r) => r.statusCode), [200, 200]);
  const bots = await inject(app, { method: 'GET', url: `/api/multiverse/${world.id}/bots`, headers: bearer(u.member.id) });
  assert.equal(bots.json().bots.length, 2);
  const botId = adds[0].json().bot.id;
  const bu = await inject(app, { method: 'PUT', url: `/api/multiverse/${world.id}/bots/${botId}`, headers: bearer(u.member.id), payload: { animation_state: 'wave' } });
  assert.equal(bu.statusCode, 200, bu.body);
  assert.equal(bu.json().bot.animation_state, 'wave');
  assert.match(bu.json().bot.updated_at, TEXT_TS);
  assert.equal((await inject(app, { method: 'DELETE', url: `/api/multiverse/${world.id}`, headers: bearer(u.other.id) })).statusCode, 403);
  assert.equal((await inject(app, { method: 'DELETE', url: `/api/multiverse/${world.id}`, headers: bearer(u.member.id) })).statusCode, 200);
  assert.equal((await one('SELECT COUNT(*) AS n FROM world_bots WHERE world_id = ?', world.id)).n, 0, 'bots cascade with the world');
});

// ---------------------------------------------------------------------------
// Public chat
// ---------------------------------------------------------------------------

test('avatars: CRUD with camelCase fields; concurrent first adds activate exactly one; activate and delete hand over', { skip }, async () => {
  const app = await appWith(m.routes.avatar);
  const h = bearer(u.member.id);
  const add = (n) => inject(app, { method: 'POST', url: '/api/avatars', headers: h, payload: { name: `A${n} ${tag}`, source: 'url', glbUrl: `https://models.readyplayer.me/${tag}-${n}.glb` } });
  const [a1, a2] = await Promise.all([add(1), add(2)]);
  assert.equal(a1.statusCode, 200, a1.body);
  assert.equal(a2.statusCode, 200, a2.body);
  const list1 = (await inject(app, { method: 'GET', url: '/api/avatars', headers: h })).json().avatars;
  assert.equal(list1.length, 2);
  assert.equal(list1.filter((a) => a.isActive === 1).length, 1, 'exactly one active');
  for (const k of ['userId', 'glbUrl', 'localGlbPath', 'previewUrl', 'bgColor', 'bgScene', 'isActive', 'createdAt']) assert.ok(k in list1[0], k);
  assert.equal(list1[0].userId, u.member.id);
  const inactive = list1.find((a) => a.isActive === 0);
  const act = await inject(app, { method: 'PATCH', url: `/api/avatars/${inactive.id}/activate`, headers: h, payload: {} });
  assert.equal(act.statusCode, 200, act.body);
  const list2 = (await inject(app, { method: 'GET', url: '/api/avatars', headers: h })).json().avatars;
  assert.deepEqual(list2.filter((a) => a.isActive === 1).map((a) => a.id), [inactive.id]);
  assert.equal((await one('SELECT avatar_url FROM users WHERE id = ?', u.member.id)).avatar_url, inactive.glbUrl);
  assert.equal((await one('SELECT rpm_avatar_url FROM avatar_settings WHERE user_id = ?', u.member.id)).rpm_avatar_url, inactive.glbUrl);
  const patch = await inject(app, { method: 'PATCH', url: `/api/avatars/${inactive.id}`, headers: h, payload: { bgColor: '#123456' } });
  assert.equal(patch.statusCode, 200);
  const single = await inject(app, { method: 'GET', url: `/api/avatars/${inactive.id}`, headers: h });
  assert.equal(single.json().avatar.bgColor, '#123456');
  assert.equal((await inject(app, { method: 'GET', url: `/api/avatars/${inactive.id}`, headers: bearer(u.other.id) })).statusCode, 404, 'not the caller\'s avatar');
  // Deleting the active one activates the remaining one.
  assert.equal((await inject(app, { method: 'DELETE', url: `/api/avatars/${inactive.id}`, headers: h })).statusCode, 200);
  const list3 = (await inject(app, { method: 'GET', url: '/api/avatars', headers: h })).json().avatars;
  assert.equal(list3.length, 1);
  assert.equal(list3[0].isActive, 1);
  assert.equal((await one('SELECT avatar_url FROM users WHERE id = ?', u.member.id)).avatar_url, list3[0].glbUrl);
  // Settings save: check-then-write under the user lock; aliases quoted.
  const s1 = await inject(app, { method: 'POST', url: '/api/avatar/settings', headers: h, payload: { bgColor: '#000001' } });
  assert.equal(s1.statusCode, 200, s1.body);
  assert.equal(s1.json().settings.bgColor, '#000001');
  assert.equal(s1.json().settings.userId, u.member.id);
  const g1 = await inject(app, { method: 'GET', url: '/api/avatar/settings', headers: h });
  assert.equal(g1.statusCode, 200, g1.body);
  assert.equal((await one('SELECT COUNT(*) AS n FROM avatar_settings WHERE user_id = ?', u.member.id)).n, 1);
});

// ---------------------------------------------------------------------------
// Onboarding wizard
// ---------------------------------------------------------------------------

test('onboarding wizard: concurrent saves keep both answers (per-user lock); profile name on PostgreSQL; complete and reset', { skip }, async () => {
  const id = u.member.id;
  await Promise.all([
    m.wizard.saveWizardStep(id, { step: 'channels', answers: { selectedChannels: ['web'] } }, 3),
    m.wizard.saveWizardStep(id, { step: 'skills', answers: { selectedSkills: ['notes'] } }, 4),
  ]);
  const st = await m.wizard.getWizardState(id);
  assert.deepEqual(st.data.selectedChannels, ['web']);
  assert.deepEqual(st.data.selectedSkills, ['notes']);
  assert.equal(st.completed, false);
  // The profile step writes users.full_name on PostgreSQL (no SQLite users repository).
  await m.wizard.saveWizardStep(id, { step: 'profile', answers: { userName: `Member ${tag}`, language: 'en' } }, 2);
  assert.equal((await one('SELECT full_name FROM users WHERE id = ?', id)).full_name, `Member ${tag}`);
  assert.equal((await m.wizard.getWizardState(id)).data.userName, `Member ${tag}`);
  const done = await m.wizard.completeWizard(id, true);
  assert.equal(done.completed, true);
  assert.equal(done.skipped, true);
  assert.ok((await one('SELECT completed_at FROM onboarding_state WHERE user_id = ?', id)).completed_at);
  const reset = await m.wizard.resetWizard(id);
  assert.equal(reset.completed, false);
  assert.deepEqual(reset.data, {});
});

// ---------------------------------------------------------------------------
// Database admin routes
// ---------------------------------------------------------------------------

test('database routes on PostgreSQL: stats from the catalog (owner only), backup / vacuum / restore 501, health', { skip }, async () => {
  const app = await appWith(m.routes.database);
  const stats = await inject(app, { method: 'GET', url: '/api/database/stats', headers: bearer(u.owner.id) });
  assert.equal(stats.statusCode, 200, stats.body);
  const s = stats.json();
  assert.equal(typeof s.totalSize, 'number');
  assert.ok(s.totalSize > 0);
  const users = s.tables.find((t) => t.name === 'users');
  assert.ok(users && users.records >= 4 && typeof users.size === 'number' && users.size > 0, JSON.stringify(users));
  assert.ok(s.totalRecords >= users.records);
  assert.equal((await inject(app, { method: 'GET', url: '/api/database/stats', headers: bearer(u.admin.id) })).statusCode, 403, 'owner only');
  for (const [url, payload] of [['/api/database/backup', {}], ['/api/database/vacuum', {}], ['/api/database/restore', { filename: 'x.db' }], ['/api/database/query', { query: 'SELECT 1' }]]) {
    const res = await inject(app, { method: 'POST', url, headers: bearer(u.owner.id), payload });
    assert.equal(res.statusCode, 501, `${url}: ${res.body}`);
    assert.equal(res.json().code, 'not_supported_on_postgres');
    assert.match(res.json().error, /pg_dump/);
  }
  assert.equal((await inject(app, { method: 'POST', url: '/api/database/backup', headers: bearer(u.member.id) })).statusCode, 403, 'the owner tier still runs first');

  const app2 = await appWith(m.routes.databaseStats);
  const health = await inject(app2, { method: 'GET', url: '/api/database/health', headers: bearer(u.owner.id) });
  assert.equal(health.statusCode, 200, health.body);
  const st2 = await inject(app2, { method: 'GET', url: '/api/database/stats', headers: bearer(u.owner.id) });
  assert.equal(st2.statusCode, 200, st2.body);
  assert.ok(st2.json().totalSize > 0);
  assert.ok(st2.json().tables.some((t) => t.name === 'users'));
  assert.equal((await inject(app2, { method: 'POST', url: '/api/database/vacuum', headers: bearer(u.owner.id) })).statusCode, 501);
  assert.equal((await inject(app2, { method: 'POST', url: '/api/database/backup', headers: bearer(u.owner.id) })).statusCode, 501);
});

test('no ported statement reached SQLite; the SQLite file was never created', { skip }, async () => {
  assert.deepEqual(sqliteHits, []);
  assert.equal(existsSync(process.env.DATABASE_PATH), false, 'agent-player.db must not exist on PostgreSQL');
});
