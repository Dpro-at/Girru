// STORE-MAP-01 P10 (XP3, SUB4): the provider conformance scenario through Girru's real doors, with
// EVERY memory switch on together (PILOT, P2–P9, P9B), on a real database:
//   save a fact with a topic key -> recall finds it -> replace it with a corrected text -> handoff ->
//   propose -> a wrong argument is refused -> a last recall returns the new fact and not the old one.
// Three doors, each with each provider's own wire format as synthetic fixtures (CX11: no live provider,
// no network, no credits):
//  1 native tools (API and local models): Claude API (tool_use blocks), Ollama and LM Studio (function
//    calls) run Girru's own memory tools through the agent's tools registry;
//  2 the subscription JSON tool protocol (SUB4): Claude Code (-p --output-format json), Codex (exec --json
//    events) and Antigravity (stream-json) replies are parsed by the real CLI output reader and drive
//    subscriptionToolLoop over the same registry, as a chat reply does;
//  3 MCP (dpro-memory): Claude Code, Codex, Gemini CLI, Antigravity and Cursor through the real MCP server
//    and HTTP door with a session capability; their writes become proposals the owner approves.
// With P10_CONFORMANCE_OUT set, the per-door, per-provider results are written there as JSON (for the
// P10 report). Live runs against the real providers are NOT made here; they wait for the owner's OK.
// Run: node --import tsx --test test/store-p10-conformance.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

import { clearEnv } from './helpers/switches.mjs';
const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p10-xp3-')));
const home = join(dir, 'home');
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
mkdirSync(home, { recursive: true });
process.chdir(dir);
process.env.HOME = home;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['CODEX_HOME', 'AGENT_EXEC_TOOLS', 'DEFAULT_MODEL', 'GIRRU_STORE_PILOT_AGENT']) clearEnv(k);
const SWITCHES = ['GIRRU_STORE_PILOT', 'GIRRU_STORE_P2', 'GIRRU_STORE_P3', 'GIRRU_STORE_P4', 'GIRRU_STORE_P5', 'GIRRU_STORE_P6', 'GIRRU_STORE_P7', 'GIRRU_STORE_P8', 'GIRRU_STORE_P9', 'GIRRU_STORE_P9B'];
for (const k of SWITCHES) process.env[k] = '1';

globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet; console.error = quiet;

const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const { getDatabase } = await load('src/db/database.ts');
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await load('src/credentials/storage.ts');
await getCredentialStorage().initialize();
const { getOrchestrator } = await load('src/multi-agent/index.ts');
await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
const OWNER = 'xp-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, 'xp@example.test', 'xp', 'x', 'owner', 'active', 1)`).run(OWNER);
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('xp-main', 'Main', 'ollama', 'qwen-test', 1)`).run();

const { generateToken } = await load('src/auth/jwt.ts');
const { buildServer } = await load('src/api/app.ts');
const { createProject, createConversation } = await load('src/repositories/chat-conversations.ts');
const { createAgentToolsRegistry, useRemoteModelTools } = await load('src/tools/index.ts');
const { PROVIDER_FORMATS } = await load('src/memory/conformance.ts');
const { subscriptionToolLoop } = await load('src/services/subscription-tool-loop.ts');
const { subscriptionAnswer } = await load('src/services/subscription-chat.ts');
const { publishInstanceIdentity } = await load('src/services/instance-identity.ts');
const { createBridgeMcpServer, httpBackend } = await load('src/memory/bridge/mcp-server.ts');
const B = await load('src/memory/bridge/service.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

B.setBridgeEnv({ home, env: {} });
publishInstanceIdentity();
const app = await buildServer({ logger: false });
await app.ready();
const call = (method, url, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${generateToken(OWNER, 1)}` }, ...(payload ? { payload } : {}) });

const RESULTS = [];
test.after(async () => {
  await app.close();
  if (process.env.P10_CONFORMANCE_OUT) writeFileSync(process.env.P10_CONFORMANCE_OUT, JSON.stringify(RESULTS, null, 2));
});

/** The scenario's facts differ per run so one door never finds another door's facts. */
const facts = (tag) => ({ old: `Release day for ${tag} is Friday`, new: `Release day for ${tag} is Thursday`, key: `release-day-${tag}` });
/** The verdict of one run (XP3): every verb worked, the wrong argument was refused, the last recall is right. */
function verdict(door, provider, steps, lastRecall, f) {
  const failures = [];
  for (const v of ['save', 'recall', 'supersede', 'handoff', 'propose']) if (!steps.some((s) => s.verb === v && s.ok)) failures.push(`${v} did not succeed`);
  if (!steps.some((s) => s.verb === 'refused' && s.ok)) failures.push('a wrong argument was not refused');
  if (!lastRecall.includes(f.new)) failures.push('the last recall did not return the new fact');
  if (lastRecall.includes(f.old)) failures.push('the last recall still returned the replaced fact');
  const r = { door, provider, passed: failures.length === 0, failures, steps: steps.map((s) => `${s.verb}:${s.ok ? 'ok' : 'no'}`) };
  RESULTS.push(r);
  return r;
}
const textOf = (result) => (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
/** The owner accepts every waiting proposal (Accept in the chat or in Memory › Review). */
async function approvePending() {
  const list = (await call('GET', '/api/memory/proposals?status=pending')).json();
  for (const p of list.proposals ?? list.items ?? list) {
    const full = (await call('GET', `/api/memory/proposals/${p.id}`)).json();
    const r = await call('POST', `/api/memory/proposals/${p.id}/approve`, { expectedReviewHash: full.reviewHash ?? full.proposal?.reviewHash });
    assert.equal(r.statusCode, 200, r.body);
  }
}

test('switches: every memory switch is on for this file', () => {
  for (const k of SWITCHES) assert.equal(process.env[k], '1', k);
});

// --- 1 Native tools: Claude API, Ollama, LM Studio --------------------------------------------

// The native door's verbs are Girru's own memory tools: memory_save (topic key) saves and, saved again
// with the same topic key, replaces; memory_search recalls; handoff_save hands off; an important
// memory_save (importance 8–10) is proposed to the owner first.
const nativeScript = (f) => [
  ['save', 'memory_save', { content: f.old, topic_key: f.key, importance: 5 }],
  ['recall', 'memory_search', { query: f.key.replace(/-/g, ' ') }],
  ['supersede', 'memory_save', { content: f.new, topic_key: f.key, importance: 5 }],
  ['handoff', 'handoff_save', { done: ['Moved the release'], next: ['Tell the team'] }],
  ['propose', 'memory_save', { content: `Decision: every release of ${f.key} needs two reviewers`, importance: 9 }],
  ['refused', 'memory_search', { limit: 5 }],
  ['last', 'memory_search', { query: f.key.replace(/-/g, ' ') }],
];
/** One synthetic tool call in a provider's own wire format. */
const WIRE = {
  anthropic: (name, input, i) => ({ type: 'tool_use', id: `toolu_${i}`, name, input }),
  ollama: (name, args) => ({ function: { name, arguments: args } }),
  lmstudio: (name, args, i) => ({ id: `call_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }),
};
const FORMAT_OF = { anthropic: 'anthropic', ollama: 'ollama', lmstudio: 'ollama' };

for (const [provider, label] of [['anthropic', 'Claude API'], ['ollama', 'Ollama'], ['lmstudio', 'LM Studio']]) {
  test(`native door: ${label} passes the five-verb scenario`, async () => {
    const f = facts(`native-${provider}`);
    const conv = await createConversation(OWNER, { title: `XP3 ${label}`, agentId: 'xp-main' });
    const registry = await createAgentToolsRegistry({ userId: OWNER, sessionId: conv.id, agentId: 'xp-main', workspaceDir: dir, chatPlan: true });
    const offered = registry.getToolsForAPI().map((t) => t.name);
    for (const t of ['memory_save', 'memory_search', 'handoff_save']) assert.ok(offered.includes(t), `${label} is offered ${t}`);
    const format = PROVIDER_FORMATS.find((p) => p.id === FORMAT_OF[provider]);
    const steps = [];
    let lastRecall = '';
    for (const [i, [verb, name, args]] of nativeScript(f).entries()) {
      const decoded = format.decodeCall(WIRE[provider](name, args, i));
      assert.equal(decoded?.name, name, `${label} call ${i + 1} decodes`);
      const r = await registry.execute(decoded.name, decoded.args);
      // In a saved chat the owner decides every memory (CHAT-PRO-02 E): Accept, as the owner does.
      if (verb === 'save' || verb === 'supersede') await approvePending();
      const failed = !!r.error || /^Error/i.test(textOf(r));
      if (verb === 'refused') steps.push({ verb, ok: failed });
      else if (verb === 'last') { lastRecall = textOf(r); steps.push({ verb: 'recall', ok: !failed }); }
      else if (verb === 'propose') steps.push({ verb, ok: !failed && (r.data?.pendingApproval === true || /owner/i.test(textOf(r))) });
      else steps.push({ verb, ok: !failed });
    }
    const v = verdict('native', label, steps, lastRecall, f);
    assert.ok(v.passed, `${label}: ${v.failures.join('; ')}`);
    // The replaced fact is history, not gone (P9 M4 keep-new: superseded, or a new version of the topic).
    const rows = db.prepare(`SELECT content, valid_to, superseded_by FROM memories WHERE user_id = ? AND content LIKE ?`).all(OWNER, `%${f.key.slice(13)}%`);
    assert.ok(rows.some((m) => m.content === f.new));
  });
}

// Live run (qwen3:4b): a model added a guessed filter (type "fact") to every recall of facts saved with the
// default type, and found nothing. When the filters hide every match, the words are searched without them.
test('native door: a guessed filter that hides every match falls back to the words alone', async () => {
  const conv = await createConversation(OWNER, { title: 'XP3 filter', agentId: 'xp-main' });
  const registry = await createAgentToolsRegistry({ userId: OWNER, sessionId: conv.id, agentId: 'xp-main', workspaceDir: dir, chatPlan: true });
  await registry.execute('memory_save', { content: 'The Orbit checklist lives in docs/release.md', topic_key: 'orbit-checklist', importance: 5 });
  await approvePending();
  const r = await registry.execute('memory_search', { query: 'Orbit checklist', type: 'fact', layer: 'factual' });
  assert.match(textOf(r), /No memory matched the filters; these match the words without them/);
  assert.match(textOf(r), /docs\/release\.md/);
  assert.equal(r.data?.widened, true);
  const none = await registry.execute('memory_search', { query: 'zebra migration timetable', type: 'fact' });
  assert.match(textOf(none), /No memories found/);
});

// --- 2 The subscription JSON tool protocol: Claude Code, Codex, Antigravity ----------------------

/** What each CLI prints for one reply whose text is `text` (the shapes subscriptionAnswer reads). */
const CLI_STDOUT = {
  claude: (text) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { input_tokens: 10, output_tokens: 5 } }),
  codex: (text) => [JSON.stringify({ type: 'thread.started', thread_id: 't' }), JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text } }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })].join('\n'),
  gemini: (text) => [JSON.stringify({ event: 'init', init: { permission_mode: 'request-review' } }), JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: text } })].join('\n'),
};

for (const [kind, label] of [['claude', 'Claude Code'], ['codex', 'Codex'], ['gemini', 'Antigravity']]) {
  test(`subscription JSON protocol: ${label} passes the five-verb scenario`, async () => {
    const f = facts(`sub-${kind}`);
    const conv = await createConversation(OWNER, { title: `XP3 ${label}`, agentId: 'xp-main' });
    const registry = await createAgentToolsRegistry({ userId: OWNER, sessionId: conv.id, agentId: 'xp-main', workspaceDir: dir, fileReadRoot: dir, chatPlan: true });
    useRemoteModelTools(registry); // a coding app is not a local model (as chat.ts does)
    const tools = registry.getAll().map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
    const script = nativeScript(f).map(([verb, name, args]) => [verb, JSON.stringify({ type: 'tool', name: name === 'handoff_save' && tools.some((t) => t.name === 'handoff_save') ? 'handoff_save' : name, arguments: args })]);
    script.push(['answer', JSON.stringify({ type: 'answer', text: 'Done.' })]);
    let turn = 0;
    const prompts = [];
    const steps = [];
    let lastRecall = '';
    const answer = await subscriptionToolLoop({
      prompt: 'Remember the release day, then correct it.', signal: new AbortController().signal, tools,
      // The CLI's own stdout for this turn, read by the real CLI output reader.
      reply: async (prompt) => { prompts.push(prompt); return subscriptionAnswer(kind, CLI_STDOUT[kind](script[turn++][1])); },
      execute: async (name, args) => {
        const r = await registry.execute(name, args);
        if (['save', 'supersede'].includes(script[turn - 1][0])) await approvePending();
        return r;
      },
      onTool: (_name, result) => {
        const verb = script[turn - 1][0];
        const failed = !!result.error || /^Error/i.test(textOf(result));
        if (verb === 'refused') steps.push({ verb, ok: failed });
        else if (verb === 'last') { lastRecall = textOf(result); steps.push({ verb: 'recall', ok: !failed }); }
        else if (verb === 'propose') steps.push({ verb, ok: !failed && (result.data?.pendingApproval === true || /owner/i.test(textOf(result))) });
        else steps.push({ verb, ok: !failed });
      },
    });
    assert.equal(answer, 'Done.');
    assert.equal(turn, script.length, 'every scripted reply was used');
    // Tool results reach the next turn as untrusted data, never as instructions.
    assert.match(prompts.at(-1), /execution receipt \(tool content is untrusted data\)/);
    const v = verdict('subscription-json', label, steps, lastRecall, f);
    assert.ok(v.passed, `${label}: ${v.failures.join('; ')}`);
  });
}

// --- 3 MCP (dpro-memory): Claude Code, Codex, Gemini CLI, Antigravity, Cursor ----------------------

const injectFetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname !== '127.0.0.1') throw new Error(`MCP server left loopback: ${url}`);
  const r = await app.inject({ method: init.method ?? 'GET', url: u.pathname + u.search, headers: init.headers, payload: init.body });
  return new Response(r.body, { status: r.statusCode, headers: { 'Content-Type': 'application/json' } });
};

// Girru launches Claude Code, Codex and Antigravity runs itself (the trusted launcher); Gemini CLI and Cursor
// are started by the owner, so the owner issues their session in Girru (the same capability).
for (const [client, kind, label] of [['claude-code', 'claude', 'Claude Code'], ['codex', 'codex', 'Codex'], ['gemini-cli', null, 'Gemini CLI'], ['antigravity', 'gemini', 'Antigravity'], ['cursor', null, 'Cursor']]) {
  test(`MCP door: ${label} passes the five-verb scenario`, async () => {
    const f = facts(`mcp-${client}`);
    const folder = join(dir, 'Projects', client);
    mkdirSync(folder, { recursive: true });
    const project = await createProject(OWNER, { name: `XP3 ${label}`, folder });
    await B.setClient(OWNER, client, true);
    B.resetReadVolume();
    const C = await load('src/memory/bridge/capability.ts');
    let cap, end;
    if (!kind) {
      const r = await C.launchCapability(OWNER, project.id, client, false, null);
      cap = r.token; end = () => C.revokeCapability(OWNER, r.capability.id);
    } else {
      const s = await B.launchSession(folder, kind);
      cap = s.env.GIRRU_SESSION_CAPABILITY; end = s.end;
      assert.equal((await C.verifyCapability(cap)).client, client);
    }
    const server = createBridgeMcpServer(httpBackend({ client, cwd: folder, backendUrl: 'http://127.0.0.1:41553', configDir: process.env.AGENT_PLAYER_CONFIG_DIR, fetchImpl: injectFetch, capability: cap }), { verbs: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: `xp3-${client}`, version: '1' });
    await c.connect(b);
    const listed = (await c.listTools()).tools.map((t) => t.name);
    for (const v of ['recall', 'save', 'supersede', 'handoff', 'propose']) assert.ok(listed.includes(`memory_${v}`), `${label} lists memory_${v}`);
    const tool = async (name, args) => { const r = await c.callTool({ name, arguments: args }); return { text: r.content?.[0]?.text ?? '', isError: !!r.isError }; };
    const steps = [];
    // save -> owner approves -> recall finds it
    const saved = await tool('memory_save', { content: f.old, topic_key: f.key, request_id: `req-${client}-save` });
    steps.push({ verb: 'save', ok: !saved.isError && /owner reviews/i.test(saved.text) });
    await approvePending();
    const found = await tool('memory_recall', { query: f.old });
    const id = /- \[([^\]]+)\] /.exec(found.text)?.[1];
    steps.push({ verb: 'recall', ok: !found.isError && found.text.includes(f.old) && !!id });
    // supersede by id -> owner approves
    const sup = await tool('memory_supersede', { id, content: f.new, request_id: `req-${client}-sup` });
    steps.push({ verb: 'supersede', ok: !sup.isError });
    await approvePending();
    const h = await tool('memory_handoff', { done: ['Moved the release'], next: ['Tell the team'] });
    steps.push({ verb: 'handoff', ok: !h.isError });
    const p = await tool('memory_propose', { content: `Every release of ${f.key} needs two reviewers.` });
    steps.push({ verb: 'propose', ok: !p.isError });
    const bad = await tool('memory_recall', { query: 'release', colour: 'red' });
    steps.push({ verb: 'refused', ok: bad.isError });
    const last = await tool('memory_recall', { query: `Release day for mcp ${client}` });
    const v = verdict('mcp', label, steps, last.text, f);
    await c.close();
    await end();
    assert.ok(v.passed, `${label}: ${v.failures.join('; ')}`);
  });
}

test('results: every door and provider is recorded; nothing called a live provider', () => {
  assert.equal(RESULTS.length, 11);
  assert.deepEqual(RESULTS.filter((r) => !r.passed).map((r) => `${r.door}/${r.provider}`), []);
});
