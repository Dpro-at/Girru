// AGENT-BTW-01: store + service behaviour on a throwaway SQLite database.
//  - a side question writes only its own tables, never the main chat/run tables
//    or the context snapshot (isolation);
//  - a leftover `running` request becomes `interrupted` on restart, partial kept;
//  - stop cancels a running request and keeps the partial answer;
//  - clear empties the history and forgets the snapshot;
//  - one running request per parent session.
// Model calls are stubbed (injected provider), so no network is used.
// Run: node --import tsx --import ../../scripts/test-temp-root.mjs --test test/side-question-db.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const backendDir = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'ap-side-question-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.NODE_ENV = 'test';

// No real network: fail loudly if the default provider is ever reached.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`)
  .run('owner-1', 'owner@example.test', 'owner');

const snapshot = await import(join(backendDir, 'src/services/side-question/snapshot.ts'));
const store = await import(join(backendDir, 'src/services/side-question/store.ts'));
const service = await import(join(backendDir, 'src/services/side-question/service.ts'));

const q = (sql, ...p) => db.prepare(sql).get(...p);
const makeSnapshot = (sessionId) => snapshot.captureMainContext({
  ownerId: 'owner-1', parentSessionId: sessionId,
  systemPrompt: 'main system prompt', provider: 'ollama', model: 'qwen',
  messages: [{ role: 'user', content: 'do a big task' }, { role: 'assistant', content: 'working on it' }],
});

/** A provider that streams canned deltas and can be made to hang until aborted. */
function stubProvider(parts, opts = {}) {
  return {
    async run(input, onDelta) {
      let text = '';
      for (const p of parts) {
        if (input.signal.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
        text += p; onDelta(text);
      }
      if (opts.hang) {
        await new Promise((resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(input.signal.reason ?? new Error('aborted')), { once: true });
        });
      }
      return { text, provider: 'ollama', model: input.model };
    },
  };
}

// Count rows of a main table only if it exists, so a missing table never
// errors the test (the real transcript table is `chat_messages`, not `messages`).
const countIfExists = (table) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
    ? (q(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0)
    : null;

test('a side question writes only its own tables, not the main transcript', async () => {
  snapshot.clearAllSnapshots();
  makeSnapshot('sess-iso');
  const before = { messages: countIfExists('chat_messages'), runs: countIfExists('chat_runs') };
  const res = await service.askSideQuestion(
    { ownerId: 'owner-1', parentSessionId: 'sess-iso', question: 'why did you pick that approach?', provider: stubProvider(['Because ', 'it is ', 'safer.']), persistEveryMs: 0 },
  );
  assert.equal(res.status, 'done');
  assert.equal(res.answer, 'Because it is safer.');

  // Side tables got exactly one request; the main transcript/run tables are untouched.
  assert.equal(q('SELECT COUNT(*) AS n FROM side_question_requests')?.n, 1);
  if (before.messages !== null) assert.equal(countIfExists('chat_messages'), before.messages, 'no main chat messages written');
  if (before.runs !== null) assert.equal(countIfExists('chat_runs'), before.runs, 'no chat runs written');

  // The snapshot is unchanged by answering off it.
  const snap = snapshot.getSnapshot('owner-1', 'sess-iso');
  assert.equal(snap.systemPrompt, 'main system prompt');
  assert.equal(snap.messages.length, 2);
});

test('P9: local-sourced history is not sent to a cloud request, and no API key goes local', async () => {
  snapshot.clearAllSnapshots();
  // First, a LOCAL snapshot (ollama) produces a local-sourced answer.
  makeSnapshot('sess-p9');
  await service.askSideQuestion(
    { ownerId: 'owner-1', parentSessionId: 'sess-p9', question: 'local q', provider: stubProvider(['LOCAL-SECRET-ANSWER']), persistEveryMs: 0 },
  );
  let s = await store.ensureSession('owner-1', 'sess-p9');
  assert.equal(s.history_local, 1, 'history marked local');

  // Now the main turn switches to a CLOUD provider: a new snapshot with a key.
  snapshot.captureMainContext({
    ownerId: 'owner-1', parentSessionId: 'sess-p9',
    systemPrompt: 'cloud system prompt', provider: 'claude', model: 'claude-x', apiKey: 'test-cloud-key',
    messages: [{ role: 'user', content: 'cloud task' }],
  });
  // Record what the provider actually receives.
  let seen = null;
  const recording = {
    async run(input, onDelta) { seen = input; onDelta('cloud answer'); return { text: 'cloud answer', provider: input.provider, model: input.model }; },
  };
  const res = await service.askSideQuestion(
    { ownerId: 'owner-1', parentSessionId: 'sess-p9', question: 'cloud q', provider: recording, persistEveryMs: 0 },
  );
  assert.equal(res.status, 'done');
  // The local-sourced answer must NOT appear anywhere in the cloud request.
  const payload = JSON.stringify(seen.messages) + seen.system;
  assert.doesNotMatch(payload, /LOCAL-SECRET-ANSWER/, 'local-sourced history excluded from the cloud request');
  // The prior local request was cleared; the session is now cloud-sourced.
  s = await store.ensureSession('owner-1', 'sess-p9');
  assert.equal(s.history_local, 0, 'history now cloud');
  const rows = await store.listRequests(s.id);
  assert.equal(rows.length, 1, 'local history dropped, only the cloud request remains');
  assert.equal(rows[0].source_local, 0);
});

test('no snapshot -> no_snapshot, nothing persisted', async () => {
  snapshot.clearAllSnapshots();
  await assert.rejects(
    () => service.askSideQuestion({ ownerId: 'owner-1', parentSessionId: 'never-captured', question: 'hi', provider: stubProvider(['x']) }),
    (e) => e.code === 'no_snapshot',
  );
});

test('one running request per parent session (busy)', async () => {
  snapshot.clearAllSnapshots();
  makeSnapshot('sess-busy');
  const first = service.askSideQuestion(
    { ownerId: 'owner-1', parentSessionId: 'sess-busy', question: 'q1', provider: stubProvider(['partial '], { hang: true }), persistEveryMs: 0 },
  );
  // Give the first one a tick to register as running.
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(
    () => service.askSideQuestion({ ownerId: 'owner-1', parentSessionId: 'sess-busy', question: 'q2', provider: stubProvider(['y']) }),
    (e) => e.code === 'session_busy',
  );
  assert.equal(await service.stopSideQuestion('owner-1', 'sess-busy'), true);
  const res = await first;
  assert.equal(res.status, 'cancelled');
  assert.equal(res.answer, 'partial ', 'partial answer kept on stop');
});

test('stop keeps the partial answer and marks it cancelled in the database', async () => {
  snapshot.clearAllSnapshots();
  makeSnapshot('sess-stop');
  const run = service.askSideQuestion(
    { ownerId: 'owner-1', parentSessionId: 'sess-stop', question: 'q', provider: stubProvider(['one ', 'two '], { hang: true }), persistEveryMs: 0 },
  );
  await new Promise((r) => setTimeout(r, 20));
  await service.stopSideQuestion('owner-1', 'sess-stop');
  const res = await run;
  assert.equal(res.status, 'cancelled');
  const row = q('SELECT status, answer FROM side_question_requests WHERE id = ?', res.requestId);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.answer, 'one two ');
});

test('restart marks leftover running as interrupted, partial kept', async () => {
  // Simulate a crash: a request stuck in `running` with a partial answer.
  const session = await store.ensureSession('owner-1', 'sess-restart');
  const id = await store.insertRunning({ sideSessionId: session.id, ownerId: 'owner-1', question: 'q', provider: 'ollama', model: 'qwen', sourceLocal: true });
  await store.setAnswer(id, 'half an answer');
  const changed = await store.interruptLeftovers();
  assert.ok(changed >= 1);
  const row = q('SELECT status, answer FROM side_question_requests WHERE id = ?', id);
  assert.equal(row.status, 'interrupted');
  assert.equal(row.answer, 'half an answer', 'partial answer preserved');
});

test('clear empties history and forgets the snapshot', async () => {
  snapshot.clearAllSnapshots();
  makeSnapshot('sess-clear');
  await service.askSideQuestion(
    { ownerId: 'owner-1', parentSessionId: 'sess-clear', question: 'q', provider: stubProvider(['a']), persistEveryMs: 0 },
  );
  const session = await store.ensureSession('owner-1', 'sess-clear');
  assert.ok((await store.listRequests(session.id)).length >= 1);

  const cleared = await store.clearSession('owner-1', 'sess-clear');
  snapshot.clearSnapshot('owner-1', 'sess-clear');
  assert.equal(cleared, true);
  assert.equal((await store.listRequests(session.id)).length, 0);
  assert.equal(snapshot.getSnapshot('owner-1', 'sess-clear'), null);
});

test('rolling summary folds older Q&A beyond the recent window', async () => {
  snapshot.clearAllSnapshots();
  makeSnapshot('sess-roll');
  // 22 completed questions -> 2 oldest fold into the summary (window is 20).
  for (let i = 0; i < 22; i++) {
    await service.askSideQuestion(
      { ownerId: 'owner-1', parentSessionId: 'sess-roll', question: `question ${i}`, provider: stubProvider([`answer ${i}`]), persistEveryMs: 0 },
    );
  }
  const session = await store.ensureSession('owner-1', 'sess-roll');
  assert.equal(session.summarized_through, 2, 'two oldest folded');
  assert.match(session.summary, /question 0/);
  assert.match(session.summary, /question 1/);
  const recent = await store.recentQa(session.id);
  assert.equal(recent.length, 20, 'recent window capped at 20');
});

globalThis.fetch = realFetch;
