// MEM-READ-01 MR3: library folders are never projects. The tree's library projects leave every
// project list and wait under Settings › Memory › Projects › Not projects; "It's a project" brings one back.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allowedRequest } = require('../src/session.ts');
const { memoryPagesRoute, memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { MemoryScopesController } = require('../src/memory-scopes.ts');

const counts = (memories) => ({ memories, pendingReviews: 0, conflicts: 0, pinnedFacts: 0, lastMemoryAt: '2026-11-11T08:00:00.000Z', health: 'ok', reasons: [] });
const p = (slug, name, extra = {}) => ({ slug, name, departmentId: 'general', pinned: false, archived: false, archivedAt: null, mergedInto: null, ...counts(3), ...extra });

function backend() {
  const calls = [];
  let lib = new Set(['bubbletea-v1-3-10', 'ansi-v0-0-0-20230315-abcdef']);
  const tree = () => ({
    generatedAt: '2026-11-12T12:00:00.000Z', cached: false,
    company: { ...counts(9), drawers: { project: 9 }, departments: 1, projects: 3, archivedProjects: 0 },
    departments: [{ id: 'general', name: 'General', isDefault: true, projects: 3, archivedProjects: 0, ...counts(9) }],
    projects: [p('grenzer', 'grenzer', { chatProjectId: 'grenzer' }), ...['bubbletea-v1-3-10', 'ansi-v0-0-0-20230315-abcdef'].map(s => p(s, s, lib.has(s) ? { notProject: true, notProjectReason: 'Go library' } : {}))],
    people: [], agents: { total: 0, withTemplate: 0, withExceptions: 0 },
  });
  const routes = {
    'GET /api/memory/scopes/tree': () => tree(),
    'GET /api/agents': () => ({ agents: [] }),
    'POST /api/memory/scopes/projects/bubbletea-v1-3-10/kind': (_, b) => { const before = lib.has('bubbletea-v1-3-10') ? 'library' : 'project'; if (b.kind === 'project') lib.delete('bubbletea-v1-3-10'); else lib.add('bubbletea-v1-3-10'); return { slug: 'bubbletea-v1-3-10', kind: b.kind, before }; },
  };
  const client = { request: async r => {
    calls.push(r);
    assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path} passes the browser allow-list`);
    const fn = routes[`${r.method} ${r.path.split('?')[0]}`];
    if (!fn) return { status: 404, body: null };
    const out = fn(r.path, r.body);
    const once = x => memoryPagesRoute(r.path) ? memoryPagesResponse(r.path, 200, x) : x;
    return { status: 200, body: once(once(out)) };
  } };
  return { client, calls };
}

test('library projects leave the project list and wait under Not projects', async () => {
  const { client } = backend();
  const c = new MemoryScopesController(client, () => Date.parse('2026-11-12T12:00:00Z'));
  await c.load();
  const t = c.getSnapshot().tree;
  assert.deepEqual(t.projects.map(x => x.slug), ['grenzer']);
  assert.deepEqual(t.notProjects.map(x => [x.slug, x.notProjectReason]), [['bubbletea-v1-3-10', 'Go library'], ['ansi-v0-0-0-20230315-abcdef', 'Go library']]);
  assert.equal(t.projects[0].chatProject, true, 'a chat project is marked (no "Not a project" for it)');
  assert.ok(!('chatProjectId' in t.projects[0]), 'its internal id stays out');
});

test("It's a project brings one back; the reverse undoes it", async () => {
  const { client, calls } = backend();
  const c = new MemoryScopesController(client, () => Date.parse('2026-11-12T12:00:00Z'));
  await c.load();
  assert.equal(await c.setProjectKind('bubbletea-v1-3-10', 'project'), true);
  assert.deepEqual(c.getSnapshot().tree.projects.map(x => x.slug).sort(), ['bubbletea-v1-3-10', 'grenzer']);
  assert.ok(calls.some(r => r.method === 'POST' && r.path === '/api/memory/scopes/projects/bubbletea-v1-3-10/kind' && r.body.kind === 'project'));
  assert.equal(await c.setProjectKind('bubbletea-v1-3-10', 'library'), true);
  assert.equal(c.getSnapshot().tree.notProjects.length, 2);
  assert.equal(allowedRequest('POST', '/api/memory/scopes/projects/x/kind', { kind: 'maybe' }), false, 'only project or library');
});
