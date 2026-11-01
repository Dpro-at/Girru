require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConversationsController } = require('../src/conversations.ts');
const { conversationResponse } = require('../src/conversation-contract.js');
const CID = '0f0c2b6e-1d2a-4f4e-9b1a-6c7d8e9f0a1b';
const R1 = 'run-group-0001', R2 = 'run-group-0002', R3 = 'run-group-0003';
const conversation = { id: CID, title: 'Team', agentId: 'main', projectId: null, pinned: false, preview: '', createdAt: '', updatedAt: '' };
const msg = (id, role, content, runId, agentId) => ({ id, role, content, runId, agentId, parts: [], status: 'complete', durationMs: 1, createdAt: '' });
const round = (state, activeRunId, id) => ({ id: R1, state, activeRunId, total: 3, remaining: state === 'complete' ? 0 : 2, speaker: { id, name: id, department: id === 'main' ? 'management' : 'marketing' } });
async function until(fn) { const end = Date.now() + 4000; while (!fn()) { if (Date.now() > end) throw Error('timeout'); await new Promise(r => setTimeout(r, 5)); } }

test('the boundary keeps bounded round metadata and removes untrusted fields', () => {
  const path = `/api/chat/conversations/${CID}/messages`;
  const data = { conversation, messages: [], activeRunId: R1, replyRound: { ...round('active', R1, 'main'), owner_id: 'private', speaker: { id: 'main', name: 'Main', department: null, secret: 'private' } } };
  const value = conversationResponse(path, 200, data);
  assert.equal(value.replyRound.total, 3);
  assert.equal(value.replyRound.owner_id, undefined);
  assert.equal(value.replyRound.speaker.secret, undefined);
  assert.equal(conversationResponse(path,200,{...data,replyRound:{...data.replyRound,total:1,remaining:0}}).replyRound.total,1,'a naturally addressed participant has a single-member route');
  for (const patch of [{ total: 5000 }, { remaining: -1 }, { state: 'execute' }, { activeRunId: '../bad' }]) {
    assert.equal(conversationResponse(path, 200, { ...data, replyRound: { ...data.replyRound, ...patch } }).replyRound, undefined);
  }
});

test('attendance controls execute while a meeting speaker is working and use the stored acknowledgement without fake model streams', async t => {
  let changed=false, posts=0, streams=0;
  const meetingConversation={...conversation,meeting:{id:'meeting-001',state:'active'}};
  const rows=[msg('old-user','user','Discuss',R1),{...msg('old-reply','assistant','Partial discussion',R1,'hayden'),status:'stopped'}];
  const client={getSnapshot:()=>({phase:'authenticated',epoch:1,user:{role:'owner'}}),subscribe:()=>()=>{},request:async r=>{
    if(r.method==='POST'&&r.path.endsWith('/runs')){posts++;changed=true;const user=msg('attendance-user','user',r.body.message,r.body.runId);const reply=msg('attendance-reply','assistant','One participant remains',r.body.runId,'main');rows.push(user,reply);return{status:202,body:{runId:r.body.runId,completed:true,userMessage:user,assistantMessage:reply}};}
    if(/\/messages/.test(r.path))return{status:200,body:{conversation:meetingConversation,messages:[...rows],activeRunId:changed?null:R1}};
    return{status:200,body:{conversations:[meetingConversation],agents:[],projects:[]}};
  },runEvents:async(id,after,callback,signal)=>{streams++;return new Promise(resolve=>signal.addEventListener('abort',()=>resolve({last:0,ended:false}),{once:true}));}};
  const c=new ConversationsController(client,()=>'attendance-001');t.after(()=>c.dispose());
  await c.load();await c.open(CID);assert.equal(c.getSnapshot().runId,R1);
  c.edit('الكل تخرج يبقى بس الاساسي');await c.send();
  assert.equal(posts,1);assert.equal(streams,1,'no model stream for a deterministic attendance update');assert.equal(c.getSnapshot().runId,null);assert.equal(c.getSnapshot().queue.length,0);assert.equal(c.getSnapshot().meetingRevision,1);assert.equal(c.getSnapshot().turns.at(-1).content,'One participant remains');
});

test('one send follows three saved participant replies with one user row and exact departments', async t => {
  let stage = 0, starts = 0;
  const rows = [], followed = [];
  const client = { getSnapshot: () => ({ phase: 'authenticated', epoch: 1, user: { role: 'owner' } }), subscribe: () => () => {}, request: async r => {
    if (r.method === 'POST' && r.path.endsWith('/runs')) {
      starts++; rows.push(msg('user-1', 'user', r.body.message, R1));
      return { status: 202, body: { runId: R1, userMessage: rows[0], replyRound: round('active', R1, 'main') } };
    }
    if (/\/messages/.test(r.path)) return { status: 200, body: { conversation, messages: [...rows], activeRunId: stage > 0 && stage < 3 ? [R1, R2, R3][stage] : null, ...(stage ? { replyRound: round(stage === 3 ? 'complete' : 'active', [R1, R2, R3][Math.min(stage, 2)], ['main', 'hayden', 'charlie'][Math.min(stage, 2)]) } : {}) } };
    if (r.path === '/api/chat/conversations') return { status: 200, body: { conversations: [conversation] } };
    return { status: 200, body: { agents: [], models: [], projects: [], sidebar: {} } };
  }, runEvents: async (id, after, onEvent) => {
    followed.push(id); const index = [R1, R2, R3].indexOf(id), actor = ['main', 'hayden', 'charlie'][index];
    onEvent({ seq: 1, type: 'text', content: actor + ' present' });
    rows.push(msg('reply-' + index, 'assistant', actor + ' present', id, actor)); stage = index + 1;
    onEvent({ seq: 2, type: 'end', status: 'complete', ms: 1 });
    return { last: 2, ended: true };
  } };
  const c = new ConversationsController(client, () => 'group-0001'); t.after(() => c.dispose());
  await c.load(); await c.open(CID); c.edit('كل واحد يرد'); await c.send();
  await until(() => followed.length === 3 && c.getSnapshot().runId === null);
  assert.equal(starts, 1);
  assert.deepEqual(followed, [R1, R2, R3]);
  assert.equal(c.getSnapshot().turns.filter(t => t.role === 'user').length, 1);
  assert.deepEqual(c.getSnapshot().turns.filter(t => t.role === 'assistant').map(t => t.agentId), ['main', 'hayden', 'charlie']);
  assert.equal(c.getSnapshot().agents.find(a => a.id === 'charlie').department, 'marketing');
});

test('opening an active child attaches without sending or repeating the request', async t => {
  let sends = 0;
  const rows = [msg('user-1', 'user', 'كل واحد يرد', R1), msg('main-1', 'assistant', 'Main present', R1, 'main')];
  let complete = false;
  const client = { getSnapshot: () => ({ phase: 'authenticated', epoch: 1, user: { role: 'owner' } }), subscribe: () => () => {}, request: async r => {
    if (r.method === 'POST') sends++;
    if (/\/messages/.test(r.path)) return { status: 200, body: { conversation, messages: [...rows], activeRunId: complete ? null : R2, replyRound: round(complete ? 'paused' : 'active', R2, 'hayden') } };
    return { status: 200, body: { conversations: [conversation], agents: [], projects: [] } };
  }, runEvents: async (id, after, callback) => { assert.equal(id, R2); complete = true; rows.push(msg('hayden-1', 'assistant', 'Here', R2, 'hayden')); callback({ seq: 1, type: 'end', status: 'stopped', ms: 1 }); return { last: 1, ended: true }; } };
  const c = new ConversationsController(client); t.after(() => c.dispose());
  await c.load(); await c.open(CID); await until(() => c.getSnapshot().runId === null);
  assert.equal(sends, 0); assert.match(c.getSnapshot().notice, /group replies paused/i);
  assert.equal(c.getSnapshot().turns.filter(t => t.role === 'user').length, 1);
});
