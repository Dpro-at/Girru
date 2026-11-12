// MEM-READ-01 MR7: the project panel's size and a reader's level (Read only / Read + write) with Undo.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allowedRequest } = require('../src/session.ts');
const { memoryPagesRoute, memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { MemoryScopesController } = require('../src/memory-scopes.ts');

const H = 'c'.repeat(64);
function backend() {
  const calls = [];
  const routes = {
    'GET /api/memory/scopes/projects/grenzer/size': () => ({ memories: { count: 7, tokens: 3200 }, keyFiles: { count: 6, tokens: 9800 }, documents: { count: 14, tokens: 4600 }, summaries: { count: 0, tokens: 0 }, total: 17600, perReply: 1333, biggest: { name: 'CLAUDE.md', tokens: 4100 }, secret: 'dropped' }),
    'POST /api/memory/access/preview': () => ({ previewHash: H, version: 3, changes: 1, agentsAffected: 1, projectsAffected: 1, noProjectAffected: false, pairsChanged: 1, widened: 1, narrowed: 0, agentsTotal: 3, projectsTotal: 1, sample: [] }),
    'POST /api/memory/access/apply': () => ({ version: 4, preview: { previewHash: H } }),
  };
  return { calls, client: { request: async r => {
    calls.push(r);
    assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path}`);
    const fn = routes[`${r.method} ${r.path.split('?')[0]}`]; if (!fn) return { status: 404, body: null };
    const once = x => memoryPagesRoute(r.path) ? memoryPagesResponse(r.path, 200, x) : x;
    return { status: 200, body: once(once(fn(r.body))) };
  } } };
}

test('size per part passes both projections; extra fields stay out', async () => {
  const { client } = backend();
  const c = new MemoryScopesController(client);
  await c['loadSize'](0, 'grenzer');
  const s = c.getSnapshot().size;
  assert.deepEqual(s.keyFiles, { count: 6, tokens: 9800 });
  assert.equal(s.perReply, 1333); assert.equal(s.secret, undefined);
});

test('Read + write is the same project exception Settings makes; Undo sets it back', async () => {
  const { client, calls } = backend();
  const c = new MemoryScopesController(client);
  c.publish({ usage: [{ agentId: 'devops', name: 'DevOps agent', read: true, write: false, why: 'Engineering department' }] });
  const undo = await c.setReaderWrite('grenzer', 'devops', true);
  assert.ok(undo);
  assert.equal(c.getSnapshot().usage[0].write, true);
  const apply = calls.find(r => r.path === '/api/memory/access/apply');
  assert.deepEqual(apply.body.changes, [{ op: 'set_rule', scope: 'project:grenzer', agentId: 'devops', drawerKind: 'project', write: 'allow' }]);
  assert.equal(apply.body.confirm, true);
  assert.equal(await undo(), true);
  assert.equal(c.getSnapshot().usage[0].write, false);
});
