// CHAT-REBUILD-01: the local model's agent loop. Fake model (no network).
// Run: node --import tsx --test test/ollama-agent-loop.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { runOllamaAgentLoop, toOllamaTools, ModelUnavailable, TOOL_OUTPUT_CHARS, EMPTY_ANSWER_NUDGE, EMPTY_ANSWER_NUDGE_FIRST } from '../src/services/ollama-agent-loop.ts';

/** A fake local model: each call returns the next scripted list of NDJSON chunks. */
function fakeModel(script) {
  const bodies = [];
  let i = 0;
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const lines = script[i++] ?? [];
    if (lines === 'fail') return new Response('boom', { status: 500 });
    const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    return new Response(new ReadableStream({ start(c) { for (let k = 0; k < text.length; k += 7) c.enqueue(new TextEncoder().encode(text.slice(k, k + 7))); c.close(); } }));
  };
  return { fetchImpl, bodies };
}

const base = (over) => ({ url: 'http://model.invalid', model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], execute: async () => ({ content: [] }), signal: new AbortController().signal, now: () => 0, ...over });

test('streams reasoning and text, then done', async () => {
  const frames = [];
  const { fetchImpl } = fakeModel([[{ message: { thinking: 'let me ' } }, { message: { thinking: 'think' } }, { message: { content: 'Hel' } }, { message: { content: 'lo' } }, { done: true }]]);
  const r = await runOllamaAgentLoop(base({ fetchImpl, write: (f) => frames.push(f) }));
  assert.deepEqual(frames, [
    { type: 'reasoning', content: 'let me ' }, { type: 'reasoning', content: 'think' },
    { type: 'text', content: 'Hel' }, { type: 'text', content: 'lo' }, { type: 'done', done: true, steps: 1 },
  ]);
  assert.equal(r.answer, 'Hello');
});

test('runs requested tools, feeds results back, continues to the answer', async () => {
  const frames = [];
  const calls = [];
  const { fetchImpl, bodies } = fakeModel([
    [{ message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }, { function: { name: 'exec', arguments: '{"command":"ls"}' } }] } }, { done: true }],
    [{ message: { content: 'Done.' } }, { done: true }],
  ]);
  const execute = async (name, args) => { calls.push([name, args]); return name === 'exec' ? { content: [{ type: 'text', text: 'Error: refused' }] } : { content: [{ type: 'text', text: 'file body' }] }; };
  const tools = [{ name: 'read_file', description: 'Read', input_schema: { type: 'object', properties: {} } }];
  const r = await runOllamaAgentLoop(base({ fetchImpl, execute, tools, write: (f) => frames.push(f) }));
  assert.deepEqual(calls, [['read_file', { path: 'a.txt' }], ['exec', { command: 'ls' }]]);
  assert.deepEqual(frames[0], { type: 'tool_start', step: 1, tools: [{ id: 'call-1', name: 'read_file', input: '{"path":"a.txt"}' }, { id: 'call-2', name: 'exec', input: '{"command":"ls"}' }] });
  assert.deepEqual(frames[1], { type: 'tool_result', step: 1, results: [{ id: 'call-1', name: 'read_file', output: 'file body', isError: false, ms: 0 }, { id: 'call-2', name: 'exec', output: 'Error: refused', isError: true, ms: 0 }] });
  assert.deepEqual(frames.at(-1), { type: 'done', done: true, steps: 2 });
  assert.equal(r.answer, 'Done.');
  // Tools go in the function format; the second call carries the assistant call and both results.
  assert.deepEqual(bodies[0].tools, toOllamaTools(tools));
  assert.equal(bodies[1].messages.at(-3).tool_calls.length, 2);
  assert.deepEqual(bodies[1].messages.slice(-2).map((m) => [m.role, m.tool_name, m.content]), [['tool', 'read_file', 'file body'], ['tool', 'exec', 'Error: refused']]);
});

test('a thrown tool error becomes an error result, not a failed turn', async () => {
  const frames = [];
  const { fetchImpl } = fakeModel([[{ message: { tool_calls: [{ function: { name: 'x', arguments: {} } }] } }], [{ message: { content: 'ok' } }]]);
  await runOllamaAgentLoop(base({ fetchImpl, execute: async () => { throw new Error('nope'); }, write: (f) => frames.push(f) }));
  assert.equal(frames[1].results[0].isError, true);
  assert.equal(frames[1].results[0].output, 'Error: nope');
});

test('long tool output is clipped for the client', async () => {
  const frames = [];
  const big = 'x'.repeat(TOOL_OUTPUT_CHARS + 50);
  const { fetchImpl } = fakeModel([[{ message: { tool_calls: [{ function: { name: 'x', arguments: {} } }] } }], [{ message: { content: 'ok' } }]]);
  await runOllamaAgentLoop(base({ fetchImpl, execute: async () => ({ content: [{ type: 'text', text: big }] }), write: (f) => frames.push(f) }));
  assert.match(frames[1].results[0].output, /… 50 more characters$/);
});

test('stops at the step limit with a note', async () => {
  const frames = [];
  const step = [{ message: { tool_calls: [{ function: { name: 'x', arguments: {} } }] } }];
  const { fetchImpl } = fakeModel([step, step, step]);
  const r = await runOllamaAgentLoop(base({ fetchImpl, maxSteps: 2, write: (f) => frames.push(f) }));
  assert.equal(r.steps, 2);
  assert.match(frames.at(-2).content, /2 steps/);
  assert.deepEqual(frames.at(-1), { type: 'done', done: true, steps: 2 });
});

test('abort stops the loop without a done frame', async () => {
  const frames = [];
  const ac = new AbortController();
  const { fetchImpl } = fakeModel([[{ message: { tool_calls: [{ function: { name: 'x', arguments: {} } }] } }], [{ message: { content: 'never' } }]]);
  const r = await runOllamaAgentLoop(base({ fetchImpl, signal: ac.signal, execute: async () => { ac.abort(); return { content: [] }; }, write: (f) => frames.push(f) }));
  assert.equal(r.aborted, true);
  assert.ok(!frames.some((f) => f.type === 'done' || f.type === 'tool_result'));
});

test('a refused model call throws ModelUnavailable', async () => {
  const { fetchImpl } = fakeModel(['fail']);
  await assert.rejects(runOllamaAgentLoop(base({ fetchImpl, write: () => {} })), ModelUnavailable);
});

test('an empty answer (after tools, or thinking only) gets one short follow-up ask; a second empty answer stays empty', async () => {
  const call = [{ message: { content: '', tool_calls: [{ function: { name: 'memory_save', arguments: { content: 'x' } } }] } }, { done: true }];
  const empty = [{ message: { content: '' } }, { done: true }];
  const done = [{ message: { content: 'Saved.' } }, { done: true }];
  const { fetchImpl, bodies } = fakeModel([call, empty, done]);
  const r = await runOllamaAgentLoop(base({ fetchImpl, write: () => {} }));
  assert.equal(r.answer, 'Saved.');
  assert.equal(r.steps, 3);
  assert.equal(bodies[2].messages.at(-1).content, EMPTY_ANSWER_NUDGE);
  const again = fakeModel([call, empty, empty]);
  const r2 = await runOllamaAgentLoop(base({ fetchImpl: again.fetchImpl, write: () => {} }));
  assert.equal(r2.answer, '');
  assert.equal(again.bodies.length, 3, 'asked only once');
  const first = fakeModel([[{ message: { thinking: 'hmm' } }, { done: true }], done]);
  assert.equal((await runOllamaAgentLoop(base({ fetchImpl: first.fetchImpl, write: () => {} }))).answer, 'Saved.', 'thinking only: one follow-up too');
  assert.equal(first.bodies[1].messages.at(-1).content, EMPTY_ANSWER_NUDGE_FIRST);
});
