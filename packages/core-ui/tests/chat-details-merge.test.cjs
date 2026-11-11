require('./load.cjs');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('../../backend/node_modules/jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'http://localhost/'});
Object.assign(globalThis, {window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true});
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: dom.window.navigator});
const React = require('../node_modules/react');
const {act} = React;
const {createRoot} = require('../node_modules/react-dom/client');
const {ChatDetails} = require('../src/ChatDetails.tsx');

test('merged panel keeps granted connections, sub-sessions and exact file targets while refreshing paused schedules', async t => {
  const schedule = {every: 'daily', at: '09:00', weekday: null, message: 'Check', paused: false, nextRun: '2026-11-07T09:00:00Z'};
  const calls = [], opened = [];
  const state = {activeId: 'chat', agentId: 'lead', conversations: [{id: 'chat', agentId: 'lead'}, {id: 'child', parentId: 'chat', title: 'Child run', agentId: 'lead'}],
    agents: [{id: 'lead', name: 'Lead'}], models: [], model: 'auto', runId: null, git: {files: 1, added: 1, removed: 0, branch: 'main'},
    turns: [{key: 'reply', role: 'assistant', status: 'complete', content: '', changes: {files: 1}, parts: [{kind: 'tools', calls: [{id: 'write1', name: 'write', input: JSON.stringify({path: 'src/Example.ts', content: 'example'}), output: 'Written', running: false}]}]}]};
  const controller = {subscribe: () => () => {}, getSnapshot: () => state, activeProject: () => ({id: 'project', folder: '/fictional/project', folders: []}), open: id => opened.push(['chat', id])};
  const client = {getSnapshot: () => ({user: {role: 'owner'}}), request: async r => {
    calls.push(r);
    if (r.path.endsWith('/schedule')) {if (r.method === 'PUT') Object.assign(schedule, r.body); return {status: 200, body: {schedule: {...schedule}}};}
    if (r.path === '/api/mcp/servers') return {status: 200, body: {servers: [{id: 'ok', name: 'Allowed', enabled: true, description: 'Permitted'}, {id: 'hidden', name: 'Forbidden', enabled: true}]}};
    if (r.path.endsWith('/tool-grants')) return {status: 200, body: {grants: [{tool: 'mcp__Allowed__read'}]}};
    if (r.path.endsWith('/usage')) return {status: 200, body: {usage: []}};
    if (r.path.endsWith('/team')) return {status: 200, body: {team: [], apps: []}};
    return {status: 200, body: {}};
  }};
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  t.after(async () => {await act(async () => root.unmount()); container.remove(); dom.window.close();});
  await act(async () => {root.render(React.createElement(ChatDetails, {controller, client, onOpenPane: (...args) => opened.push(args), onClose() {}, onStop() {}, onSchedule() {}, onAddFolder() {}}));});
  assert.match(container.textContent, /Allowed/); assert.doesNotMatch(container.textContent, /Forbidden/);
  assert.match(container.textContent, /Child run/);
  const file = [...container.querySelectorAll('[data-part="results"] button')].find(b => b.textContent.includes('Example.ts'));
  assert.ok(file); await act(async () => file.click()); assert.deepEqual(opened.at(-1), ['files', 'src/Example.ts']);
  const pause = [...container.querySelectorAll('button')].find(b => b.textContent === 'Pause'); assert.ok(pause);
  await act(async () => pause.click());
  assert.ok([...container.querySelectorAll('button')].some(b => b.textContent === 'Resume'));
  assert.equal(calls.find(r => r.method === 'PUT' && r.path.endsWith('/schedule')).body.paused, true);
  assert.doesNotMatch(container.textContent, /Forbidden/);
});
