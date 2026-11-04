// STORE-MAP-01 P9 (boards P9c, P9d): one person's export and forget, and the
// personal-data / sensitive chips in Needs you — the wire contract at both
// boundaries, the projections (unchanged while the switch is off), the controllers
// and the parts as the boards drew them.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowed, project } = require('../scripts/application-server.cjs');
const { personExportPath, personForgetPath, personPathResponse, privacyOf } = require('../src/memory-people-contract.js');
const { storeSwitchesResponse } = require('../src/store-switches-contract.js');
const { storeSwitches } = require('../src/store-switches.ts');
const { MemoryPeopleController, personName, exportFileName } = require('../src/memory-people.ts');
const { PersonInspector, ExportPersonSheet, ForgetPersonSheet, personMenu } = require('../src/MemoryPeople.tsx');
const { PrivacyChips } = require('../src/MemoryNeeds.tsx');
const { MemoryReviewController, plainReasons, isSensitive } = require('../src/memory-review.ts');
const { placeScope } = require('../src/memory-desktop.ts');

const both = (m, p, b) => { const a = allowedRequest(m, p, b), x = allowed(m, p, b); assert.equal(a, x, `${m} ${p} same at both boundaries`); return a; };
const H64 = 'a'.repeat(64);
const EXPORT = {
  person: 'sam', exportedAt: '2026-11-03T10:00:00.000Z', names: ['sam'], secret: 'x',
  drawer: [{ id: 'm1', drawer: 'people:sam', type: 'fact', status: 'active', content: 'Sam prefers calls in the morning.', createdAt: '2026-10-12T09:00:00Z', validTo: null, token: 'x' },
    { id: 'm2', drawer: 'people:sam', type: 'fact', status: 'replaced', content: 'Sam works at Lumen.', createdAt: '2026-03-02T09:00:00Z', validTo: '2026-03-02T09:00:00Z' }],
  mentions: [{ id: 'm3', drawer: 'project:website', type: 'event', status: 'active', content: 'Meeting with Sam about the invoice on Friday.', createdAt: '2026-10-01T09:00:00Z', validTo: null, why: 'name' },
    { id: 'm4', drawer: 'owner', type: 'fact', status: 'active', content: 'He asked for the new design.', createdAt: '2026-10-02T09:00:00Z', validTo: null, why: 'graph' },
    { id: '../x', drawer: 'owner', content: 'bad', why: 'name' }],
  agentNotes: { count: 2, ids: ['a1', 'a2'] }, graph: [{ id: 'g1', name: 'Sam', aliases: [], links: 3 }],
  handoffs: [{ id: 'h1', agentId: 'omar', scope: 'task:run-1', createdAt: '2026-10-03T09:00:00Z', lines: ['Call Sam back.'] }],
};

test('P9 person routes pass both boundaries only with exact bodies', () => {
  for (const [m, p, b] of [['GET', personExportPath('sam')], ['POST', personForgetPath('sam'), { confirm: 'sam' }], ['POST', personForgetPath('sam'), { confirm: 'sam', mentionIds: ['m3', 'm4'] }],
    ['GET', personExportPath('mona.k')]])
    assert.equal(both(m, p, b), true, `${m} ${p}`);
  for (const [m, p, b] of [['POST', personExportPath('sam'), {}], ['GET', personForgetPath('sam')], ['POST', personForgetPath('sam'), { confirm: 'Sam' }], ['POST', personForgetPath('sam'), {}],
    ['POST', personForgetPath('sam'), { confirm: 'sam', all: true }], ['POST', personForgetPath('sam'), { confirm: 'sam', mentionIds: ['../x'] }], ['POST', personForgetPath('sam'), { confirm: 'sam', mentionIds: 'm3' }],
    ['GET', '/api/memory/people/..%2Fx/export'], ['GET', '/api/memory/people/sam/export?all=1'], ['DELETE', personExportPath('sam')]])
    assert.equal(both(m, p, b), false, `${m} ${p} ${JSON.stringify(b)}`);
});

test('projections keep the reviewed fields; proposals are unchanged without privacy', () => {
  const e = personPathResponse(personExportPath('sam'), 200, EXPORT);
  assert.equal(e.secret, undefined); assert.equal(e.drawer[0].token, undefined); assert.equal(e.mentions.length, 2); assert.equal(e.graph[0].links, 3);
  assert.deepEqual(project(personExportPath('sam'), 200, EXPORT), e, 'the bridge projects it the same way');
  assert.throws(() => personPathResponse(personExportPath('sam'), 200, { ...EXPORT, person: 'lena' }), 'the answer is about the asked person');
  assert.deepEqual(personPathResponse(personForgetPath('sam'), 200, { drawer: 2, mentions: 1, graph: 1, extra: 1 }), { drawer: 2, mentions: 1, graph: 1 });
  assert.deepEqual(personPathResponse(personExportPath('sam'), 404, { code: 'not_found' }), { code: 'not_found' });
  assert.deepEqual(personPathResponse(personForgetPath('sam'), 400, { error: "Type the person's name to confirm" }), { code: 'invalid_request', error: "Type the person's name to confirm" });
  const proposal = { id: 'p1', userId: 'u1', agentId: 'nora', drawerId: 'people:lena', drawer: { kind: 'people', key: 'lena' }, reviewHash: H64, baseHash: H64, baseRevision: 1, status: 'pending', source: 'learning',
    note: null, createdBy: 'nora', createdAt: '2026-11-03T10:00:00.000Z', decidedBy: null, decidedAt: null, appliedRevision: null, reasons: ['special-category'], importBatchId: null, counts: { add: 1, update: 0, delete: 0 } };
  const off = project('/api/memory/proposals?status=pending', 200, { proposals: [proposal] }).proposals[0];
  assert.equal('privacy' in off, false, 'no privacy key while P9 is off');
  const on = project('/api/memory/proposals?status=pending', 200, { proposals: [{ ...proposal, privacy: { personalData: ['email', 'blood-type'], sensitive: ['health', 'health'] } }] }).proposals[0];
  assert.deepEqual(on.privacy, { personalData: ['email'], sensitive: ['health'] }, 'only known kinds, once');
  assert.equal(privacyOf('x'), undefined);
  assert.deepEqual(storeSwitchesResponse(200, { p2: true }), { p2: true, p3: false, p4: false }, 'no p9 key while it is off');
  assert.equal(storeSwitchesResponse(200, { p9: true }).p9, true);
});

test('storeSwitches carries p9 only when it is on; a person is a place of its own', async () => {
  assert.equal('p9' in await storeSwitches({ request: async () => ({ status: 200, body: { p6: true } }) }), false);
  assert.equal((await storeSwitches({ request: async () => ({ status: 200, body: { p9: true } }) })).p9, true);
  assert.equal(placeScope('people:sam'), 'people:sam'); assert.equal(placeScope('people'), 'kind:people');
});

test('the controller reads the export and forgets with the key and the picked mentions', async () => {
  const calls = [];
  const c = new MemoryPeopleController({ request: async r => { calls.push(r); return r.method === 'GET' ? { status: 200, body: personPathResponse(r.path, 200, EXPORT) } : { status: 200, body: { drawer: 2, mentions: 1, graph: 1 } }; } });
  await c.load('sam');
  assert.equal(c.getSnapshot().phase, 'ready'); assert.equal(c.getSnapshot().data.drawer.length, 2);
  await c.load('sam'); assert.equal(calls.length, 1, 'read once');
  const out = await c.forget('sam', ['m3']);
  assert.deepEqual(out, { drawer: 2, mentions: 1, graph: 1 });
  assert.deepEqual(calls[1], { method: 'POST', path: personForgetPath('sam'), body: { confirm: 'sam', mentionIds: ['m3'] } });
  assert.equal(c.getSnapshot().person, null);
  const refused = new MemoryPeopleController({ request: async () => ({ status: 400, body: { code: 'invalid_request', error: 'Some memories do not mention this person' } }) });
  assert.equal(await refused.forget('sam', ['m9']), null);
  assert.match(refused.getSnapshot().notice, /Nothing was forgotten: Some memories do not mention this person/);
  const off = new MemoryPeopleController({ request: async () => ({ status: 404, body: { code: 'not_found' } }) });
  await off.load('sam'); assert.equal(off.getSnapshot().phase, 'error');
});

test('the person parts say it as the board drew it', async () => {
  assert.equal(personName('sam'), 'Sam'); assert.equal(personName('mona-k'), 'Mona-K'); assert.equal(personName('Ahmed2'), 'Ahmed2');
  assert.equal(exportFileName({ person: 'sam', exportedAt: '2026-11-03T10:00:00Z' }), 'person-sam-2026-11-03.json');
  const menu = personMenu('sam', () => {});
  assert.deepEqual(menu.map(m => m.label), ['Export everything about Sam…', 'Forget Sam…']);
  assert.equal(menu[1].danger, true); assert.match(menu[0].shortcut, /E$/);
  const c = new MemoryPeopleController({ request: async r => ({ status: 200, body: personPathResponse(r.path, 200, EXPORT) }) });
  await c.load('sam');
  const insp = renderToStaticMarkup(React.createElement(PersonInspector, { c, personKey: 'sam', staysLocal: true }));
  assert.match(insp, /1 here · 2 elsewhere mention Sam/); assert.match(insp, /On \(People\)/); assert.match(insp, /Replaced facts go after a year/);
  const exp = renderToStaticMarkup(React.createElement(ExportPersonSheet, { c, personKey: 'sam', onClose() {}, onSaved() {} }));
  assert.match(exp, /person-sam-2026-11-03\.json/); assert.match(exp, /Save the file/); assert.match(exp, /nothing is sent/);
  const f = renderToStaticMarkup(React.createElement(ForgetPersonSheet, { c, personKey: 'sam', onClose() {}, onExport() {}, onForgotten() {} }));
  for (const re of [/This cannot be undone/, /Sam’s 2 memories and their history/, /Sam in the memory map/, /Memories elsewhere that mention Sam/, /Meeting with Sam about the invoice/, /names Sam/, /linked to Sam/,
    /Handoff notes that name Sam stay/, /Type Sam to confirm/, /Export first…/, /class="danger-solid" disabled=""[^>]*>Forget Sam/]) assert.match(f, re);
  assert.equal((f.match(/class="primary"/g) ?? []).length, 0, 'the red button is the only filled one');
});

test('P9d: two chips with kinds and topics, never the values; sensitive items start unchecked', async () => {
  const chips = renderToStaticMarkup(React.createElement(PrivacyChips, { reasons: ['personal-data', 'special-category'], privacy: { personalData: ['email', 'phone'], sensitive: ['health'] } }));
  assert.match(chips, /Sensitive · health/); assert.match(chips, /Personal data · e-mail, phone/);
  assert.match(renderToStaticMarkup(React.createElement(PrivacyChips, { reasons: ['personal-data'] })), />Personal data<\/span>/, 'a chip without details when the kinds are not known');
  assert.deepEqual(plainReasons(['people', 'personal-data', 'special-category', 'run-notes']), ['people'], 'shown as chips, not as reasons');
  const item = (id, reasons) => ({ id, userId: 'u1', agentId: 'nora', drawerId: 'people:lena', drawer: { kind: 'people', key: 'lena' }, reviewHash: H64, baseHash: H64, baseRevision: 1, status: 'pending', source: 'learning',
    note: null, createdBy: 'nora', createdAt: '2026-11-03T10:00:00.000Z', decidedBy: null, decidedAt: null, appliedRevision: null, reasons, importBatchId: null, counts: { add: 1, update: 0, delete: 0 } });
  const proposals = [item('p1', ['special-category']), item('p2', ['personal-data']), item('p3', ['important'])];
  const rv = new MemoryReviewController({ request: async r => r.path.startsWith('/api/memory/proposals?') ? { status: 200, body: { proposals } } : { status: 200, body: r.path === '/api/agents' ? { agents: [] } : { links: [] } } });
  await rv.load();
  assert.equal(isSensitive(proposals[0]), true);
  rv.checkAll(true);
  assert.deepEqual([...rv.getSnapshot().checked].sort(), ['p:p2', 'p:p3']);
});
