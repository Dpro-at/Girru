// CHAT-GAPS-01: small text is readable, sign-in opens the last chat, first run without a model, the folder stays fixed.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { conversationResponse } = require('../src/conversation-contract.js');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
const lum = (c) => { const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const mix = (fg, bg, p) => fg.map((v, i) => v * p + bg[i] * (1 - p));

test('small text keeps 4.5:1 on the canvas and the sidebar, in light and dark', () => {
  const css = src('styles.css');
  const pct = (block, name) => Number(new RegExp(`--${name}:color-mix\\(in srgb,var\\(--text\\) (\\d+)%`).exec(block)[1]) / 100;
  const light = css.slice(css.indexOf('.app-shell { grid-template-columns'), css.indexOf('--ease-arrive'));
  const dark = css.slice(css.indexOf('.shell[data-theme="dark"] .app-shell, .app-shell[data-theme="dark"] { --text-2'));
  for (const [block, text, bgs, needs] of [[light, '#252528', ['#F8F9FE', '#F3F7FF', '#FDFDFD'], '#A15C00'], [dark, '#D9E0E6', ['#0D1015', '#010409', '#0E0F12'], '#E0A040']]) {
    for (const bg of bgs) {
      for (const name of ['text-2', 'text-3', 'text-4']) assert.ok(ratio(mix(hex(text), hex(bg), pct(block, name)), hex(bg)) >= 4.5, `${name} on ${bg}`);
      assert.ok(ratio(hex(needs), hex(bg)) >= 4.5, `needs amber on ${bg}`);
    }
    assert.match(block, new RegExp(`--needs:${needs}`));
  }
  assert.doesNotMatch(css, /\{ color:#E0A040/, 'amber text uses the readable token');
});

test('sign-in opens the chat that was open (kept on the server, not in the browser); a new chat forgets it', () => {
  const { allowedConversation: allow, conversationResponse: res } = require('../src/conversation-contract.js');
  const ID = '9a8b7c6d-1d2a-4f4e-9b1a-6c7d8e9f0a1b';
  assert.equal(allow('GET', '/api/chat/last', undefined), true);
  for (const body of [{ last: ID }, { last: null }]) assert.equal(allow('PUT', '/api/chat/last', body), true);
  for (const body of [{}, { last: '../x' }, { last: ID, other: 1 }, { last: 5 }]) assert.equal(allow('PUT', '/api/chat/last', body), false, JSON.stringify(body));
  assert.deepEqual(res('/api/chat/last', 200, { last: ID }), { last: ID });
  assert.deepEqual(res('/api/chat/last', 200, { last: '<script>' }), { last: null });
  const ctl = src('conversations.ts');
  assert.match(ctl, /this\.rememberLast\(id\);/, 'opening a chat remembers it');
  assert.match(ctl, /this\.rememberLast\(null\);/, 'a new chat forgets it');
  assert.match(ctl, /!this\.#state\.activeId && this\.#state\.conversations\.some\(c => c\.id === id\)/, 'only a chat that still exists, and only when nothing else was opened');
  assert.match(src('SignedInShell.tsx'), /if \(!linked\) \{ void c\.restoreLast\(\); return; \}/);
});

test('first run without a model: one card that leads to Models and replies', () => {
  const view = src('ChatView.tsx');
  assert.match(view, /s\.modelsLoaded && s\.models\.length === 0 && onSetUpModel/);
  assert.match(view, /Your team needs a model to think with/);
  assert.match(src('SignedInShell.tsx'), /onSetUpModel=\{\(\) => openSettings\('replies'\)\}/);
  assert.match(src('conversations.ts'), /this\.publish\(\{ modelsLoaded: true,/);
});

test('a chat that already worked in its folder stays there: the refusal passes and says what to do', () => {
  const r = conversationResponse('/api/chat/conversations/9a8b7c6d-1d2a-4f4e-9b1a-6c7d8e9f0a1b', 409, { code: 'folder_fixed', error: 'x' });
  assert.equal(r.code, 'folder_fixed');
  assert.match(src('conversations.ts'), /r\.status === 409\) this\.publish\(\{ notice: 'This chat already worked in its folder\. Continue in another folder… starts a new chat there\.' \}\)/);
});

test('the footer never swaps names and icons forever at the edge width (that left a blank window)', () => {
  const footer = src('ShellFooter.tsx');
  assert.match(footer, /needed\.current=el\.scrollWidth-el\.clientWidth;wentAt\.current=window\.innerWidth;setCompact\(true\)/, 'remember the window width and how much did not fit');
  assert.match(footer, /window\.innerWidth>=wentAt\.current\+Math\.max\(24,needed\.current\)\)setCompact\(false\)/, 'names come back only once the window grew by what did not fit (the footer\'s own width changes with the layout and could swap forever)');
});

test('approval card: the request is read at once (Allow once with no extra step) and ⋯ opens Approvals', () => {
  const m = src('ChatMoments.tsx');
  assert.match(m, /useEffect\(\(\) => \{ if \(client && id && state === 'waiting' && !detail\) void review\(\); \}, \[id\]\)/);
  assert.match(m, /label: 'Open in Approvals', icon: 'open', run: onOpenApprovals/);
  assert.match(m, /'Always allow this… \(What agents may do\)'/);
  assert.match(m, /alwaysAllow\(detail, onOpenRules \?\? \(\(\) => onOpenApprovals\(\)\)\)/);
  assert.ok(m.indexOf('useEffect(() => { if (client && id') < m.indexOf("if (!client || !id) return null;"), 'hooks before the early return');
  assert.match(src('SignedInShell.tsx'), /onOpenApprovals=\{\(\) => setPage\('approvals'\)\}/);
});

test('chat keys: ⌘P pin, ⇧⌘S export, ⌘⌫ archive (not while typing), ⌥⌘⌫ delete asks, ⇧⌘C copies the last reply, ⌘\\ sidebar', () => {
  const v = src('ChatView.tsx');
  assert.match(v, /k === 'p' && !e\.shiftKey && !e\.altKey\) hit\(\(\) => void controller\.pin\(id, !conv\.pinned\)\)/);
  assert.match(v, /k === 's' && e\.shiftKey && !e\.altKey\) hit\(\(\) => setExportKey\(Date\.now\(\)\)\)/);
  assert.match(v, /k === 'backspace' && !typing\) hit\(\(\) => \(e\.altKey \? setChatSheet\('delete'\) : void controller\.archive\(id, !conv\.archived\)\)\)/);
  assert.match(v, /k === 'c' && e\.shiftKey && !e\.altKey\)/);
  assert.match(src('SignedInShell.tsx'), /e\.key === '\\\\'\) \{ e\.preventDefault\(\); setRail\(v => !v\); \}/);
  const list = src('ConversationList.tsx');
  for (const k of ["shortcut: '⌘P'", "shortcut: '⇧⌘S'", "shortcut: '⌘⌫'", "shortcut: '⌥⌘⌫'", "shortcut: '⌘B'"]) assert.ok(list.includes(k), k);
});

test('sidebar menus: a chat can go to the board; a project has Rename, Fold all and Delete; chats drag onto projects', () => {
  const list = src('ConversationList.tsx');
  assert.match(list, /label: 'Add to board…', icon: 'board' as const, shortcut: '⌘B', run: \(\) => onAddToBoard\(c\.id\)/);
  for (const label of ["'Rename…'", "'Fold all'", "'Delete project…'", "'Folders and variables…'", "'New chat here'"]) assert.ok(list.includes(`label: ${label}`), label);
  assert.match(list, /onDragStart=\{e => \{ e\.dataTransfer\.setData\(CHAT_DRAG, c\.id\)/);
  assert.match(list, /onDrop=\{e => \{ const id = e\.dataTransfer\.getData\(CHAT_DRAG\); setDropOn\(null\); if \(id\) \{ e\.preventDefault\(\); void controller\.moveToProject\(id, p\.id\); \} \}\}/);
  assert.match(src('ChatView.tsx'), /useEffect\(\(\) => \{ if \(boardRequest > 0 && canBoard\) openCardForm\(\); \}, \[boardRequest\]\)/);
});

test('Settings › General turns the done-in-the-background notice on or off; the plan-limit card can keep the model', () => {
  const { allowedConversation: allow, conversationResponse: res } = require('../src/conversation-contract.js');
  assert.equal(allow('GET', '/api/chat/settings', undefined), true);
  assert.equal(allow('PUT', '/api/chat/settings', { notifyDone: false }), true);
  for (const b of [{}, { notifyDone: 'no' }, { notifyDone: true, x: 1 }]) assert.equal(allow('PUT', '/api/chat/settings', b), false);
  assert.deepEqual(res('/api/chat/settings', 200, { settings: { notifyDone: false } }), { settings: { notifyDone: false } });
  assert.deepEqual(res('/api/chat/settings', 200, {}), { settings: { notifyDone: true } }, 'on unless turned off');
  assert.match(src('conversations.ts'), /if \(this\.#notifyDone && last\?\.role === 'assistant' && \(last\.durationMs \?\? 0\) >= 60_000\) notifyDone\(/);
  assert.match(src('AppSettings.tsx'), /\{live&&<ChatNoticeSettings client=\{client!\}\/>\}/);
  assert.match(src('ChatMoments.tsx'), />Keep this model</);
});

test('terminal: Stop sends ⌃C, ⌃⇧` opens a new tab, your own shell says "· you"', () => {
  const t = src('TerminalPane.tsx');
  assert.match(t, /aria-label="Stop" title="Stop what runs here \(⌃C\)" disabled=\{!active\} onClick=\{\(\) => active\?\.terminal\.write\('\\x03'\)\}/);
  assert.match(t, /'New terminal \(⌃⇧`\)'/);
  assert.match(t, / · you\{folder/);
  const v = src('ChatView.tsx');
  assert.ok(v.indexOf("e.ctrlKey && e.shiftKey && !e.metaKey && e.code === 'Backquote'") < v.indexOf("e.ctrlKey && !e.metaKey && e.code === 'Backquote'"), 'the new-tab key is checked before the toggle');
});

test('Place: an added folder can be removed (the files stay) and a started chat can continue in another folder', () => {
  const d = src('ChatDetails.tsx');
  assert.match(d, /folders: \(project\.folders \?\? \[\]\)\.filter\(x => x\.path !== f\.path\)/);
  assert.match(d, /s\.turns\.length > 0 && <button type="button" className="link-button panel-add" onClick=\{onContinue\}>/);
  assert.match(src('ChatView.tsx'), /onContinue=\{\(\) => setChatSheet\('continue'\)\}/);
});

test('reply actions: Answer again on the last finished reply; Copy shows its key; a working hand-off can be stopped', () => {
  const v = src('ChatView.tsx');
  assert.match(v, /onAgain=\{last && turn\.status === 'complete' \? onRetry : undefined\}/);
  assert.match(v, /aria-label="Answer again"/);
  assert.match(v, /label="Copy reply \(⇧⌘C\)"/);
  assert.match(v, /onStop: \(\) => void controller\.stopAll\(\)/);
  assert.match(src('ChatMoments.tsx'), /\{onStop && <button type="button" className="row-tool handoff-stop" aria-label="Stop"/, 'Stop sits on the live step line of a working hand-off');
});

test('changed files row shows +N −N; the summary notice can be read and started from', () => {
  const { conversationResponse: res } = require('../src/conversation-contract.js');
  const m = src('ChatMoments.tsx');
  assert.match(m, /<span className="diff-add">\+\{turn\.changes\.added\}<\/span> <span className="diff-del">−\{turn\.changes\.removed\}<\/span>/);
  assert.match(m, /\{shown \? 'Hide the summary' : 'Read the summary'\}/);
  assert.match(m, /m\.onStartFresh!\(summary \|\| head\)/);
  const long = `3 older messages were summed up.\n\n${'s'.repeat(2000)}`;
  const out = res('/api/chat/conversations/9a8b7c6d-1d2a-4f4e-9b1a-6c7d8e9f0a1b/messages', 200, { messages: [{ id: 'm1', role: 'assistant', content: 'x', parts: [{ kind: 'notice', code: 'summarized', text: long }, { kind: 'notice', code: 'injection', text: 'i'.repeat(900) }], status: 'complete', runId: null, durationMs: null, createdAt: '', changes: { files: 2, undone: false, added: 7, removed: 3 } }], activeRunId: null, conversation: { id: '9a8b7c6d-1d2a-4f4e-9b1a-6c7d8e9f0a1b', title: 't', agentId: null, projectId: null, pinned: false, preview: '', createdAt: '', updatedAt: '' } });
  const msg = out.messages[0];
  assert.equal(msg.parts.find((p) => p.code === 'summarized').text.length, long.length, 'the summary is kept whole (up to 2400)');
  assert.equal(msg.parts.find((p) => p.code === 'injection').text.length, 300, 'other notices stay one line');
  assert.deepEqual(msg.changes, { files: 2, undone: false, added: 7, removed: 3 });
});

test('small gaps: Esc closes the panel in a narrow window, a rail icon opens its part, the edge dot, Running now via Edit, waits in Tasks', () => {
  const v = src('ChatView.tsx'), d = src('ChatDetails.tsx'), l = src('ConversationList.tsx'), m = src('ChatMoments.tsx');
  assert.match(v, /e\.key === 'Escape' && !e\.defaultPrevented && window\.innerWidth <= 1100 && !document\.querySelector\('\[role="dialog"\], \.dk-menu'\)\) setPane/);
  assert.match(v, /<DetailsRail controller=\{controller\} onOpen=\{openPart\}\/>/);
  assert.match(v, /const openPart = \(id: PanelPart\) => \{ setPane\('details'\); setFocusPart\(f => \(\{ id, n: \(f\?\.n \?\? 0\) \+ 1 \}\)\); \};/);
  assert.match(d, /className="details-part" data-part=\{id\}/);
  assert.match(d, /onClick=\{\(\) => onOpen\(i\.id\)\}/);
  assert.match(l, /\{hiddenNeeds && <button type="button" className="chat-edge-dot"/);
  assert.match(src('chat-sidebar-prefs.ts'), /hidden: \['running', 'archived'\]/);
  assert.match(m, /\{waits > 0 && <span className="task-waits">· \{waits\} \{waits === 1 \? 'waits' : 'wait'\} for you<\/span>\}/);
  assert.match(v, /waits=\{activeConv\?\.waiting \?\? 0\}/);
});

test('MCP part: real marks from the vendored set, an amber dot when one needs you, View all always', () => {
  const d = src('ChatDetails.tsx');
  assert.match(d, /logo=\{serviceMark\(c\.name\) \? <ServiceLogo id=\{c\.name\} size=\{13\}\/> : undefined\}/);
  assert.match(d, /<span className="details-needs-dot" aria-label="Needs you"\/>/);
  assert.match(d, /'View all in Settings'/);
  assert.doesNotMatch(src('ServiceLogo.tsx'), /https?:\/\//, 'never loaded from the internet');
});

test('images: the contract lets only a bounded base64 image and image ids through; parts and the notice pass', () => {
  const { allowedConversation: allow, conversationResponse: res, MAX_IMAGE_CHARS } = require('../src/conversation-contract.js');
  const C = '9a8b7c6d-1d2a-4f4e-9b1a-6c7d8e9f0a1b', IMG = 'a'.repeat(32);
  assert.equal(allow('POST', `/api/chat/conversations/${C}/images`, { data: 'iVBORw0KGgo=', name: 'a.png' }), true);
  for (const b of [{ data: 'x'.repeat(MAX_IMAGE_CHARS + 4) }, { data: 'not base64!' }, { data: 'iVBO', path: '/etc' }]) assert.equal(allow('POST', `/api/chat/conversations/${C}/images`, b), false);
  assert.equal(allow('GET', `/api/chat/conversations/${C}/images/${IMG}`, undefined), true);
  assert.equal(allow('GET', `/api/chat/conversations/${C}/images/../x`, undefined), false);
  assert.equal(allow('POST', `/api/chat/conversations/${C}/runs`, { runId: 'run-12345678', message: 'hi', images: [IMG] }), true);
  for (const images of [[IMG, IMG, IMG, IMG, IMG], ['../x'], 'x']) assert.equal(allow('POST', `/api/chat/conversations/${C}/runs`, { runId: 'run-12345678', message: 'hi', images }), false);
  assert.throws(() => res(`/api/chat/conversations/${C}/images/${IMG}`, 200, { image: { id: IMG, type: 'image/svg+xml', data: 'PHN2Zz4=' } }), /protocol/, 'never an SVG');
  assert.equal(res(`/api/chat/conversations/${C}/images/${IMG}`, 200, { image: { id: IMG, type: 'image/png', data: 'iVBO', name: 'a' } }).image.type, 'image/png');
});

test('images: kept for the next message (up to 4, 5 MB, four kinds) and sent after they are saved with the chat', async () => {
  const { ConversationsController } = require('../src/conversations.ts');
  const calls = [];
  const client = { getSnapshot: () => ({ phase: 'authenticated', epoch: 1, user: { id: 'u', role: 'owner' } }), subscribe: () => () => {}, runEvents: async () => ({ last: 0, ended: true }),
    request: async (r) => { calls.push(r);
      if (r.path === '/api/chat/conversations' && r.method === 'POST') return { status: 201, body: { conversation: { id: '9a8b7c6d-1d2a-4f4e-9b1a-6c7d8e9f0a1b', title: null, agentId: null, projectId: null, pinned: false, preview: '', createdAt: '', updatedAt: '' } } };
      if (/\/images$/.test(r.path)) return { status: 201, body: { image: { id: 'b'.repeat(32), type: 'image/png', name: 'a.png', size: 4 } } };
      if (/\/runs$/.test(r.path)) return { status: 202, body: { runId: r.body.runId } };
      return { status: 200, body: { conversations: [], projects: [], agents: [], models: [], last: null } }; } };
  const c = new ConversationsController(client);
  try {
    assert.match(c.attachImages([{ name: 'x.svg', type: 'image/svg+xml', data: 'PHN2Zz4=' }]), /only PNG, JPEG, GIF and WebP/);
    assert.equal(c.attachImages([{ name: 'a.png', type: 'image/png', data: 'iVBORw0KGgo=' }]), null);
    assert.match(c.attachImages(Array.from({ length: 4 }, (_, i) => ({ name: `${i}.png`, type: 'image/png', data: 'iVBO' }))), /Up to 4/);
    assert.equal(c.getSnapshot().images.length, 1, 'a refused batch adds nothing');
    c.edit('What is in it?');
    await c.send();
    const upload = calls.findIndex((r) => /\/images$/.test(r.path)), run = calls.findIndex((r) => /\/runs$/.test(r.path));
    assert.ok(upload >= 0 && run > upload, 'saved with the chat before the message goes');
    assert.deepEqual(calls[run].body.images, ['b'.repeat(32)]);
    assert.equal(c.getSnapshot().images.length, 0, 'the box is clear after sending');
  } finally { c.dispose(); }
});

test('images: when an image cannot be saved, nothing is sent and the text, files and images come back', async () => {
  const { ConversationsController } = require('../src/conversations.ts');
  const calls = [];
  const client = { getSnapshot: () => ({ phase: 'authenticated', epoch: 1, user: { id: 'u', role: 'owner' } }), subscribe: () => () => {}, runEvents: async () => ({ last: 0, ended: true }),
    request: async (r) => { calls.push(r);
      if (r.path === '/api/chat/conversations' && r.method === 'POST') return { status: 201, body: { conversation: { id: '9a8b7c6d-1d2a-4f4e-9b1a-6c7d8e9f0a1b', title: null, agentId: null, projectId: null, pinned: false, preview: '', createdAt: '', updatedAt: '' } } };
      if (/\/images$/.test(r.path)) return { status: 400, body: { code: 'invalid_image' } };
      return { status: 200, body: { conversations: [], projects: [], agents: [], models: [], last: null } }; } };
  const c = new ConversationsController(client);
  try {
    c.attachImages([{ name: 'a.png', type: 'image/png', data: 'iVBORw0KGgo=' }]);
    c.edit('Look at this');
    await c.send();
    assert.equal(calls.some((r) => /\/runs$/.test(r.path)), false, 'nothing sent');
    assert.equal(c.getSnapshot().draft, 'Look at this');
    assert.equal(c.getSnapshot().images.length, 1);
    assert.match(c.getSnapshot().notice, /could not be attached/);
  } finally { c.dispose(); }
});

test('coding apps: shown in Team with their own Stop; the terminal keeps only your shells', () => {
  const { allowedConversation: allow, conversationResponse: res } = require('../src/conversation-contract.js');
  const id = '11111111-1111-4111-8111-111111111111', run = 'a'.repeat(32);
  assert.equal(allow('POST', `/api/chat/conversations/${id}/apps/${run}/stop`, undefined), true);
  assert.equal(allow('POST', `/api/chat/conversations/${id}/apps/${run}/stop`, { x: 1 }), false);
  assert.equal(allow('GET', `/api/chat/conversations/${id}/apps/${run}/stop`, undefined), false);
  assert.equal(allow('POST', `/api/chat/conversations/${id}/apps/../stop`, undefined), false);
  const team = res(`/api/chat/conversations/${id}/team`, 200, { team: [], apps: [{ id: run, app: 'Claude Code', agentName: 'QA Tester', about: 'Check the hero', startedAt: 'now', secret: 'x' }, { id: 'bad', app: 'Codex' }] });
  assert.deepEqual(team.apps, [{ id: run, app: 'Claude Code', agentName: 'QA Tester', about: 'Check the hero', startedAt: 'now' }]);
  const panel = src('ChatDetails.tsx');
  assert.match(panel, /live\.apps\.map\(a => <Row key=\{a\.id\} icon="terminal"/);
  assert.match(panel, /\/apps\/\$\{id\}\/stop/);
  assert.match(panel, /setInterval\(\(\) => setPulse/, 'Team looks again while a reply runs');
  assert.doesNotMatch(src('TerminalPane.tsx'), /agentId|startedBy/, 'no agent tabs in the terminal');
});

test('CH1 match: the window keeps the board measures (title bar 40, footer 30, sidebar 256, side panel 320, column 768)', () => {
  const css = src('styles.css'), block = css.slice(css.indexOf('/* CH1 match (2026-10-28)'));
  assert.match(block, /\.app-shell \{ grid-template-rows:40px minmax\(0,1fr\) 30px; grid-template-columns:256px minmax\(0,1fr\); \}/);
  assert.match(block, /\.app-shell \.chat-layout\[data-panel\] \{ grid-template-columns:minmax\(0,1fr\) 320px; \}/);
  assert.match(block, /\.app-shell \.chat-column \{ max-inline-size:768px;/);
  assert.match(block, /\.app-shell \.chat-composer \{ inline-size:100%; max-inline-size:768px;/);
  assert.match(block, /--row-open:#24324A/);
  const shell = src('SignedInShell.tsx'), view = src('ChatView.tsx');
  assert.match(shell, /<div className="titlebar-tools end" ref=\{setTitleSlot\}\/>/);
  assert.doesNotMatch(shell, /aria-label="Switch theme"/, 'the theme lives in Settings and Commands');
  assert.doesNotMatch(view, /className="chat-topbar"|function ProjectBar/, 'no second bar under the title bar');
  assert.match(view, /<PaneSwitch items=\{paneButtons\} pane=\{pane\} onPane=\{setPane\}\/>/);
});

test('CH2: a sent message shows its files as chips (the text stays the typed text)', () => {
  const { withAttachments, splitAttached } = require('../src/conversations.ts');
  const sent = withAttachments('Check these.', [{ name: 'brand-kit.md', text: '# Brand\nteal' }, { name: 'notes.txt', text: 'a ```fence``` inside' }]);
  assert.deepEqual(splitAttached(sent), { text: 'Check these.', files: [{ name: 'brand-kit.md', kb: 1 }, { name: 'notes.txt', kb: 1 }] });
  assert.deepEqual(splitAttached('Just text with `code`'), { text: 'Just text with `code`', files: [] });
  const view = src('ChatView.tsx');
  assert.match(view, /aria-label="Edit and send again"/);
  assert.match(view, /<Copy text=\{text\} label="Copy"\/>/);
  assert.match(view, /className="reply-meta"/);
});

test('CH3 + CH8: chips inside the box, a red chip per file that cannot be read; the side panel as quiet rows', () => {
  const view = src('ChatView.tsx'), css = src('styles.css');
  assert.ok(view.indexOf('className="chat-attachments"') > view.indexOf('<form className="chat-composer"'), 'files sit inside the box');
  assert.match(view, /className="attach-chip bad" role="alert"/);
  assert.match(view, /const errors = files\.map\(f => controller\.attach\(\[f\]\)\)/);
  assert.doesNotMatch(view, /className="fine-print">Uses your signed-in coding app/);
  assert.match(view, /<section className="git-rows"/);
  assert.match(css, /\.app-shell \.chat-composer \.round-button \{ inline-size:30px; block-size:30px;/);
  assert.match(css, /\.app-shell \.chat-details \.details-icon \{ inline-size:24px; block-size:24px;/);
});

test('CH5 + CH6: a new chat keeps its composer without suggested-message pills; hand-off cards show face, name and state on the right', () => {
  const view = src('ChatView.tsx'), moments = src('ChatMoments.tsx'), css = src('styles.css');
  assert.match(view, /data-empty=\{empty \|\| undefined\}/);
  assert.doesNotMatch(view, /className="chat-suggestions"|const SUGGESTIONS/);
  assert.match(css, /\.app-shell \.chat-layout\[data-empty\] > \.chat-panel, \.app-shell \.chat-layout\[data-empty\] > \.details-rail \{ display:none; \}/);
  assert.match(moments, /<span className="handoff-verb">/);
  assert.match(moments, /className="moment-hint handoff-state"/);
  assert.match(moments, /className="handoff-fold"/);
});

test('CH4 + CH9 + CH10 + CH11: panes, sidebar edit, trust moments and the signed-out screen follow their boards', () => {
  const panes = src('ProjectPanes.tsx'), list = src('ConversationList.tsx'), moments = src('ChatMoments.tsx'), css = src('styles.css');
  assert.match(panes, /<label className="pane-find"><UiIcon name="search" size=\{12\}\/><input type="search" aria-label="Find a file"/);
  assert.match(panes, /SECRET\.test\(e\.name\) \? 'hidden' : size\(e\.size\)/, 'secret-looking files show locked, not their size');
  assert.match(panes, /<span className="pane-branch" dir="ltr"[^>]*><UiIcon name="branch" size=\{13\}\/>/);
  assert.match(list, /<div className="chat-edit-head"><b>Edit chats sidebar<\/b>/);
  assert.doesNotMatch(list, /chat-edit-actions/);
  assert.match(moments, /<div className="moment-card changes" role="note">/);
  assert.match(css, /\.app-shell \.moment-actions \.moment-main, \.app-shell \.moment-actions > \.link-button:first-child \{ block-size:28px;/);
  assert.match(css, /\.public-shell \.titlebar \{ justify-content:center; \}/);
});
