// KNOW-INDEX-01 (board K1): the document-memory wire contract at both
// boundaries, document lines in a reply's trace, the Agent › Files PDF rules,
// and the parts as the board drew them (Settings › Memory › Documents rows,
// the citation chips under a reply).
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowed, project } = require('../scripts/application-server.cjs');
const C = require('../src/doc-index-contract.js');
const R = require('../src/memory-recall-contract.js');
const L = require('../src/agent-library-contract.js');
const { statusLine, citeLabel, PDF_UNREADABLE } = require('../src/doc-index.ts');

const both = (m, p, b) => { const a = allowedRequest(m, p, b), x = allowed(m, p, b); assert.equal(a, x, `${m} ${p} same at both boundaries`); return a; };
const SID = 'a'.repeat(32);

test('document routes: the same allow list at both boundaries', () => {
  assert.equal(both('GET', '/api/memory/documents'), true);
  assert.equal(both('POST', '/api/memory/documents'), false);
  assert.equal(both('PUT', '/api/memory/documents/sources', { kind: 'project', refId: 'p-1', enabled: true }), true);
  assert.equal(both('PUT', '/api/memory/documents/sources', { kind: 'agent', refId: 'a-1', enabled: true }), false);
  assert.equal(both('PUT', '/api/memory/documents/sources', { kind: 'project', refId: 'p-1', enabled: 'yes' }), false);
  assert.equal(both('PUT', '/api/memory/documents/sources', { kind: 'project', refId: 'p-1', enabled: true, extra: 1 }), false);
  assert.equal(both('POST', `/api/memory/documents/sources/${SID}/reindex`), true);
  assert.equal(both('POST', '/api/memory/documents/sources/../reindex'), false);
  assert.equal(both('POST', '/api/memory/documents/read-pdf', { data: 'JVBERi0x' }), true);
  assert.equal(both('POST', '/api/memory/documents/read-pdf', { data: 'not base64!' }), false);
  assert.equal(both('POST', '/api/memory/documents/read-pdf', { data: 'A'.repeat(C.READ_PDF_BASE64 + 1) }), false);
});

test('the documents view passes only what the pane shows', () => {
  const body = {
    projects: [{ id: 'p-1', name: 'Alpha', mine: true, hasFolder: true, secret: 'x',
      source: { id: SID, enabled: true, state: 'ready', files: 3, chunks: 9, unreadable: [{ file: 'docs/scan.pdf', reason: 'no_text' }, { file: 'x.pdf', reason: 'weird' }], limited: false, note: null, scannedAt: '2026-11-04T10:00:00.000Z' },
      folders: [{ path: '/Users/me/alpha', name: 'alpha', main: true, files: 3 }] }],
    agents: { sources: 2, files: 4, unreadable: [], state: 'ready' },
  };
  for (const out of [C.docIndexResponse('/api/memory/documents', 200, body), project('/api/memory/documents', 200, body)]) {
    assert.equal(out.projects[0].secret, undefined);
    assert.equal(out.projects[0].source.unreadable[1].reason, 'unreadable');
    assert.equal(out.projects[0].folders[0].files, 3);
    assert.equal(out.agents.files, 4);
  }
  assert.deepEqual(C.docIndexResponse('/api/memory/documents/read-pdf', 200, { reason: 'encrypted' }), { reason: 'encrypted' });
  assert.deepEqual(C.docIndexResponse('/api/memory/documents', 404, { code: 'not_found' }), { code: 'not_found' });
});

test('a reply trace with a document line keeps its citation; bad ones are dropped', () => {
  const trace = (items) => ({ runId: 'run-0001', messageId: null, agentId: null, createdAt: '2026-11-04 10:00:00', items, context: { keptTurns: 1 }, notLoaded: null });
  const out = R.memoryRecallResponse('/api/memory/recall/runs/run-0001', 200, { trace: trace([
    { kind: 'document', id: 'c'.repeat(32), drawer: 'project:p-1', why: 'document', state: 'active', score: 0.5, preview: 'The relay listens on 41588.', cite: { file: 'docs/spec.pdf', page: 2, heading: null, path: '/Users/me/alpha/docs/spec.pdf' } },
    { kind: 'document', id: 'd'.repeat(32), drawer: 'agent:a-1', why: 'document', state: 'changed', cite: { file: 'knowledge/x.md', page: -1, heading: 'A‮B', path: 'relative/path' } },
  ]) }).trace;
  assert.deepEqual(out.items[0].cite, { file: 'docs/spec.pdf', page: 2, heading: null, path: '/Users/me/alpha/docs/spec.pdf' });
  assert.equal(out.items[0].drawer, 'project:p-1');
  assert.deepEqual(out.items[1].cite, { file: 'knowledge/x.md', page: null, heading: null });
  assert.equal(out.items[1].drawer, 'agent:a-1');
});

test('Agent › Files: PDFs are added as base64, never saved over', () => {
  assert.equal(L.fileName('price list.pdf'), true);
  const p = '/api/agents/agent-1/library/file';
  assert.equal(both('POST', p, { name: 'price list.pdf', content: 'JVBERi0xLjQK', read: false }), true);
  assert.equal(both('POST', p, { name: 'price list.pdf', content: 'not base64 at all!' }), false);
  assert.equal(both('PUT', p, { name: 'price list.pdf', content: 'x', expectedHash: null }), false);
  const view = L.libraryResponse(`${p}?name=a.pdf`, 200, { name: 'a.pdf', kind: 'knowledge', content: '--- page 1 ---\nHi', hash: 'f'.repeat(64), managed: null, redacted: false, read: false, readOnly: true, unreadable: 'no_text' });
  assert.equal(view.readOnly, true);
  assert.equal(view.unreadable, 'no_text');
});

test('plain words: status lines and citations', () => {
  const base = { id: 'p', name: 'Alpha', mine: false, hasFolder: true, folders: [] };
  assert.equal(statusLine({ ...base, source: null }), 'Not read');
  assert.equal(statusLine({ ...base, hasFolder: false, source: null }), 'No folder on this computer');
  assert.equal(statusLine({ ...base, source: { enabled: true, state: 'running', files: 12 } }), 'Reading… 12 files so far');
  assert.equal(statusLine({ ...base, source: { enabled: true, state: 'ready', files: 1, scannedAt: new Date(Date.now() - 4 * 60000).toISOString() } }), 'Up to date · 1 file · read 4 min ago');
  assert.equal(citeLabel({ file: 'docs/spec.pdf', page: 2, heading: null }), 'spec.pdf · p. 2');
  assert.equal(citeLabel({ file: 'docs/spec.pdf', page: 2, heading: null }, false), 'docs/spec.pdf · page 2');
  assert.equal(citeLabel({ file: 'guide.md', page: null, heading: 'Guide › Releases' }), 'guide.md › Releases');
  for (const code of C.PDF_REASONS) assert.ok(PDF_UNREADABLE[code], code);
});

test('the source of a reply shows in its details, not as a chip under the reply', () => {
  const fs = require('node:fs');
  const view = fs.readFileSync(require.resolve('../src/ChatView.tsx'), 'utf8');
  assert.doesNotMatch(view, /DocCites/);
  const { RecallChip } = require('../src/ChatRecall.tsx');
  const items = [{ kind: 'document', id: 'c1', drawer: 'project:p', why: 'document', state: 'active', preview: 'x', cite: { file: 'docs/spec.pdf', page: 2, heading: null } },
    { kind: 'memory', id: 'm1', drawer: 'owner', why: 'meaning', state: 'active', preview: 'z' }];
  const trace = { items, notLoaded: null, context: { drawers: { loaded: [], noAccess: [] } } };
  const c = { subscribe: () => () => {}, getSnapshot: () => ({ open: null }), trace: () => trace, ensure: async () => {}, toggle() {} };
  const html = renderToStaticMarkup(React.createElement(RecallChip, { c, turn: { key: 't', role: 'assistant', runId: 'run-0001' } }));
  assert.match(html, /Used 1 memory · 1 document/);
});
