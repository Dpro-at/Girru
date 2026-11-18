// RUN-ISO read-only stage 1 (AGENT_PLAYER_READONLY=1) and ISO-RO-1 safe-read
// allowlist, on the real buildServer() + startup route table.
//  - only GET/HEAD on READ_ONLY_SAFE_READS (dispatched route template +
//    method), CORS preflight for those, plus exact POST /api/auth/login,
//    POST /api/auth/logout and the setup routes while setup is not complete;
//  - every allowlisted read, called as the owner under side-effect spies
//    (test/fixtures/side-effect-spies.mjs), causes no SQL write, no network,
//    no child process, no file write and no exit (table-driven over the
//    exported list, so a new entry is checked automatically);
//  - GETs with side effects (agents/status provider probe, skills
//    marketplace GitHub fetch, avatar SQL writes, ...), other unlisted reads,
//    unknown routes, chat, memory approve, agents PUT, settings, path tricks,
//    websocket upgrades and event streams get
//    403 { error: 'Forbidden', code: 'read_only_stage' }.
// Throwaway temp data root; all network is blocked by the spies; app.inject only.
// Run: node --import tsx --test test/read-only-stage.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { installSideEffectSpies, noSideEffects } from './fixtures/side-effect-spies.mjs';

const backendDir = process.cwd();
const base = realpathSync(mkdtempSync(join(tmpdir(), 'ap-readonly-')));
const dataDir = join(base, 'data');
const cwdDir = join(base, 'data', 'run');
for (const d of [dataDir, cwdDir, join(base, 'home'), join(base, 'tmp')]) mkdirSync(d, { recursive: true });
process.chdir(cwdDir);
for (const k of ['DATABASE_PATH', 'UPLOADS_DIR', 'AUDIT_DB_PATH', 'ENCRYPTION_DB_PATH', 'MCP_SERVERS_DIR', 'STORAGE_BASE_DIR',
  'AGENT_PLAYER_DB', 'AGENT_PLAYER_PG_URL', 'DATABASE_URL', 'JWT_SECRET', 'ENCRYPTION_KEY', 'MASTER_ENCRYPTION_KEY',
  'WORKFLOW_SECRET', 'AGENT_EXEC_TOOLS', 'AGENT_PLAYER_ISOLATED', 'GITHUB_TOKEN']) delete process.env[k];
Object.assign(process.env, {
  HOME: join(base, 'home'), TMPDIR: join(base, 'tmp'), NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0',
  AGENT_PLAYER_DATA_DIR: dataDir, AGENT_PLAYER_BACKGROUND: 'off', EXTENSIONS_DISABLED: 'true', MEMORY_EMBEDDINGS: 'hash',
  OLLAMA_URL: 'http://127.0.0.1:9', LOCAL_MODEL_API_URL: 'http://127.0.0.1:9/v1', ALLOWED_ORIGINS: 'http://127.0.0.1:42522',
  AGENT_PLAYER_READONLY: '1', AGENT_PLAYER_ISOLATED_STAGE: '1',
});

const spies = installSideEffectSpies(backendDir);
const quiet = { log: console.log, warn: console.warn, info: console.info, error: console.error };
console.log = () => {}; console.info = () => {}; console.warn = () => {}; console.error = () => {};

await import(join(backendDir, 'src/config/load-env.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { initializeBackend } = await import(join(backendDir, 'src/api/startup.ts'));
const { READ_ONLY_SAFE_READS } = await import(join(backendDir, 'src/api/read-only-stage.ts'));
const app = await buildServer({ logger: false });
await initializeBackend(app);
await app.ready();
const { closeDatabase, getDatabase } = await import(join(backendDir, 'src/db/database.ts'));

test.after(async () => {
  console.log = quiet.log; console.info = quiet.info; console.warn = quiet.warn; console.error = quiet.error;
  spies.restoreFetch();
  await app.close();
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
});

const ORIGIN = 'http://127.0.0.1:42522';
const owner = { name: 'Fictional Owner', email: 'owner@example.test', password: `T-${randomBytes(12).toString('hex')}-a1!` };
let token = null;
const ids = {};

function req(method, url, { payload, headers = {}, auth = true } = {}) {
  return app.inject({
    method, url, payload,
    headers: {
      host: '127.0.0.1:42521', origin: ORIGIN,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

function assertReadOnly(res, what) {
  assert.equal(res.statusCode, 403, `${what}: ${res.statusCode} ${res.body}`);
  assert.deepEqual(res.json(), { error: 'Forbidden', code: 'read_only_stage' }, what);
}

/** Run a request with the spies armed; returns [response, side effects seen]. */
async function spied(method, url, opts) {
  spies.arm();
  try {
    const res = await req(method, url, opts);
    await new Promise((r) => setTimeout(r, 50)); // let fire-and-forget work show up
    return [res, spies.disarm()];
  } finally {
    spies.disarm();
  }
}

test('reads pass: GET /health, HEAD /health, preflight for a safe read, GET /api/setup/status', async () => {
  assert.equal((await req('GET', '/health')).statusCode, 200);
  assert.equal((await req('HEAD', '/health')).statusCode, 200);
  const pre = await req('OPTIONS', '/api/agents', { headers: { 'access-control-request-method': 'GET' } });
  assert.equal(pre.statusCode, 204, pre.body);
  assert.equal(pre.headers['access-control-allow-origin'], ORIGIN);
  assert.equal((await req('GET', '/api/setup/status')).statusCode, 200);
});

test('preflight only for allowlisted targets', async () => {
  const pf = (url, m) => req('OPTIONS', url, { headers: { 'access-control-request-method': m } });
  assert.equal((await pf('/api/auth/login', 'POST')).statusCode, 204, 'login preflight');
  assert.equal((await pf('/api/agents/a1', 'GET')).statusCode, 204, 'agent detail preflight');
  assertReadOnly(await pf('/api/chat', 'POST'), 'chat preflight');
  assertReadOnly(await pf('/api/agents/a1', 'PUT'), 'agents PUT preflight');
  assertReadOnly(await pf('/api/agents/status', 'GET'), 'static sibling of /api/agents/:id');
  assertReadOnly(await pf('/api/skills/marketplace/available', 'GET'), 'marketplace preflight');
  assertReadOnly(await pf('/api/no-such-route', 'GET'), 'unknown route preflight');
  assertReadOnly(await pf('/api/agents/a%2Fb', 'GET'), 'encoded slash preflight');
  assertReadOnly(await pf('/api/auth/login?x=1', 'POST'), 'login preflight with query');
  assertReadOnly(await req('OPTIONS', '/api/agents'), 'OPTIONS without preflight headers');
});

test('setup before completion: only the exact routes; query, slash and case tricks are refused', async () => {
  for (const url of ['/api/setup/admin?x=1', '/api/setup/admin/', '/API/setup/admin', '/api/setup//admin',
    '/api/setup/admin%2F', '/api/setup/database', '/api/setup/python']) {
    assertReadOnly(await req('POST', url, { payload: owner }), url);
  }
  assertReadOnly(await req('GET', '/api/setup/check'), 'GET /api/setup/check spawns host commands');
  const { issueSetupToken } = await import(join(backendDir, 'src/auth/setup-token.ts'));
  const created = await req('POST', '/api/setup/admin', { payload: { ...owner, setupToken: issueSetupToken() } });
  assert.equal(created.statusCode, 200, created.body);
  // An owner now exists: admin is closed even before complete.
  assertReadOnly(await req('POST', '/api/setup/admin', { payload: { ...owner, email: 'second@example.test' } }), 'second admin');
  const done = await req('POST', '/api/setup/complete', { payload: {} });
  assert.equal(done.statusCode, 200, done.body);
  assertReadOnly(await req('POST', '/api/setup/complete', { payload: {} }), 'complete after completion');
  assertReadOnly(await req('POST', '/api/setup/admin', { payload: owner }), 'admin after completion');
});

test('login works (exact URL only); a GET read works with the token', async () => {
  assertReadOnly(await req('POST', '/api/auth/login?next=/x', { payload: { email: owner.email, password: owner.password } }), 'login with query');
  assertReadOnly(await req('POST', '/api/auth/login/', { payload: { email: owner.email, password: owner.password } }), 'login with slash');
  const res = await req('POST', '/api/auth/login', { payload: { email: owner.email, password: owner.password } });
  assert.equal(res.statusCode, 200, res.body);
  token = res.json().token ?? res.json().accessToken;
  assert.ok(token, 'a token is returned');
  const me = await req('GET', '/api/auth/me');
  assert.equal(me.statusCode, 200, me.body);
  const user = me.json().user ?? me.json();
  assert.equal(user.email, owner.email);
  ids.user = user.id;
  const agents = await req('GET', '/api/agents');
  assert.equal(agents.statusCode, 200, agents.body);
  ids.agent = agents.json().agents[0]?.id;
  assert.ok(ids.agent, 'a default agent exists');
});

test('seed one memory proposal and one personality proposal (direct store calls, spies off)', async () => {
  const MF = await import(join(backendDir, 'src/memory/memory-files.ts'));
  const view = await MF.viewDrawerFile(ids.user, ids.agent, { kind: 'owner' });
  const text = `${view.content}\n### new | fact | importance 6\nRead-only stage seed entry\n`;
  const mp = await MF.createProposal({ userId: ids.user, agentId: ids.agent, drawer: { kind: 'owner' }, text, source: 'upload', note: null });
  ids.memoryProposal = mp.id;
  const PS = await import(join(backendDir, 'src/services/personality-store.ts'));
  const pp = await PS.createPersonalityProposal(ids.agent, { delta: { warmth: -2 }, reason: 'read-only stage seed' }, 'owner', ids.user);
  ids.personalityProposal = pp.id;
  assert.ok(ids.memoryProposal && ids.personalityProposal);
});

// One real request per allowlisted template, filled with seeded ids so the
// handler takes its full (positive) path. A new entry must add a sample here.
const SAMPLES = {
  '/health': () => '/health',
  '/': () => '/',
  '/api/setup/status': () => '/api/setup/status',
  '/api/auth/me': () => '/api/auth/me',
  '/api/agents': () => '/api/agents',
  '/api/agents/:id': () => `/api/agents/${ids.agent}`,
  '/api/agents/:id/personality/proposals': () => `/api/agents/${ids.agent}/personality/proposals?status=pending`,
  '/api/agents/:id/personality/proposals/:pid': () => `/api/agents/${ids.agent}/personality/proposals/${ids.personalityProposal}`,
  '/api/memory/proposals': () => '/api/memory/proposals?status=pending',
  '/api/memory/proposals/:id': () => `/api/memory/proposals/${ids.memoryProposal}`,
  '/api/memory/files/:drawer': () => `/api/memory/files/owner?agentId=${encodeURIComponent(ids.agent)}`,
};

test('the allowlist is frozen, GET only, registered routes, each with a reason and a sample', () => {
  assert.ok(READ_ONLY_SAFE_READS.length >= 10);
  assert.ok(Object.isFrozen(READ_ONLY_SAFE_READS));
  for (const e of READ_ONLY_SAFE_READS) {
    assert.ok(Object.isFrozen(e), `${e.url} entry is frozen`);
    assert.equal(e.method, 'GET', e.url);
    assert.ok(typeof e.why === 'string' && e.why.length > 10, `${e.url} has a reason`);
    assert.ok(app.hasRoute({ method: 'GET', url: e.url }), `${e.url} is a registered GET route`);
    assert.ok(SAMPLES[e.url], `${e.url}: add a sample URL to SAMPLES in this test`);
  }
});

for (const entry of READ_ONLY_SAFE_READS) {
  test(`safe read ${entry.method} ${entry.url}: passes and has no side effect (GET and HEAD)`, async () => {
    for (const method of ['GET', 'HEAD']) {
      const url = SAMPLES[entry.url]();
      const [res, seen] = await spied(method, url);
      assert.equal(res.statusCode, 200, `${method} ${url}: ${res.statusCode} ${res.body}`);
      assert.ok(noSideEffects(seen), `${method} ${url} side effects: ${JSON.stringify(seen)}`);
    }
  });
}

test('the spies do see side effects (control)', async () => {
  spies.arm();
  getDatabase().prepare('UPDATE users SET email = email WHERE id = ?').run(ids.user);
  await fetch('https://example.invalid/').catch(() => {});
  const seen = spies.disarm();
  assert.equal(seen.sql.length, 1, JSON.stringify(seen));
  assert.equal(seen.net.length, 1, JSON.stringify(seen));
});

// GETs found with side effects by the ISO-RO-1 audit (spies + handler reading).
const SIDE_EFFECT_GETS = [
  ['/api/agents/status', 'probes the model endpoint (fetch 127.0.0.1:9/api/version) and cloud providers'],
  ['/api/skills/marketplace/available', 'fetches api.github.com without a token'],
  ['/api/avatars?userId=1', 'may INSERT user_avatars / UPDATE users.avatar_url'],
  ['/api/sandbox/status', 'exec docker'],
  ['/api/models', 'fetch model endpoint /api/tags'],
  ['/api/models/providers', 'fetch model endpoint /api/tags'],
  ['/api/ai-tools/ollama/models', 'fetch model endpoint /api/tags'],
  ['/api/approvals', 'UPDATE tool_approvals SET status = expired'],
  ['/api/notifications/settings', 'INSERT notification_settings'],
  ['/api/agents/main-agent/tool-grants', 'DELETE + INSERT agent_tool_grants'],
  ['/api/agents/main-agent/personality', 'mkdir the agent folder'],
  ['/api/agents/main-agent/memory', 'mkdir the agent folder'],
  ['/api/agents/main-agent/files', 'mkdir the agent folder'],
  ['/api/setup/check', 'spawns host commands'],
];

test('GETs with side effects are refused before their handler runs (403, no side effect)', async () => {
  for (const [url, why] of SIDE_EFFECT_GETS) {
    for (const method of ['GET', 'HEAD']) {
      const [res, seen] = await spied(method, url);
      if (method === 'GET') assertReadOnly(res, `${method} ${url} (${why})`);
      else assert.equal(res.statusCode, 403, `${method} ${url}`);
      assert.ok(noSideEffects(seen), `${method} ${url}: ${JSON.stringify(seen)}`);
    }
  }
});

test('unlisted reads and unknown routes are refused', async () => {
  for (const url of ['/api/settings', '/api/sessions', '/api/memory/files', '/api/memory/files/owner/versions',
    '/api/agents/main-agent/personality/current', '/api/instance', '/docs', '/favicon.ico', '/index.html',
    '/api/no-such-route', '/api/ext/some-extension/anything', '/no-such-file.txt']) {
    assertReadOnly(await req('GET', url), `GET ${url}`);
  }
  assert.equal((await req('HEAD', '/api/settings')).statusCode, 403);
});

test('query strings on safe reads pass; path tricks are refused or routed to a safe read', async () => {
  for (const url of ['/api/agents?x=1', '/api/memory/proposals', '/api/memory/proposals?status=pending', '/health?probe=1']) {
    const [res, seen] = await spied('GET', url);
    assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
    assert.ok(noSideEffects(seen), url);
  }
  for (const url of ['//api/agents', '/api//agents', '/api/agents/', '/API/agents', '/api/Agents', '/api/agents%2Fstatus',
    '/api/agents/a%2Fb', '/api/agents/a%2fb', '/api/agents/%2E%2E', '/api/agents/%2e',
    '/api/agents/%252E', '/api/agents/a%5Cb', '/api/agents\\status', '/api/agents/a%00', '/api/agents/status',
    '/api/agents/status?x=1', '/health/', '/HEALTH']) {
    const [res, seen] = await spied('GET', url);
    assertReadOnly(res, `GET ${url}`);
    assert.ok(noSideEffects(seen), url);
  }
  // Dot segments: light-my-request (like fetch) resolves them before the
  // server sees the URL, so they arrive as a plain safe read or as a refused
  // route; the raw form is refused by the real-launcher test.
  for (const url of ['/api/./agents', '/api/agents/x/..', '/api/x/../agents/status', '/api/agents/..']) {
    const [res, seen] = await spied('GET', url);
    assert.ok(res.statusCode === 200 || (res.statusCode === 403 && res.json().code === 'read_only_stage'), `${url}: ${res.statusCode}`);
    assert.ok(noSideEffects(seen), url);
  }
  // A differently-cased word is just an agent id on the safe /api/agents/:id read
  // (the router is case-sensitive): it never reaches /api/agents/status.
  const [res, seen] = await spied('GET', '/api/agents/STATUS');
  assert.equal(res.statusCode, 404, res.body);
  assert.ok(noSideEffects(seen));
});

test('writes are refused: chat POST (and SSE chat), memory approve, agents PUT, settings, deletes, unknown routes', async () => {
  assertReadOnly(await req('POST', '/api/chat', { payload: { message: 'hi' } }), 'POST /api/chat');
  assertReadOnly(await req('POST', '/api/chat', { payload: { message: 'hi', stream: true }, headers: { accept: 'text/event-stream' } }), 'SSE chat');
  assertReadOnly(await req('POST', '/api/chat/agentic', { payload: { message: 'hi' } }), 'agentic chat');
  assertReadOnly(await req('POST', `/api/memory/proposals/${ids.memoryProposal}/approve`, { payload: {} }), 'memory approve');
  assertReadOnly(await req('PUT', '/api/agents/a1', { payload: { name: 'x' } }), 'agents PUT');
  assertReadOnly(await req('PUT', '/api/settings', { payload: { provider: 'local' } }), 'settings PUT');
  assertReadOnly(await req('DELETE', '/api/agents/a1'), 'agents DELETE');
  assertReadOnly(await req('PATCH', '/api/agents/a1', { payload: {} }), 'PATCH');
  assertReadOnly(await req('POST', '/api/no-such-route', { payload: {} }), 'unknown POST');
});

test('websocket upgrades and event streams are refused even on GET', async () => {
  assertReadOnly(await req('GET', '/health', { headers: { connection: 'Upgrade', upgrade: 'websocket' } }), 'upgrade');
  assertReadOnly(await req('GET', '/api/auth/me', { headers: { accept: 'text/event-stream' } }), 'event stream');
});

test('stage 2 (chat test): exactly POST /api/chat passes the gate (also streaming); every other write stays refused', async () => {
  const saved = { stage: process.env.AGENT_PLAYER_ISOLATED_STAGE, only: process.env.AGENT_PLAYER_LOCAL_MODEL_ONLY };
  try {
    // The switch alone (without the stage) changes nothing.
    process.env.AGENT_PLAYER_LOCAL_MODEL_ONLY = '1';
    assertReadOnly(await req('POST', '/api/chat', { payload: {} }), 'flag without stage 2');
    process.env.AGENT_PLAYER_ISOLATED_STAGE = '2';
    // An invalid body reaches the route (400 from the chat validation), so no model is called here.
    for (const headers of [{}, { accept: 'text/event-stream' }]) {
      const res = await req('POST', '/api/chat', { payload: {}, headers });
      assert.notEqual(res.statusCode, 403, `chat passes the gate: ${res.statusCode} ${res.body}`);
      assert.equal(res.statusCode, 400, res.body);
    }
    assertReadOnly(await req('POST', '/api/chat?x=1', { payload: {} }), 'query trick');
    assertReadOnly(await req('POST', '/api/chat/agentic', { payload: { message: 'hi' } }), 'agentic chat');
    assertReadOnly(await req('POST', `/api/memory/proposals/${ids.memoryProposal}/approve`, { payload: {} }), 'memory approve');
    assertReadOnly(await req('PUT', '/api/agents/a1', { payload: { name: 'x' } }), 'agents PUT');
    assertReadOnly(await req('PUT', '/api/settings', { payload: { provider: 'local' } }), 'settings PUT');
    assertReadOnly(await req('GET', '/api/auth/me', { headers: { accept: 'text/event-stream' } }), 'event stream on other routes');
  } finally {
    if (saved.stage === undefined) delete process.env.AGENT_PLAYER_ISOLATED_STAGE; else process.env.AGENT_PLAYER_ISOLATED_STAGE = saved.stage;
    if (saved.only === undefined) delete process.env.AGENT_PLAYER_LOCAL_MODEL_ONLY; else process.env.AGENT_PLAYER_LOCAL_MODEL_ONLY = saved.only;
  }
  assertReadOnly(await req('POST', '/api/chat', { payload: {} }), 'back in stage 1');
});

test('logout works', async () => {
  const res = await req('POST', '/api/auth/logout', { payload: {} });
  assert.notEqual(res.statusCode, 403, res.body);
  assert.ok(res.statusCode < 400, `${res.statusCode} ${res.body}`);
});

test('stage 3 (hire test): exactly create agent + read/replace its tool grants, still behind the gate', async () => {
  const saved = { stage: process.env.AGENT_PLAYER_ISOLATED_STAGE, only: process.env.AGENT_PLAYER_LOCAL_MODEL_ONLY };
  const login = await req('POST', '/api/auth/login', { payload: { email: owner.email, password: owner.password } });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token ?? login.json().accessToken;
  try {
    process.env.AGENT_PLAYER_LOCAL_MODEL_ONLY = '1';
    process.env.AGENT_PLAYER_ISOLATED_STAGE = '2';
    assertReadOnly(await req('POST', '/api/agents', { payload: { role: 'specialist' } }), 'create in stage 2');
    assertReadOnly(await req('POST', '/api/onboarding/team-plan', { payload: { size: 'small', departments: ['sales'] } }), 'team plan in stage 2');
    assertReadOnly(await req('POST', '/api/onboarding/team-batches', { payload: { id: 'stage2-batch', language: 'en', departments: [{ department: 'sales', count: 1 }] } }), 'batch in stage 2');
    process.env.AGENT_PLAYER_ISOLATED_STAGE = '3';
    const created = await req('POST', '/api/agents', { payload: { role: 'specialist', name: 'Stage Three Hire', personality: { preset: 'bold-creative' } } });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().agent.id;
    const view = await req('GET', `/api/agents/${id}/tool-grants`);
    assert.equal(view.statusCode, 200, view.body);
    assert.ok(Array.isArray(view.json().available) && view.json().available.length > 0);
    const put = await req('PUT', `/api/agents/${id}/tool-grants`, { payload: { grants: ['memory_search', 'web_fetch'], expectedVersion: view.json().version } });
    assert.equal(put.statusCode, 200, put.body);
    assert.deepEqual(put.json().grants.map(g => g.tool).sort(), ['memory_search', 'web_fetch']);
    // CORE-PERMS-01: memory scope + off/ask/allow on the hire stage.
    const permView = await req('GET', `/api/agents/${id}/permissions`);
    assert.equal(permView.statusCode, 200, permView.body);
    const permPut = await req('PUT', `/api/agents/${id}/permissions`, { payload: { memoryRead: ['task'], memoryWrite: ['task'], sharedMemory: false, modes: { ...permView.json().modes, browser: 'off' }, expectedVersion: permView.json().version } });
    assert.equal(permPut.statusCode, 200, permPut.body);
    assertReadOnly(await req('PUT', `/api/agents/${id}/permissions?x=1`, { payload: {} }), 'permissions query trick');
    // BOARD-01: board reads and writes on the hire stage.
    const boards = await req('GET', '/api/boards');
    assert.equal(boards.statusCode, 200, boards.body);
    const bid = boards.json().boards[0].id;
    const bview = await req('GET', `/api/boards/${bid}`);
    const card = await req('POST', `/api/boards/${bid}/cards`, { payload: { columnId: bview.json().columns[0].id, title: 'Stage three card' } });
    assert.equal(card.statusCode, 201, card.body);
    const moved = await req('PUT', `/api/boards/${bid}/cards/${card.json().id}`, { payload: { expectedVersion: 1, columnId: bview.json().columns[1].id } });
    assert.equal(moved.statusCode, 200, moved.body);
    assertReadOnly(await req('PUT', `/api/boards/${bid}/cards/${card.json().id}?x=1`, { payload: { expectedVersion: 2 } }), 'board PUT query trick');
    assertReadOnly(await req('PATCH', `/api/boards/${bid}/cards/${card.json().id}`, { payload: { expectedVersion: 2 } }), 'PATCH stays refused');
    const catalogue = await req('GET', '/api/onboarding/team-catalogue');
    assert.equal(catalogue.statusCode, 200, catalogue.body);
    const teamPlan = await req('POST', '/api/onboarding/team-plan', { payload: { size: 'small', departments: ['sales', 'finance'] } });
    assert.equal(teamPlan.statusCode, 200, teamPlan.body);
    assert.equal(teamPlan.json().hires.length, 4);
    assertReadOnly(await req('POST', '/api/onboarding/team-plan?x=1', { payload: { size: 'small', departments: ['sales'] } }), 'team plan query trick');
    // ONBOARD-TEAM-02: distribution + batch hire.
    const dist = await req('POST', '/api/onboarding/team-distribution', { payload: { total: 7, departments: ['sales', 'finance'] } });
    assert.equal(dist.statusCode, 200, dist.body);
    const batch = await req('POST', '/api/onboarding/team-batches', { payload: { id: 'stage3-batch-1', language: 'en', departments: [{ department: 'sales', count: 2 }] } });
    assert.equal(batch.statusCode, 201, batch.body);
    assert.equal((await req('GET', '/api/onboarding/team-batches')).statusCode, 200);
    assert.equal((await req('GET', '/api/onboarding/team-batches/stage3-batch-1')).statusCode, 200);
    const ran = await req('POST', '/api/onboarding/team-batches/stage3-batch-1/run', { payload: {} });
    assert.equal(ran.statusCode, 200, ran.body);
    assert.equal(ran.json().batch.created, 2);
    assertReadOnly(await req('POST', '/api/onboarding/team-batches/stage3-batch-1/run?x=1', { payload: {} }), 'batch run query trick');
    assertReadOnly(await req('POST', '/api/onboarding/team-batches/stage3%2fbatch/run', { payload: {} }), 'batch run encoding trick');
    assertReadOnly(await req('DELETE', '/api/onboarding/team-batches/stage3-batch-1'), 'batch delete');
    assertReadOnly(await req('POST', '/api/onboarding', { payload: { step: 'profile', data: {} } }), 'other onboarding writes');
    // CHAT-REBUILD-01: saved conversations + the one run event stream.
    const conv = await req('POST', '/api/chat/conversations', { payload: { title: 'Stage chat' } });
    assert.equal(conv.statusCode, 201, conv.body);
    const cid = conv.json().conversation.id;
    assert.equal((await req('GET', '/api/chat/conversations')).statusCode, 200);
    assert.equal((await req('PUT', `/api/chat/conversations/${cid}`, { payload: { pinned: true } })).statusCode, 200);
    assert.equal((await req('GET', `/api/chat/conversations/${cid}/messages`)).statusCode, 200);
    const sse = { 'accept': 'text/event-stream' };
    assert.equal((await req('GET', '/api/chat/runs/run-unknown-1/events?after=3', { headers: sse })).statusCode, 404, 'events stream passes the stage (unknown run)');
    assertReadOnly(await req('GET', '/api/chat/runs/run-unknown-1/events?after=3&x=1', { headers: sse }), 'events query trick');
    assertReadOnly(await req('GET', '/api/chat/runs/run-unknown-1/events?after=-1', { headers: sse }), 'events negative after');
    assertReadOnly(await req('PUT', `/api/chat/conversations/${cid}?x=1`, { payload: { pinned: false } }), 'conversation PUT query trick');
    // CHAT-PRO-02 D: search inside conversations, only in its canonical form.
    const found = await req('GET', '/api/chat/search?q=Stage%20chat&limit=20');
    assert.equal(found.statusCode, 200, found.body);
    assert.equal(found.json().results[0].conversationId, cid);
    assertReadOnly(await req('GET', '/api/chat/search?q=Stage&x=1'), 'search query trick');
    assertReadOnly(await req('GET', '/api/chat/search?limit=5&q=Stage'), 'search parameter order');
    assertReadOnly(await req('GET', '/api/chat/search?q=Stage&limit=0'), 'search limit 0');
    assertReadOnly(await req('GET', '/api/chat/search?q=a/b'), 'search raw slash');
    // CHAT-PRO-02 F: export as Markdown, plain or with exactly ?tools=1.
    const exported = await req('GET', `/api/chat/conversations/${cid}/export`);
    assert.equal(exported.statusCode, 200, exported.body);
    assert.match(exported.json().markdown, /^# Stage chat/);
    assert.equal((await req('GET', `/api/chat/conversations/${cid}/export?tools=1`)).statusCode, 200);
    assertReadOnly(await req('GET', `/api/chat/conversations/${cid}/export?tools=1&x=1`), 'export query trick');
    assertReadOnly(await req('GET', `/api/chat/conversations/${cid}/export?tools=0`), 'export tools=0');
    assertReadOnly(await req('GET', `/api/chat/conversations/${cid}/export?x=1`), 'export other query');
    assert.equal((await req('DELETE', `/api/chat/conversations/${cid}`)).statusCode, 200);
    assertReadOnly(await req('DELETE', '/api/sessions/x'), 'other DELETE');
    // Still behind the auth gate.
    assert.equal((await req('POST', '/api/agents', { payload: { role: 'specialist' }, auth: false })).statusCode, 401);
    // Only those routes; tricks and neighbours stay refused.
    assertReadOnly(await req('PUT', `/api/agents/${id}/tool-grants?x=1`, { payload: { grants: [], expectedVersion: 2 } }), 'query trick');
    assertReadOnly(await req('POST', '/api/agents?x=1', { payload: { role: 'specialist' } }), 'create query trick');
    // AGENT-CARD-01: profile edit and persona versions on the hire stage.
    const before = (await req('GET', `/api/agents/${id}`)).json().agent;
    const edited = await req('PUT', `/api/agents/${id}`, { payload: { role: 'specialist', department: 'sales', description: 'Card test', expectedVersion: before.version } });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(edited.json().agent.department, 'sales');
    assertReadOnly(await req('PUT', `/api/agents/${id}?x=1`, { payload: { description: 'x' } }), 'agent PUT query trick');
    assertReadOnly(await req('DELETE', `/api/agents/${id}`), 'delete agent');
    assertReadOnly(await req('POST', `/api/agents/${id}/duplicate`, { payload: {} }), 'duplicate');
    assertReadOnly(await req('POST', `/api/agents/${id}/set-primary`, { payload: {} }), 'set primary');
    assert.equal((await req('GET', `/api/agents/${id}/personality/current`)).statusCode, 200);
    const persona = await req('POST', `/api/agents/${id}/personality/versions`, { payload: { preset: 'careful-auditor' } });
    assert.equal(persona.statusCode, 200, persona.body);
    assert.equal((await req('GET', `/api/agents/${id}/personality/versions`)).statusCode, 200);
    // MEMORY-PAGE-02: memory items.
    const mem = await req('POST', '/api/memory', { payload: { type: 'fact', content: 'Stage memory', importance: 7, drawer: { kind: 'owner' } } });
    assert.equal(mem.statusCode, 200, mem.body);
    const mid = mem.json().memory.id;
    assert.equal((await req('GET', '/api/memory')).statusCode, 200);
    assert.equal((await req('GET', '/api/memory/drawers')).statusCode, 200);
    assert.equal((await req('PUT', `/api/memory/${mid}`, { payload: { content: 'Stage memory, edited' } })).statusCode, 200);
    assert.equal((await req('GET', `/api/memory/${mid}/versions`)).statusCode, 200);
    assert.equal((await req('POST', `/api/memory/${mid}/forget`, { payload: {} })).statusCode, 200);
    assertReadOnly(await req('POST', '/api/memory/consolidate', { payload: {} }), 'memory maintenance stays refused');
    assertReadOnly(await req('GET', '/api/memory?userId=x'), 'memory list query trick');
    assertReadOnly(await req('POST', '/api/agents/name-suggestion', { payload: {} }), 'name suggestion');
    assertReadOnly(await req('PUT', '/api/settings', { payload: { provider: 'local' } }), 'settings PUT');
    // The switch is required: stage 3 without local-model-only opens nothing.
    delete process.env.AGENT_PLAYER_LOCAL_MODEL_ONLY;
    assertReadOnly(await req('POST', '/api/agents', { payload: { role: 'specialist' } }), 'stage 3 without the switch');
  } finally {
    if (saved.stage === undefined) delete process.env.AGENT_PLAYER_ISOLATED_STAGE; else process.env.AGENT_PLAYER_ISOLATED_STAGE = saved.stage;
    if (saved.only === undefined) delete process.env.AGENT_PLAYER_LOCAL_MODEL_ONLY; else process.env.AGENT_PLAYER_LOCAL_MODEL_ONLY = saved.only;
  }
  assertReadOnly(await req('POST', '/api/agents', { payload: { role: 'specialist' } }), 'back in stage 1');
});
