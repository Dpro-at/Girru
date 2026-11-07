// BE-UI-01: backend contracts the new UI relies on.
//  - approvals carry an absolute `expiresAt`; approval, task-run, memory
//    proposal, personality-version and small-agent timestamps are ISO-8601
//    UTC with `Z` (DB format unchanged);
//  - optimistic concurrency: `version` + ETag on agents and tool grants,
//    `expectedVersion` / If-Match -> 409 on mismatch; partial agent PUT;
//  - chat: every SSE frame and JSON body carries runId + messageId; a
//    repeated Idempotency-Key returns the first outcome without a new model call.
// Throwaway DB/keys; the local model is stubbed (no network, no port).
// Run: node --import tsx --test test/ui-contracts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-ui-contracts-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
for (const k of ['AGENT_EXEC_TOOLS', 'OLLAMA_THINK', 'DEFAULT_MODEL']) delete process.env[k];

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// --- stubbed local model (Ollama /api/chat, stream and non-stream) -----------
let modelCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== 'http://127.0.0.1:11434/api/chat') throw new Error(`unexpected network call in test: ${url}`);
  modelCalls++;
  const body = JSON.parse(init.body);
  if (!body.stream) {
    return new Response(JSON.stringify({ model: body.model, message: { role: 'assistant', content: `reply ${modelCalls}` }, done: true }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const lines = [
    { message: { role: 'assistant', content: 'Hello ' }, done: false },
    { message: { role: 'assistant', content: `there ${modelCalls}` }, done: false },
    { message: { role: 'assistant', content: '' }, done: true },
  ].map((l) => `${JSON.stringify(l)}\n`).join('');
  return new Response(lines, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
};

const quiet = { log: console.log, warn: console.warn, info: console.info, error: console.error };
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(join(backendDir, 'src/multi-agent/index.ts'));
await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`)
  .run(id, `${id}@example.test`, id, role);
addUser('c-owner', 'owner');
addUser('c-member', 'user');
addUser('c-guest', 'guest');
db.prepare(`INSERT INTO agents_config (id, name, provider, model) VALUES ('c-agent', 'Contract Agent', 'ollama', 'qwen-test')`).run();
db.prepare(`UPDATE agents_config SET is_primary = CASE WHEN id = 'c-agent' THEN 1 ELSE 0 END`).run();

const tools = await import(join(backendDir, 'src/tools/index.ts'));
const grants = await import(join(backendDir, 'src/tools/grants.ts'));
const idem = await import(join(backendDir, 'src/services/chat-idempotency.ts'));
const { isoUtc } = await import(join(backendDir, 'src/api/timestamps.ts'));
tools.registerExtensionTool({ name: 'uc_risky', description: 'needs approval', extensionId: 'uc', requiresApproval: true,
  input_schema: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'ran' }] }) });
const avail = tools.createToolsRegistry({ workspaceDir: dir }).listRegistered();
await grants.setAgentGrants('c-agent', { grants: ['uc_risky', 'memory_search'] }, 'c-owner', avail);

const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const app = await buildServer({ logger: false });
await app.ready();
const bearer = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const inject = async (opts) => {
  const l = console.log, w = console.warn, e = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await app.inject(opts); } finally { console.log = l; console.warn = w; console.error = e; }
};

console.log = quiet.log;
console.info = quiet.info;
console.warn = quiet.warn;

test.after(async () => {
  globalThis.fetch = realFetch;
  tools.unregisterExtensionTool('uc_risky');
  try { await app.close(); } catch { /* ignore */ }
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

// --- timestamps --------------------------------------------------------------

test('isoUtc: SQLite UTC strings get a Z; ISO strings, Dates and epochs normalise; junk -> null', () => {
  assert.equal(isoUtc('2026-10-14 10:00:00'), '2026-10-14T10:00:00.000Z');
  assert.equal(isoUtc('2026-10-14T10:00:00.123Z'), '2026-10-14T10:00:00.123Z');
  assert.equal(isoUtc(Date.UTC(2026, 9, 14, 10)), '2026-10-14T10:00:00.000Z');
  assert.equal(isoUtc(null), null);
  assert.equal(isoUtc('not a date'), null);
});

test('approvals: ISO UTC timestamps with Z and an absolute expiresAt = requestedAt + 24 h', async () => {
  const reg = tools.createToolsRegistry({ workspaceDir: dir, agentId: 'c-agent', userId: 'c-owner', sessionId: 's1' });
  const held = await inject({ method: 'GET', url: '/health' }); // warm-up, nothing else
  assert.ok(held.statusCode < 500);
  const l = console.log; console.log = () => {};
  const res = await reg.execute('uc_risky', {});
  console.log = l;
  const id = res.details.approvalId;
  const list = await inject({ method: 'GET', url: '/api/approvals?status=pending', headers: bearer('c-owner') });
  assert.equal(list.statusCode, 200);
  const a = list.json().approvals.find((x) => x.id === id);
  assert.match(a.requestedAt, ISO_Z);
  assert.match(a.expiresAt, ISO_Z);
  assert.equal(Date.parse(a.expiresAt) - Date.parse(a.requestedAt), 24 * 3600_000);
  assert.equal(a.decidedAt, null);
  assert.ok(Math.abs(Date.parse(a.requestedAt) - Date.now()) < 120_000, 'requestedAt is UTC, not shifted by the local zone');
  const one = (await inject({ method: 'GET', url: `/api/approvals/${id}`, headers: bearer('c-owner') })).json().approval;
  assert.equal(one.expiresAt, a.expiresAt);
  const denied = (await inject({ method: 'POST', url: `/api/approvals/${id}/deny`, headers: bearer('c-owner') })).json().approval;
  assert.match(denied.decidedAt, ISO_Z);
  // The database keeps its own format.
  assert.match(db.prepare('SELECT requested_at FROM tool_approvals WHERE id = ?').get(id).requested_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('task runs: createdAt/updatedAt/finishedAt and step times are ISO UTC with Z', async () => {
  const runs = await import(join(backendDir, 'src/services/task-runs.ts'));
  const t = getOrchestrator().createTask({ title: 'contract', description: 'contract', origin: 'owner' });
  const r = await runs.createRun({ taskId: t.id, agentId: 'c-agent', userId: 'c-owner', prompt: 'x' });
  const res = await inject({ method: 'GET', url: `/api/task-runs/${r.id}`, headers: bearer('c-owner') });
  assert.equal(res.statusCode, 200, res.body);
  const run = res.json().run;
  assert.match(run.createdAt, ISO_Z);
  assert.match(run.updatedAt, ISO_Z);
  assert.equal(run.finishedAt, null);
  const cancelled = (await inject({ method: 'POST', url: `/api/task-runs/${r.id}/cancel`, headers: bearer('c-owner') })).json().run;
  assert.match(cancelled.finishedAt ?? cancelled.updatedAt, ISO_Z);
});

test('personality versions return ISO UTC createdAt', async () => {
  const res = await inject({ method: 'POST', url: '/api/agents/c-agent/personality/versions', headers: bearer('c-owner'), payload: { preset: 'balanced' } });
  if (res.statusCode >= 400) {
    // Fall back to traits when the preset name differs.
    const r2 = await inject({ method: 'POST', url: '/api/agents/c-agent/personality/versions', headers: bearer('c-owner'), payload: { traits: { warmth: 60 } } });
    assert.ok(r2.statusCode < 400, r2.body);
  }
  const list = await inject({ method: 'GET', url: '/api/agents/c-agent/personality/versions', headers: bearer('c-owner') });
  assert.equal(list.statusCode, 200, list.body);
  const versions = list.json().versions;
  assert.ok(versions.length >= 1);
  for (const v of versions) if (v.createdAt !== null) assert.match(v.createdAt, ISO_Z);
});

// --- public rooms ------------------------------------------------------------

test('agents: version + ETag; partial PUT {name}; stale expectedVersion / If-Match -> 409', async () => {
  const created = (await inject({ method: 'POST', url: '/api/agents', headers: bearer('c-owner'), payload: { name: 'Version One', description: 'first' } })).json().agent;
  assert.equal(created.version, 1);
  assert.match(created.created_at, ISO_Z);
  const got = await inject({ method: 'GET', url: `/api/agents/${created.id}`, headers: bearer('c-owner') });
  assert.equal(got.headers.etag, '"1"');

  // Partial update: only the name changes, the description is kept.
  const r1 = await inject({ method: 'PUT', url: `/api/agents/${created.id}`, headers: bearer('c-owner'), payload: { name: 'Version Two', expectedVersion: 1 } });
  assert.equal(r1.statusCode, 200, r1.body);
  assert.equal(r1.json().agent.name, 'Version Two');
  assert.equal(r1.json().agent.description, 'first');
  assert.equal(r1.json().agent.version, 2);
  assert.equal(r1.headers.etag, '"2"');

  // A stale version is refused and nothing changes (also no name reserved).
  const stale = await inject({ method: 'PUT', url: `/api/agents/${created.id}`, headers: bearer('c-owner'), payload: { name: 'Lost Update', expectedVersion: 1 } });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'version_conflict');
  assert.equal(stale.json().currentVersion, 2);
  assert.equal(stale.json().agent.name, 'Version Two');
  assert.equal(stale.json().agent.api_key, '', 'no key material in the conflict body');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM used_agent_names WHERE name = ?').get('Lost Update').n, 0);

  // If-Match works too; strong, weak and bare forms.
  const r2 = await inject({ method: 'PUT', url: `/api/agents/${created.id}`, headers: { ...bearer('c-owner'), 'if-match': 'W/"2"' }, payload: { description: 'second' } });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.equal(r2.json().agent.version, 3);
  assert.equal((await inject({ method: 'PUT', url: `/api/agents/${created.id}`, headers: { ...bearer('c-owner'), 'if-match': '"2"' }, payload: { description: 'x' } })).statusCode, 409);
  for (const bad of [{ headers: { 'if-match': 'abc' }, payload: {} }, { headers: {}, payload: { expectedVersion: 'x' } }, { headers: { 'if-match': '"3"' }, payload: { expectedVersion: 2 } }]) {
    const res = await inject({ method: 'PUT', url: `/api/agents/${created.id}`, headers: { ...bearer('c-owner'), ...bad.headers }, payload: bad.payload });
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
  }
  // Without a version the old behaviour stays (no check), but still partial.
  const r3 = await inject({ method: 'PUT', url: `/api/agents/${created.id}`, headers: bearer('c-owner'), payload: { emoji: '🧪' } });
  assert.equal(r3.statusCode, 200);
  assert.equal(r3.json().agent.description, 'second');
  // Any writer bumps the version (trigger), so the UI sees out-of-band edits.
  db.prepare('UPDATE agents_config SET system_prompt = ? WHERE id = ?').run('changed elsewhere', created.id);
  const after = (await inject({ method: 'GET', url: `/api/agents/${created.id}`, headers: bearer('c-owner') })).json().agent;
  assert.equal(after.version, r3.json().agent.version + 1);
});

test('tool grants: version + ETag; replace only when expectedVersion matches', async () => {
  const view = await inject({ method: 'GET', url: '/api/agents/c-agent/tool-grants', headers: bearer('c-owner') });
  assert.equal(view.statusCode, 200);
  const v = view.json().version;
  assert.ok(Number.isInteger(v));
  assert.equal(view.headers.etag, `"${v}"`);
  const ok = await inject({ method: 'PUT', url: '/api/agents/c-agent/tool-grants', headers: bearer('c-owner'), payload: { grants: ['memory_search'], expectedVersion: v } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().version, v + 1);
  const stale = await inject({ method: 'PUT', url: '/api/agents/c-agent/tool-grants', headers: bearer('c-owner'), payload: { grants: ['memory_search', 'uc_risky'], expectedVersion: v } });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'version_conflict');
  assert.equal(stale.json().currentVersion, v + 1);
  assert.deepEqual(stale.json().grants.map((g) => g.tool), ['memory_search'], 'nothing replaced');
  const viaHeader = await inject({ method: 'PUT', url: '/api/agents/c-agent/tool-grants', headers: { ...bearer('c-owner'), 'if-match': `"${v + 1}"` }, payload: { grants: ['memory_search', 'uc_risky'] } });
  assert.equal(viaHeader.statusCode, 200, viaHeader.body);
  assert.deepEqual(viaHeader.json().grants.map((g) => g.tool).sort(), ['memory_search', 'uc_risky']);
});

// --- chat: ids + idempotency ---------------------------------------------------

const frames = (body) => body.split('\n\n').map((b) => b.trim()).filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)));
const chat = (who, payload, headers = {}) => inject({ method: 'POST', url: '/api/chat', headers: { ...bearer(who), ...headers }, payload: { agentId: 'c-agent', sessionId: 'ui-1', ...payload } });

test('chat SSE: every frame carries runId and messageId (also as headers)', async () => {
  const res = await chat('c-owner', { stream: true, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.statusCode, 200, res.body);
  const fs = frames(res.body);
  assert.ok(fs.length >= 2, res.body);
  const { runId, messageId } = fs[0];
  assert.match(runId, /^[0-9a-f-]{36}$/);
  assert.match(messageId, /^[0-9a-f-]{36}$/);
  assert.notEqual(runId, messageId);
  for (const f of fs) assert.deepEqual([f.runId, f.messageId], [runId, messageId]);
  assert.equal(fs.at(-1).done, true);
  assert.equal(res.headers['x-run-id'], runId);
  assert.equal(res.headers['x-message-id'], messageId);
  // A second turn gets new ids.
  const again = frames((await chat('c-owner', { stream: true, messages: [{ role: 'user', content: 'hi' }] })).body);
  assert.notEqual(again[0].runId, runId);
});

test('chat Idempotency-Key: a repeat replays the first stream outcome without a new model call', async () => {
  const key = `ui-${randomBytes(8).toString('hex')}`;
  const payload = { stream: true, messages: [{ role: 'user', content: 'once only' }] };
  const before = modelCalls;
  const first = await chat('c-owner', payload, { 'idempotency-key': key });
  assert.equal(modelCalls, before + 1);
  const f1 = frames(first.body);
  const text = f1.filter((f) => f.content).map((f) => f.content).join('');
  const second = await chat('c-owner', payload, { 'idempotency-key': key });
  assert.equal(second.statusCode, 200);
  assert.equal(modelCalls, before + 1, 'the turn was not sent again');
  assert.equal(second.headers['idempotent-replayed'], 'true');
  const f2 = frames(second.body);
  assert.equal(f2[0].runId, f1[0].runId);
  assert.equal(f2[0].messageId, f1[0].messageId);
  assert.equal(f2.filter((f) => f.content).map((f) => f.content).join(''), text);
  assert.ok(f2.every((f) => f.replayed === true));
  assert.equal(f2.at(-1).done, true);

  // Same key, different request -> 422; another user may use the same key.
  const other = await chat('c-owner', { ...payload, messages: [{ role: 'user', content: 'something else' }] }, { 'idempotency-key': key });
  assert.equal(other.statusCode, 422);
  assert.equal(other.json().code, 'idempotency_key_reused');
  const member = await chat('c-member', payload, { 'idempotency-key': key });
  assert.equal(member.statusCode, 200);
  assert.equal(modelCalls, before + 2);
  assert.notEqual(frames(member.body)[0].runId, f1[0].runId);
  // Malformed keys are refused before anything runs.
  for (const bad of ['short', 'has space in it', 'x'.repeat(200)]) {
    assert.equal((await chat('c-owner', payload, { 'idempotency-key': bad })).statusCode, 400, bad);
  }
  assert.equal(modelCalls, before + 2);
});

test('chat non-stream: body has runId/messageId; a repeated key returns the same body', async () => {
  const key = `ui-${randomBytes(8).toString('hex')}`;
  const payload = { stream: false, messages: [{ role: 'user', content: 'plain' }] };
  const before = modelCalls;
  const a = await chat('c-owner', payload, { 'idempotency-key': key });
  assert.equal(a.statusCode, 200, a.body);
  assert.match(a.json().runId, /^[0-9a-f-]{36}$/);
  assert.match(a.json().messageId, /^[0-9a-f-]{36}$/);
  const b = await chat('c-owner', payload, { 'idempotency-key': key });
  assert.equal(modelCalls, before + 1);
  assert.deepEqual(b.json(), a.json());
});

test('idempotency state: a key still running answers in_progress; entries expire after 10 minutes', () => {
  idem.resetChatIdempotency();
  const fp = idem.requestFingerprint({ agentId: 'a', sessionId: 's', stream: true, messages: [{ role: 'user', content: 'x' }] });
  const first = idem.beginChatTurn('u1', 'key-12345678', fp);
  assert.equal(first.kind, 'new');
  const second = idem.beginChatTurn('u1', 'key-12345678', fp);
  assert.equal(second.kind, 'in_progress');
  assert.equal(second.ids.runId, first.ids.runId);
  assert.equal(idem.beginChatTurn('u2', 'key-12345678', fp).kind, 'new', 'keys are per user');
  assert.equal(idem.beginChatTurn('u1', null, fp).kind, 'new', 'no key -> always new');
  assert.equal(idem.IDEMPOTENCY_TTL_MS, 600_000);
});

test('model selection intent resolves from backend catalogue after actor/version gates; legacy updates remain compatible', async () => {
  const fetchBefore = globalThis.fetch, flag = process.env.DPRO_SUBSCRIPTION_CHAT;
  const { clearLocalModelCache } = await import('../src/llm/local-models.ts');
  process.env.DPRO_SUBSCRIPTION_CHAT = '0';
  let probes = 0;
  globalThis.fetch = async url => {
    probes++;
    const path = new URL(String(url)).pathname;
    if (path === '/api/tags') return Response.json({ models: [{ name: 'catalogue-fixture:latest', size: 1000, digest: 'fixture' }] });
    if (path === '/api/show') return Response.json({ capabilities: ['completion', 'thinking'] });
    if (path.endsWith('/models')) return Response.json({ data: [] });
    throw Error('unexpected fixture network');
  };
  clearLocalModelCache();
  try {
    const created = (await inject({ method: 'POST', url: '/api/agents', headers: bearer('c-owner'), payload: { name: 'Catalogue fixture' } })).json().agent;
    const update = (payload, user = 'c-owner') => inject({ method: 'PUT', url: `/api/agents/${created.id}`, headers: bearer(user), payload });
    probes = 0;
    assert.equal((await update({ expectedVersion: 1, modelSelection: 'catalogue-fixture:latest' }, 'c-member')).statusCode, 403);
    assert.equal(probes, 0);
    assert.equal((await update({ expectedVersion: 999, modelSelection: 'catalogue-fixture:latest' })).statusCode, 409);
    assert.equal(probes, 0);
    assert.equal((await update({ modelSelection: 'catalogue-fixture:latest' })).statusCode, 400);
    assert.equal(probes, 0);
    assert.equal((await update({ expectedVersion: 1, modelSelection: 'catalogue-fixture:latest', provider: 'claude' })).statusCode, 400);
    assert.equal(probes, 0);
    const selected = await update({ expectedVersion: 1, modelSelection: 'catalogue-fixture:latest' });
    assert.equal(selected.statusCode, 200, selected.body);
    assert.equal(selected.json().agent.model, 'catalogue-fixture:latest');
    assert.equal(selected.json().agent.provider, 'ollama');
    const invalid = await update({ expectedVersion: 2, modelSelection: 'claude-missing-fixture' });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().code, 'invalid_model');
    const legacy = await update({ expectedVersion: 2, model: 'legacy-offline-fixture', provider: 'ollama' });
    assert.equal(legacy.statusCode, 200, legacy.body);
    assert.equal(legacy.json().agent.model, 'legacy-offline-fixture');
  } finally {
    globalThis.fetch = fetchBefore; clearLocalModelCache();
    if (flag === undefined) delete process.env.DPRO_SUBSCRIPTION_CHAT; else process.env.DPRO_SUBSCRIPTION_CHAT = flag;
  }
});

test('canonical model descriptors refuse absent, ambiguous, unavailable and unsupported sources', async () => {
  const { canonicalModelSelection } = await import('../src/services/model-catalogue.ts');
  for (const provider of ['local', 'ollama', 'claude', 'lmstudio', 'subscription']) { const id = provider === 'lmstudio' ? 'lmstudio:fixture' : provider === 'subscription' ? 'subscription:codex' : 'fixture'; assert.equal(canonicalModelSelection(id, [{ id, provider }]).provider, provider === 'local' ? 'ollama' : provider); }
  for (const models of [[{ id: 'fixture', provider: 'lmstudio' }], [{ id: 'fixture', provider: 'subscription' }], [], [{ id: 'fixture', provider: 'local', available: false }], [{ id: 'fixture', provider: 'openai' }], [{ id: 'fixture', provider: 'local' }, { id: 'fixture', provider: 'claude' }]]) assert.throws(() => canonicalModelSelection('fixture', models), /invalid_model/);
});
