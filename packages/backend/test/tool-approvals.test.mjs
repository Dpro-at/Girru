import {fileURLToPath as backendFixtureFileURLToPath} from 'node:url';
// S1.3: risky tool calls wait for a one-time owner approval.
// Pending record (encrypted params), nothing executed until approved, approve
// runs exactly once, deny never runs, non-owners cannot approve.
// Run: node --import tsx --test test/tool-approvals.test.mjs
// Throwaway DB + cwd, random test-only secrets, model calls stubbed (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = backendFixtureFileURLToPath(new URL('../',import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'ap-approvals-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
delete process.env.AGENT_EXEC_TOOLS;

const modelRequests = [];
let emitToolCalls = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith('https://api.anthropic.com/')) throw new Error(`unexpected network call in test: ${url}`);
  const body = JSON.parse(init.body);
  modelRequests.push(body);
  const last = body.messages[body.messages.length - 1];
  const isToolResult = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
  const content = emitToolCalls && !isToolResult ? emitToolCalls : [{ type: 'text', text: 'stub reply' }];
  return new Response(JSON.stringify({ content, stop_reason: isToolResult || !emitToolCalls ? 'end_turn' : 'tool_use' }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};

const quiet = { log: console.log, warn: console.warn };
console.log = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`).run(id, `${id}@example.test`, id, role);
addUser('ap-owner', 'owner');
addUser('ap-admin', 'admin');
addUser('ap-user', 'user');
db.prepare(`INSERT INTO agents_config (id, name, provider, model) VALUES ('ap-agent', 'ap-agent', 'claude', 'claude-test')`).run();

const tools = await import(join(backendDir, 'src/tools/index.ts'));
const grants = await import(join(backendDir, 'src/tools/grants.ts'));
const approvals = await import(join(backendDir, 'src/tools/approvals.ts'));
const { setAgentApiKey } = await import(join(backendDir, 'src/credentials/authority.ts'));
const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { approvalsRoutes } = await import(join(backendDir, 'src/api/routes/approvals.ts'));
const { chatRoutes } = await import(join(backendDir, 'src/api/routes/chat.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');

const sent = [];
const ran = [];
tools.registerExtensionTool({
  name: 'demo_send', description: 'send', extensionId: 'demo', destinationParam: 'to',
  input_schema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to'] },
  async execute(params) { sent.push(params); return { content: [{ type: 'text', text: `sent to ${params.to}` }] }; },
});
tools.registerExtensionTool({
  name: 'demo_risky', description: 'flagged by its extension', extensionId: 'demo', requiresApproval: true,
  input_schema: { type: 'object', properties: {} },
  async execute() { ran.push('demo_risky'); return { content: [{ type: 'text', text: 'ran' }] }; },
});
tools.registerExtensionTool({
  name: 'demo_safe', description: 'no approval', extensionId: 'demo',
  input_schema: { type: 'object', properties: {} },
  async execute() { ran.push('demo_safe'); return { content: [{ type: 'text', text: 'ran' }] }; },
});
const avail = tools.createToolsRegistry({ workspaceDir: dir }).listRegistered();
await grants.setAgentGrants('ap-agent', { grants: ['demo_send', 'demo_risky', 'demo_safe', 'memory_search'] }, 'ap-owner', avail);
await setAgentApiKey('ap-agent', 'sk-ant-test-' + randomBytes(12).toString('hex'));

const app = Fastify();
registerAuthGate(app);
await app.register(approvalsRoutes);
await app.register(chatRoutes);
await app.ready();

console.log = quiet.log;
console.warn = quiet.warn;

test.after(async () => {
  globalThis.fetch = realFetch;
  for (const n of ['demo_send', 'demo_risky', 'demo_safe']) tools.unregisterExtensionTool(n);
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const quietly = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };
const registry = () => tools.createToolsRegistry({ workspaceDir: dir, agentId: 'ap-agent', userId: 'ap-owner', sessionId: 's1' });
const requestSend = async (to, text = 'hello') => {
  const res = await quietly(() => registry().execute('demo_send', { to, text }));
  assert.equal(res.error, undefined, 'waiting is not an error');
  assert.equal(res.details.status, 'pending_approval');
  assert.match(res.content[0].text, /Waiting for owner approval/);
  return res.details.approvalId;
};
// The owner opens the full view first and approves exactly that (paramsHash).
const detail = async (id) => (await app.inject({ method: 'GET', url: `/api/approvals/${id}`, headers: auth('ap-owner') })).json().approval;
const approve = async (id, who = 'ap-owner', hash) => {
  const paramsHash = hash ?? (await detail(id))?.paramsHash ?? undefined;
  return quietly(() => app.inject({ method: 'POST', url: `/api/approvals/${id}/approve`, headers: auth(who), payload: { paramsHash } }));
};
const deny = (id, who = 'ap-owner') => app.inject({ method: 'POST', url: `/api/approvals/${id}/deny`, headers: auth(who) });

test('a risky call creates a pending record (params encrypted) and runs nothing', async () => {
  sent.length = 0;
  const secretText = 'secret-' + randomBytes(8).toString('hex');
  const id = await requestSend('chat-9', secretText);
  assert.equal(sent.length, 0);
  const row = db.prepare('SELECT * FROM tool_approvals WHERE id = ?').get(id);
  assert.equal(row.status, 'pending');
  assert.equal(row.agent_id, 'ap-agent');
  assert.equal(row.category, 'message');
  assert.ok(!row.params_encrypted.includes(secretText), 'params stored encrypted');
  assert.match(row.params_preview, /chat-9/);

  // Extension-flagged tool needs approval too; an unflagged one runs directly.
  ran.length = 0;
  const risky = await quietly(() => registry().execute('demo_risky', {}));
  assert.equal(risky.details.status, 'pending_approval');
  const safe = await quietly(() => registry().execute('demo_safe', {}));
  assert.equal(safe.error, undefined);
  assert.deepEqual(ran, ['demo_safe']);
  // Built-in risky tools are classified even without a flag.
  for (const name of ['credentials_save', 'skill_install', 'storage_delete', 'make_call', 'trading_execute', 'whatsapp_send', 'x_send']) {
    assert.ok(approvals.approvalCategory({ name }), `${name} needs approval`);
  }
  assert.equal(approvals.approvalCategory({ name: 'read' }), null);
});

test('only the owner may list, approve or deny', async () => {
  const id = await requestSend('chat-1');
  for (const [method, url] of [['GET', '/api/approvals'], ['GET', `/api/approvals/${id}`], ['POST', `/api/approvals/${id}/approve`], ['POST', `/api/approvals/${id}/deny`]]) {
    assert.equal((await app.inject({ method, url })).statusCode, 401, `${method} ${url} anonymous`);
    for (const who of ['ap-admin', 'ap-user']) {
      const res = await app.inject({ method, url, headers: auth(who) });
      assert.equal(res.statusCode, 403, `${method} ${url} as ${who}`);
    }
  }
  assert.equal(db.prepare('SELECT status FROM tool_approvals WHERE id = ?').get(id).status, 'pending');
  const list = await app.inject({ method: 'GET', url: '/api/approvals?status=pending', headers: auth('ap-owner') });
  assert.equal(list.statusCode, 200);
  const found = list.json().approvals.find((a) => a.id === id);
  assert.ok(found);
  assert.equal(found.toolName, 'demo_send');
  assert.equal(found.paramsEncrypted, undefined);
});

test('agentId filter keeps one agent\'s requests, refuses a bad id and stays owner-only', async () => {
  const id = await requestSend('chat-agent-filter');
  const res = await quietly(() => registry().execute('demo_send', { to: 'x', text: 'y' }));
  assert.match(res.content[0].text, /Approvals › Waiting for me; you never approve it yourself/);
  const mine = await app.inject({ method: 'GET', url: '/api/approvals?agentId=ap-agent&limit=100', headers: auth('ap-owner') });
  assert.equal(mine.statusCode, 200, mine.body);
  assert.ok(mine.json().approvals.some((a) => a.id === id));
  assert.ok(mine.json().approvals.every((a) => a.agentId === 'ap-agent'));
  const other = await app.inject({ method: 'GET', url: '/api/approvals?agentId=someone-else', headers: auth('ap-owner') });
  assert.equal(other.statusCode, 200);
  assert.deepEqual(other.json().approvals, []);
  const both = await app.inject({ method: 'GET', url: '/api/approvals?status=pending&agentId=ap-agent', headers: auth('ap-owner') });
  assert.ok(both.json().approvals.every((a) => a.status === 'pending' && a.agentId === 'ap-agent'));
  for (const bad of ['', '..%2Fkeys', "x'%20OR%201%3D1", '-lead', 'a'.repeat(129)]) {
    const r = await app.inject({ method: 'GET', url: '/api/approvals?agentId=' + bad, headers: auth('ap-owner') });
    assert.equal(r.statusCode, 400, `agentId ${bad}`);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/approvals?agentId=ap-agent&agentId=x', headers: auth('ap-owner') })).statusCode, 400);
  await assert.rejects(() => approvals.listApprovals({ agentId: 'bad id' }));
  assert.equal((await app.inject({ method: 'GET', url: '/api/approvals?agentId=ap-agent' })).statusCode, 401);
  for (const who of ['ap-admin', 'ap-user']) assert.equal((await app.inject({ method: 'GET', url: '/api/approvals?agentId=ap-agent', headers: auth(who) })).statusCode, 403);
});

test('approve runs the call exactly once; a second approval is refused', async () => {
  sent.length = 0;
  const id = await requestSend('chat-2', 'once');
  const res = await approve(id);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().approval.status, 'executed');
  assert.deepEqual(sent.map((s) => s.to), ['chat-2']);
  const again = await approve(id);
  assert.equal(again.statusCode, 409);
  assert.equal(sent.length, 1);

  // Concurrent approvals: still once.
  sent.length = 0;
  const id2 = await requestSend('chat-3');
  const results = await Promise.all([approve(id2), approve(id2), approve(id2)]);
  assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
  assert.equal(sent.length, 1);
});

test('deny never runs; approve after deny is refused', async () => {
  sent.length = 0;
  const id = await requestSend('chat-4');
  const res = await deny(id);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().approval.status, 'denied');
  assert.equal((await approve(id)).statusCode, 409);
  assert.equal((await deny(id)).statusCode, 409);
  assert.equal(sent.length, 0);
});

test('expired requests cannot be approved; revoked grants are re-checked at approval', async () => {
  sent.length = 0;
  const old = await requestSend('chat-5');
  db.prepare(`UPDATE tool_approvals SET requested_at = datetime('now', '-2 days') WHERE id = ?`).run(old);
  assert.equal((await approve(old)).statusCode, 409);
  assert.equal(db.prepare('SELECT status FROM tool_approvals WHERE id = ?').get(old).status, 'expired');

  const id = await requestSend('chat-6');
  await grants.setAgentGrants('ap-agent', { grants: ['demo_risky', 'demo_safe', 'memory_search'] }, 'ap-owner', avail);
  try {
    const res = await approve(id);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().approval.status, 'failed');
    assert.equal(sent.length, 0, 'not run after the grant was removed');
  } finally {
    await grants.setAgentGrants('ap-agent', { grants: ['demo_send', 'demo_risky', 'demo_safe', 'memory_search'] }, 'ap-owner', avail);
  }
});

test('a forged ticket cannot bypass approval', async () => {
  sent.length = 0;
  const res = await quietly(() => registry().execute('demo_send', { to: 'x' }, { approvalTicket: { approvalId: 'a', toolName: 'demo_send' } }));
  assert.equal(res.details.status, 'pending_approval');
  assert.equal(sent.length, 0);
});

test('chat: a model-emitted risky call returns "waiting for approval" and does not run', async () => {
  sent.length = 0;
  modelRequests.length = 0;
  emitToolCalls = [{ type: 'tool_use', id: 'x1', name: 'demo_send', input: { to: 'chat-7', text: 'hi' } }];
  let res;
  try {
    res = await quietly(() => app.inject({ method: 'POST', url: '/api/chat', headers: auth('ap-owner'),
      payload: { agentId: 'ap-agent', stream: false, messages: [{ role: 'user', content: 'send it' }] } }));
  } finally { emitToolCalls = null; }
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(sent.length, 0);
  const result = modelRequests[1].messages.at(-1).content.find((b) => b.type === 'tool_result');
  assert.match(JSON.stringify(result.content), /Waiting for owner approval/);
  assert.notEqual(result.is_error, true);
  const pending = (await approvals.listApprovals({ status: 'pending' })).filter((a) => a.paramsPreview?.to === 'chat-7');
  assert.equal(pending.length, 1);
});

test('full view shows the exact parameters; lossy list previews are marked truncated', async () => {
  const long = 'L'.repeat(1000);
  const res = await quietly(() => registry().execute('demo_send', { to: 'chat-8', text: long, extra: { nested: ['a', { deep: 1 }] }, apiKey: 'sk-secret-' + 'x'.repeat(20) }));
  const id = res.details.approvalId;
  const item = (await approvals.listApprovals({ status: 'pending' })).find((a) => a.id === id);
  assert.equal(item.truncated, true);
  const full = await detail(id);
  assert.equal(full.params.text, long, 'exact long text');
  assert.deepEqual(full.params.extra, { nested: ['a', { deep: 1 }] }, 'exact nested object');
  assert.deepEqual(Object.keys(full.params.apiKey).sort(), ['fingerprint', 'masked'], 'real secret field masked');
  assert.equal(full.params.apiKey.masked, true);
  assert.deepEqual(full.maskedFields, ['apiKey']);
  assert.match(full.paramsHash, /^[0-9a-f]{64}$/);
  const short = await requestSend('chat-short', 'hi');
  assert.equal((await approvals.listApprovals({ status: 'pending' })).find((a) => a.id === short).truncated, false);
});

test('approve must carry the hash of the shown parameters; changed parameters never run', async () => {
  sent.length = 0;
  const id = await requestSend('chat-10', 'original');
  const noHash = await quietly(() => app.inject({ method: 'POST', url: `/api/approvals/${id}/approve`, headers: auth('ap-owner'), payload: {} }));
  assert.equal(noHash.statusCode, 400);
  const wrong = await approve(id, 'ap-owner', 'f'.repeat(64));
  assert.equal(wrong.statusCode, 409);
  assert.equal(db.prepare('SELECT status FROM tool_approvals WHERE id = ?').get(id).status, 'pending', 'still pending');

  // Parameters swapped in storage after the request (same hash shown): refused, nothing runs.
  const shownHash = (await detail(id)).paramsHash;
  const { getEncryptionService } = await import(join(backendDir, 'src/credentials/encryption.ts'));
  const forged = await getEncryptionService().encrypt(JSON.stringify({ to: 'attacker', text: 'swapped' }));
  db.prepare('UPDATE tool_approvals SET params_encrypted = ?, params_iv = ?, params_tag = ? WHERE id = ?')
    .run(forged.encrypted, forged.iv, forged.authTag, id);
  const res = await approve(id, 'ap-owner', shownHash);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().approval.status, 'failed');
  assert.equal(sent.length, 0);
});

test('CL-01: only secret string leaves are masked; objects are walked; generic `value` is shown', async () => {
  const secret = 'tok-' + randomBytes(16).toString('hex');
  const res = await quietly(() => registry().execute('demo_send', {
    to: 'chat-cl01', text: 'hi', value: 'visible-value',
    settings: { value: 42, enabled: true, label: 'shown', nested: [{ value: 'also-visible' }] },
    auth: { token: secret, type: 'bearer' },
    credentials: { username: 'bob', password: secret, keys: [secret, 7], enabled: false },
  }));
  const full = await detail(res.details.approvalId);
  assert.equal(full.params.value, 'visible-value', 'generic `value` is not a secret');
  assert.deepEqual(full.params.settings, { value: 42, enabled: true, label: 'shown', nested: [{ value: 'also-visible' }] });
  assert.equal(full.params.auth.type, 'bearer', 'sibling of a secret stays visible');
  assert.equal(full.params.auth.token.masked, true);
  assert.match(full.params.auth.token.fingerprint, /^[0-9a-f]{8}$/);
  // Object under a secret-looking key: structure visible, string/number leaves masked, booleans shown.
  assert.equal(full.params.credentials.enabled, false);
  assert.equal(full.params.credentials.username.masked, true);
  assert.equal(full.params.credentials.keys.length, 2);
  assert.equal(full.params.credentials.keys[1].masked, true);
  assert.deepEqual(full.maskedFields.sort(), ['auth.token', 'credentials.keys[0]', 'credentials.keys[1]', 'credentials.password', 'credentials.username'].sort());
  assert.ok(!JSON.stringify(full).includes(secret), 'secret never in the response');
  const listed = (await approvals.listApprovals({ status: 'pending' })).find((a) => a.id === res.details.approvalId);
  assert.equal(listed.paramsPreview.value, 'visible-value');
  assert.ok(!JSON.stringify(listed).includes(secret));
});

test('CL-01: credentials_save `value` is shown only as a SHA-256 fingerprint', async () => {
  const { createHash } = await import('node:crypto');
  const secret = 'sk-test-' + randomBytes(16).toString('hex');
  const masked = [];
  const out = approvals.maskApprovalParams('credentials_save', { service: 'custom', name: 'n', value: secret, meta: { value: 'x' } }, masked);
  assert.deepEqual(out.value, { masked: true, fingerprint: createHash('sha256').update(secret).digest('hex').slice(0, 8) });
  assert.equal(out.service, 'custom');
  assert.deepEqual(out.meta, { value: 'x' }, 'only the top-level `value` of that tool');
  assert.deepEqual(masked, ['value']);
  // Other tools: `value` visible.
  assert.equal(approvals.maskApprovalParams('demo_send', { value: secret }).value, secret);
  // Hash binding still covers the real parameters (approve flow unchanged).
  assert.deepEqual(approvals.maskApprovalParams('x', { password: '' }, []), { password: '' }, 'empty stays empty');
});
