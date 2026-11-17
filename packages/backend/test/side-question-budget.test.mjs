// AGENT-BTW-01: the side-question context budget trims from the oldest and
// never splits a tool call from its result.
// Run: node --import tsx --test test/side-question-budget.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const backendDir = fileURLToPath(new URL('../', import.meta.url));
const { sideBudget, assemblePrompt, sideChannelTurn } =
  await import(join(backendDir, 'src/services/side-question/budget.ts'));

test('sideBudget input = window - outputCap - safetyMargin', () => {
  const b = sideBudget({ window: 8192, outputCap: 1024, safetyMargin: 512 });
  assert.equal(b.inputTokens, 8192 - 1024 - 512);
});

test('the question turn and system prompt are always kept', () => {
  const out = assemblePrompt({
    systemPrompt: 'SYS',
    context: [],
    summary: '',
    recent: [],
    question: 'why did you do that?',
    budget: sideBudget({ window: 2048 }),
  });
  assert.equal(out.system, 'SYS');
  const last = out.messages[out.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.match(last.content, /why did you do that\?/);
});

test('oldest context is dropped first when the budget is tight', () => {
  const context = [];
  for (let i = 0; i < 40; i++) context.push({ role: i % 2 ? 'assistant' : 'user', content: `message number ${i} `.repeat(30) });
  const out = assemblePrompt({
    systemPrompt: 'sys', context, summary: '', recent: [],
    question: 'q', budget: sideBudget({ window: 2048, outputCap: 256, safetyMargin: 128 }),
  });
  assert.ok(out.droppedContext > 0, 'some context dropped');
  // Whatever survived is the newest; message 39 must appear before older ones are reintroduced.
  const kept = out.messages.slice(0, -1).map((m) => m.content).join('\n');
  assert.match(kept, /message number 39/, 'newest kept');
  assert.doesNotMatch(kept, /message number 0 /, 'oldest dropped');
});

test('a tool call and its result are kept or dropped together, never split', () => {
  // A pair at the very start, then lots of filler so the pair is on the drop boundary.
  const context = [
    { role: 'assistant', content: 'calling tool now', pairId: 'p1' },
    { role: 'tool', content: 'tool result payload', pairId: 'p1' },
  ];
  for (let i = 0; i < 60; i++) context.push({ role: i % 2 ? 'assistant' : 'user', content: `filler ${i} `.repeat(20) });

  for (const window of [1500, 2048, 4096, 8192]) {
    const out = assemblePrompt({
      systemPrompt: 'sys', context, summary: '', recent: [],
      question: 'q', budget: sideBudget({ window, outputCap: 256, safetyMargin: 128 }),
    });
    const text = out.messages.map((m) => m.content).join('\n');
    const hasCall = text.includes('calling tool now');
    const hasResult = text.includes('tool result payload');
    assert.equal(hasCall, hasResult, `pair integrity at window ${window} (call=${hasCall} result=${hasResult})`);
  }
});

test('recent Q&A and summary are folded into the side-channel turn', () => {
  const turn = sideChannelTurn('older stuff summarized', [{ question: 'Q1', answer: 'A1' }], 'new question');
  assert.match(turn, /older stuff summarized/);
  assert.match(turn, /Q: Q1/);
  assert.match(turn, /A: A1/);
  assert.match(turn, /new question/);
  assert.match(turn, /read-only/i, 'tells the model not to act');
});
