// AGENT-BTW-01: the context snapshot is an immutable deep copy.
// Run: node --import tsx --test test/side-question-snapshot.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const backendDir = fileURLToPath(new URL('../', import.meta.url));
const { captureMainContext, getSnapshot, clearSnapshot, clearAllSnapshots } =
  await import(join(backendDir, 'src/services/side-question/snapshot.ts'));

test('snapshot is frozen and deep-copied from a mutable source', () => {
  clearAllSnapshots();
  const sourceMessages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
  ];
  const snap = captureMainContext({
    ownerId: 'owner-1', parentSessionId: 's1',
    systemPrompt: 'be helpful', messages: sourceMessages,
    provider: 'ollama', model: 'qwen', temperature: 0.5,
  });

  // Mutating the source after capture must not change the snapshot.
  sourceMessages.push({ role: 'user', content: 'injected later' });
  sourceMessages[0].content = 'changed';
  assert.equal(snap.messages.length, 2, 'later pushes do not leak in');
  assert.equal(snap.messages[0].content, 'first', 'earlier content is a copy');

  // The snapshot and its messages are frozen (writes throw in module scope / are ignored).
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.messages));
  assert.ok(Object.isFrozen(snap.messages[0]));
  assert.throws(() => { 'use strict'; snap.messages[0].content = 'x'; });
  assert.throws(() => { 'use strict'; snap.systemPrompt = 'x'; });
});

test('getSnapshot returns the latest per owner+session; owners are isolated', () => {
  clearAllSnapshots();
  captureMainContext({ ownerId: 'a', parentSessionId: 's', systemPrompt: 'one', messages: [], provider: 'ollama', model: 'm' });
  captureMainContext({ ownerId: 'a', parentSessionId: 's', systemPrompt: 'two', messages: [], provider: 'ollama', model: 'm' });
  assert.equal(getSnapshot('a', 's').systemPrompt, 'two', 'latest wins');
  assert.equal(getSnapshot('b', 's'), null, 'another owner sees nothing');
});

test('clearSnapshot forgets only the targeted session', () => {
  clearAllSnapshots();
  captureMainContext({ ownerId: 'a', parentSessionId: 's1', systemPrompt: 'x', messages: [], provider: 'ollama', model: 'm' });
  captureMainContext({ ownerId: 'a', parentSessionId: 's2', systemPrompt: 'y', messages: [], provider: 'ollama', model: 'm' });
  clearSnapshot('a', 's1');
  assert.equal(getSnapshot('a', 's1'), null);
  assert.ok(getSnapshot('a', 's2'));
});

test('array (vision) message content is flattened to its text parts', () => {
  clearAllSnapshots();
  const snap = captureMainContext({
    ownerId: 'a', parentSessionId: 's', systemPrompt: '', provider: 'ollama', model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', data: 'xxx' }] }],
  });
  assert.equal(snap.messages[0].content, 'hello');
});
