// S1.2: per-agent tool grants. Offered tools and registry execution are the
// intersection of the exec gate, the channel policy and the agent's grants;
// legacy agents keep their non-exec tools, new agents get a minimal set,
// sub-agents and delegated runs only get a subset of the parent's grants.
// Run: node --import tsx --test test/agent-tool-grants.test.mjs
// Throwaway DB + cwd, random test-only secrets, model calls stubbed (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-grants-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
delete process.env.AGENT_EXEC_TOOLS;
for (const key of Object.keys(process.env)) if (key.startsWith('CHANNEL_AGENT_TOOLS_')) delete process.env[key];

const modelRequests = [];
let emitToolCalls = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (!target.startsWith('https://api.anthropic.com/')) throw new Error(`unexpected network call in test: ${target}`);
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
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES ('gr-owner', 'gr@example.test', 'gr-owner', 'x', 'owner', 'active')`).run();

const tools = await import(join(backendDir, 'src/tools/index.ts'));
const grants = await import(join(backendDir, 'src/tools/grants.ts'));
const { setAgentApiKey } = await import(join(backendDir, 'src/credentials/authority.ts'));
const { chatRoutes } = await import(join(backendDir, 'src/api/routes/chat.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');

// A side-effect-free extension tool with a destination parameter.
const notified = [];
tools.registerExtensionTool({
  name: 'fake_notify', description: 'notify', extensionId: 'fake', destinationParam: 'target',
  input_schema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
  async execute(params) { notified.push(params.target); return { content: [{ type: 'text', text: 'notified' }] }; },
});
tools.registerExtensionTool({
  name: 'fake_proc', description: 'proc', extensionId: 'fake', execClass: true,
  input_schema: { type: 'object', properties: {} },
  async execute() { return { content: [{ type: 'text', text: 'ran' }] }; },
});

const app = Fastify();
await app.register(chatRoutes);
await app.ready();

console.log = quiet.log;
console.warn = quiet.warn;

test.after(async () => {
  globalThis.fetch = realFetch;
  tools.unregisterExtensionTool('fake_notify');
  tools.unregisterExtensionTool('fake_proc');
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

// STORE-MAP-01 P2 (AG1): an agent may read its own guides (guide_read) wherever it runs; it is prompt text on demand, not a grant.
const P2_ON = /^(1|true|yes|on)$/i.test(process.env.GIRRU_STORE_P2 ?? '');
const noGuide = (list) => list.filter((n) => n !== 'guide_read');
const addAgent = (id) => db.prepare(`INSERT INTO agents_config (id, name, provider, model) VALUES (?, ?, 'claude', 'claude-test')`).run(id, id);
const registryFor = (agentId, extra = {}) => tools.createToolsRegistry({ userId: 'gr-owner', workspaceDir: dir, agentId, ...extra });
const names = (reg) => noGuide(reg.getToolsForAPI().map((t) => t.name)).sort();
const offersGuide = (reg) => reg.getToolsForAPI().some((t) => t.name === 'guide_read');
const quietly = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };

test('legacy agents keep their current non-exec tools; exec-class tools are never seeded', () => {
  const profile = db.prepare(`SELECT source FROM agent_grant_profiles WHERE agent_id = 'main-agent'`).get();
  assert.equal(profile.source, 'legacy-pending');
  const offered = names(registryFor('main-agent'));
  for (const t of ['read', 'write', 'web_fetch', 'memory_search', 'credentials_save', 'skill_install', 'fake_notify']) {
    assert.ok(offered.includes(t), `legacy agent keeps ${t}`);
  }
  const stored = db.prepare(`SELECT tool_name FROM agent_tool_grants WHERE agent_id = 'main-agent'`).all().map((r) => r.tool_name);
  for (const t of ['exec', 'execute_code', 'desktop_control', 'fake_proc']) assert.ok(!stored.includes(t), `${t} not seeded`);
  assert.equal(db.prepare(`SELECT source FROM agent_grant_profiles WHERE agent_id = 'main-agent'`).get().source, 'legacy');
});

test('new agents start with the minimal safe set; a registry without an agent too', () => {
  addAgent('gr-new');
  assert.deepEqual(names(registryFor('gr-new')), [...grants.DEFAULT_AGENT_TOOLS].sort());
  assert.equal(db.prepare(`SELECT source FROM agent_grant_profiles WHERE agent_id = 'gr-new'`).get().source, 'default');
  assert.deepEqual(names(registryFor(undefined)), [...grants.DEFAULT_AGENT_TOOLS].sort());
  assert.deepEqual(names(registryFor('no-such-agent')), [], 'unknown agent: nothing');
  assert.equal(offersGuide(registryFor('gr-new')), P2_ON);
});

test('an ungranted call is refused even if the model emits it; exec needs grant AND server gate', async () => {
  const reg = registryFor('gr-new');
  const target = join(dir, 'pwned.txt');
  const res = await quietly(() => reg.execute('write', { path: target, content: 'x' }));
  assert.match(res.error, /agent grants/);
  assert.equal(existsSync(target), false);

  // Owner grants fake_proc (exec-class): still refused while the exec gate is off.
  await grants.setAgentGrants('gr-new', { grants: ['memory_search', 'fake_proc'] }, 'gr-owner', registryFor('gr-new').listRegistered());
  const reg2 = registryFor('gr-new');
  assert.deepEqual(names(reg2), ['memory_search']);
  assert.match((await quietly(() => reg2.execute('fake_proc', {}))).error, /disabled/i);
});

test('destination scopes: only granted destinations run', async () => {
  addAgent('gr-scope');
  await grants.setAgentGrants('gr-scope', { grants: [{ tool: 'fake_notify', scopes: { destinations: ['ok-1'] } }] }, 'gr-owner', registryFor('gr-scope').listRegistered());
  const reg = registryFor('gr-scope');
  notified.length = 0;
  assert.match((await quietly(() => reg.execute('fake_notify', { target: 'other' }))).error, /agent grants/);
  assert.equal((await quietly(() => reg.execute('fake_notify', { target: 'ok-1' }))).error, undefined);
  assert.deepEqual(notified, ['ok-1']);
  await assert.rejects(() => grants.setAgentGrants('gr-scope', { grants: [{ tool: 'fake_notify', scopes: { anything: 1 } }] }, 'gr-owner', []), /unknown scope/);
});

test('chat: the model sees only granted tools and ungranted emitted calls are refused', async () => {
  addAgent('gr-chat');
  await quietly(() => setAgentApiKey('gr-chat', 'sk-ant-test-' + randomBytes(12).toString('hex')));
  await grants.setAgentGrants('gr-chat', { grants: ['memory_search', 'read'] }, 'gr-owner', registryFor('gr-chat').listRegistered());
  modelRequests.length = 0;
  const target = join(dir, 'chat-pwned.txt');
  emitToolCalls = [
    { type: 'tool_use', id: 'w1', name: 'write', input: { path: target, content: 'x' } },
    { type: 'tool_use', id: 'n1', name: 'fake_notify', input: { target: 'x' } },
  ];
  notified.length = 0;
  let res;
  try {
    res = await quietly(() => app.inject({ method: 'POST', url: '/api/chat',
      headers: { authorization: `Bearer ${generateToken('gr-owner', 1)}` },
      payload: { agentId: 'gr-chat', stream: false, messages: [{ role: 'user', content: 'hi' }] } }));
  } finally { emitToolCalls = null; }
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(noGuide((modelRequests[0].tools || []).map((t) => t.name)).sort(), ['memory_search', 'read']);
  assert.equal(existsSync(target), false);
  assert.deepEqual(notified, []);
  const results = modelRequests[1].messages.at(-1).content.filter((b) => b.type === 'tool_result');
  assert.equal(results.length, 2);
  for (const r of results) assert.match(JSON.stringify(r.content), /not permitted for this agent/);
});

test('sub-agents and delegated runs only get a subset of the parent\'s grants', async () => {
  addAgent('gr-parent');
  addAgent('gr-child');
  const avail = registryFor('gr-parent').listRegistered();
  await grants.setAgentGrants('gr-parent', { grants: ['memory_search', 'read', { tool: 'fake_notify', scopes: { destinations: ['a', 'b'] } }] }, 'gr-owner', avail);

  await assert.rejects(() => grants.setAgentGrants('gr-child', { grants: ['write'], parentAgentId: 'gr-parent' }, 'gr-owner', avail), /subset/);
  await assert.rejects(() => grants.setAgentGrants('gr-child', { grants: ['fake_notify'], parentAgentId: 'gr-parent' }, 'gr-owner', avail), /subset/);
  await assert.rejects(() => grants.setAgentGrants('gr-child', { grants: [{ tool: 'fake_notify', scopes: { destinations: ['c'] } }], parentAgentId: 'gr-parent' }, 'gr-owner', avail), /subset/);
  await grants.setAgentGrants('gr-child', { grants: ['memory_search', 'read', { tool: 'fake_notify', scopes: { destinations: ['a'] } }], parentAgentId: 'gr-parent' }, 'gr-owner', avail);
  await assert.rejects(() => grants.setAgentGrants('gr-parent', { grants: ['read'], parentAgentId: 'gr-child' }, 'gr-owner', avail), /cycle/);

  // The parent later loses `read`: the child's effective grants shrink with it.
  await grants.setAgentGrants('gr-parent', { grants: ['memory_search', { tool: 'fake_notify', scopes: { destinations: ['a', 'b'] } }] }, 'gr-owner', avail);
  assert.deepEqual(names(registryFor('gr-child')), ['fake_notify', 'memory_search']);

  // A delegated run (task spawned by gr-new, which only has memory_search) gets the intersection.
  const delegated = await grants.loadAgentGrants('gr-child', avail, ['gr-new']);
  assert.deepEqual([...delegated.tools.keys()].sort(), ['memory_search']);
  // Delegated from an unknown agent: nothing (fail closed).
  assert.deepEqual([...(await grants.loadAgentGrants('gr-child', avail, ['ghost'])).tools.keys()], []);
  // The cron runner passes the task's spawners.
  const reg = registryFor('gr-child', { delegatedFrom: ['gr-new'] });
  assert.deepEqual(names(reg), ['memory_search']);
});
