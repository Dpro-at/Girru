// MEM-ACC-02: the recall query built from the conversation (src/memory/context/query.ts). Pure; no DB, no model.
// Run: node --import tsx --test test/context-query.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { buildContextQuery } = await import(pathToFileURL(join(process.cwd(), 'src/memory/context/query.ts')).href);
const FALCON = { names: ['Falcon', 'فالكون'] };
const HARBOR = { names: ['Harbor', 'هاربر'] };
const AMIRA = { names: ['Amira Saeed', 'Amira'] };
const entities = [FALCON, HARBOR, AMIRA];

test('the last message names the entity: its other names are added (a question in Arabic finds an English fact)', () => {
  const r = buildContextQuery({ message: 'متى موعد الإطلاق النهائي لفالكون؟', entities, openProject: HARBOR });
  assert.equal(r.source, 'message');
  assert.equal(r.entity, FALCON);
  assert.match(r.query, /Falcon/);
  assert.ok(r.query.startsWith('متى موعد الإطلاق النهائي لفالكون؟'), 'the message stays first');
});

test('no name in the message: the latest mention in the conversation wins (switch and return)', () => {
  const switched = buildContextQuery({ message: 'And when is the deadline?', history: ["Let's look at Falcon first.", 'ok', 'Now about Harbor.'], entities, openProject: FALCON });
  assert.equal(switched.entity, HARBOR);
  assert.equal(switched.source, 'conversation');
  const back = buildContextQuery({ message: 'And when is the deadline?', history: ['Harbor first.', 'Back to Falcon for a moment.'], entities, openProject: HARBOR });
  assert.equal(back.entity, FALCON);
  const sameLine = buildContextQuery({ message: 'deadline?', history: ['First Falcon, now Harbor.'], entities });
  assert.equal(sameLine.entity, HARBOR, 'within one message the later name wins');
});

test('a mention 30 messages back is still found; topic words come from that message only', () => {
  const history = ['We were going through the Falcon server setup and its database yesterday.', ...Array(30).fill('ok thanks')];
  const r = buildContextQuery({ message: 'Why did we change it?', history, entities });
  assert.equal(r.entity, FALCON);
  assert.ok(r.topic.length > 0 && r.topic.length <= 4);
  assert.ok(!r.topic.some((w) => /falcon|thanks/i.test(w)));
  assert.equal(buildContextQuery({ message: 'Why did we change it?', history, entities, topic: false }).topic.length, 0);
});

test('nothing named anywhere: the open project; nothing open: the message unchanged', () => {
  assert.equal(buildContextQuery({ message: 'Which database does the server use now?', entities, openProject: FALCON }).source, 'open-project');
  const none = buildContextQuery({ message: 'hello there', entities });
  assert.equal(none.query, 'hello there');
  assert.equal(none.entity, null);
});

test('a short name or a name inside another word is not a mention', () => {
  const r = buildContextQuery({ message: 'the falconry club meets on Friday', entities: [FALCON, { names: ['Al'] }] });
  assert.equal(r.entity, null);
});

// MEM-CTX-02: topic words come from the owner's own memory of the open drawers.
test('topic words: only words the memory of these drawers uses, and never just one', async () => {
  const { buildContextQuery: build, TOPIC_COMMON_SHARE } = await import(pathToFileURL(join(process.cwd(), 'src/memory/context/query.ts')).href);
  // "database" and "setup" are in this project's memory; "going"/"yesterday" are not; "project" is in all
  // of it. The keys are what lexicalTokens makes of them (it stems: database -> databas), as the index is.
  const df = (t) => ({ databas: 3, setup: 2, project: 10 })[t] ?? 0;
  const memoryWords = { df, live: 10 };
  const history = ['We were going through the Quill project server setup and its database yesterday.', 'ok'];
  const r = build({ message: 'Remind me what happened with that server thing?', history, entities: [{ names: ['Quill', 'كويل'] }], memoryWords });
  assert.deepEqual(r.topic, ['setup', 'database'], 'rarest in this memory first, in the order of the text');
  assert.match(r.query, /\(Quill \/ كويل: setup database\)$/);
  assert.ok(df('project') >= memoryWords.live * TOPIC_COMMON_SHARE, 'a word in half the memories is dropped');
  // One usable word only: nothing is added (the query stays as it was).
  const one = build({ message: 'what happened?', history: ['We talked about the Quill database and nothing else.'], entities: [{ names: ['Quill'] }], memoryWords });
  assert.deepEqual(one.topic, []);
  assert.equal(one.query, 'what happened?\n(Quill)');
});
