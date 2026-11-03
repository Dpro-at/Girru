// STORE-MAP-01 P9b (boards P9b-1 to P9b-3) and CODE-OPEN-01 (boards C1–C3):
// the wire contracts at both boundaries, the projections, the trust controller
// (verify / check / forget with Undo) and the parts as the boards drew them.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowed, project } = require('../scripts/application-server.cjs');
const C = require('../src/memory-trust-contract.js');
const { codeOpenResponse } = require('../src/code-open-contract.js');
const { storeSwitchesResponse } = require('../src/store-switches-contract.js');
const { MemoryTrustController } = require('../src/memory-trust.ts');
const { HowSureRows, TrustChip, CorrectedView, QuestionsView } = require('../src/MemoryTrust.tsx');
const { codeOpenNotice, joinPath, openInCode, setCodeHost } = require('../src/code-open.ts');

const both = (m, p, b) => { const a = allowedRequest(m, p, b), x = allowed(m, p, b); assert.equal(a, x, `${m} ${p} same at both boundaries`); return a; };

test('trust routes: the same allow list at both boundaries', () => {
  assert.equal(both('GET', C.trustPath(['m1', 'm2'])), true);
  assert.equal(both('GET', '/api/memory/trust?ids='), false);
  assert.equal(both('GET', '/api/memory/trust?ids=../x'), false);
  assert.equal(both('POST', C.verifyPath('m1')), true);
  assert.equal(both('POST', C.verifyPath('m1', true)), true);
  assert.equal(both('GET', C.verifyPath('m1')), false);
  assert.equal(both('POST', C.correctedPath('m1'), { checked: true }), true);
  assert.equal(both('POST', C.correctedPath('m1'), { checked: 'yes' }), false);
  assert.equal(both('POST', C.correctedPath('m1'), { checked: true, extra: 1 }), false);
  assert.equal(both('POST', C.questionPath('oq-1', 'answer'), { text: 'Wednesday at noon' }), true);
  assert.equal(both('POST', C.questionPath('oq-1', 'answer'), { text: 'x', drawer: 'project:alpha' }), true);
  assert.equal(both('POST', C.questionPath('oq-1', 'answer'), { text: ' ' }), false);
  assert.equal(both('POST', C.questionPath('oq-1', 'answer'), { text: 'x'.repeat(2001) }), false);
  assert.equal(both('POST', C.questionPath('oq-1', 'answer'), { text: 'x', drawer: '../owner' }), false);
  assert.equal(both('POST', C.questionPath('oq-1', 'forget')), true);
  assert.equal(both('POST', C.questionPath('oq-1', 'restore')), true);
  for (const p of [C.TRUST_WAITING_PATH, C.CORRECTED_PATH, C.QUESTIONS_PATH]) assert.equal(both('GET', p), true, p);
  assert.equal(both('POST', '/api/code-open', { path: '/Users/me/alpha/.girru/tasks.md', line: 42 }), true);
  assert.equal(both('POST', '/api/code-open', { path: 'relative.md' }), false);
  assert.equal(both('POST', '/api/code-open', { path: '/a/b', line: 0 }), false);
  assert.equal(both('POST', '/api/code-open', { path: '/a/b', other: 1 }), false);
});

test('projections keep only known fields; p9b only while on', () => {
  const body = { items: [{ id: 'm1', level: 'verified', byOwner: true, heardFrom: [{ kind: 'you' }, { kind: 'agent', agentId: 'nora' }, { kind: 'bad' }], uses: 6, lastUsedAt: '2026-11-03T10:00:00Z', secret: 'x' }, { id: 'm2', level: 'odd' }] };
  const out = C.trustPathResponse(C.trustPath(['m1', 'm2']), 200, body);
  assert.deepEqual(out, { items: [{ id: 'm1', level: 'verified', byOwner: true, heardFrom: [{ kind: 'you' }, { kind: 'agent', agentId: 'nora' }], uses: 6, lastUsedAt: '2026-11-03T10:00:00Z' }] });
  assert.deepEqual(project(C.trustPath(['m1', 'm2']), 200, body), out, 'the bridge projects the same');
  assert.deepEqual(C.trustPathResponse(C.CORRECTED_PATH, 404, {}), { code: 'not_found' });
  assert.equal(storeSwitchesResponse(200, { p2: true, p9b: true }).p9b, true);
  assert.equal('p9b' in storeSwitchesResponse(200, { p2: true }), false, 'unchanged while off');
  assert.deepEqual(codeOpenResponse(403, { code: 'outside', error: 'x' }), { code: 'outside' });
  assert.deepEqual(codeOpenResponse(200, { folder: '/p', file: '.girru/tasks.md', path: '/p/.girru/tasks.md', line: 3, generated: true, where: 'project', project: 'Alpha', extra: 1 }),
    { folder: '/p', file: '.girru/tasks.md', path: '/p/.girru/tasks.md', line: 3, generated: true, where: 'project', project: 'Alpha' });
  assert.throws(() => codeOpenResponse(200, { folder: '/p', file: '../x', path: '/x' }));
});

function fakeClient(routes) {
  const calls = [];
  return { calls, request: async (r) => { calls.push(`${r.method} ${r.path}`); const h = routes[`${r.method} ${r.path}`]; return h ? h(r.body) : { status: 404, body: {} }; } };
}
const sink = () => { const s = { undo: [], said: [], remember(label, run) { s.undo.push({ label, run }); }, say(t) { s.said.push(t); } }; return s; };
const view = (id, level, byOwner = false) => ({ id, level, byOwner, heardFrom: [], uses: 0, lastUsedAt: null });

test('controller: verify, check, forget each offer Undo', async () => {
  const q = { id: 'oq-1', question: 'Which day is the release freeze?', agentId: 'nora', status: 'open', askedAt: new Date().toISOString(), resolvedAt: null, resolvedMemoryId: null, endsAt: new Date(Date.now() + 12 * 86400000).toISOString() };
  let questions = [q];
  const client = fakeClient({
    [`GET ${C.trustPath(['m1'])}`]: () => ({ status: 200, body: { items: [view('m1', 'heard-once')] } }),
    [`POST ${C.verifyPath('m1')}`]: () => ({ status: 200, body: { item: view('m1', 'verified', true) } }),
    [`POST ${C.verifyPath('m1', true)}`]: () => ({ status: 200, body: { item: view('m1', 'heard-once') } }),
    [`GET ${C.CORRECTED_PATH}`]: () => ({ status: 200, body: { items: [{ memoryId: 'c1', nowId: 'c1', drawer: 'project:alpha', was: 'Tuesdays', now: 'Wednesdays', changedAt: null, how: 'edited', checked: false, replyCount: 3, replies: [] }] } }),
    [`POST ${C.correctedPath('c1')}`]: (b) => ({ status: 200, body: { memoryId: 'c1', checked: b.checked } }),
    [`GET ${C.QUESTIONS_PATH}`]: () => ({ status: 200, body: { items: questions } }),
    [`POST ${C.questionPath('oq-1', 'forget')}`]: () => { questions = []; return { status: 200, body: { id: 'oq-1', undo: true } }; },
    [`POST ${C.questionPath('oq-1', 'restore')}`]: () => { questions = [q]; return { status: 200, body: { question: q } }; },
  });
  const s = sink();
  const c = new MemoryTrustController(client, s);
  await c.loadTrust(['m1']);
  await c.loadTrust(['m1']);
  assert.equal(client.calls.filter(x => x.includes('/trust?')).length, 1, 'each id once');
  assert.equal(await c.verify('m1'), true);
  assert.equal(c.getSnapshot().trust.m1.level, 'verified');
  assert.equal(await s.undo.pop().run(), true);
  assert.equal(c.getSnapshot().trust.m1.level, 'heard-once', 'undo');
  c.setView('corrected'); await new Promise(r => setTimeout(r, 0));
  assert.equal(c.getSnapshot().waiting.corrected, 1);
  assert.equal(await c.check('c1'), true);
  assert.equal(c.getSnapshot().waiting.corrected, 0);
  assert.equal(await s.undo.pop().run(), true);
  assert.equal(c.getSnapshot().waiting.corrected, 1);
  c.setView('questions'); await new Promise(r => setTimeout(r, 0));
  assert.equal(await c.forget('oq-1'), true);
  assert.equal(c.getSnapshot().questions.length, 0, 'no confirmation');
  assert.equal(await s.undo.pop().run(), true);
  assert.equal(c.getSnapshot().questions.length, 1, 'back with undo');
});

test('parts: bars and words, never a number; only two chips', () => {
  const h = renderToStaticMarkup(React.createElement('dl', null, React.createElement(HowSureRows, { t: { ...view('m1', 'verified'), heardFrom: [{ kind: 'you' }, { kind: 'agent', agentId: 'nora' }] }, names: { nora: 'Nora' } })));
  assert.match(h, /How sure/); assert.match(h, /High/); assert.match(h, /Verified/); assert.match(h, /you, Nora/);
  assert.doesNotMatch(h, /\d+ ?%|0\.\d/, 'no percentages or scores');
  assert.equal(renderToStaticMarkup(React.createElement(TrustChip, { t: view('m2', 'heard-once') })), '', 'heard once has no chip');
  assert.match(renderToStaticMarkup(React.createElement(TrustChip, { t: view('m3', 'not-checked') })), /Not checked/);
  const c = new MemoryTrustController(fakeClient({}), sink());
  assert.match(renderToStaticMarkup(React.createElement(CorrectedView, { c, names: {} })), /Reading/);
  assert.match(renderToStaticMarkup(React.createElement(QuestionsView, { c, names: {} })), /Reading/);
});

test('openInCode: refused paths open nothing; no runtime falls back', async () => {
  const client = fakeClient({ 'POST /api/code-open': (b) => (b.path.startsWith('/p/') ? { status: 200, body: { folder: '/p', file: 'a.ts', path: b.path, line: b.line ?? null, generated: false, where: 'project', project: 'P' } } : { status: 403, body: { code: 'outside' } }) });
  const opened = [];
  setCodeHost(async (t, o) => { opened.push([t.folder, t.file, t.line, !!o.readOnly]); return true; }, true);
  assert.equal(await openInCode(client, '/etc/hosts'), 'outside');
  assert.equal(codeOpenNotice('outside'), 'This file is outside your projects.');
  assert.equal(opened.length, 0, 'nothing opens');
  assert.equal(await openInCode(client, '/p/a.ts', 7, { readOnly: true }), 'opened');
  assert.deepEqual(opened, [['/p', 'a.ts', 7, true]]);
  setCodeHost(null, false);
  assert.equal(await openInCode(client, '/p/a.ts'), 'no_code', 'no Code runtime and no Finder in a browser');
  assert.equal(joinPath('/p/', '.girru/tasks.md'), '/p/.girru/tasks.md');
  assert.equal(joinPath('C:\\p', '.girru/tasks.md'), 'C:\\p\\.girru\\tasks.md');
});
