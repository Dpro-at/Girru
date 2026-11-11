// CH3 "Answers with": Gemini Pro / Gemini Flash under Gemini; the thinking choice only for models that can think.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { agentCardResponse } = require('../src/agent-card-contract.js');
const { answersLabel, ModelButton } = require('../src/ChatComposerControls.tsx');
const { ConversationsController, canThink } = require('../src/conversations.ts');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const CID = '3f0c2b6e-1d2a-4f4e-9b1a-6c7d8e9f0a1b';

const wire = { models: [
  { id: 'subscription:claude', provider: 'subscription', label: 'Claude Code · existing account', size: '', think: true, variants: [{ id: 'opus', label: 'Opus' }] },
  { id: 'subscription:codex', provider: 'subscription', label: 'Codex · existing ChatGPT account', size: '', think: true, variants: [{ id: 'gpt-5.5', label: 'GPT-5.5' }] },
  { id: 'subscription:gemini', provider: 'subscription', label: 'Google Gemini · Antigravity account', size: '', variants: [{ id: 'gemini-3.1-pro', label: 'Gemini Pro', note: 'Long documents and research' }, { id: 'gemini-3.8-flash', label: 'Gemini Flash', note: 'Quick' }, { id: '--bad', label: 'x', note: 'y' }] },
  { id: 'qwen3:8b', name: '🏠 qwen3:8b', provider: 'local', size: '5GB', think: true },
  { id: 'llama3.2:3b', name: '🏠 llama3.2:3b', provider: 'local', size: '2GB' },
  { id: 'lmstudio:qwen/qwen3-8b', name: 'qwen/qwen3-8b', provider: 'lmstudio', size: '', think: 'yes' },
  { id: 'claude-sonnet-4-5-20250929', name: '🧠 Claude Sonnet 4.5', provider: 'claude', size: 'API', think: true },
] };

test('the contract keeps Gemini Pro / Flash with their notes and only a real think flag', () => {
  const { models } = agentCardResponse('/api/models', 200, wire);
  assert.deepEqual(agentCardResponse('/api/models', 200, { models }), { models }, 'runs twice unchanged');
  const gemini = models.find(m => m.id === 'subscription:gemini');
  assert.deepEqual(gemini.variants, [{ id: 'gemini-3.1-pro', label: 'Gemini Pro', note: 'Long documents and research' }, { id: 'gemini-3.8-flash', label: 'Gemini Flash', note: 'Quick' }]);
  assert.equal(gemini.think, undefined);
  assert.deepEqual(models.filter(m => m.think).map(m => m.id), ['subscription:claude', 'subscription:codex', 'qwen3:8b', 'claude-sonnet-4-5-20250929']);
  assert.equal(answersLabel('subscription:gemini/gemini-3.1-pro', models, 'normal'), 'Gemini · Gemini Pro');
  assert.equal(answersLabel('subscription:gemini/gemini-3.8-flash', models, 'normal'), 'Gemini · Gemini Flash');
});

test('canThink: Claude, Claude Code, Codex and thinking local models; never Gemini, LM Studio or a plain local model', () => {
  const { models } = agentCardResponse('/api/models', 200, wire);
  for (const m of ['auto', '', 'subscription:claude', 'subscription:claude/opus', 'subscription:codex/gpt-5.5', 'qwen3:8b', 'claude-sonnet-4-5-20250929']) assert.equal(canThink(m, models), true, m);
  for (const m of [`subscription:codex:${'a'.repeat(32)}`, 'subscription:gemini', 'subscription:gemini/gemini-3.1-pro', 'llama3.2:3b', 'lmstudio:qwen/qwen3-8b', 'gone:1b']) assert.equal(canThink(m, models), false, m);
  // The muted word is left out for a model that cannot think; the saved value is unchanged.
  assert.equal(answersLabel('llama3.2:3b', models, 'deep'), 'llama3.2:3b');
  assert.equal(answersLabel('subscription:gemini/gemini-3.8-flash', models, 'quick'), 'Gemini · Gemini Flash');
  assert.equal(answersLabel('subscription:codex/gpt-5.5', models, 'deep'), 'Codex · GPT-5.5 · Deep');
});

const fakeController = (state) => ({ subscribe: () => () => {}, getSnapshot: () => state, loadModels: async () => {}, selectModel() {}, setThinking: async () => {} });
test('the pill shows the muted thinking word only for a model that can think', () => {
  const { models } = agentCardResponse('/api/models', 200, wire);
  const pill = (model, thinking) => renderToStaticMarkup(React.createElement(ModelButton, { controller: fakeController({ model, models, thinking }), open: false, setOpen() {} }));
  assert.match(pill('qwen3:8b', 'deep'), /class="pill-muted">Deep</);
  assert.doesNotMatch(pill('llama3.2:3b', 'deep'), /pill-muted/);
  assert.doesNotMatch(pill('subscription:gemini/gemini-3.1-pro', 'quick'), /pill-muted/);
  assert.match(pill('subscription:gemini/gemini-3.1-pro', 'quick'), /aria-label="Answers with: Gemini · Gemini Pro"/);
  const code = src('ChatComposerControls.tsx');
  assert.match(code, /\{thinks && <div className="pop-think">/, 'the segmented control is drawn only when the model can think');
  assert.match(code, /\{v\.note && <small>\{v\.note\}<\/small>\}/, 'a variant shows its note');
});

test('a model that cannot think never gets a thinking level sent, and the saved choice stays', async (t) => {
  const rows = new Map([[CID, { id: CID, title: 'T', agentId: null, projectId: null, pinned: false, preview: '', createdAt: '', updatedAt: '', model: 'llama3.2:3b', thinking: 'deep' }]]);
  const puts = [], posts = [];
  const client = { getSnapshot: () => ({ phase: 'authenticated', epoch: 1, user: { role: 'owner' } }), subscribe: () => () => {}, request: async r => {
    if (r.path === '/api/models') return { status: 200, body: agentCardResponse('/api/models', 200, wire) };
    if (/\/messages(\?|$)/.test(r.path)) return { status: 200, body: { conversation: { ...rows.get(CID) }, messages: [], activeRunId: null } };
    if (r.method === 'PUT') { puts.push(r.body); return { status: 200, body: { conversation: { ...rows.get(CID), ...r.body } } }; }
    if (r.method === 'POST' && r.path === '/api/chat/conversations') { posts.push(r.body); return { status: 503 }; }
    if (r.path === '/api/chat/conversations') return { status: 200, body: { conversations: [{ ...rows.get(CID) }] } };
    return { status: 200, body: { projects: [], agents: [], sidebar: {} } };
  } };
  const c = new ConversationsController(client); t.after(() => c.dispose());
  await c.load(); await c.loadModels(); await c.open(CID);
  assert.equal(c.getSnapshot().model, 'llama3.2:3b');
  assert.equal(c.getSnapshot().thinking, 'deep', 'the saved value is kept as it is');
  await c.setThinking('quick');
  assert.deepEqual(puts.filter(p => 'thinking' in p), [], 'no thinking write for a model that cannot think');
  assert.equal(c.getSnapshot().thinking, 'deep');
  c.selectModel('qwen3:8b');
  await c.setThinking('quick');
  assert.deepEqual(puts.filter(p => 'thinking' in p), [{ thinking: 'quick' }], 'a thinking model saves it');
  assert.match(src('conversations.ts'), /this\.#state\.thinking !== 'normal' && canThink\(this\.#state\.model, this\.#state\.models\) \? \{ thinking: this\.#state\.thinking \}/, 'a new chat sends thinking only when the model can think');
});


test('advertised bound-session capability survives both projections and cannot cross sources', () => {
  const raw = { models: [
    { id: 'subscription:codex', provider: 'subscription', sessionPrefix: 'subscription:codex:', think: true },
    { id: 'subscription:claude', provider: 'subscription', sessionPrefix: 'subscription:codex:', think: true },
    { id: 'qwen', provider: 'local', sessionPrefix: 'subscription:gemini:', think: true },
  ] };
  const once = agentCardResponse('/api/models', 200, raw);
  assert.deepEqual(agentCardResponse('/api/models', 200, once), once);
  assert.equal(once.models[0].sessionPrefix, 'subscription:codex:');
  assert.equal(once.models[1].sessionPrefix, undefined);
  assert.equal(once.models[2].sessionPrefix, undefined);
  assert.equal(canThink('subscription:codex:' + 'a'.repeat(32) + '/deep', once.models), true);
  assert.equal(canThink('subscription:claude:' + 'a'.repeat(32), once.models), false);
  assert.equal(canThink('subscription:codex:invalid', once.models), false);
  assert.equal(canThink('subscription:gemini:' + 'a'.repeat(32), once.models), false);
});
