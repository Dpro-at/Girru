// CHAT-PRO-02 G: LM Studio as a local model provider next to Ollama.
//  - the base URL is always loopback (127.0.0.1); any other host is ignored;
//  - the model list asks LM Studio what it has (embedding models left out);
//    not running = nothing listed;
//  - the agent loop streams text, reasoning and tool calls (sent in pieces)
//    over the OpenAI-compatible API and feeds tool results back;
//  - GET /api/models lists LM Studio models as `lmstudio:<id>`; a chat turn
//    with such a model runs on LM Studio with tools; when LM Studio is not
//    running the run ends with `lmstudio_not_running`.
// Throwaway DB/keys; LM Studio is a stub OpenAI-compatible server on 127.0.0.1.
// Run: node --import tsx --test test/lmstudio.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { offeredNames, expectedNumCtx, expectedNumPredict, p2bOn } from './helpers/p2b.mjs';

// --- stub LM Studio: /v1/models + streamed /v1/chat/completions ---------------
const replies = []; // each: list of delta objects for one streamed answer
const bodies = [];
let modelIds = ['qwen/qwen3-8b', 'text-embedding-nomic-embed-text-v1.5', 'llama-3.2-3b-instruct@q4_k_m'];
const stub = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: modelIds.map((id) => ({ id, object: 'model', owned_by: 'organization_owner' })) }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      const deltas = replies.shift() ?? [{ content: 'ok' }];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const d of deltas) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: null }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubUrl = `http://127.0.0.1:${stub.address().port}/v1`;

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-lmstudio-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9'; // nothing listens: Ollama is "not running"
process.env.LMSTUDIO_API_URL = stubUrl;
for (const k of ['AGENT_EXEC_TOOLS', 'OLLAMA_THINK', 'DEFAULT_MODEL']) delete process.env[k];
const capture = () => {};
console.log = capture; console.info = capture; console.warn = capture; console.error = capture;

const lm = await import(join(backendDir, 'src/llm/lmstudio.ts'));
const { runLmStudioAgentLoop } = await import(join(backendDir, 'src/services/lmstudio-agent-loop.ts'));
const { ModelUnavailable } = await import(join(backendDir, 'src/services/ollama-agent-loop.ts'));

test('the LM Studio address is always loopback; other hosts are ignored', () => {
  assert.equal(lm.lmStudioApiUrl({}), 'http://127.0.0.1:1234/v1');
  assert.equal(lm.lmStudioApiUrl({ LMSTUDIO_API_URL: 'http://127.0.0.1:4321/v1/' }), 'http://127.0.0.1:4321/v1');
  for (const bad of ['http://10.0.0.5:1234/v1', 'https://api.example.com/v1', 'http://localhost.evil.test/v1', 'http://user:pw@127.0.0.1:1234/v1', 'file:///etc/passwd', 'nonsense']) {
    assert.equal(lm.lmStudioApiUrl({ LMSTUDIO_API_URL: bad }), 'http://127.0.0.1:1234/v1', bad);
  }
  assert.equal(lm.lmStudioAddress({}), '127.0.0.1:1234');
  assert.equal(lm.lmStudioModelName('lmstudio:qwen/qwen3-8b'), 'qwen/qwen3-8b');
  assert.equal(lm.lmStudioModelName('qwen3.8:27b'), '');
  assert.equal(lm.lmStudioModelName('lmstudio:../x y'), '');
  assert.match(lm.lmStudioNotRunningMessage({}), /LM Studio is not running on 127\.0\.0\.1:1234/);
});

test('the model list: chat models only; not running = nothing listed', async () => {
  assert.deepEqual(await lm.listLmStudioModels(), { running: true, models: ['qwen/qwen3-8b', 'llama-3.2-3b-instruct@q4_k_m'] });
  assert.deepEqual(await lm.listLmStudioModels({ env: { LMSTUDIO_API_URL: 'http://127.0.0.1:9/v1' } }), { running: false, models: [] });
  const refused = async () => new Response('no', { status: 500 });
  assert.deepEqual(await lm.listLmStudioModels({ fetchImpl: refused }), { running: false, models: [] });
  const odd = async () => new Response(JSON.stringify({ data: [{ id: 'a b' }, { id: 5 }, null, { id: 'ok-model' }] }), { status: 200 });
  assert.deepEqual(await lm.listLmStudioModels({ fetchImpl: odd }), { running: true, models: ['ok-model'] });
});

test('the loop streams reasoning and text, joins tool calls sent in pieces, feeds results back', async () => {
  replies.push(
    [{ reasoning_content: 'Let me echo.' }, { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'x_echo', arguments: '' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '{"text":' } }] }, { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] }],
    [{ content: 'All ' }, { content: 'done.' }],
  );
  bodies.length = 0;
  const frames = [];
  const calls = [];
  const tools = [{ name: 'x_echo', description: 'echo', input_schema: { type: 'object', properties: { text: { type: 'string' } } } }];
  const r = await runLmStudioAgentLoop({
    url: stubUrl, model: 'qwen/qwen3-8b', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Echo hi' }], tools,
    execute: async (name, args) => { calls.push([name, args]); return { content: [{ type: 'text', text: `echo: ${args.text}` }] }; },
    write: (f) => frames.push(f), signal: new AbortController().signal, now: () => 0,
  });
  assert.equal(r.answer, 'All done.');
  assert.deepEqual(calls, [['x_echo', { text: 'hi' }]]);
  assert.deepEqual(frames.map((f) => f.type), ['reasoning', 'tool_start', 'tool_result', 'text', 'text', 'done']);
  assert.deepEqual(frames[1].tools, [{ id: 'call-1', name: 'x_echo', input: '{"text":"hi"}' }]);
  assert.equal(frames[2].results[0].output, 'echo: hi');
  // OpenAI format: the model name without the prefix, tools as functions, stream on.
  assert.equal(bodies[0].model, 'qwen/qwen3-8b');
  assert.equal(bodies[0].stream, true);
  assert.equal(bodies[0].tools[0].function.name, 'x_echo');
  // The second call carries the assistant's call and the result, linked by id.
  const [asst, tool] = bodies[1].messages.slice(-2);
  assert.equal(asst.tool_calls[0].function.arguments, '{"text":"hi"}');
  assert.deepEqual([tool.role, tool.tool_call_id, tool.content], ['tool', asst.tool_calls[0].id, 'echo: hi']);
});

test('the loop: an unreachable or refusing server is ModelUnavailable; stop ends quietly', async () => {
  const base = { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], execute: async () => ({ content: [] }), write: () => {}, signal: new AbortController().signal };
  await assert.rejects(runLmStudioAgentLoop({ ...base, url: 'http://127.0.0.1:9/v1' }), ModelUnavailable);
  await assert.rejects(runLmStudioAgentLoop({ ...base, url: stubUrl, fetchImpl: async () => new Response('x', { status: 404 }) }), ModelUnavailable);
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await runLmStudioAgentLoop({ ...base, url: stubUrl, signal: ac.signal }), { steps: 0, answer: '', aborted: true });
});

// --- the routes -----------------------------------------------------------
const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(join(backendDir, 'src/multi-agent/index.ts'));
await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES ('l-owner', 'l-owner@example.test', 'l-owner', 'x', 'owner', 'active', 1)`).run();
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('l-agent', 'Main', 'ollama', 'qwen-test', 1)`).run();
const toolsMod = await import(join(backendDir, 'src/tools/index.ts'));
const grants = await import(join(backendDir, 'src/tools/grants.ts'));
const echoed = [];
toolsMod.registerExtensionTool({ name: 'x_echo', description: 'echo', extensionId: 'x', requiresApproval: false,
  input_schema: { type: 'object', properties: { text: { type: 'string' } } },
  execute: async (p) => { echoed.push(p.text); return { content: [{ type: 'text', text: `echo: ${p.text}` }] }; } });
await grants.setAgentGrants('l-agent', { grants: ['x_echo'] }, 'l-owner', toolsMod.createToolsRegistry({ workspaceDir: dir }).listRegistered());
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { chatRuns } = await import(join(backendDir, 'src/services/chat-runs.ts'));
const app = await buildServer({ logger: false });
await app.ready();
const call = (method, url, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${generateToken('l-owner', 1)}` }, ...(payload ? { payload } : {}) });
const frames = (body) => body.split('\n\n').filter((b) => b.includes('data:')).map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data:')).slice(5)));
const ended = (runId) => new Promise((r) => { const run = chatRuns.get(runId); if (run.status !== 'running') r(); else run.emitter.once('end', r); });
const rid = () => `run-${randomBytes(6).toString('hex')}`;

test('GET /api/models lists the LM Studio models with the lmstudio: prefix (Ollama down = none of its)', async () => {
  const r = await call('GET', '/api/models');
  assert.equal(r.statusCode, 200);
  const lmRows = r.json().models.filter((m) => m.provider === 'lmstudio');
  assert.deepEqual(lmRows.map((m) => [m.id, m.name]), [['lmstudio:qwen/qwen3-8b', 'qwen/qwen3-8b'], ['lmstudio:llama-3.2-3b-instruct@q4_k_m', 'llama-3.2-3b-instruct@q4_k_m']]);
  assert.equal(r.json().models.filter((m) => m.provider === 'local').length, 0);
});

test('a chat turn with an LM Studio model runs there, with the agent tools', async () => {
  const c = (await call('POST', '/api/chat/conversations', {})).json().conversation;
  replies.push(
    [{ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'x_echo', arguments: '{"text":"from lm"}' } }] }],
    [{ content: 'Echoed.' }],
  );
  bodies.length = 0;
  const runId = rid();
  const start = await call('POST', `/api/chat/conversations/${c.id}/runs`, { runId, message: 'Echo please', model: 'lmstudio:llama-3.2-3b-instruct@q4_k_m' });
  assert.equal(start.statusCode, 202);
  await ended(runId);
  const ev = frames((await call('GET', `/api/chat/runs/${runId}/events`)).body);
  assert.deepEqual(ev.map((f) => f.type), ['tool_start', 'tool_result', 'text', 'end']);
  assert.equal(ev.at(-1).status, 'complete');
  assert.deepEqual(echoed, ['from lm']);
  assert.equal(bodies[0].model, 'llama-3.2-3b-instruct@q4_k_m');
  assert.ok(offeredNames(bodies[0]).includes('x_echo'), 'the agent granted tools are offered');
  const m = (await call('GET', `/api/chat/conversations/${c.id}/messages`)).json();
  assert.equal(m.messages.at(-1).content, 'Echoed.');
});

test('the local-model-only stage keeps a picked LM Studio model', async () => {
  process.env.AGENT_PLAYER_LOCAL_MODEL_ONLY = '1'; process.env.AGENT_PLAYER_ISOLATED = '1';
  try {
    const c = (await call('POST', '/api/chat/conversations', {})).json().conversation;
    replies.push([{ content: 'Stage answer.' }]);
    bodies.length = 0;
    const runId = rid();
    assert.equal((await call('POST', `/api/chat/conversations/${c.id}/runs`, { runId, message: 'hi', model: 'lmstudio:qwen/qwen3-8b' })).statusCode, 202);
    await ended(runId);
    assert.equal(bodies[0]?.model, 'qwen/qwen3-8b');
    assert.equal((await call('GET', `/api/chat/conversations/${c.id}/messages`)).json().messages.at(-1).content, 'Stage answer.');
  } finally {
    delete process.env.AGENT_PLAYER_LOCAL_MODEL_ONLY; delete process.env.AGENT_PLAYER_ISOLATED;
  }
});

test('LM Studio not running: the run ends with lmstudio_not_running; a bad id is refused', async () => {
  const c = (await call('POST', '/api/chat/conversations', {})).json().conversation;
  assert.equal((await call('POST', `/api/chat/conversations/${c.id}/runs`, { runId: rid(), message: 'hi', model: 'lmstudio:bad model' })).statusCode, 400);
  await new Promise((r) => stub.close(r));
  const runId = rid();
  assert.equal((await call('POST', `/api/chat/conversations/${c.id}/runs`, { runId, message: 'Hello?', model: 'lmstudio:qwen/qwen3-8b' })).statusCode, 202);
  await ended(runId);
  const ev = frames((await call('GET', `/api/chat/runs/${runId}/events`)).body);
  assert.deepEqual([ev.at(-1).type, ev.at(-1).status, ev.at(-1).code], ['end', 'error', 'lmstudio_not_running']);
  // And the picker simply lists none of its models.
  assert.equal((await call('GET', '/api/models')).json().models.filter((m) => m.provider === 'lmstudio').length, 0);
  await app.close();
});
