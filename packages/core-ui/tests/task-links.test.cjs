// STORE-MAP-01 P8 (boards P8a–P8c): T-n as the link hub of a board task — the wire
// contract at both boundaries, the projections (and that nothing changes while the
// switch is off), the controller, the helpers and the parts as the boards drew them.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowed, project } = require('../scripts/application-server.cjs');
const { taskLinksPath, handoffPath, runNotesPath, taskLinksResponse, taskLinksPathResponse, validBlockers } = require('../src/task-links-contract.js');
const { boardResponse } = require('../src/board-contract.js');
const { memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { storeSwitchesResponse } = require('../src/store-switches-contract.js');
const { storeSwitches } = require('../src/store-switches.ts');
const { TaskLinksController, whoWords, handedWords, handoffLine, countLine, linksLine, linksText, runNotesRef, clearsWords, blockerLines } = require('../src/task-links.ts');
const { LatestHandoffCard, LinkedGroup, LinkedList, handoffEvents } = require('../src/BoardTaskLinks.tsx');
const { TaskHandoffMark } = require('../src/BoardTaskFile.tsx');
const { RunWorkingNotes } = require('../src/RunNotes.tsx');
const { MemoryHandoffsController } = require('../src/memory-handoffs.ts');
const { HandoffsView } = require('../src/MemoryHandoffs.tsx');
const { plainReasons, RUN_NOTES } = require('../src/memory-review.ts');

const both = (m, p, b) => { const a = allowedRequest(m, p, b), x = allowed(m, p, b); assert.equal(a, x, `${m} ${p} same at both boundaries`); return a; };
const LINKS = taskLinksPath('b1', 'c1');
const ago = min => new Date(Date.now() - min * 60000).toISOString();
const H = (o) => ({ id: 'h3', agentId: 'omar', agentName: 'Omar', app: 'Codex', fromAgentId: null, fromAgentName: null, at: ago(10), done: ['Found the cause.'], left: ['The installer still writes the old path.'],
  next: ['Change the installer path.'], blockers: ['The Windows test job needs the signing key.'], files: ['packages/desktop/src/sign-in.ts'], questions: [], cardId: 'c1', taskNo: 'T-12', conversationId: 'chat-12345678', conversationTitle: 'Sign-in on Windows', ...o });
const WIRE = { taskNo: 'T-12', notesPlace: { place: 'task:run-1', count: 4 }, blocked: true, secret: 'x',
  handoffs: [{ ...H({}), token: 'x' }, H({ id: 'h2', agentId: 'omar', agentName: 'Omar', app: null, fromAgentId: 'sara', fromAgentName: 'Sara', at: ago(300), blockers: [], files: [], next: ['Find why sign-in fails only on Windows'] }), { id: '../x' }],
  chats: [{ id: 'chat-12345678', title: 'Sign-in on Windows', at: ago(12) }, { id: 'chat-87654321', title: 'Look at the login logs', at: ago(200) }, { id: '../bad' }],
  taskFile: { path: '.girru/tasks.md', line: 14 } };

test('P8 routes pass both boundaries only with exact bodies; the links GET shares the TASKPAGE-02 path', () => {
  for (const [m, p, b] of [['GET', LINKS], ['PUT', LINKS, { waitsFor: 'w1', on: true }], ['PATCH', handoffPath('h3'), { blockers: ['The signing key'] }], ['PATCH', handoffPath('h3'), { blockers: [] }],
    ['GET', runNotesPath('r1', 'chat')], ['GET', runNotesPath('task-run-9', 'task')], ['GET', runNotesPath('d:1', 'delegation')]])
    assert.equal(both(m, p, b), true, `${m} ${p}`);
  for (const [m, p, b] of [['POST', LINKS, {}], ['PATCH', handoffPath('coding-apps'), { blockers: [] }], ['PATCH', handoffPath('h3'), { blockers: ['x'], files: ['y'] }],
    ['PATCH', handoffPath('h3'), { blockers: Array(9).fill('x') }], ['PATCH', handoffPath('h3'), { blockers: ['two\nlines'] }], ['PATCH', handoffPath('h3'), { blockers: ['x'.repeat(301)] }],
    ['PATCH', handoffPath('h3'), { blockers: [' '] }], ['GET', handoffPath('h3')], ['DELETE', handoffPath('h3')], ['GET', '/api/runs/r1/notes'], ['GET', '/api/runs/r1/notes?kind=job'],
    ['GET', '/api/runs/r1/notes?kind=chat&all=1'], ['POST', runNotesPath('r1', 'chat'), {}], ['GET', runNotesPath('../x', 'chat')]])
    assert.equal(both(m, p, b), false, `${m} ${p} ${JSON.stringify(b)}`);
  assert.equal(validBlockers(['ok']), true); assert.equal(validBlockers('ok'), false);
});

test('projections keep the reviewed fields; the old answers are unchanged without P8 fields', () => {
  const l = boardResponse(LINKS, 200, WIRE);
  assert.equal(l.secret, undefined); assert.equal(l.handoffs.length, 2); assert.equal(l.handoffs[0].token, undefined); assert.equal(l.chats.length, 2);
  assert.deepEqual(l.notesPlace, { place: 'task:run-1', count: 4 }); assert.deepEqual(l.taskFile, { path: '.girru/tasks.md', line: 14 });
  assert.deepEqual(boardResponse(LINKS, 200, l), l, 'a second pass changes nothing');
  assert.deepEqual(project(LINKS, 200, WIRE), l, 'the bridge projects it the same way');
  assert.deepEqual(boardResponse(LINKS, 200, { ok: true }), { ok: true }, 'the PUT answer of TASKPAGE-02 is unchanged');
  assert.equal(taskLinksResponse({ ...WIRE, taskFile: { path: '.girru/tasks-done.md' } }).taskFile.path, '.girru/tasks-done.md');
  const card = { id: 'c1', columnId: 'k1', title: 'Fix', priority: 'normal', version: 1, position: 0, agents: [], departments: [] };
  const off = boardResponse('/api/boards/b1/cards/c1', 200, card);
  assert.equal('handoffCount' in off, false); assert.equal('blocked' in off, false);
  assert.equal('handoffCount' in boardResponse('/api/boards/b1/cards/c1', 200, { ...card, handoffCount: 0, blocked: false }), false, 'zero and false say nothing');
  const on = boardResponse('/api/boards/b1/cards/c1', 200, { ...card, handoffCount: 3, blocked: true });
  assert.equal(on.handoffCount, 3); assert.equal(on.blocked, true);
  const plain = { id: 'h1', agentId: 'omar', kind: 'task', scopeId: 'run-1', projectId: null, version: 2, source: 'agent', createdAt: '2026-11-03 10:00:00', done: ['a'], left: [], next: [], questions: [] };
  const hOff = memoryPagesResponse('/api/handoffs', 200, { handoffs: [plain] }).handoffs[0];
  for (const k of ['cardId', 'taskNo', 'boardId', 'blockers', 'files']) assert.equal(k in hOff, false, `${k} absent while P8 is off`);
  const hOn = memoryPagesResponse('/api/handoffs', 200, { handoffs: [{ ...plain, cardId: 'c1', taskNo: 'T-12', boardId: 'b1', blockers: ['key'], files: ['a.ts'] }] }).handoffs[0];
  assert.deepEqual([hOn.cardId, hOn.taskNo, hOn.boardId, hOn.blockers, hOn.files], ['c1', 'T-12', 'b1', ['key'], ['a.ts']]);
  assert.deepEqual(taskLinksPathResponse(runNotesPath('r1', 'chat'), 200, { notes: [{ seq: 1, text: 'The path is built in sign-in.ts:88', at: '2026-11-03T12:02:00Z', x: 1 }, { seq: 'b' }], clearsAt: '2026-11-17T12:14:00Z' }),
    { notes: [{ seq: 1, text: 'The path is built in sign-in.ts:88', at: '2026-11-03T12:02:00Z' }], clearsAt: '2026-11-17T12:14:00Z' });
  assert.deepEqual(taskLinksPathResponse(handoffPath('h3'), 404, { code: 'not_found', error: 'x' }), { code: 'not_found' });
  assert.deepEqual(storeSwitchesResponse(200, { p2: true, p6: true }), { p2: true, p3: false, p4: false, p6: true }, 'no p8 key while it is off');
  assert.equal(storeSwitchesResponse(200, { p8: true }).p8, true);
});

test('storeSwitches carries p8 only when it is on', async () => {
  assert.equal('p8' in await storeSwitches({ request: async () => ({ status: 200, body: { p6: true } }) }), false);
  assert.equal((await storeSwitches({ request: async () => ({ status: 200, body: { p8: true } }) })).p8, true);
});

test('helpers say it in plain words', () => {
  const l = taskLinksResponse(WIRE);
  assert.equal(whoWords(l.handoffs[0]), 'Omar through Codex');
  assert.equal(whoWords({ agentName: 'Omar', app: null }), 'Omar', 'Girru’s own model shows only the agent');
  assert.equal(whoWords({ agentName: 'Omar', app: 'Girru' }), 'Omar');
  assert.equal(handedWords(l.handoffs[1]), 'Sara handed this to Omar');
  assert.equal(handedWords(l.handoffs[0]), null);
  assert.equal(handoffLine(l.handoffs[1]), 'Next: Find why sign-in fails only on Windows');
  assert.equal(countLine(3, ago(10)), '3 · newest 10 min ago'); assert.equal(countLine(0), 'None yet');
  assert.equal(linksLine(l), 'T-12 · 2 handoffs · 2 chats');
  assert.match(linksText(l, 'Fix sign-in on Windows'), /^T-12 Fix sign-in on Windows\nTask notes: 4\nLatest handoff: Omar through Codex · Blocked: The Windows test job/);
  assert.deepEqual(runNotesRef({ id: 'chat:r1' }), { id: 'r1', kind: 'chat' });
  assert.deepEqual(runNotesRef({ id: 'handoff:d1' }), { id: 'd1', kind: 'delegation' });
  assert.equal(runNotesRef({ id: 'job:backup' }), null);
  assert.equal(clearsWords(new Date(Date.now() + 14 * 86400000 - 1000).toISOString()), 'cleared in 14 days');
  assert.equal(clearsWords(null), 'cleared 14 days after the run ends');
  assert.deepEqual(blockerLines(' a \n\n b  c \n'), ['a', 'b c']);
  assert.deepEqual(plainReasons([RUN_NOTES, 'important']), ['important'], 'the run label is not a reason');
});

function backend(routes) {
  const calls = [];
  return { calls, request: async r => {
    assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path}`);
    calls.push(`${r.method} ${r.path}${r.body ? ' ' + JSON.stringify(r.body) : ''}`);
    const h = routes[`${r.method} ${r.path}`]; const out = typeof h === 'function' ? h(r) : h;
    if (!out) return { status: 404, body: { code: 'not_found' } };
    return { status: out.status, body: r.path === LINKS ? boardResponse(r.path, out.status, out.body) : taskLinksPathResponse(r.path, out.status, out.body) };
  } };
}

test('controller: reads the links, 404 = not available yet, blockers saved in place and Blocked follows the newest', async () => {
  const off = new TaskLinksController(backend({}));
  await off.load('b1', 'c1');
  assert.equal(off.getSnapshot().phase, 'missing');
  const api = backend({ [`GET ${LINKS}`]: { status: 200, body: WIRE }, [`PATCH ${handoffPath('h3')}`]: r => ({ status: 200, body: { handoff: H({ blockers: r.body.blockers }) } }) });
  const c = new TaskLinksController(api);
  await c.load('b1', 'c1');
  assert.equal(c.getSnapshot().phase, 'ready'); assert.equal(c.getSnapshot().links.blocked, true);
  assert.equal(await c.saveBlockers('h3', '\n'), true);
  assert.ok(api.calls.includes(`PATCH ${handoffPath('h3')} {"blockers":[]}`));
  assert.equal(c.getSnapshot().links.blocked, false, 'no blockers on the newest: the card is no longer Blocked');
  assert.equal(c.getSnapshot().saved, 'Blockers cleared.');
  const missing = new TaskLinksController(backend({ [`GET ${LINKS}`]: { status: 200, body: WIRE } }));
  await missing.load('b1', 'c1');
  assert.equal(await missing.saveBlockers('h3', 'x'), false);
  assert.equal(missing.getSnapshot().notice, 'Editing blockers is not available yet.');
});

test('page parts: Linked to T-12, the Latest handoff with the hand-over folded, Activity events, the card mark', async () => {
  const api = backend({ [`GET ${LINKS}`]: { status: 200, body: WIRE } });
  const c = new TaskLinksController(api); await c.load('b1', 'c1');
  const links = c.getSnapshot().links;
  const mark = { no: 'T-12', projectId: 'p1', projectName: 'Girru', problem: null, apps: ['Codex'], finished: false };
  const side = renderToStaticMarkup(React.createElement(LinkedGroup, { links, mark, title: 'Fix sign-in on Windows', onOpenMemory: () => {}, onOpenChat: () => {}, onShowFile: () => {}, onShowHandoff: () => {} }));
  for (const w of ['Linked to <span class="task-number">T-12</span>', 'Task notes', '4 things agents remember', 'Open in Memory › Tasks › T-12', 'Handoffs', '2 · newest 10 min ago', '>Blocked<', 'Chats', 'Sign-in on Windows', 'Look at the login logs', 'Task file', 'tasks.md:14 · up to date', 'Copy the links of T-12'])
    assert.ok(side.includes(w), w);
  const list = renderToStaticMarkup(React.createElement(LinkedList, { links, onClose: () => {}, onShowHandoff: () => {} }));
  for (const w of ['Linked to T-12 · arrows move, Enter opens, Esc closes', 'Memory › Tasks › T-12', 'Latest handoff', 'Omar through Codex', '.girru/tasks.md']) assert.ok(list.includes(w), w);
  const mid = renderToStaticMarkup(React.createElement(LatestHandoffCard, { c, links, detail: null, onOpenChat: () => {}, onOpenMemory: () => {} }));
  for (const w of ['Latest handoff', '<b>Omar</b> through', 'Codex', '10 min ago', 'from the chat', 'Sign-in on Windows', 'Done', 'Found the cause.', 'Left', 'Next', 'Blockers', 'The Windows test job needs the signing key.',
    'Edit the blockers', 'Files touched', 'packages/desktop/src/sign-in.ts', '1 older handoff', 'All handoffs of T-12 in Memory › Handoffs', 'More: copy, open in Memory to edit'])
    assert.ok(mid.includes(w), w);
  const none = renderToStaticMarkup(React.createElement(LatestHandoffCard, { c, links: { ...links, handoffs: [] }, detail: null }));
  assert.ok(none.includes('No handoff yet. Agents write one when they stop.'));
  const ev = renderToStaticMarkup(React.createElement(React.Fragment, null, ...handoffEvents(links).map(e => e.node)));
  assert.ok(ev.includes('<b>Omar</b> wrote a handoff')); assert.ok(ev.includes('<b>Sara</b> handed this to <b>Omar</b>'));
  assert.equal(renderToStaticMarkup(React.createElement(TaskHandoffMark, {})), '', 'nothing on the card without handoffs (P8 off)');
  const m = renderToStaticMarkup(React.createElement(TaskHandoffMark, { count: 3, blocked: true }));
  assert.ok(m.includes('3 handoffs') && m.includes('Blocked'));
  for (const html of [side, list, mid]) assert.doesNotMatch(html, /drawer|scratch|hash/i, 'plain words');
});

test('run working notes: read only, cleared after 14 days (first paint while reading)', () => {
  const html = renderToStaticMarkup(React.createElement(RunWorkingNotes, { client: { request: async () => ({ status: 404 }) }, at: { id: 'r1', kind: 'chat' }, live: true, onCopy: () => {} }));
  assert.ok(html.includes('Working notes')); assert.ok(html.includes('Reading the working notes'));
});

test('Memory › Handoffs: T-12 on task rows, “Open the task T-12”, Blockers editable in place, Files touched read only; unchanged without P8 fields', async () => {
  const calls = [];
  const P8 = { cardId: 'c1', taskNo: 'T-12', boardId: 'b1', blockers: ['The signing key'], files: ['sign-in.ts'] };
  const row = (extra) => ({ id: 'h3', agentId: 'omar', kind: 'task', scopeId: 'run-1', projectId: null, version: 3, source: 'agent', createdAt: '2026-11-03 10:00:00', done: ['a'], left: ['b'], next: [], questions: [], title: 'Fix sign-in on Windows', ...extra });
  const client = (extra) => ({ request: async r => {
    assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path}`); calls.push(`${r.method} ${r.path}${r.body ? ' ' + JSON.stringify(r.body) : ''}`);
    const path = r.path.split('?')[0], f = b => memoryPagesResponse(r.path, 200, b);
    if (path === '/api/handoffs') return { status: 200, body: f({ handoffs: [row(extra)] }) };
    if (path === '/api/handoffs/coding-apps') return { status: 200, body: f({ handoffs: [] }) };
    if (path === '/api/handoffs/task/run-1') return { status: 200, body: f({ handoff: row(extra), history: [row(extra)] }) };
    if (r.method === 'PATCH') return { status: 200, body: taskLinksPathResponse(r.path, 200, { handoff: H({ blockers: r.body.blockers }) }) };
    if (path === '/api/agents') return { status: 200, body: { agents: [{ id: 'omar', name: 'Omar' }] } };
    return { status: 200, body: { projects: [] } };
  } });
  const on = new MemoryHandoffsController(client(P8)); await on.load();
  const html = renderToStaticMarkup(React.createElement(HandoffsView, { c: on, onOpenChat: () => {}, onOpenCard: () => {} }));
  for (const w of ['<span class="task-number">T-12</span>', 'Open the task T-12', 'Blockers', 'The signing key', 'Files touched', '(listed by the agent, read only)', 'sign-in.ts', 'Save as version 4']) assert.ok(html.includes(w), w);
  on.edit({ blockers: '' });
  assert.equal(on.changed(), true); assert.equal(on.textChanged(), false);
  await on.save();
  assert.ok(calls.includes('PATCH /api/handoffs/h3 {"blockers":[]}'), 'blockers alone are edited in place');
  assert.ok(!calls.some(c => c.startsWith('PUT ')), 'no new version for blockers alone');
  const off = new MemoryHandoffsController(client({})); await off.load();
  const plain = renderToStaticMarkup(React.createElement(HandoffsView, { c: off, onOpenChat: () => {}, onOpenCard: () => {} }));
  for (const w of ['Open the task', 'Blockers', 'Files touched', 'task-number']) assert.equal(plain.includes(w), false, `${w} absent while P8 is off`);
});

test('P8 off: the task page and the board card are as today (no Linked group, no Latest handoff, Chats stay in Work)', async () => {
  const { SessionClient } = require('../src/session.ts');
  const { createLoginMock } = require('../src/session-mock.ts');
  const { BoardController } = require('../src/board.ts');
  const { TaskBoard } = require('../src/TaskBoard.tsx');
  const base = createLoginMock(), calls = [];
  const PAGE = { openedBy: { kind: 'user', id: 'u1', name: 'Mohamed' }, openedAt: '2026-10-27T10:00:00.000Z', people: [], team: [], parent: null, subtasks: [], waitsFor: [], blocks: [], release: null, following: false, followers: 0,
    chats: [{ id: 'chat-12345678', title: 'Sign-in bug' }], spent: [], files: { count: 0, added: 0, removed: 0, paths: [] }, development: null };
  const client = new SessionClient({ mock: async r => {
    calls.push(r.path);
    if (/\/cards\/[^/]+\/page$/.test(r.path)) return { status: 200, body: { page: PAGE } };
    if (/\/cards\/[^/]+\/activity/.test(r.path)) return { status: 200, body: { items: [], more: false } };
    return base(r);
  } });
  client.selectMode('mock'); await client.login('demo@example.invalid', 'mock-only');
  const b = new BoardController(client);
  await b.load(); await b.addCard(b.getSnapshot().columns[0].id, 'Fix the sign-in timeout');
  await b.openCard(b.getSnapshot().cards[0].id);
  for (let i = 0; i < 40 && b.getSnapshot().page?.phase !== 'ready'; i++) await new Promise(r => setTimeout(r, 5));
  const html = renderToStaticMarkup(React.createElement(TaskBoard, { controller: b, onOpenChat: () => {}, onOpenMemory: () => {} }));
  for (const w of ['Linked to', 'Latest handoff', 'Starts from the latest handoff', 'Not available yet', 'tp-hub']) assert.equal(html.includes(w), false, `${w} absent while P8 is off`);
  assert.ok(html.includes('aria-label="Work"') && html.includes('>Chats<'), 'Chats stay in Work');
  assert.ok(!calls.some(p => /\/links$/.test(p)), 'the links are never asked for while P8 is off');
  b.dispose();
});
