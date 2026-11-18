// CH1/CH3/CH8c: ⇧⌘Z redoes the last undone file change, ⌥⌘N starts a chat in this project, faces in the title bar, the project name opens Place.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { redoTarget, chatPeople, TitleFaces } = require('../src/ChatMoments.tsx');
const { COMPOSER_KEYS } = require('../src/ChatComposerControls.tsx');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

const reply = (key, extra = {}) => ({ key, role: 'assistant', content: '', parts: [], status: 'complete', ...extra });
const hand = (agent) => ({ kind: 'tools', calls: [{ id: `c-${agent}`, name: 'team_delegate', input: JSON.stringify({ agent_id: agent, request: 'x' }), running: false }] });

test('⇧⌘Z picks the newest reply whose changes are undone; nothing undone means nothing to redo', () => {
  const turns = [{ key: 'u1', role: 'user', content: 'hi', parts: [] }, reply('a1', { changes: { files: 2, undone: true } }), reply('a2', { changes: { files: 1, undone: false } }), reply('a3')];
  const cards = new Map([['a1', { undone: true }], ['a2', { undone: false }]]);
  assert.equal(redoTarget(turns, cards), 'a1');
  cards.set('a2', { undone: true });
  assert.equal(redoTarget(turns, cards), 'a2', 'the newest undone card wins');
  assert.equal(redoTarget(turns, new Map([['a1', { undone: false }], ['a2', { undone: false }]])), null);
  assert.equal(redoTarget(turns, new Map()), null, 'a card not on screen is not redone');
  assert.equal(redoTarget([reply('a9', { changes: { files: 0, undone: true } })], new Map([['a9', { undone: true }]])), null, 'no files, nothing to redo');
});

test('⇧⌘Z is bound in the chat, never while typing, and runs the card’s own Redo (POST …/undo with redo)', () => {
  const view = src('ChatView.tsx'), moments = src('ChatMoments.tsx');
  assert.match(view, /k === 'z' && e\.shiftKey && !e\.altKey && !typing\) \{ const target = redoTarget\(snap\.turns, changeCards\); if \(target\) hit\(\(\) => changeCards\.get\(target\)\?\.redo\(\)\); \}/);
  assert.match(view, /const moments = \{ client, conversationId: s\.activeId, onOpenApprovals, steps, changeCards,/);
  assert.match(moments, /changeCards\.set\(messageId, \{ undone, redo: \(\) => void go\(true\) \}\);/);
  assert.match(moments, /return \(\) => \{ changeCards\.delete\(messageId\); \};/);
  assert.match(moments, /body: redo \? \{ redo: true \} : \{\}/);
  assert.doesNotMatch(view, /k === 'z' && !e\.shiftKey/, '⌘Z stays the system undo');
});

test('⌥⌘N starts a new chat in the open chat’s project, reusing the sidebar’s "New chat here"', () => {
  const view = src('ChatView.tsx');
  assert.match(view, /e\.altKey && !e\.shiftKey && e\.code === 'KeyN'\) \{ e\.preventDefault\(\); const snap = controller\.getSnapshot\(\); controller\.newChatIn\(snap\.conversations\.find\(c => c\.id === snap\.activeId\)\?\.projectId \?\? snap\.projectFilter \?\? ''\);/);
  assert.match(src('conversations.ts'), /newChatIn\(projectId: string\) \{ this\.filterProject\(projectId\); this\.newChat\(\); \}/);
  assert.match(src('ConversationList.tsx'), /label: 'New chat here', icon: 'compose', run: \(\) => \{ controller\.newChatIn\(p\.id\); onOpen\(\); \}/);
  const keys = new Map(COMPOSER_KEYS);
  assert.equal(keys.get('New chat in this project'), '⌥⌘N');
  assert.equal(keys.get('Redo the last undone file change'), '⇧⌘Z');
});

test('the people of a chat: the lead, who wrote replies, who was handed a part — once each, in order', () => {
  const names = { lead: 'Nora', sam: 'Sam', lia: 'Lia', kai: 'Kai' };
  const nameOf = (id) => (id ? names[id] ?? id : 'Main agent');
  const turns = [{ key: 'u', role: 'user', content: 'go', parts: [] }, reply('a1', { parts: [hand('sam'), hand('lia')] }), reply('a2', { agentId: 'kai', parts: [hand('sam')] }), reply('a3')];
  assert.deepEqual(chatPeople(turns, 'lead', nameOf), ['Nora', 'Sam', 'Lia', 'Kai']);
  assert.deepEqual(chatPeople([], null, nameOf), ['Main agent']);
  assert.deepEqual(chatPeople([reply('b', { parts: [{ kind: 'tools', calls: [{ id: 'x', name: 'team_delegate', input: '{bad', running: false }] }] })], 'lead', nameOf), ['Nora'], 'a broken hand-off is skipped');
});

test('title-bar faces: at most three, the tooltip names everyone, a click opens Team', () => {
  const html = renderToStaticMarkup(React.createElement(TitleFaces, { names: ['Nora', 'Sam', 'Lia', 'Kai'], onOpen: () => {} }));
  assert.equal((html.match(/class="composer-face"/g) || []).length, 3);
  assert.match(html, /title="Nora, Sam, Lia, Kai · open Team"/);
  assert.match(html, /aria-label="Team: Nora, Sam, Lia, Kai"/);
  assert.equal(renderToStaticMarkup(React.createElement(TitleFaces, { names: [], onOpen: () => {} })), '');
  const view = src('ChatView.tsx');
  assert.match(view, /\{!phone && pane === null && s\.activeId && s\.turns\.length > 0 && <TitleFaces names=\{chatPeople\(s\.turns, convAgentId, nameOf\)\} onOpen=\{\(\) => openPart\('team'\)\}\/>\}/, 'only with the side panel hidden, and not on the phone (its details are a drawer)');
  assert.ok(view.indexOf('<TitleFaces') < view.indexOf('<ExportMenu'), 'before the tools');
  assert.match(view, /const openPart = \(id: PanelPart\) => \{ setPane\('details'\); setFocusPart\(f => \(\{ id, n: \(f\?\.n \?\? 0\) \+ 1 \}\)\); \};/);
});

test('the muted project name in the title bar opens Details › Place; hover still shows the full path', () => {
  const shell = src('SignedInShell.tsx');
  assert.match(shell, /<button type="button" className="titlebar-project" title=\{activeProject\.folder \?\? activeProject\.name\}[^>]*onClick=\{\(\) => setPlaceRequest\(n => n \+ 1\)\}>/);
  assert.match(shell, /placeRequest=\{placeRequest\}/);
  assert.match(src('ChatView.tsx'), /useEffect\(\(\) => \{ if \(placeRequest > 0\) openPart\('place'\); \}, \[placeRequest\]\);/);
  const css = src('styles.css');
  const tail = css.slice(css.lastIndexOf('/* Keys and faces (2026-10-28) */'));
  assert.ok(css.lastIndexOf('/* Keys and faces (2026-10-28) */') > 0);
  assert.match(tail, /\.titlebar \.titlebar-project \{ all:unset;/);
  assert.match(tail, /\.title-faces \.composer-face/);
});
