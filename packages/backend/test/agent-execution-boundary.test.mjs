import test from 'node:test';
import assert from 'node:assert/strict';
import { runStepCalls } from '../src/agent/execution/tool-step.ts';
import { runLmStudioAgentLoop } from '../src/services/lmstudio-agent-loop.ts';

test('capped execution deduplicates, preserves order and retains registry refusals', async () => {
  const calls = [{ id: 'a', name: 'read', args: {} }, { id: 'b', name: 'read', args: {} }, { id: 'c', name: 'write', args: {} }, { id: 'd', name: 'extra', args: {} }];
  const invoked = [];
  const out = await runStepCalls(calls, async name => {
    invoked.push(name);
    if (name === 'write') throw new Error('permission_revoked');
    return { content: [{ type: 'text', text: 'record' }] };
  }, () => 10, 2);
  assert.deepEqual(invoked, ['read', 'write']);
  assert.deepEqual(out.results.map(r => [r.id, r.isError]), [['a', false], ['c', true]]);
  assert.match(out.results[1].text, /permission_revoked/);
  assert.ok(out.skippedNote);
});

test('LM Studio preserves shared events, tool correlation and inference count', async () => {
  const bodies = [], frames = [];
  const replies = [[{ reasoning_content: 'inspect' }, { tool_calls: [{ index: 0, id: 'provider-call', type: 'function', function: { name: 'read', arguments: '{}' } }] }], [{ content: 'done' }]];
  const result = await runLmStudioAgentLoop({
    url: 'http://fixture.invalid/v1', model: 'fixture', messages: [{ role: 'user', content: 'inspect' }],
    tools: [{ name: 'read', description: 'Read', input_schema: { type: 'object' } }],
    signal: new AbortController().signal, write: f => frames.push(f),
    execute: async name => { assert.equal(name, 'read'); return { content: [{ type: 'text', text: 'record' }] }; },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      const deltas = replies.shift(); assert.ok(deltas, 'no duplicate inference');
      return new Response(deltas.map(delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join('') + 'data: [DONE]\n\n');
    },
  });
  assert.deepEqual(result, { answer: 'done', steps: 2, aborted: false });
  assert.deepEqual(frames.map(f => f.type), ['reasoning', 'tool_start', 'tool_result', 'text', 'done']);
  const [request, receipt] = bodies[1].messages.slice(-2);
  assert.equal(receipt.tool_call_id, request.tool_calls[0].id);
  assert.equal(receipt.content, 'record');
});

test('backend dispatch preserves provider protocols and refuses unknown providers', async () => {
  const { executeLocalTurn } = await import('../src/agent/execution/local-turn.ts');
  for (const provider of ['ollama', 'lmstudio', 'openai-local']) {
    const frames = [], requests = [];
    const result = await executeLocalTurn({ provider, options: {
      url: 'http://fixture.invalid/v1', model: 'resolved-model',
      messages: [{ role: 'user', content: 'hello' }], tools: [],
      signal: new AbortController().signal, write: frame => frames.push(frame),
      execute: async () => { throw new Error('unexpected_tool_execution'); },
      fetchImpl: async (url, init) => {
        requests.push([String(url), JSON.parse(init.body)]);
        return new Response(provider === 'ollama'
          ? JSON.stringify({ message: { content: 'answer' }, done: true }) + '\n'
          : 'data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n');
      },
    } });
    assert.equal(requests.length, 1);
    assert.equal(requests[0][1].model, 'resolved-model');
    assert.match(requests[0][0], provider === 'ollama' ? /\/api\/chat$/ : /\/chat\/completions$/);
    assert.deepEqual(result, { answer: 'answer', steps: 1, aborted: false });
    assert.deepEqual(frames.map(f => f.type), ['text', 'done']);
  }
  assert.throws(() => executeLocalTurn({ provider: 'unknown', options: {} }), /unsupported_local_provider/);
});
