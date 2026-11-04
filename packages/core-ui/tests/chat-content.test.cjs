// CHAT-CONTENT-01: what a reply can hold: code with its file, commands to run,
// file chips, and the viewer's outline and marked text.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { Markdown, MarkdownActionsContext, commandOf, terminalLine } = require('../src/markdown.tsx');
const { replyFiles, FileChips, MomentsContext } = require('../src/ChatMoments.tsx');
const { outlineOf, markParts } = require('../src/ProjectPanes.tsx');
const { exitOf } = require('../src/ChatView.tsx');
const md = (text, ctx = {}) => renderToStaticMarkup(React.createElement(MarkdownActionsContext.Provider, { value: ctx }, React.createElement(Markdown, { text })));

test('code names its file and language; Open and Code show only where the chat gives them', () => {
  const t = '```ts src/auth.ts\nawait session.save()\n```';
  assert.match(md(t), /<span class="md-code-lang"><span dir="ltr">src\/auth\.ts<\/span> · TypeScript<\/span>/);
  assert.doesNotMatch(md(t), />Open</);
  const opened = md(t, { openFile: () => {}, openInCode: () => {} });
  assert.match(opened, />Open<\/button>/); assert.match(opened, /aria-label="Open in Code"/);
  assert.match(md('```python title="tools/run.py"\nx = 1\n```'), /tools\/run\.py<\/span> · Python/);
  assert.match(md('```js\nx\n```'), /md-code-lang">JavaScript</);
});

test('a shell block is a command to run: Copy, and Run only for the owner', () => {
  assert.equal(commandOf('$ npm test -- login\n✓ 12 passed'), 'npm test -- login');
  assert.equal(commandOf('npm ci\nnpm test'), 'npm ci\nnpm test');
  const t = '```bash\n$ npm test -- login\n```';
  assert.match(md(t, { folderName: 'agent_player' }), /Terminal · in agent_player/);
  assert.doesNotMatch(md(t), /md-run/);
  assert.match(md(t, { runCommand: () => {} }), /class="md-code-btn md-run"[^>]*>Run</);
});

test('file chips: changed beats read; private drafts and waiting calls are left out; a search marks its text', () => {
  const call = (name, input, output, extra = {}) => ({ id: name + input, name, input: JSON.stringify(input), output, running: false, ...extra });
  const parts = [{ kind: 'tools', step: 1, calls: [
    call('read', { path: 'README.md' }, '# Girru'), call('edit', { path: 'README.md', before: 'a', after: 'b' }, 'Updated README.md'),
    call('write', { path: 'report.html', content: 'x' }, 'Wrote report.html in the project folder (18000 bytes).'),
    call('write', { path: 'draft.md', content: 'x' }, 'Saved a private draft "draft.md" (1 bytes) in your own drafts folder.'),
    call('edit', { path: 'wait.md', before: 'a', after: 'b' }, 'Waiting for owner approval: "edit" was NOT run.'),
    call('read', { path: 'docs/invoice.pdf', pattern: 'Total' }, '1 matches'), call('read', { path: '.' }, 'Folder . (3 entries):'),
  ] }];
  const files = replyFiles(parts);
  assert.deepEqual(files.map(f => [f.path, f.status]), [['README.md', 'changed'], ['report.html', 'written'], ['docs/invoice.pdf', 'read']]);
  assert.equal(files[1].detail, '18 KB'); assert.equal(files[2].mark, 'Total');
  const html = renderToStaticMarkup(React.createElement(MomentsContext.Provider, { value: { onOpenFile: () => {} } }, React.createElement(FileChips, { files })));
  assert.match(html, /data-tile="md".*MD.*README\.md.*Changed/s);
  assert.match(html, /data-tile="html".*HTML.*report\.html.*Written · 18 KB/s);
  assert.match(html, /data-tile="pdf".*PDF.*invoice\.pdf.*Read/s);
});

test('viewer: the outline skips code, the quoted text is marked, a command shows its end', () => {
  assert.deepEqual(outlineOf('# Girru\n## Install\n```\n# not a heading\n```\n### Memory').map(h => [h.level, h.title]), [[1, 'Girru'], [2, 'Install'], [3, 'Memory']]);
  assert.deepEqual(markParts('Total: 480 EUR, total paid', 'total'), [{ text: 'Total', hit: true }, { text: ': 480 EUR, ', hit: false }, { text: 'total', hit: true }, { text: ' paid', hit: false }]);
  assert.equal(exitOf('✓ 12 tests passed\nexit code 0'), 'Done · exit 0');
  assert.equal(exitOf('npm ERR!\nExit code: 1', true), 'Failed · exit 1');
  assert.equal(exitOf('ok'), 'Done');
});

test('Run types one clean line only: no newline or control character can run a command before Enter', () => {
  assert.equal(terminalLine('npm test -- login\n'), 'npm test -- login');
  assert.equal(terminalLine('npm ci\nnpm test'), null);
  assert.equal(terminalLine('echo hi\rrm -rf x'), null);
  assert.equal(terminalLine('echo \x1b[201~hi\x03'), 'echo [201~hi');
  assert.equal(terminalLine('   '), null);
});
