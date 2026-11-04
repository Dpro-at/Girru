// S1.4: owner API to view/edit an agent's tool grants. Owner only, audited.
// Run: node --import tsx --test test/agent-grants-api.test.mjs
// Throwaway DB + cwd, random test-only secrets, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-grants-api-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
delete process.env.AGENT_EXEC_TOOLS;

const quiet = { log: console.log, warn: console.warn };
console.log = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`).run(id, `${id}@example.test`, id, role);
addUser('ga-owner', 'owner');
addUser('ga-admin', 'admin');
addUser('ga-user', 'user');
for (const id of ['ga-agent', 'ga-parent', 'ga-sub']) {
  db.prepare(`INSERT INTO agents_config (id, name) VALUES (?, ?)`).run(id, id);
}

const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { agentGrantsRoutes } = await import(join(backendDir, 'src/api/routes/agent-grants.ts'));
const tools = await import(join(backendDir, 'src/tools/index.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');

const app = Fastify();
registerAuthGate(app);
await app.register(agentGrantsRoutes);
await app.ready();

console.log = quiet.log;
console.warn = quiet.warn;

test.after(async () => {
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const url = (id) => `/api/agents/${id}/tool-grants`;
const put = (id, payload, who = 'ga-owner') => app.inject({ method: 'PUT', url: url(id), headers: auth(who), payload });
const audits = () => db.prepare(`SELECT * FROM audit_logs WHERE action = 'agent_tool_grants.update' ORDER BY id`).all();

test('only the owner may view or change grants (gate + handler)', async () => {
  for (const method of ['GET', 'PUT']) {
    assert.equal((await app.inject({ method, url: url('ga-agent'), payload: { grants: [] } })).statusCode, 401);
    for (const who of ['ga-admin', 'ga-user']) {
      const res = await app.inject({ method, url: url('ga-agent'), headers: auth(who), payload: { grants: ['read'] } });
      assert.equal(res.statusCode, 403, `${method} as ${who}`);
    }
  }
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM agent_tool_grants WHERE agent_id = 'ga-agent' AND tool_name = 'read'`).get().n, 0);
});

test('owner views grants with the available tool list', async () => {
  const res = await app.inject({ method: 'GET', url: url('ga-agent'), headers: auth('ga-owner') });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.agentId, 'ga-agent');
  assert.ok(body.grants.length > 0);
  const exec = body.available.find((t) => t.name === 'exec');
  assert.equal(exec.execClass, true);
  assert.equal(exec.allowedByServer, false);
  assert.equal(body.available.find((t) => t.name === 'credentials_save').requiresApproval, true);
  assert.equal((await app.inject({ method: 'GET', url: url('no-agent'), headers: auth('ga-owner') })).statusCode, 404);
});

// STORE-MAP-01 P2 (AG1): an agent may read its own guides (guide_read) wherever it runs; it is prompt text on demand, not a grant.
const P2_ON = /^(1|true|yes|on)$/i.test(process.env.GIRRU_STORE_P2 ?? '');
const noGuide = (list) => list.filter((n) => n !== 'guide_read');
test('owner changes grants; the change is audited and takes effect', async () => {
  const before = audits().length;
  const res = await put('ga-agent', { grants: ['read', { tool: 'telegram_send', scopes: { destinations: ['chat-1'] } }] });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().grants.map((g) => g.tool), ['read', 'telegram_send']);
  assert.equal(res.json().source, 'owner');
  const log = audits();
  assert.equal(log.length, before + 1);
  const entry = log.at(-1);
  assert.equal(entry.user_id, 'ga-owner');
  assert.equal(entry.event_type, 'authz.permission.change');
  assert.equal(entry.resource_id, 'ga-agent');
  const meta = JSON.parse(entry.metadata);
  assert.ok(meta.added.includes('read'));
  assert.ok(meta.removed.includes('memory_search'));

  const reg = tools.createToolsRegistry({ workspaceDir: dir, agentId: 'ga-agent' });
  assert.deepEqual(noGuide(reg.getToolsForAPI().map((t) => t.name)), ['read']);
  assert.equal(reg.getToolsForAPI().some((t) => t.name === 'guide_read'), P2_ON);
});

test('invalid input is refused (and audited as a failure)', async () => {
  for (const payload of [{}, { grants: 'read' }, { grants: ['bad name!'] }, { grants: ['read', 'read'] },
    { grants: [{ tool: 'read', scopes: { admin: true } }] }, { grants: [], parentAgentId: 'ghost' }, { grants: [], parentAgentId: 'ga-agent' }]) {
    const res = await put('ga-agent', payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  assert.equal((await put('no-agent', { grants: [] })).statusCode, 404);
  assert.ok(audits().some((a) => a.success === 0));
});

test('a sub-agent only receives a subset of its parent\'s grants', async () => {
  assert.equal((await put('ga-parent', { grants: ['memory_search', 'read'] })).statusCode, 200);
  const bad = await put('ga-sub', { grants: ['write'], parentAgentId: 'ga-parent' });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /subset/);
  const ok = await put('ga-sub', { grants: ['read'], parentAgentId: 'ga-parent' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().parentAgentId, 'ga-parent');
  const cycle = await put('ga-parent', { grants: ['read'], parentAgentId: 'ga-sub' });
  assert.equal(cycle.statusCode, 400);
});

test('keepScopes: a name-only save keeps each still-granted tool\'s limits (never widens them)', async () => {
  const first = await put('ga-agent', { grants: ['read', { tool: 'telegram_send', scopes: { destinations: ['chat-1'] } }] });
  assert.equal(first.statusCode, 200, first.body);
  const v = first.json().version;
  const res = await put('ga-agent', { grants: ['read', 'telegram_send', 'memory_search'], keepScopes: true, expectedVersion: v });
  assert.equal(res.statusCode, 200, res.body);
  const tg = res.json().grants.find((g) => g.tool === 'telegram_send');
  assert.deepEqual(tg.scopes, { destinations: ['chat-1'] }, 'the limit stays');
  assert.equal(res.json().grants.find((g) => g.tool === 'memory_search').scopes ?? null, null);
  const gone = await put('ga-agent', { grants: ['read'], keepScopes: true, expectedVersion: res.json().version });
  assert.deepEqual(gone.json().grants.map((g) => g.tool), ['read'], 'unchecking still removes a limited tool');
});
