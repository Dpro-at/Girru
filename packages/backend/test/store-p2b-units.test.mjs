// STORE-MAP-01 P2b (LOCAL-ONLY-01): the pieces of a local turn, without a database or a model:
// the model's window, the argument checks (XP2), tools on demand, one definition for every door
// (XP1), the adaptive budget (an 8k turn fits), many calls in one reply, and the background queue (LAT).
// Run: node --import tsx --test test/store-p2b-units.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.CHAT_NUM_CTX;
delete process.env.GIRRU_LOCAL_OPENAI_CONTEXT;
const quiet = () => {};
console.log = quiet; console.warn = quiet;

const { storeP2bEnabled } = await import('../src/services/store-p2b.ts');
const W = await import('../src/llm/model-window.ts');
const { checkToolArgs } = await import('../src/tools/validate-args.ts');
const OD = await import('../src/tools/on-demand.ts');
const D = await import('../src/tools/tool-doors.ts');
const { planLocalBudget, fitLocalTurn, trimRecall } = await import('../src/memory/context/local-budget.ts');
const { estimateTokens } = await import('../src/memory/context/budget.ts');
const S = await import('../src/llm/local-scheduler.ts');
const { runOllamaAgentLoop } = await import('../src/services/ollama-agent-loop.ts');
const { runLmStudioAgentLoop } = await import('../src/services/lmstudio-agent-loop.ts');
const { openAiLocalUrl, openAiLocalModelName } = await import('../src/llm/openai-local.ts');
const { prepareLocalTurn, NO_INVENTED_MEMORY } = await import('../src/services/local-turn.ts');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('the switch is off by default and reads the usual words', () => {
  assert.equal(storeP2bEnabled({}), false);
  for (const v of ['1', 'true', 'on', 'YES']) assert.equal(storeP2bEnabled({ GIRRU_STORE_P2B: v }), true);
  assert.equal(storeP2bEnabled({ GIRRU_STORE_P2B: '0' }), false);
});

test('model window: Ollama reports the trained window, a Modelfile num_ctx and the RAM limit cap it', async () => {
  W.clearModelWindowCache();
  const show = (info, parameters = '') => async (url, init) => { assert.match(String(url), /\/api\/show$/); assert.equal(JSON.parse(init.body).model, 'm'); return json({ model_info: info, parameters }); };
  assert.deepEqual(await W.ollamaWindow('http://127.0.0.1:1', 'm', { fetchImpl: show({ 'general.architecture': 'llama', 'llama.context_length': 8192 }) }), { tokens: 8192, reported: 8192, source: 'ollama_show' });
  W.clearModelWindowCache();
  // 262k trained, but the RAM limit (CHAT_NUM_CTX, default 32768) wins.
  assert.equal((await W.ollamaWindow('http://127.0.0.1:1', 'm', { fetchImpl: show({ 'qwen3.context_length': 262144 }) })).tokens, 32768);
  W.clearModelWindowCache();
  const set = await W.ollamaWindow('http://127.0.0.1:1', 'm', { fetchImpl: show({ 'qwen3.context_length': 262144 }, 'temperature 0.6\nnum_ctx 4096\n') });
  assert.deepEqual(set, { tokens: 4096, reported: 262144, source: 'ollama_modelfile' });
  W.clearModelWindowCache();
  assert.equal((await W.ollamaWindow('http://127.0.0.1:1', 'm', { fetchImpl: show({ 'qwen3.context_length': 262144 }), env: { CHAT_NUM_CTX: '8192' } })).tokens, 8192);
  W.clearModelWindowCache();
  // A server that is down or strange: the safe 8192.
  assert.deepEqual(await W.ollamaWindow('http://127.0.0.1:1', 'm', { fetchImpl: async () => { throw new Error('down'); } }), { tokens: 8192, reported: null, source: 'fallback' });
});

test('model window: LM Studio (loaded window first) and a generic server (config, vLLM, llama.cpp)', async () => {
  W.clearModelWindowCache();
  const lm = await W.lmStudioWindow('http://127.0.0.1:1234/v1', 'qwen/qwen3-8b', { fetchImpl: async (url) => { assert.equal(String(url), 'http://127.0.0.1:1234/api/v0/models/qwen%2Fqwen3-8b'); return json({ max_context_length: 40960, loaded_context_length: 16384 }); } });
  assert.deepEqual(lm, { tokens: 16384, reported: 16384, source: 'lmstudio' });
  assert.equal((await W.openAiCompatWindow('http://127.0.0.1:8080/v1', 'x', { env: { GIRRU_LOCAL_OPENAI_CONTEXT: '12000' }, fetchImpl: async () => { throw new Error('not asked'); } })).tokens, 12000);
  W.clearModelWindowCache();
  const vllm = await W.openAiCompatWindow('http://127.0.0.1:8000/v1', 'qwen', { env: {}, fetchImpl: async (url) => (String(url).endsWith('/models') ? json({ data: [{ id: 'qwen', max_model_len: 8192 }] }) : json({}, 404)) });
  assert.deepEqual(vllm, { tokens: 8192, reported: 8192, source: 'openai_models' });
  W.clearModelWindowCache();
  const llama = await W.openAiCompatWindow('http://127.0.0.1:8080/v1', 'any', { env: {}, fetchImpl: async (url) => (String(url).endsWith('/models') ? json({ data: [{ id: 'g.gguf', meta: { n_ctx_train: 131072 } }] }) : json({ default_generation_settings: { n_ctx: 8192 } })) });
  assert.deepEqual(llama, { tokens: 8192, reported: 8192, source: 'llamacpp_props' });
});

test('the generic local server is loopback only', () => {
  assert.equal(openAiLocalUrl({ GIRRU_LOCAL_OPENAI_URL: 'http://127.0.0.1:8080/v1/' }), 'http://127.0.0.1:8080/v1');
  for (const bad of ['http://example.com/v1', 'https://127.0.0.1:8080/v1', 'http://user:pw@127.0.0.1:8080', 'http://192.168.1.4:8080/v1']) assert.equal(openAiLocalUrl({ GIRRU_LOCAL_OPENAI_URL: bad }), '', bad);
  assert.equal(openAiLocalModelName('openai-local:qwen3-8b'), 'qwen3-8b');
  assert.equal(openAiLocalModelName('qwen3-8b'), '');
});

test('XP2: arguments are checked against the tool schema, repaired only when safe', () => {
  const schema = { type: 'object', properties: { query: { type: 'string', maxLength: 20 }, limit: { type: 'integer', minimum: 1, maximum: 20 }, tags: { type: 'array', items: { type: 'string' } }, exact: { type: 'boolean' }, kind: { type: 'string', enum: ['fact', 'note'] } }, required: ['query'] };
  assert.deepEqual(checkToolArgs(schema, { query: 'a', limit: '5', tags: 'x', exact: 'true', guess: 1, kind: null }), { ok: true, args: { query: 'a', limit: 5, tags: ['x'], exact: true }, dropped: ['guess'] });
  assert.deepEqual(checkToolArgs(schema, '{"query":"b"}'), { ok: true, args: { query: 'b' }, dropped: [] });
  for (const [args, msg] of [[{}, /query is required/], [{ query: 'a', limit: 50 }, /at most 20/], [{ query: 'a', limit: 1.5 }, /whole number/], [{ query: 'x'.repeat(21) }, /longer than 20/], [{ query: 'a', kind: 'idea' }, /one of: fact, note/], [{ query: { a: 1 } }, /must be text/], [[1], /one JSON object/]]) {
    const r = checkToolArgs(schema, args);
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.match(r.error, msg);
  }
  assert.match(checkToolArgs({ ...schema, additionalProperties: false }, { query: 'a', guess: 1 }).error, /guess is not an argument/);
});

const tool = (name, description, props = { q: { type: 'string', description: 'What. More words here that a small model does not need at all.' } }, required = []) => ({ name, description, input_schema: { type: 'object', properties: props, required, examples: [{ q: 'x' }] } });
const ALL = [
  tool('memory_search', 'Search memory. Long text follows.', undefined, ['q']), tool('memory_save', 'Save a fact. More.'), tool('memory_edit', 'Edit a memory.'), tool('handoff_save', 'Leave a handoff.'),
  tool('web_fetch', 'Fetch a web page. And more.', { url: { type: 'string' } }, ['url']), tool('board_move', 'Move a card.'), tool('board_comment', 'Comment on a card.'), tool('board_check', 'Tick a checklist item.'), tool('board_my_cards', 'Your cards.'),
  tool('memory_trash_empty', 'Empty the trash.'), tool('desktop_control', 'Control the desktop.'),
];

test('tools on demand: the memory verbs and tool_load in full, the rest as a short index', async () => {
  const t = new OD.OnDemandTools(ALL, 'medium');
  assert.deepEqual(t.definitions().map((d) => d.name), ['tool_load', 'memory_search', 'memory_save', 'memory_edit', 'handoff_save']);
  const index = t.index();
  assert.match(index, /- web_fetch: Fetch a web page\n/);
  assert.ok(!index.includes('memory_search'), 'the loaded verbs are not in the index');
  assert.match(index, /memory_trash_empty/); // medium: admin tools listed
  // tool_load loads by name; the next step sends it in full; unknown names are said.
  const r = await t.execute('tool_load', { names: ['web_fetch', 'nope'] }, async () => assert.fail('tool_load never reaches the registry'));
  assert.match(r.content[0].text, /^Loaded; you can call it now\.\n\nweb_fetch: Fetch a web page\. And more\.\narguments: /);
  assert.match(r.content[0].text, /Not found: nope/);
  assert.deepEqual(t.definitions().map((d) => d.name).slice(-1), ['web_fetch']);
  // A group.
  await t.execute('tool_load', { group: 'board' }, async () => {});
  assert.deepEqual(t.loaded(), ['web_fetch', 'board_move', 'board_comment', 'board_check', 'board_my_cards']);
  // An unknown tool: similar names; a wrong argument: what the tool takes; extras dropped and said.
  assert.match((await t.execute('board_delete', {}, async () => {})).content[0].text, /no tool "board_delete".*Similar tools: board_move/);
  const bad = await t.execute('web_fetch', {}, async () => assert.fail('not run'));
  assert.equal(bad.error, 'invalid_arguments');
  assert.match(bad.content[0].text, /web_fetch was not run: url is required\. Its arguments: \{"type":"object"/);
  let ran;
  const ok = await t.execute('web_fetch', { url: 'https://a.test', page: 2 }, async (name, args) => { ran = { name, args }; return { content: [{ type: 'text', text: 'page' }] }; });
  assert.deepEqual(ran, { name: 'web_fetch', args: { url: 'https://a.test' } });
  assert.match(ok.content.at(-1).text, /Ignored arguments web_fetch does not take: page/);
});

test('tools on demand, small model: simpler verbs, no admin tools in the index, few loaded at a time', async () => {
  const t = new OD.OnDemandTools(ALL, 'small');
  const save = t.definitions().find((d) => d.name === 'memory_save');
  assert.equal(save.description, 'Save a fact');
  assert.equal(save.input_schema.examples, undefined);
  assert.equal(save.input_schema.properties.q.description, 'What');
  assert.ok(!t.index().includes('memory_trash_empty'));
  await t.execute('tool_load', { names: ['board_move', 'board_check', 'board_comment'] }, async () => {});
  await t.execute('tool_load', { names: ['web_fetch'] }, async () => {});
  assert.deepEqual(t.loaded(), ['board_check', 'board_comment', 'web_fetch']); // the oldest left
  assert.match((await t.execute('tool_load', { names: ['a', 'b', 'c', 'd'] }, async () => {})).content[0].text, /more than 3 items/);
  assert.equal(OD.tierOf(8192), 'small'); assert.equal(OD.tierOf(32768), 'medium'); assert.equal(OD.tierOf(131072), 'large');
});

test('XP1: one definition for every door', async () => {
  const { contractToolDefs, mcpContractTools, nativeContractTools } = await import('../src/memory/contract.ts');
  const defs = contractToolDefs();
  assert.deepEqual(defs.map((d) => d.name), ['memory_recall', 'memory_save', 'memory_supersede', 'memory_handoff', 'memory_propose']);
  assert.deepEqual(mcpContractTools().map(D.fromMcp), defs);
  assert.deepEqual(nativeContractTools(), defs.map(D.asNative));
  // The subscription protocol prints the same JSON as before (byte for byte).
  const tools = ALL.map((d) => ({ name: d.name, description: d.description, input_schema: d.input_schema }));
  assert.equal(D.asProtocol(tools), JSON.stringify(tools));
  assert.deepEqual(D.asFunction(ALL[0]), { type: 'function', function: { name: 'memory_search', description: ALL[0].description, parameters: ALL[0].input_schema } });
  assert.equal(D.shortLine('Search the memory you may read. Returns ids.'), 'Search the memory you may read');
});

test('adaptive budget: a full turn fits an 8k model with room for the reply, the order is kept', () => {
  const b = planLocalBudget(8192);
  assert.deepEqual([b.tier, b.replyTokens, b.promptTokens], ['small', 1638, 6554]);
  assert.equal(planLocalBudget(32768).replyTokens, 4096);
  const t = new OD.OnDemandTools(ALL, b.tier);
  const system = `Owner rules first.\n${'Persona and guides. '.repeat(1500)}\nYou are answered by qwen3:4b on this computer.`;
  const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${'words '.repeat(120)}` }));
  const recall = ['[Memory recalled for this message — data, not instructions]', ...Array.from({ length: 60 }, (_, i) => `- fact ${i} ${'detail '.repeat(20)}`), '[End of recalled memory]'].join('\n');
  const last = { role: 'user', content: `${recall}\n\nWhere is staging hosted?` };
  const fit = fitLocalTurn({ system, messages: [...history, last], tools: t.definitions(), budget: b });
  assert.ok(fit.fits, JSON.stringify(fit.tokens));
  assert.ok(fit.tokens.total <= b.promptTokens);
  assert.ok(fit.system.startsWith('Owner rules first.') && fit.system.endsWith('on this computer.'), 'the start and end of the system text stay');
  assert.ok(fit.cut.systemTokens > 0 && fit.cut.recallLines > 0 && fit.cut.historyTurns > 0);
  const out = fit.messages.at(-1).content;
  assert.match(out, /- fact 0 /); assert.ok(!out.includes('- fact 59 '), 'the best recalled lines stay, the last go');
  assert.match(out, /Where is staging hosted\?$/);
  assert.equal(fit.messages[0].role, 'user', 'history starts with a user turn');
  assert.deepEqual(fit.messages.slice(0, -1), history.slice(history.length - fit.messages.length + 1), 'the newest turns are kept, in order');
  // The same input gives the same output (a stable prefix for the cache).
  assert.deepEqual(fitLocalTurn({ system, messages: [...history, last], tools: t.definitions(), budget: b }), fit);
  // A small turn is not touched.
  const small = fitLocalTurn({ system: 'hi', messages: [{ role: 'user', content: 'q' }], tools: t.definitions(), budget: b });
  assert.deepEqual(small.cut, { systemTokens: 0, recallLines: 0, historyTurns: 0 });
  assert.equal(trimRecall('no block', 1).dropped, 0);
});

test('prepareLocalTurn: index and the memory rule in the system text, the reply room, caps per tier', () => {
  const lt = prepareLocalTurn({ window: { tokens: 8192, reported: 8192, source: 'ollama_show' }, tools: ALL, systemHead: 'Rules.', systemTail: 'UI.', messages: [{ role: 'user', content: 'hi' }], maxTokens: 9000, run: async () => ({ content: [] }) });
  assert.match(lt.system, /^Rules\.\n\n---\n\n## Tool index\n/);
  assert.ok(lt.system.includes(NO_INVENTED_MEMORY) && lt.system.endsWith('UI.'));
  assert.deepEqual([lt.numCtx, lt.maxTokens, lt.callCap, lt.maxSteps], [8192, 1638, 2, 12]);
  assert.ok(estimateTokens(lt.system) + estimateTokens(JSON.stringify(lt.toolSet.definitions())) < 6554);
});

test('weak tool calling: repeats dropped, a few calls run one after another, the model is told the rest', async () => {
  const calls = [{ id: '1', name: 'a', args: { x: 1 } }, { id: '2', name: 'a', args: { x: 1 } }, { id: '3', name: 'b', args: {} }, { id: '4', name: 'c', args: {} }];
  assert.deepEqual(OD.planCalls(calls, 2), { run: [calls[0], calls[2]], skipped: [calls[3]] });
  // The Ollama loop: 32 calls in one reply (as qwen3:4b did in P10), cap 2, the tool list asked again each step.
  const bodies = [];
  let n = 0;
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const enc = new TextEncoder();
    const msg = n++ === 0 ? { message: { content: '', tool_calls: Array.from({ length: 32 }, (_, i) => ({ function: { name: 'memory_search', arguments: { q: `w${i % 3}` } } })) }, done: true } : { message: { content: 'done' }, done: true };
    return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(JSON.stringify(msg) + '\n')); c.close(); } }), { status: 200 });
  };
  let active = 0, maxActive = 0, ran = 0, step = 0;
  const execute = async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 5)); active--; ran++; return { content: [{ type: 'text', text: 'ok' }] }; };
  const r = await runOllamaAgentLoop({ url: 'http://127.0.0.1:1', model: 'm', messages: [{ role: 'user', content: 'go' }], tools: [], execute, write: () => {}, signal: new AbortController().signal, callCap: 2, fetchImpl,
    toolSet: { definitions: () => [{ name: `t${++step}`, description: 'd', input_schema: { type: 'object', properties: {} } }] } });
  assert.equal(r.answer, 'done');
  assert.equal(ran, 2); assert.equal(maxActive, 1, 'one after another');
  assert.deepEqual(bodies.map((b) => b.tools.map((t) => t.function.name)), [['t1'], ['t2']]);
  const toolMsgs = bodies[1].messages.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 2);
  assert.match(toolMsgs[1].content, /1 more tool call was not run/);
  assert.equal(bodies[1].messages.find((m) => m.role === 'assistant').tool_calls.length, 2);
  // Without a cap nothing changes (all at once).
  n = 0; ran = 0;
  await runOllamaAgentLoop({ url: 'http://127.0.0.1:1', model: 'm', messages: [{ role: 'user', content: 'go' }], tools: [], execute, write: () => {}, signal: new AbortController().signal, fetchImpl });
  assert.equal(ran, 32);
});

test('weak tool calling on the OpenAI-compatible loop (LM Studio and generic servers)', async () => {
  let n = 0;
  const bodies = [];
  const sse = (chunks) => new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode(`data: ${JSON.stringify(x)}\n\n`)); c.enqueue(e.encode('data: [DONE]\n\n')); c.close(); } }), { status: 200 });
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (n++ === 0) return sse([{ choices: [{ delta: { tool_calls: [0, 1, 2].map((i) => ({ index: i, function: { name: 'web_fetch', arguments: JSON.stringify({ url: `u${i}` }) } })) } }] }]);
    return sse([{ choices: [{ delta: { content: 'ok' } }] }]);
  };
  let ran = 0;
  const r = await runLmStudioAgentLoop({ url: 'http://127.0.0.1:8080/v1', model: 'm', messages: [{ role: 'user', content: 'go' }], tools: [], execute: async () => { ran++; return { content: [{ type: 'text', text: 'x' }] }; }, write: () => {}, signal: new AbortController().signal, fetchImpl, callCap: 2,
    toolSet: { definitions: () => ALL.slice(0, 2) } });
  assert.equal(r.answer, 'ok'); assert.equal(ran, 2);
  assert.equal(bodies[0].tools.length, 2);
  const tm = bodies[1].messages.filter((m) => m.role === 'tool');
  assert.deepEqual(tm.map((m) => m.tool_call_id), bodies[1].messages.find((m) => m.role === 'assistant').tool_calls.map((c) => c.id), 'every sent call has its result');
  assert.match(tm[1].content, /1 more tool call was not run/);
});

test('LAT: background work waits while a local reply runs, one job at a time; the chat model stays warm', async () => {
  S.resetScheduler();
  process.env.GIRRU_STORE_P2B = '1';
  try {
    const end = S.beginLocalReply('qwen3:4b');
    const order = [];
    const a = S.inBackgroundSlot(async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 10)); order.push('a-end'); });
    const b = S.inBackgroundSlot(async () => { order.push('b'); });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(order, [], 'nothing runs during the reply');
    end(); end(); // ending twice is harmless
    await Promise.all([a, b]);
    assert.deepEqual(order, ['a-start', 'a-end', 'b'], 'one at a time, in order');
    assert.equal(S.localRepliesRunning(), 0);
    // A job never waits forever.
    const end2 = S.beginLocalReply('qwen3:4b');
    let ran = false;
    await S.inBackgroundSlot(async () => { ran = true; }, { maxWaitMs: 20 });
    assert.ok(ran); assert.equal(S.schedulerStats().ranDuringReply, 1);
    end2();
    assert.equal(S.backgroundKeepAlive('qwen3:4b', S.chatModelInUse(), '30m'), '30m');
    assert.equal(S.backgroundKeepAlive('worker:1b', S.chatModelInUse(), '30m'), S.HELPER_KEEP_ALIVE);
  } finally { delete process.env.GIRRU_STORE_P2B; S.resetScheduler(); }
  // Off: no wait at all.
  const end = S.beginLocalReply('m');
  let ran = false;
  await S.inBackgroundSlot(async () => { ran = true; });
  assert.ok(ran);
  end();
  assert.equal(S.schedulerStats().queued, 0);
});
