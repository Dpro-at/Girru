// CH3: the Thinking choice reaches only a model that can think; a non-thinking model never gets a level it ignores.
// Run: node --import tsx --test test/chat-thinking-models.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
delete process.env.OLLAMA_THINK;
const { chatThinkFor } = await import('../src/llm/ollama.ts');

test('a thinking local model gets Quick/Deep; Normal keeps the server default', () => {
  const caps = ['completion', 'tools', 'thinking'];
  assert.deepEqual(chatThinkFor('deep', caps), { think: true, thinkOptional: true });
  assert.deepEqual(chatThinkFor('quick', caps), { think: false, thinkOptional: true });
  assert.deepEqual(chatThinkFor('normal', caps), {});
  assert.deepEqual(chatThinkFor(undefined, caps), {});
});

test('a model that says it cannot think gets no level; unknown capabilities keep the optional flag', () => {
  for (const t of ['deep', 'quick', 'normal']) assert.deepEqual(chatThinkFor(t, ['completion', 'tools']), {}, t);
  assert.deepEqual(chatThinkFor('deep', []), { think: true, thinkOptional: true });
  assert.deepEqual(chatThinkFor('deep'), { think: true, thinkOptional: true });
});

test('the model list marks what can think: Claude, Claude Code, Codex and Gemini, local models by their own capabilities', () => {
  const src = readFileSync(new URL('../src/services/model-catalogue.ts', import.meta.url), 'utf8');
  assert.match(src, /variants:await subscriptionVariants\(kind\),think:true\}/);
  assert.match(src, /m\.capabilities\.includes\('thinking'\) \? \{ think: true \}/);
  assert.doesNotMatch(src.slice(src.indexOf('// 3. Add OpenAI models')), /think:/);
  const chat = readFileSync(new URL('../src/agent/execution/chat-turn.ts', import.meta.url), 'utf8');
  assert.match(chat, /\.\.\.chatThinkFor\(thinking, thinkCaps\)/);
});

const { subscriptionArgs, subscriptionEffort } = await import('../src/services/subscription-chat.ts');
const { claudeMessageBody, claudeThinkingFor, CLAUDE_DEEP_THINKING_BUDGET } = await import('../src/llm/claude-client.ts');
const effortOf = (args) => args.filter((a, i) => a === '--effort' || /^model_reasoning_effort=/.test(a) || args[i - 1] === '--effort');

test('coding apps get Quick→low and Deep→high; Normal leaves the app default', () => {
  assert.deepEqual(subscriptionArgs('codex', undefined, undefined, true, false, false, [], [], 'quick').slice(0, 3), ['exec', '-c', 'model_reasoning_effort="low"']);
  assert.deepEqual(subscriptionArgs('codex', undefined, undefined, true, false, false, [], [], 'deep').slice(0, 3), ['exec', '-c', 'model_reasoning_effort="high"']);
  assert.deepEqual(subscriptionArgs('claude', undefined, undefined, true, false, false, [], [], 'quick').slice(-2), ['--effort', 'low']);
  assert.deepEqual(subscriptionArgs('claude', undefined, 'opus', false, false, true, ['/tmp/x'], [], 'deep').slice(-2), ['--effort', 'high']);
  assert.deepEqual(subscriptionArgs('gemini', undefined, undefined, false, false, false, [], [], 'quick').slice(-2), ['--effort', 'low']);
  assert.deepEqual(subscriptionArgs('gemini', undefined, 'gemini-3.1-pro', false, false, false, [], [], 'deep').slice(-4), ['--model', 'gemini-3.1-pro', '--effort', 'high']);
  for (const kind of ['claude', 'codex', 'gemini']) {
    assert.deepEqual(subscriptionArgs(kind, undefined, undefined, false, false, false, [], [], 'normal'), subscriptionArgs(kind), kind);
    assert.deepEqual(effortOf(subscriptionArgs(kind, undefined, undefined, false, false, false, [], [], 'normal')), [], kind);
  }
  const fork = subscriptionArgs('codex', 'a1b2c3d4-0000-0000-0000-000000000000', 'gpt-6.1-sol', false, false, false, [], [], 'deep');
  assert.deepEqual(fork.slice(-3), ['fork', 'a1b2c3d4-0000-0000-0000-000000000000', '-'], 'the prompt still comes from stdin');
  assert.ok(fork.includes('model_reasoning_effort="high"') && fork.includes('gpt-6.1-sol'));
});

test('a bad thinking value never reaches the command line', () => {
  const bad = ['max', 'xhigh', 'ultra', 'low', 'high', 'medium', 'Deep', ' deep', 'deep"; rm -rf /', '--yolo', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 1, null, {}, ['deep'], { toString: () => 'deep' }];
  for (const v of bad) {
    assert.equal(subscriptionEffort(v), undefined, String(v));
    for (const kind of ['claude', 'codex', 'gemini']) assert.deepEqual(subscriptionArgs(kind, undefined, undefined, false, false, false, [], [], v), subscriptionArgs(kind), `${kind} ${String(v)}`);
  }
  for (const kind of ['claude', 'codex', 'gemini']) for (const t of ['quick', 'deep']) {
    const vals = effortOf(subscriptionArgs(kind, undefined, undefined, false, false, false, [], [], t)).filter((a) => a !== '--effort');
    assert.equal(vals.length, 1, `${kind} ${t}`);
    assert.ok(['low', 'high', 'model_reasoning_effort="low"', 'model_reasoning_effort="high"'].includes(vals[0]), `${kind} ${t}`);
  }
  const src = readFileSync(new URL('../src/agent/execution/chat-turn.ts', import.meta.url), 'utf8');
  assert.match(src, /images:seen,thinking:currentChatRun\(\)\?\.thinking(,agentId:selectedAgent\?\.id\?\?null)?\}/, 'the chat passes its saved level, not user text');
});

test('Claude API: Deep turns use bounded extended thinking; Quick and Normal send none', () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  assert.deepEqual(claudeThinkingFor('deep'), { budgetTokens: CLAUDE_DEEP_THINKING_BUDGET });
  for (const t of ['quick', 'normal', undefined, 'max', 'DEEP', 7]) assert.equal(claudeThinkingFor(t), undefined, String(t));
  const deep = claudeMessageBody('claude-x', msgs, { maxTokens: 4096, temperature: 0.7, thinking: claudeThinkingFor('deep') });
  assert.deepEqual(deep.thinking, { type: 'enabled', budget_tokens: CLAUDE_DEEP_THINKING_BUDGET });
  assert.ok(deep.max_tokens > CLAUDE_DEEP_THINKING_BUDGET, 'max_tokens stays above the budget');
  assert.equal(deep.temperature, undefined, 'thinking turns leave temperature out');
  const quick = claudeMessageBody('claude-x', msgs, { maxTokens: 4096, temperature: 0.7, thinking: claudeThinkingFor('quick') });
  assert.equal(quick.thinking, undefined); assert.equal(quick.temperature, 0.7); assert.equal(quick.max_tokens, 4096);
  assert.equal(claudeMessageBody('m', msgs, { thinking: { budgetTokens: 1e9 } }).thinking.budget_tokens, CLAUDE_DEEP_THINKING_BUDGET, 'the budget is bounded');
  assert.equal(claudeMessageBody('m', msgs, { thinking: { budgetTokens: 5 } }).thinking.budget_tokens, 1024);
  assert.equal(claudeMessageBody('m', msgs, { thinking: { budgetTokens: NaN } }).thinking, undefined);
  const agentic = readFileSync(new URL('../src/agent/execution/cloud-turn.ts', import.meta.url), 'utf8');
  assert.match(agentic, /thinking: claudeThinkingFor\(currentChatRun\(\)\?\.thinking\)/);
});

test('the chat\'s thinking level also goes with a hand-off and with ask_coding_app', async () => {
  const { readFileSync } = await import('node:fs');
  const team = readFileSync(new URL('../src/tools/tasks/team.ts', import.meta.url), 'utf8');
  const ask = readFileSync(new URL('../src/tools/cli/ask-coding-app.ts', import.meta.url), 'utf8');
  assert.match(team, /const thinking = currentChatRun\(\)\?\.thinking;/);
  assert.match(team, /runSubscription\(target\.model, folder, prompt, signal, \{ appToolsOnly: true, thinking(, agentId: target\.id)? \}\)/);
  assert.match(ask, /readOnly: app === 'codex', thinking: currentChatRun\(\)\?\.thinking(, agentId: context\?\.agentId \?\? null)? \}/);
});
