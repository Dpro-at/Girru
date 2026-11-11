// CHAT-LIVE-01: a running reply's live preview carries its steps (inputs
// redacted) and its plan; the agent's choice question is cleaned and refuses
// asking for secrets; the coding-app loop ends on a question.
// Run: node --import tsx --test test/live-work.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const backendDir = process.cwd();
const { liveWork } = await import(join(backendDir, 'src/services/chat-runs.ts'));
const { choiceOf, askChoiceTool } = await import(join(backendDir, 'src/tools/plan/ask-choice.ts'));
const { subscriptionToolLoop } = await import(join(backendDir, 'src/services/subscription-tool-loop.ts'));

test('liveWork lists steps (redacted, newest 12) and the newest plan with sub-steps', () => {
  const key = 'sk-ant-api03-' + 'A'.repeat(90);
  const parts = [
    { kind: 'tools', step: 1, calls: [{ id: 'p', name: 'plan_steps', input: JSON.stringify({ steps: [{ title: 'Read', status: 'done' }, { title: 'Read part', status: 'active', parent: 1 }, { title: 'Write', status: 'pending' }] }), output: 'ok' }] },
    { kind: 'tools', step: 2, calls: [{ id: 'r', name: 'read', input: JSON.stringify({ path: 'notes.md', key }), output: 'x', ms: 12 }, { id: 'w', name: 'web_fetch', input: '{"url":"https://example.com"}' }] },
  ];
  const w = liveWork(parts);
  assert.deepEqual(w.steps.map((s) => [s.name, s.done]), [['read', true], ['web_fetch', false]]);
  assert.ok(!w.steps[0].input.includes(key), 'a key in a tool input never shows live');
  assert.deepEqual(w.plan, [{ title: 'Read', status: 'done' }, { title: 'Read part', status: 'active', parent: 1 }, { title: 'Write', status: 'pending' }]);
  assert.deepEqual(liveWork([]), {});
});

test('choiceOf cleans the question and refuses secrets or bad lists', () => {
  assert.deepEqual(choiceOf({ question: ' Lunch? ', options: ['Pizza', 'Sushi', 'Pizza'], suggested: 2 }), { question: 'Lunch?', options: ['Pizza', 'Sushi'], multiple: false, suggested: 2 });
  assert.equal(typeof choiceOf({ question: 'Lunch?', options: ['Pizza'] }), 'string');
  assert.equal(typeof choiceOf({ question: 'Your API key?', options: ['a', 'b'] }), 'string');
  assert.equal(typeof choiceOf({ question: 'Which?', options: ['1', '2', '3', '4', '5', '6'] }), 'string');
});

test('ask_choice waits for the owner; the coding-app loop ends on it', async () => {
  const r = await askChoiceTool.execute({ question: 'Lunch?', options: ['Pizza', 'Sushi'] });
  assert.equal(r.details.status, 'waiting_choice');
  let calls = 0;
  const text = await subscriptionToolLoop({
    prompt: 'p', signal: new AbortController().signal, tools: [askChoiceTool],
    reply: async () => { calls++; return JSON.stringify({ type: 'tool', name: 'ask_choice', arguments: { question: 'Lunch?', options: ['Pizza', 'Sushi'] } }); },
    execute: async (_n, a) => askChoiceTool.execute(a),
  });
  assert.equal(calls, 1, 'no second model call after the question');
  assert.equal(text, 'Waiting for your choice.');
});

test('CHAT-CONTENT-01: answers can carry a one-line reason (a reasons list or { label, reason })', () => {
  assert.deepEqual(choiceOf({ question: 'Which fix?', options: ['Move the check', 'Retry'], reasons: ['Smallest change', 'Hides the race'], suggested: 1 }),
    { question: 'Which fix?', options: ['Move the check', 'Retry'], reasons: ['Smallest change', 'Hides the race'], multiple: false, suggested: 1 });
  assert.deepEqual(choiceOf({ question: 'Which fix?', options: [{ label: 'A', reason: 'why A' }, 'B'] }).reasons, ['why A', '']);
  assert.equal(choiceOf({ question: 'Which?', options: ['A', 'B'] }).reasons, undefined);
  assert.equal(typeof choiceOf({ question: 'Which?', options: ['A', 'B'], reasons: ['type your password', ''] }), 'string');
});
