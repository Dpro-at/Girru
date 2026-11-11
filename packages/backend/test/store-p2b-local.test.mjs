// STORE-MAP-01 P2b (LOCAL-ONLY-01, XP3): local models only, through Girru's real chat route and tools
// registry on a real database, with EVERY memory switch on (PILOT, P2–P9B) plus GIRRU_STORE_P2B:
//  1 an 8k local model: the real /api/chat request fits its window with room for the reply (one-piece
//    and streamed), with the memory verbs, tool_load and a short index instead of every tool; with P2b
//    off the same request is unchanged (every tool);
//  2 conformance: Ollama, LM Studio and a generic OpenAI-compatible server (llama.cpp and vLLM wire
//    shapes) pass the five memory verbs on the local path (save → recall → supersede → handoff → propose
//    → a wrong argument refused → the last recall returns the new fact, not the old one), as synthetic
//    model servers that answer in each one's own wire format, through the local agent loop, tools on
//    demand and the real registry;
//  3 the subscription JSON protocol uses the same tools on demand (XP1).
// No network: every model server is a stub on a fake loopback address. Run:
//   node --import tsx --test test/store-p2b-local.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

import { clearEnv } from './helpers/switches.mjs';
const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p2b-')));
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
const OLLAMA = 'http://127.0.0.1:41591';
const LMSTUDIO = 'http://127.0.0.1:41592/v1';
const GENERIC = 'http://127.0.0.1:41593/v1';
process.env.OLLAMA_URL = OLLAMA;
process.env.LMSTUDIO_API_URL = LMSTUDIO;
process.env.GIRRU_LOCAL_OPENAI_URL = GENERIC;
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['CODEX_HOME', 'AGENT_EXEC_TOOLS', 'DEFAULT_MODEL', 'GIRRU_STORE_PILOT_AGENT', 'CHAT_NUM_CTX', 'OLLAMA_THINK']) clearEnv(k);
const SWITCHES = ['GIRRU_STORE_PILOT', 'GIRRU_STORE_P2', 'GIRRU_STORE_P3', 'GIRRU_STORE_P4', 'GIRRU_STORE_P5', 'GIRRU_STORE_P6', 'GIRRU_STORE_P7', 'GIRRU_STORE_P8', 'GIRRU_STORE_P9', 'GIRRU_STORE_P9B', 'GIRRU_STORE_P2B'];
for (const k of SWITCHES) process.env[k] = '1';

// The stub model servers: /api/show says the model has an 8k window; each /api/chat is recorded and
// answered by `nextReply` (a plain answer unless a test scripts tool calls).
const captured = [];
let nextReply = () => ({ message: { content: 'ok' }, done: true });
const ndjson = (rows) => new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); for (const r of rows) c.enqueue(e.encode(JSON.stringify(r) + '\n')); c.close(); } }), { status: 200 });
const sse = (chunks) => new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode(`data: ${JSON.stringify(x)}\n\n`)); c.enqueue(e.encode('data: [DONE]\n\n')); c.close(); } }), { status: 200 });
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
let openAiReply = () => [{ choices: [{ delta: { content: 'ok' } }] }];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === `${OLLAMA}/api/show`) return json({ model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 8192 }, parameters: 'temperature 0.6' });
  if (u === `${OLLAMA}/api/tags`) return json({ models: [{ name: 'qwen-small:8k', model: 'qwen-small:8k', details: {}, capabilities: ['completion', 'tools'] }] });
  if (u === `${OLLAMA}/api/chat`) { const body = JSON.parse(init.body); captured.push({ door: 'ollama', body }); const r = nextReply(body); return body.stream === false ? json(r) : ndjson([r]); }
  if (u === `${OLLAMA}/api/generate` || u === `${OLLAMA}/api/embed`) return json({ error: 'stub' }, 503);
  if (u === 'http://127.0.0.1:41592/api/v0/models/qwen3-8b') return json({ max_context_length: 32768, loaded_context_length: 8192 });
  if (u === `${GENERIC}/models`) return json({ data: [{ id: 'g', max_model_len: 8192 }] });
  if (u === 'http://127.0.0.1:41593/props') return json({}, 404);
  if (u === `${LMSTUDIO}/chat/completions` || u === `${GENERIC}/chat/completions`) { const body = JSON.parse(init.body); captured.push({ door: u.startsWith(GENERIC) ? 'generic' : 'lmstudio', body }); return sse(openAiReply(body)); }
  throw new Error(`unexpected network call in test: ${u}`);
};
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
const OWNER = 'p2b-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, 'p2b@example.test', 'p2b', 'x', 'owner', 'active', 1)`).run(OWNER);
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary, system_prompt) VALUES ('p2b-main', 'Rafid', 'ollama', 'qwen-small:8k', 1, ?)`).run('You are Rafid, a careful backend engineer. '.repeat(40));

const { generateToken } = await load('src/auth/jwt.ts');
const { buildServer } = await load('src/api/app.ts');
const { createConversation } = await load('src/repositories/chat-conversations.ts');
const { createAgentToolsRegistry } = await load('src/tools/index.ts');
const { prepareLocalTurn, localModelWindow } = await load('src/services/local-turn.ts');
const { runOllamaAgentLoop } = await load('src/services/ollama-agent-loop.ts');
const { runLmStudioAgentLoop } = await load('src/services/lmstudio-agent-loop.ts');
const { estimateTokens } = await load('src/memory/context/budget.ts');
const { clearModelWindowCache } = await load('src/llm/model-window.ts');
const { OnDemandTools } = await load('src/tools/on-demand.ts');
const { subscriptionToolLoop } = await load('src/services/subscription-tool-loop.ts');
const app = await buildServer({ logger: false });
await app.ready();
const auth = { authorization: `Bearer ${generateToken(OWNER, 1)}` };
const call = (method, url, payload) => app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
test.after(async () => { await app.close(); });

const textOf = (result) => (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
async function approvePending() {
  const list = (await call('GET', '/api/memory/proposals?status=pending')).json();
  for (const p of list.proposals ?? list.items ?? list) {
    const full = (await call('GET', `/api/memory/proposals/${p.id}`)).json();
    const r = await call('POST', `/api/memory/proposals/${p.id}/approve`, { expectedReviewHash: full.reviewHash ?? full.proposal?.reviewHash });
    assert.equal(r.statusCode, 200, r.body);
  }
}
/** The prompt of one model request, estimated like the budget does (characters / 3). */
const promptTokens = (body) => estimateTokens(JSON.stringify(body.messages.map((m) => m.content))) + estimateTokens(JSON.stringify(body.tools ?? []));

const HISTORY = Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Earlier turn ${i}: ${'the alpha release needs the invoice export fixed and the installer signed. '.repeat(12)}` }));
const QUESTION = { role: 'user', content: 'Where is the alpha staging database hosted? Answer briefly.' };

test('switches: every memory switch and P2b are on for this file', () => {
  for (const k of SWITCHES) assert.equal(process.env[k], '1', k);
});

test('8k Ollama model: the one-piece chat request fits its window with room for the reply', async () => {
  captured.length = 0;
  clearModelWindowCache();
  const r = await call('POST', '/api/chat', { stream: false, agentId: 'p2b-main', sessionId: 'p2b-s1', messages: [...HISTORY, QUESTION] });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().message.content, 'ok');
  const body = captured[0].body;
  assert.equal(body.options.num_ctx, 8192);
  assert.ok(body.options.num_predict <= 1638, `reply room ${body.options.num_predict}`);
  const names = body.tools.map((t) => t.function.name);
  assert.deepEqual(names.slice(0, 4), ['tool_load', 'memory_search', 'memory_save', 'memory_edit']);
  assert.ok(names.length <= 6, names.join(','));
  const system = body.messages[0].content;
  assert.match(system, /## Tool index\n/);
  assert.match(system, /Never guess or invent a memory/);
  assert.ok(promptTokens(body) <= 8192 - 1638, `prompt ${promptTokens(body)} tokens`);
  assert.equal(body.messages.at(-1).content.endsWith(QUESTION.content), true);
});

test('8k Ollama model: the streamed chat request fits too (the UI spec in its short form)', async () => {
  captured.length = 0;
  const r = await call('POST', '/api/chat', { stream: true, agentId: 'p2b-main', sessionId: 'p2b-s2', messages: [...HISTORY, QUESTION] });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /"type":"done"/);
  const body = captured[0].body;
  assert.equal(body.options.num_ctx, 8192);
  assert.ok(promptTokens(body) <= 8192 - 1638, `prompt ${promptTokens(body)} tokens`);
  assert.ok(!body.messages[0].content.includes('CRITICAL: Tool Usage Instructions'));
});

test('P2b off: the same request is unchanged (every tool, the fixed window)', async () => {
  process.env.GIRRU_STORE_P2B = '0';
  try {
    captured.length = 0;
    const r = await call('POST', '/api/chat', { stream: true, agentId: 'p2b-main', sessionId: 'p2b-s3', messages: [...HISTORY, QUESTION] });
    assert.equal(r.statusCode, 200);
    const body = captured[0].body;
    assert.equal(body.options.num_ctx, 32768);
    assert.ok(body.tools.length > 20);
    assert.ok(!body.tools.some((t) => t.function.name === 'tool_load'));
    assert.match(body.messages[0].content, /CRITICAL: Tool Usage Instructions/);
  } finally { process.env.GIRRU_STORE_P2B = '1'; }
});

test('the model window is read per provider', async () => {
  clearModelWindowCache();
  assert.equal((await localModelWindow('ollama', 'qwen-small:8k')).tokens, 8192);
  assert.equal((await localModelWindow('lmstudio', 'lmstudio:qwen3-8b')).tokens, 8192);
  assert.equal((await localModelWindow('openai-local', 'openai-local:g')).tokens, 8192);
});

// --- Conformance on the local path -------------------------------------------------------------------

const facts = (tag) => ({ old: `Release day for ${tag} is Friday`, new: `Release day for ${tag} is Thursday`, key: `release-day-${tag}` });
// recall = memory_search, save / propose = memory_save, supersede = memory_save with the same topic key,
// handoff = handoff_save; plus tool_load and a wrong argument (XP2) that must be refused.
const script = (f) => [
  ['save', 'memory_save', { content: f.old, topic_key: f.key, importance: 5 }],
  ['recall', 'memory_search', { query: f.key.replace(/-/g, ' '), limit: '5' }], // a number sent as text: repaired
  ['supersede', 'memory_save', { content: f.new, topic_key: f.key, importance: 5 }],
  ['handoff', 'handoff_save', { done: 'Moved the release', next: ['Tell the team'] }], // one value for a list: repaired
  ['propose', 'memory_save', { content: `Decision: every release of ${f.key} needs two reviewers`, importance: 9 }],
  ['load', 'tool_load', { names: ['board_my_cards'] }],
  ['refused', 'memory_search', { limit: 5 }],
  ['last', 'memory_search', { query: f.key.replace(/-/g, ' ') }],
];
function verdict(steps, lastRecall, f) {
  const failures = [];
  for (const v of ['save', 'recall', 'supersede', 'handoff', 'propose', 'load']) if (!steps.some((s) => s.verb === v && s.ok)) failures.push(`${v} did not succeed`);
  if (!steps.some((s) => s.verb === 'refused' && s.ok)) failures.push('a wrong argument was not refused');
  if (!lastRecall.includes(f.new)) failures.push('the last recall did not return the new fact');
  if (lastRecall.includes(f.old)) failures.push('the last recall still returned the replaced fact');
  return failures;
}
/** One tool call per model reply, in each server's own wire format. */
const WIRE = {
  ollama: (name, args) => ({ message: { content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: true }),
  lmstudio: (name, args) => [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }],
  // vLLM streams the arguments in pieces.
  vllm: (name, args) => { const a = JSON.stringify(args); const h = Math.floor(a.length / 2); return [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'chatcmpl-tool-1', type: 'function', function: { name, arguments: '' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(0, h) } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(h) } }] } }] }]; },
  // llama.cpp sends the call in one piece, with an empty content delta first.
  llamacpp: (name, args) => [{ choices: [{ delta: { content: null } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }],
};

for (const [label, provider, wire, model] of [['Ollama', 'ollama', 'ollama', 'qwen-small:8k'], ['LM Studio', 'lmstudio', 'lmstudio', 'lmstudio:qwen3-8b'], ['generic server (vLLM style)', 'openai-local', 'vllm', 'openai-local:g'], ['generic server (llama.cpp style)', 'openai-local', 'llamacpp', 'openai-local:g']]) {
  test(`local conformance: ${label} passes the five memory verbs with an 8k window`, async () => {
    const f = facts(`${provider}-${wire}`);
    const conv = await createConversation(OWNER, { title: `P2b ${label}`, agentId: 'p2b-main' });
    const registry = await createAgentToolsRegistry({ userId: OWNER, sessionId: conv.id, agentId: 'p2b-main', workspaceDir: dir, chatPlan: true });
    clearModelWindowCache();
    const window = await localModelWindow(provider, model);
    assert.equal(window.tokens, 8192);
    const lt = prepareLocalTurn({ window, tools: registry.getToolsForAPI(), systemHead: 'You are Rafid.', messages: [{ role: 'user', content: 'Remember the release day, then correct it.' }], run: (n, a) => registry.execute(n, a) });
    assert.equal(lt.budget.tier, 'small');
    const s = script(f);
    let i = 0;
    const steps = [];
    let lastRecall = '';
    const reply = () => (i < s.length ? WIRE[wire](s[i][1], s[i][2]) : wire === 'ollama' ? { message: { content: 'Done.' }, done: true } : [{ choices: [{ delta: { content: 'Done.' } }] }]);
    nextReply = reply; openAiReply = reply;
    captured.length = 0;
    const execute = async (name, args) => {
      const [verb] = s[i];
      const r = await lt.execute(name, args);
      if (verb === 'save' || verb === 'supersede') await approvePending();
      const failed = !!r.error || /^Error/i.test(textOf(r));
      if (verb === 'refused') steps.push({ verb, ok: failed && /query is required/.test(textOf(r)) });
      else if (verb === 'last') { lastRecall = textOf(r); steps.push({ verb: 'recall', ok: !failed }); }
      else if (verb === 'propose') steps.push({ verb, ok: !failed && (r.data?.pendingApproval === true || /owner/i.test(textOf(r))) });
      else steps.push({ verb, ok: !failed });
      i++;
      return r;
    };
    const common = { messages: [{ role: 'system', content: lt.system }, ...lt.messages], tools: [], execute, write: () => {}, signal: new AbortController().signal, toolSet: lt.toolSet, callCap: lt.callCap, maxSteps: lt.maxSteps, maxTokens: lt.maxTokens, toolOutputChars: lt.toolOutputChars, beforeStep: lt.beforeStep };
    const out = provider === 'ollama'
      ? await runOllamaAgentLoop({ ...common, url: OLLAMA, model, numCtx: lt.numCtx })
      : await runLmStudioAgentLoop({ ...common, url: provider === 'lmstudio' ? LMSTUDIO : GENERIC, model: model.split(':').slice(1).join(':') });
    assert.equal(out.answer, 'Done.');
    const failures = verdict(steps, lastRecall, f);
    assert.deepEqual(failures, [], `${label}: ${failures.join('; ')}`);
    // Tools on demand: board_my_cards was sent in full only after tool_load; every request fits the window.
    const sent = captured.map((c) => (c.body.tools ?? []).map((t) => t.function.name));
    assert.ok(!sent[0].includes('board_my_cards'));
    assert.ok(sent.at(-1).includes('board_my_cards'));
    for (const c of captured) assert.ok(promptTokens(c.body) <= 8192 - 1638, `${label} request ${promptTokens(c.body)} tokens`);
  });
}

test('subscription JSON protocol (XP1): the same tools on demand; a loaded tool can be called', async () => {
  const conv = await createConversation(OWNER, { title: 'P2b subscription', agentId: 'p2b-main' });
  const registry = await createAgentToolsRegistry({ userId: OWNER, sessionId: conv.id, agentId: 'p2b-main', workspaceDir: dir, fileReadRoot: dir, chatPlan: true });
  const all = registry.getAll().map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  const od = new OnDemandTools(all, 'large');
  const replies = [
    JSON.stringify({ type: 'tool', name: 'tool_load', arguments: { names: ['board_my_cards'] } }),
    JSON.stringify({ type: 'tool', name: 'board_my_cards', arguments: {} }),
    JSON.stringify({ type: 'answer', text: 'Done.' }),
  ];
  const prompts = [];
  const ran = [];
  const answer = await subscriptionToolLoop({
    prompt: `Context.\n\n${od.index()}`, signal: new AbortController().signal, tools: od.definitions(), isOffered: (n) => od.has(n),
    reply: async (p) => { prompts.push(p); return replies[prompts.length - 1]; },
    execute: (name, args) => od.execute(name, args, (n, a) => { ran.push(n); return registry.execute(n, a); }),
  });
  assert.equal(answer, 'Done.');
  assert.deepEqual(ran, ['board_my_cards']);
  assert.ok(prompts[0].length < JSON.stringify(all).length, 'the first prompt is smaller than every tool in full');
  assert.match(prompts[1], /board_my_cards: .*\\narguments: /);
});
