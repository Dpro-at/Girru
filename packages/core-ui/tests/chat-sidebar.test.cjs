// CHAT-BUILD-01 stage 2 (CH1, CH9): the chat sidebar.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { sections, ConversationList } = require('../src/ConversationList.tsx');
const { readPrefs, moveSection, shortTime, DEFAULT_PREFS } = require('../src/chat-sidebar-prefs.ts');
const { conversationResponse, allowedConversation } = require('../src/conversation-contract.js');
const { PublicShell } = require('../src/PublicShell.tsx');

const P = 'p0000000-0000-4000-8000-000000000001';
const chat = (id, o = {}) => ({ id: `c000000${id}-0000-4000-8000-000000000000`, title: `Chat ${id}`, agentId: null, projectId: null, pinned: false, preview: '', createdAt: '', updatedAt: '2026-10-27 09:00:00', ...o });

test('sections: pinned, projects, other chats, archived; child chats under their chat; Running now repeats working chats', () => {
  const parent = chat(1, { projectId: P });
  const list = [parent, chat(2, { parentId: parent.id, running: true }), chat(3, { pinned: true }), chat(4), chat(5, { archived: true }), chat(6, { projectId: 'gone-project-id' })];
  const v = sections(list, [P]);
  assert.deepEqual(v.pinned.map(c => c.title), ['Chat 3']);
  assert.deepEqual(v.projects.get(P).map(c => c.title), ['Chat 1']);
  assert.deepEqual(v.children.get(parent.id).map(c => c.title), ['Chat 2']);
  assert.deepEqual(v.other.map(c => c.title), ['Chat 4', 'Chat 6'], 'a chat of a deleted project is an ordinary chat');
  assert.deepEqual(v.archived.map(c => c.title), ['Chat 5']);
  assert.deepEqual(v.running.map(c => c.title), ['Chat 2']);
  assert.deepEqual(v.scheduled, []);
  assert.deepEqual(sections(list, [P], 'chat 4').other.map(c => c.title), ['Chat 4']);
});

test('sidebar choices: unknown ids dropped, new sections added, Running now and Archived hidden by default (shown via Edit); moving a section', () => {
  assert.deepEqual(DEFAULT_PREFS.hidden, ['running', 'archived']);
  const p = readPrefs(JSON.stringify({ order: ['other', 'nope', 'pinned', 'other'], hidden: ['running', 'x'], folded: ['a', 5] }));
  assert.deepEqual(p.order, ['other', 'pinned', 'scheduled', 'running', 'projects', 'archived']);
  assert.deepEqual(p.hidden, ['running']);
  assert.deepEqual(p.folded, ['a']);
  assert.deepEqual(readPrefs('not json'), DEFAULT_PREFS);
  assert.deepEqual(readPrefs({ order: ['pinned'] }).hidden, ['running', 'archived'], 'no saved hidden list: the usual one');
  assert.deepEqual(moveSection(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(moveSection(['a', 'b'], 'a', -1), ['a', 'b']);
  const now = new Date('2026-10-27T12:00:00Z');
  assert.equal(shortTime('2026-10-27 11:59:30', now), 'now');
  assert.equal(shortTime('2026-10-27 11:00:00', now), '1h');
  assert.match(shortTime('2026-10-01 11:00:00', now), /Oct 1/);
});

test('the list contract carries archived, opened-from, working and waiting; archive is a PUT field', () => {
  const id = chat(1).id;
  const body = { conversations: [{ ...chat(1), archived: true, parentId: chat(2).id, running: true, waiting: 3 }, { ...chat(3), running: 'yes', waiting: -1, parentId: '../x' }] };
  const out = conversationResponse('/api/chat/conversations', 200, body).conversations;
  assert.deepEqual([out[0].archived, out[0].parentId, out[0].running, out[0].waiting], [true, chat(2).id, true, 3]);
  assert.deepEqual([out[1].archived, out[1].parentId, out[1].running, out[1].waiting], [undefined, undefined, undefined, undefined]);
  assert.equal(allowedConversation('PUT', `/api/chat/conversations/${id}`, { archived: true }), true);
  assert.equal(allowedConversation('PUT', `/api/chat/conversations/${id}`, { archived: 'yes' }), false);
});

test('rows are plain names with status only when there is something', () => {
  const list = [chat(1, { waiting: 2 }), chat(2, { running: true }), chat(3)];
  const state = { access: 'ready', listPhase: 'ready', conversations: list, projects: [], activeId: null, runId: null, sidebar: DEFAULT_PREFS };
  const controller = { subscribe: () => () => {}, getSnapshot: () => state, load() {}, open() {}, loadSidebar() {}, saveSidebar() {} };
  const html = renderToStaticMarkup(React.createElement(ConversationList, { controller, onOpen: () => {}, onNewChat: () => {} }));
  assert.match(html, /aria-label="Search chats \(⌘F\)"/);
  assert.match(html, /aria-label="New chat"/);
  assert.match(html, />Other chats</);
  assert.equal((html.match(/class="chat-row-waits"/g) || []).length, 1);
  assert.match(html, /aria-label="2 waiting for you">2</);
  assert.equal((html.match(/class="chat-row-working"/g) || []).length, 1, 'in Other chats (Running now is shown via Edit)');
  assert.doesNotMatch(html, /session-kind|<select/, 'no separate session selector or project select');
});

test('signed out: one screen, one action', () => {
  const html = renderToStaticMarkup(React.createElement(PublicShell, { setup: 'login' }, React.createElement('i')));
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.match(html, />Sign in</);
});

test('the sidebar layout is saved per person through the backend, never in browser storage', () => {
  const { allowedConversation: allow, conversationResponse: res, SIDEBAR_PATH } = require('../src/conversation-contract.js');
  assert.equal(SIDEBAR_PATH, '/api/chat/sidebar');
  assert.equal(allow('GET', SIDEBAR_PATH, undefined), true);
  assert.equal(allow('PUT', SIDEBAR_PATH, { order: ['pinned', 'other'], hidden: [], folded: ['p-1'] }), true);
  for (const bad of [{}, { order: ['nope'] }, { hidden: ['pinned', 'pinned'] }, { folded: ['../x'] }, { theme: 'dark' }]) assert.equal(allow('PUT', SIDEBAR_PATH, bad), false, JSON.stringify(bad));
  assert.deepEqual(res(SIDEBAR_PATH, 200, { sidebar: { order: 'x', hidden: ['pinned'], folded: [] } }).sidebar.order, ['scheduled', 'running', 'pinned', 'projects', 'other', 'archived']);
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/chat-sidebar-prefs.ts'), 'utf8');
  assert.doesNotMatch(src, /localStorage|sessionStorage/);
});

test('normal, scheduled and meeting chats share sidebar rows with explicit type markers',()=>{const list=[chat(1),chat(2,{schedule:{next:'Tomorrow',paused:false}}),chat(3,{meeting:{id:'meeting-3',state:'active'}})],state={access:'ready',listPhase:'ready',conversations:list,projects:[],activeId:null,runId:null,sidebar:DEFAULT_PREFS};const controller={subscribe:()=>()=>{},getSnapshot:()=>state,loadSidebar(){},saveSidebar(){}};const html=renderToStaticMarkup(React.createElement(ConversationList,{controller,onOpen(){}}));assert.match(html,/class="chat-row-type" aria-label="Chat"/);assert.match(html,/class="chat-row-type" aria-label="Scheduled chat"/);assert.match(html,/class="chat-row-type" aria-label="Meeting"/);const wire=conversationResponse('/api/chat/conversations',200,{conversations:[{...list[2],meeting:{id:'meeting-3',state:'active',private:'secret'}}]}).conversations[0];assert.deepEqual(wire.meeting,{id:'meeting-3',state:'active'});assert.doesNotMatch(JSON.stringify(wire),/secret/);assert.equal(conversationResponse('/api/chat/conversations',200,{conversations:[{...list[2],meeting:{id:'../bad',state:'active'}}]}).conversations[0].meeting,undefined);});
