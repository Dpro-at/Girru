// REPO-TRUST-01 (board R1): the outside-projects wire contract at both boundaries, the store's
// Trust it / Put on Outside projects with Undo, and the tag as the board drew it.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowed, project } = require('../scripts/application-server.cjs');
const C = require('../src/project-trust-contract.js');
const { OutsideProjects, OutsideTag, verdictWhy } = require('../src/outside-projects.tsx');

const both = (m, p, b) => { const a = allowedRequest(m, p, b), x = allowed(m, p, b); assert.equal(a, x, `${m} ${p} same at both boundaries`); return a; };

test('outside-project routes: the same allow list at both boundaries', () => {
  assert.equal(both('GET', '/api/memory/project-trust'), true);
  assert.equal(both('PUT', '/api/memory/project-trust/projects/p-1', { outside: false }), true);
  assert.equal(both('PUT', '/api/memory/project-trust/projects/p-1', { outside: 'no' }), false);
  assert.equal(both('PUT', '/api/memory/project-trust/projects/..%2Fx', { outside: true }), false);
  assert.equal(both('DELETE', '/api/memory/project-trust/projects/p-1'), true);
  assert.equal(both('POST', '/api/memory/project-trust/owners', { name: 'my-org', host: 'github.com' }), true);
  assert.equal(both('POST', '/api/memory/project-trust/owners', { name: '../x' }), false);
  assert.equal(both('DELETE', '/api/memory/project-trust/owners', { name: 'group/sub', host: 'gitlab.com' }), true);
});

test('the view passes only ids, names, verdicts and accounts', () => {
  const body = { projects: [{ projectId: 'p-1', name: 'tool', outside: true, source: 'auto', remote: { host: 'github.com', owner: 'someone' }, folder: '/secret' }, { projectId: '../bad' }],
    owners: [{ name: '9mtm', host: 'github.com', builtIn: true }, { name: '../x', host: '' }] };
  for (const out of [C.projectTrustResponse('/api/memory/project-trust', 200, body), project('/api/memory/project-trust', 200, body)]) {
    assert.equal(out.projects.length, 1);
    assert.equal(out.projects[0].folder, undefined);
    assert.deepEqual(out.owners, [{ name: '9mtm', host: 'github.com', builtIn: true }]);
  }
});

test('Trust it and Put on Outside projects, each with Undo back to how it was', async () => {
  const calls = [];
  let view = { projects: [{ projectId: 'p-1', name: 'tool', outside: true, source: 'auto', remote: { host: 'github.com', owner: 'someone' } }], owners: [] };
  const client = { request: async (r) => {
    calls.push(`${r.method} ${r.path}${r.body ? ' ' + JSON.stringify(r.body) : ''}`);
    if (r.method === 'GET') return { status: 200, body: view };
    if (r.method === 'PUT') { view = { ...view, projects: [{ ...view.projects[0], outside: r.body.outside, source: 'owner' }] }; return { status: 200, body: { project: view.projects[0] } }; }
    if (r.method === 'DELETE') { view = { ...view, projects: [{ ...view.projects[0], outside: true, source: 'auto' }] }; return { status: 200, body: {} }; }
    return { status: 404, body: {} };
  } };
  const s = new OutsideProjects(client);
  await s.load();
  assert.equal(s.isOutside('p-1'), true);
  assert.equal(verdictWhy(s.verdict('p-1')), 'github.com/someone · found by Girru');
  const undo = await s.set('p-1', false);
  assert.equal(s.isOutside('p-1'), false);
  await undo();
  assert.equal(s.isOutside('p-1'), true);
  assert.ok(calls.includes('DELETE /api/memory/project-trust/projects/p-1'), 'an automatic verdict comes back as automatic');
  const html = renderToStaticMarkup(React.createElement(OutsideTag, { store: s, projectId: 'p-1' }));
  assert.match(html, /class="outside-tag"[^>]*>outside</);
  assert.equal(renderToStaticMarkup(React.createElement(OutsideTag, { store: s, projectId: 'other' })), '');
});
