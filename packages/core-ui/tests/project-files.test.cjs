require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { projectFilesResponse, projectFilesComparePath, placeSettingPath, taskProblemPath } = require('../src/project-files-contract.js');
const { storeSwitchesResponse } = require('../src/store-switches-contract.js');
const { storeSwitches } = require('../src/store-switches.ts');
const { ProjectFilesController, bridgeProjectFor, groupProjects, placeKeyOf, projectLine, comparable } = require('../src/project-files.ts');
const { MemoryDesktopController } = require('../src/memory-desktop.ts');
const { ProjectFilesView, ProjectFilesInspector, TaskProblems, CompareSheet } = require('../src/MemoryProjectFiles.tsx');
const { plainReasons } = require('../src/memory-review.ts');
const { boardResponse } = require('../src/board-contract.js');
const { TaskWorkedOn, workedWhen } = require('../src/BoardTaskFile.tsx');

const both = (method, path, body) => { const a = allowedRequest(method, path, body), b = allowed(method, path, body); assert.equal(a, b, `${method} ${path} same at both boundaries`); return a; };
function backend(routes) {
  const calls = [];
  return { calls, request: async r => { calls.push(`${r.method} ${r.path}${r.body ? ' ' + JSON.stringify(r.body) : ''}`); const h = routes[`${r.method} ${r.path}`]; const out = typeof h === 'function' ? h(r) : h; return out ?? { status: 404, body: { code: 'not_found' } }; } };
}
const file = (path, state = 'up_to_date', version = 41) => ({ path, what: 'x', version, state });
const proj = (id, name, state, files, extra = {}) => ({ projectId: id, name, folder: `/Users/me/${id}`, writeFiles: true, companyFacts: false, state, needsYou: ['changed_in_both', 'folder_not_found', 'could_not_write'].includes(state), writtenAt: null, version: 41, files, ...extra });

test('P6 routes pass both boundaries only with exact bodies', () => {
  for (const [m, p, b] of [
    ['GET', '/api/memory/project-files'], ['GET', projectFilesComparePath('girru', 'AGENTS.md')], ['GET', projectFilesComparePath('girru', '.girru/brief.md')],
    ['POST', '/api/memory/project-files/girru/rewrite'], ['POST', '/api/memory/project-files/girru/use-girru', { path: 'AGENTS.md' }],
    ['POST', '/api/memory/project-files/girru/undo', { undo: 'pfu_' + 'a'.repeat(48) }], ['PATCH', '/api/memory/project-files/girru', { writeFiles: false }],
    ['PATCH', '/api/memory/project-files/girru', { companyFacts: true }], ['GET', '/api/memory/project-files/needs-you'],
    ['POST', taskProblemPath('a'.repeat(24)), { action: 'new_task' }], ['GET', '/api/memory/place-settings'],
    ['PUT', placeSettingPath('people'), { staysLocal: true }], ['PUT', placeSettingPath('project:flowxtra'), { staysLocal: false }],
  ]) assert.equal(both(m, p, b), true, `${m} ${p}`);
  for (const [m, p, b] of [
    ['GET', '/api/memory/project-files?all=1'], ['GET', '/api/memory/project-files/girru/compare?path=../etc/passwd'], ['GET', '/api/memory/project-files/girru/compare'],
    ['POST', '/api/memory/project-files/girru/rewrite', {}], ['POST', '/api/memory/project-files/girru/use-girru', { path: 'README.md' }],
    ['POST', '/api/memory/project-files/girru/undo', {}], ['PATCH', '/api/memory/project-files/girru', {}], ['PATCH', '/api/memory/project-files/girru', { writeFiles: 'yes' }],
    ['PATCH', '/api/memory/project-files/girru', { folder: '/tmp' }], ['POST', taskProblemPath('x1'), { action: 'delete' }],
    ['PUT', placeSettingPath('agents'), { staysLocal: true }], ['PUT', placeSettingPath('people'), { staysLocal: 1 }], ['DELETE', '/api/memory/project-files/girru'],
  ]) assert.equal(both(m, p, b), false, `${m} ${p} ${JSON.stringify(b)}`);
});

test('responses keep reviewed fields only; refusals keep known codes; P6 off leaves the switches answer unchanged', () => {
  const list = projectFilesResponse('/api/memory/project-files', 200, { projects: [{ ...proj('girru', 'Girru', 'changed_in_both', [{ ...file('AGENTS.md', 'changed_in_both'), secret: 1 }, file('.girru/brief.md', 'odd')]), needsYou: false, token: 'x' }, { projectId: '../x' }] });
  assert.equal(list.projects.length, 1); assert.equal(list.projects[0].needsYou, true, 'needs-you follows the state'); assert.equal(list.projects[0].token, undefined);
  assert.equal(list.projects[0].files[0].secret, undefined); assert.equal(list.projects[0].files[1].state, 'could_not_write');
  assert.deepEqual(projectFilesResponse('/api/memory/project-files', 200, list), list);
  assert.deepEqual(projectFilesResponse('/api/memory/project-files/girru/undo', 409, { code: 'undo_expired', error: 'x' }), { code: 'undo_expired' });
  assert.deepEqual(projectFilesResponse('/api/memory/project-files/girru/use-girru', 409, { code: 'could_not_write' }), { code: 'could_not_write' });
  assert.equal(projectFilesResponse('/api/memory/project-files/girru', 500, { code: 'boom' }), null);
  assert.deepEqual(projectFilesResponse('/api/memory/place-settings', 200, { places: { people: { staysLocal: true }, 'agent:x': { staysLocal: true } } }), { places: { people: { staysLocal: true } } });
  const needs = projectFilesResponse('/api/memory/project-files/needs-you', 200, { items: [{ id: 'a'.repeat(24), kind: 'duplicate_number', projectId: 'girru', projectName: 'Girru', number: 'T-12', titles: ['a', 'b'], line: 4 }, { id: 'b', kind: 'odd', projectId: 'g' }] });
  assert.equal(needs.items.length, 1); assert.equal(needs.items[0].file, '.girru/tasks.md');
  assert.deepEqual(storeSwitchesResponse(200, { p2: true }), { p2: true, p3: false, p4: false });
  assert.deepEqual(storeSwitchesResponse(200, { p6: true }), { p2: false, p3: false, p4: false, p6: true });
});

test('storeSwitches carries p6 only when it is on', async () => {
  assert.equal('p6' in await storeSwitches({ request: async () => ({ status: 200, body: { p2: true } }) }), false);
  assert.equal((await storeSwitches({ request: async () => ({ status: 200, body: { p6: true } }) })).p6, true);
});

test('helpers: grouping, plain lines, the memory project to bridge project, place keys', () => {
  const ps = [proj('a', 'Shop site', 'folder_not_found', []), proj('b', 'Flow app', 'up_to_date', [], { writtenAt: '2026-11-03T10:00:00' }), proj('c', 'Girru', 'changed_in_both', [file('AGENTS.md', 'changed_in_both')])];
  const g = groupProjects(ps); assert.deepEqual(g.needs.map(p => p.projectId), ['a', 'c']); assert.deepEqual(g.rest.map(p => p.projectId), ['b']);
  assert.deepEqual(groupProjects(ps, 'flow').rest.map(p => p.name), ['Flow app']);
  assert.equal(projectLine(ps[0]), 'Folder not found · /Users/me/a');
  assert.equal(projectLine(ps[2]), '1 file changed in the folder and in Girru');
  assert.equal(projectLine(ps[1], Date.parse('2026-11-03T10:02:00Z')), 'Written 2 min ago');
  assert.equal(bridgeProjectFor('b', 'whatever', ps)?.projectId, 'b', 'the same id first (projects by id)');
  assert.equal(bridgeProjectFor('flow-app', 'flow app', ps)?.projectId, 'b', 'else the one project with the same name');
  assert.equal(bridgeProjectFor('x', 'Nope', ps), null);
  assert.equal(placeKeyOf('all'), 'company'); assert.equal(placeKeyOf('project:girru'), 'project:girru'); assert.equal(placeKeyOf('trash'), null);
  assert.equal(comparable('.girru/tasks.md'), false); assert.equal(comparable('AGENTS.md'), true);
  assert.deepEqual(plainReasons(['repository-file', 'important']), ['important'], 'the file label is not a reason');
});

test('controller: load, ⌘R, use Girru’s version with undo, switches, task problems; 404 = not available yet', async () => {
  const girru = proj('girru', 'Girru', 'changed_in_both', [file('AGENTS.md', 'changed_in_both'), file('.girru/tasks.md')]);
  const fixed = { ...girru, state: 'up_to_date', needsYou: false, files: girru.files.map(f => ({ ...f, state: 'up_to_date' })) };
  const b = backend({
    'GET /api/memory/project-files': { status: 200, body: { projects: [girru] } },
    'POST /api/memory/project-files/girru/rewrite': { status: 200, body: { project: girru } },
    'POST /api/memory/project-files/girru/use-girru': { status: 200, body: { project: fixed, undo: 'pfu_1' } },
    'POST /api/memory/project-files/girru/undo': { status: 200, body: { project: girru } },
    'PATCH /api/memory/project-files/girru': r => ({ status: 200, body: { project: { ...girru, ...r.body } } }),
    'GET /api/memory/project-files/needs-you': { status: 200, body: { items: [{ id: 'p1', kind: 'unknown_number', projectId: 'girru', projectName: 'Girru', file: '.girru/tasks.md', number: 'T-88', titles: [], line: 3 }] } },
    'POST /api/memory/project-files/needs-you/p1': { status: 200, body: { ok: true } },
  });
  const c = new ProjectFilesController(b); const d = new MemoryDesktopController(b); const said = []; c.say = t => said.push(t);
  await c.load();
  assert.equal(c.getSnapshot().selected, 'girru'); assert.equal(c.needsCount(), 1);
  await c.rewrite('girru'); assert.match(said.at(-1), /changed in both waits/);
  const { applyGirru } = require('../src/MemoryProjectFiles.tsx');
  await applyGirru(c, d, c.project('girru'), 'AGENTS.md');
  assert.equal(c.needsCount(), 0); assert.equal(d.getSnapshot().undoDepth, 1);
  assert.equal(await d.undo(), true); assert.equal(c.needsCount(), 1, '⌘Z puts the folder’s text back');
  assert.ok(b.calls.includes('POST /api/memory/project-files/girru/undo {"undo":"pfu_1"}'));
  assert.equal(await c.setProject('girru', { companyFacts: true }), true); assert.equal(c.project('girru').companyFacts, true);
  await c.loadProblems(); assert.equal(c.problemCount(), 1);
  await c.solve(c.getSnapshot().problems[0], 'add_task'); assert.equal(c.problemCount(), 0);
  const off = new ProjectFilesController(backend({}));
  await off.load(); assert.equal(off.getSnapshot().phase, 'missing');
  assert.match(renderToStaticMarkup(React.createElement(ProjectFilesView, { c: off, onMenu: () => {} })), /not available yet/);
});

test('views: list groups, inspector rows, compare and task questions', async () => {
  const girru = proj('girru', 'Girru', 'changed_in_both', [file('AGENTS.md', 'changed_in_both'), file('.girru/tasks.md', 'changed_in_both')]);
  const b = backend({
    'GET /api/memory/project-files': { status: 200, body: { projects: [girru, proj('flow', 'Flow app', 'up_to_date', [])] } },
    'GET /api/memory/project-files/needs-you': { status: 200, body: { items: [{ id: 'p1', kind: 'duplicate_number', projectId: 'girru', projectName: 'Girru', file: '.girru/tasks.md', number: 'T-12', titles: ['Fix sign-in', 'Fix sign-in on Windows'], line: 3 }] } },
    'GET /api/memory/project-files/girru/compare?path=AGENTS.md': { status: 200, body: { path: 'AGENTS.md', version: 41, girruText: '- Run the tests', folderText: '+ Never push on Friday' } },
  });
  const c = new ProjectFilesController(b); const d = new MemoryDesktopController(b);
  await c.load();
  const list = renderToStaticMarkup(React.createElement(ProjectFilesView, { c, onMenu: () => {} }));
  assert.match(list, /Needs you[\s\S]*Girru[\s\S]*Up to date[\s\S]*Flow app/); assert.match(list, /Search projects/);
  const insp = renderToStaticMarkup(React.createElement(ProjectFilesInspector, { c, d, project: c.project('girru'), onMenu: () => {} }));
  assert.equal((insp.match(/Compare…/g) ?? []).length, 1, 'no Compare for the task file');
  assert.match(insp, /Use Girru’s version/); assert.match(insp, /Write project files/); assert.match(insp, /Company facts reach coding apps/);
  assert.match(insp, /Text outside Girru’s part is never touched/); assert.doesNotMatch(insp, /Stays on this computer/);
  await c.openCompare('girru', 'AGENTS.md');
  assert.match(renderToStaticMarkup(React.createElement(CompareSheet, { c, d })), /AGENTS.md changed in the folder[\s\S]*Girru \(version 41\)[\s\S]*In the folder now/);
  await c.loadProblems();
  assert.match(renderToStaticMarkup(React.createElement(TaskProblems, { c })), /same number T-12[\s\S]*“Fix sign-in” and “Fix sign-in on Windows”[\s\S]*Make the second one a new task/);
  const empty = new ProjectFilesController(backend({ 'GET /api/memory/project-files': { status: 200, body: { projects: [] } } }));
  await empty.load();
  assert.match(renderToStaticMarkup(React.createElement(ProjectFilesView, { c: empty, onMenu: () => {} })), /No project writes files yet. Turn it on in a project’s details./);
});

test('task page: number and who worked on it only when the backend sends a number', () => {
  const task = { no: 'T-12', projectId: 'girru', projectName: 'Girru', file: '.girru/tasks.md', text: 'x', task: { title: 'Fix sign-in on Windows', state: 'doing', department: '', agent: '', priority: '', done: [], left: [], next: [] },
    workedOn: [{ app: 'Claude Code', agent: 'Sara', date: '2026-11-02', at: null, what: null }, { app: 'Codex', agent: 'Rafid', date: '2026-11-03', at: '14:05', what: null }], log: [] };
  const path = '/api/boards/b1/cards/c1/task';
  const off = boardResponse(path, 200, { task });
  const on = boardResponse(path, 200, { task: { ...task, number: 'T-12' } });
  if (off && on && 'task' in off) {
    assert.equal(off.task.number, undefined); assert.equal(on.task.number, 'T-12');
    const now = new Date(2026, 10, 3, 15);
    assert.equal(renderToStaticMarkup(React.createElement(TaskWorkedOn, { detail: off.task, now })), '');
    const html = renderToStaticMarkup(React.createElement(TaskWorkedOn, { detail: on.task, now }));
    assert.match(html, /T-12[\s\S]*Worked on by <b>Codex \(Rafid\)<\/b> · today 14:05[\s\S]*Earlier: Claude Code \(Sara\) · yesterday/);
  } else assert.fail('the task route parses');
  assert.equal(workedWhen('2026-11-03', '2026-11-03T09:30', new Date(2026, 10, 3, 12)), 'today 09:30');
});
