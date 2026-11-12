// MEM-READ-01 MR5: an agent's proposal as changes to accept or discard; the panel in the shared editor.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { lineHunks, applyHunk, hunkLabel } = require('../src/line-diff.ts');
const { allowedRequest } = require('../src/session.ts');
const { DocumentEditor } = require('../src/DocumentEditor.tsx');

const A = '# VPS\n**SSH login:** [SECRET:password:k3j9x0a1bq]\n## Known issues\n- nftables EAGAIN on start\n- Firewall reload after deploy';
const B = '# VPS\n**SSH login:** [SECRET:password:k3j9x0a1bq]\n**SSH port:** 2222\n## Known issues\n- nftables start error and firewall reload — both fixed';

test('changes are found by line and applied one at a time, in any order', () => {
  const h = lineHunks(A, B);
  assert.equal(h.length, 2);
  assert.equal(hunkLabel(h[0]), 'Add “SSH port: 2222”');
  assert.equal(hunkLabel(h[1]), 'Change “nftables EAGAIN on start”');
  const second = applyHunk(A, h[1]);
  assert.ok(second.includes('both fixed') && !second.includes('SSH port'));
  assert.equal(applyHunk(second, h[0]), B);
  assert.equal(applyHunk('something else entirely', h[1]), null, 'a place that changed is reported, not guessed');
  assert.deepEqual(lineHunks(A, A), []);
});

test('the editor offers Ask an agent (⌘J) only where it may write; the route passes the allow-list', () => {
  const props = { title: 'VPS · Edit', files: [{ id: 'm', name: 'VPS', content: A }], onChange: () => {}, onClose: () => {}, onSave: () => {}, ask: { agents: [{ id: 'grenzer-agent', name: 'Grenzer agent' }], run: async () => ({ text: B, note: '' }) } };
  assert.match(renderToStaticMarkup(React.createElement(DocumentEditor, props)), /Ask an agent/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(DocumentEditor, { ...props, files: [{ ...props.files[0], readOnly: true }] })), /Ask an agent/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(DocumentEditor, { ...props, ask: undefined })), /Ask an agent/);
  assert.equal(allowedRequest('POST', '/api/memory/scopes/ask-agent', { agentId: 'grenzer-agent', request: 'Add the port', text: A, drawer: 'project:grenzer' }), true);
  assert.equal(allowedRequest('POST', '/api/memory/scopes/ask-agent', { agentId: 'grenzer-agent', request: 'x', text: A, save: true }), false);
});
