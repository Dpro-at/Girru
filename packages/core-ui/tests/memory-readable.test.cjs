// MEM-READ-01 MR1: rows carry a title and clean lines; the inspector shows Markdown formatted, lock chips inside.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { MarkdownDocument } = require('../src/DocumentEditor.tsx');
const { KeyText } = require('../src/memory-hidden-keys.tsx');

test('explorer items keep the title and the clean lines through both projections', () => {
  const page = { scope: 'company', items: [{ id: 'm1', type: 'fact', preview: 'project-vps-ssh: VPS …', drawerId: 'owner', topicKey: null, importance: 6, layer: 'factual', createdAt: '2026-11-11T10:00:00.000Z', sourceAgentId: null, source: 'import', title: 'VPS SSH access', lines: 'VPS: Hostinger KVM 2.' }], total: 1, nextCursor: null, facets: {} };
  const path = '/api/memory/scopes/memories?scope=company&limit=50';
  const out = memoryPagesResponse(path, 200, memoryPagesResponse(path, 200, page));
  assert.equal(out.items[0].title, 'VPS SSH access');
  assert.equal(out.items[0].lines, 'VPS: Hostinger KVM 2.');
});

test('Markdown is formatted (no ** marks) and hidden keys are lock chips inside it', () => {
  const md = '# VPS: SSH access\n**Server:** Hostinger KVM 2\n**SSH login:** [SECRET:password:k3j9x0a1bq]\n## Deploy\n- `ssh grenzer-vps`\n- see [the guide](https://example.test/g)';
  const html = renderToStaticMarkup(React.createElement(MarkdownDocument, { text: md, leaf: (t, key) => React.createElement(KeyText, { key, text: t, reveal: async () => null }) }));
  assert.doesNotMatch(html, /\*\*|SECRET:|\]\(/);
  assert.match(html, /<h1[^>]*>VPS: SSH access<\/h1>/);
  assert.match(html, /<strong>Server:<\/strong>/);
  assert.match(html, /dk-key-chip/);
  assert.match(html, /<code>ssh grenzer-vps<\/code>/);
  assert.match(html, /class="doc-link" title="https:\/\/example.test\/g">the guide/);
  // Without a leaf it still renders (the shared editor's preview).
  assert.match(renderToStaticMarkup(React.createElement(MarkdownDocument, { text: 'a **b** c' })), /a <strong>b<\/strong> c/);
});

test('inspector: the title on top, the imported file name and the repeated title gone', () => {
  const { readableBody } = require('../src/MemoryDesktop.tsx');
  assert.deepEqual(readableBody('project-vps-ssh: VPS SSH access — **VPS:** Hostinger\n## Deploy', 'VPS SSH access'), { heading: 'VPS SSH access', body: '**VPS:** Hostinger\n## Deploy' });
  assert.deepEqual(readableBody('# Own heading\ntext', 'Own heading'), { heading: null, body: '# Own heading\ntext' });
  assert.deepEqual(readableBody('Plain fact here.', 'Plain fact here'), { heading: 'Plain fact here', body: '' });
});

test('MR4: the shared editor shows the notice on top, importance in its bottom bar and lock chips in the preview', () => {
  const { DocumentEditor } = require('../src/DocumentEditor.tsx');
  const html = renderToStaticMarkup(React.createElement(DocumentEditor, { title: 'VPS · Edit', note: 'grenzer', files: [{ id: 'm1', name: 'VPS', content: '**SSH login:** [SECRET:password:k3j9x0a1bq]' }], onChange: () => {}, onClose: () => {}, onSave: () => {},
    banner: React.createElement('p', null, 'This memory changed while you were editing.'), footer: React.createElement('label', { className: 'doc-importance' }, 'Importance'),
    leaf: (t, key) => React.createElement(KeyText, { key, text: t }) }));
  assert.match(html, /doc-banner[^>]*><p>This memory changed while you were editing/);
  assert.match(html, /doc-status"><label class="doc-importance">Importance/);
  assert.match(html, /doc-preview[\s\S]*dk-key-chip/);
  assert.match(html, />Save</);
});
