// CHAT-REBUILD-01: saved conversations and runs that outlive the page.
//  - a run streams numbered events (reasoning, tools, text, end) and stores the
//    user and assistant turns with their work; the first message names the chat;
//  - a reader can re-attach with after=N; Stop keeps the partial reply ("stopped");
//  - the model gets the stored history, not a client-sent one;
//  - other users get 404; a guest is refused; a busy chat answers 409; a repeated
//    runId does not run twice.
// Throwaway DB/keys; the local model is stubbed (no network).
// Run: node --import tsx --test test/chat-runs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-chat-runs-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
for (const k of ['AGENT_EXEC_TOOLS', 'OLLAMA_THINK', 'DEFAULT_MODEL']) delete process.env[k];

// --- stubbed local model: a queue of scripted replies (NDJSON lines) ---------
const script = [];
const bodies = [];
let hold = null; // when set, the next reply waits for hold.release()
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== 'http://127.0.0.1:11434/api/chat') throw new Error(`unexpected network call in test: ${url}`);
  bodies.push(JSON.parse(init.body));
  // 'missing' = the local model server answers 404 (the model is not installed).
  if (script[0] === 'missing') { script.shift(); return new Response(JSON.stringify({ error: 'model not found' }), { status: 404 }); }
  const lines = script.shift() ?? [{ message: { content: 'ok' }, done: true }];
  const enc = new TextEncoder();
  const h = hold;
  return new Response(new ReadableStream({
    async start(c) {
      c.enqueue(enc.encode(JSON.stringify(lines[0]) + '\n'));
      if (h) await new Promise((r) => { h.release = r; init.signal?.addEventListener('abort', r); });
      if (init.signal?.aborted) { c.error(new DOMException('aborted', 'AbortError')); return; }
      for (const l of lines.slice(1)) c.enqueue(enc.encode(JSON.stringify(l) + '\n'));
      c.close();
    },
  }), { status: 200 });
};

const capture = () => {};
console.log = capture; console.info = capture; console.warn = capture;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(join(backendDir, 'src/multi-agent/index.ts'));
await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
for (const [id, role] of [['r-owner', 'owner'], ['r-other', 'user'], ['r-guest', 'guest']]) {
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`).run(id, `${id}@example.test`, id, role);
}
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('r-agent', 'Run Agent', 'ollama', 'qwen-test', 1)`).run();
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('r-claude', 'Claude Agent', 'claude', 'claude-sonnet-test', 0)`).run();

const tools = await import(join(backendDir, 'src/tools/index.ts'));
const grants = await import(join(backendDir, 'src/tools/grants.ts'));
const echoed = [];
tools.registerExtensionTool({ name: 'x_echo', description: 'echo', extensionId: 'x', requiresApproval: false,
  input_schema: { type: 'object', properties: { text: { type: 'string' } } },
  execute: async (p) => { echoed.push(p.text); return { content: [{ type: 'text', text: `echo: ${p.text}` }] }; } });
const avail = tools.createToolsRegistry({ workspaceDir: dir }).listRegistered();
await grants.setAgentGrants('r-agent', { grants: ['x_echo', 'read'] }, 'r-owner', avail);

const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { chatRuns } = await import(join(backendDir, 'src/services/chat-runs.ts'));
const { historyFor } = await import(join(backendDir, 'src/api/routes/chat-conversations.ts'));
const app = await buildServer({ logger: false });
await app.ready();
const as = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const call = (user, method, url, payload) => app.inject({ method, url, headers: as(user), ...(payload ? { payload } : {}) });
const frames = (body) => body.split('\n\n').filter((b) => b.includes('data:')).map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data:')).slice(5)));
const ended = (runId) => new Promise((r) => { const run = chatRuns.get(runId); if (run.status !== 'running') r(); else run.emitter.once('end', r); });
const rid = () => `run-${randomBytes(6).toString('hex')}`;


const R=await import(join(backendDir,'src/repositories/chat-conversations.ts'));
const G=await import(join(backendDir,'src/services/chat-reply-rounds.ts'));
const {writePersonality}=await import(join(backendDir,'src/services/agent-files.ts'));
for(const [id,name,department] of [['r-agent','Main Agent','management'],['r-hayden','Hayden','marketing'],['r-charlie','Charlie','development'],['r-outsider','Outsider','sales']]) {
 db.prepare('INSERT OR IGNORE INTO agents_config(id,name,provider,model) VALUES(?,?,?,?)').run(id,name,'ollama','qwen-'+id);
 db.prepare('UPDATE agents_config SET name=?,department=?,provider=?,model=?,system_prompt=? WHERE id=?').run(name,department,'ollama','qwen-'+id,'You are '+name+'. PERSONA_'+id,id);
 await writePersonality(id,'# Personality\nPERSONA_'+id+'\nSpeak as '+name+' in '+department+'.');
}
await grants.setAgentGrants('r-hayden',{grants:['read']},'r-owner',avail);
await grants.setAgentGrants('r-charlie',{grants:[]},'r-owner',avail);
async function fixture() {const c=await R.createConversation('r-owner',{agentId:'r-agent'});for(const id of ['r-hayden','r-charlie'])await R.addAssistantMessage(c.id,{runId:rid(),content:'Prior reply',parts:[],status:'complete',durationMs:1,agentId:id});return c;}
async function until(fn) {const end=Date.now()+15000;while(!await fn()){if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,10));}}
const group=(c,message='كل واح يرد انها موجود',runId=rid())=>call('r-owner','POST',`/api/chat/conversations/${c.id}/runs`,{runId,message});
const done=c=>until(async()=>(await G.replyRoundStatus('r-owner',c.id))?.state==='complete');
const answer=text=>[{message:{content:text},done:true}];
test('intent recognizes collective requests, not counts, quotations or negation',()=>{
 for(const x of ['كل واحد يرد','كل واح يرد انها موجود','اريد كل واحد يرد باسمه وقسمه','كلكم جاوبوا','everyone reply as yourself','each of you introduce yourself','@all tell me your role','كل واحد يرد باسمه لا تستخدموا أدوات',"don't use tools, everyone reply"])assert.equal(G.collectiveReply(x),true,x);
 for(const x of ['كم واحد هنا','عندي سؤال لكم','لا تخلي كل واحد يرد','do not make everyone reply','> everyone reply','```everyone reply```','لا يرد كل واحد','كل واحد لا يرد','\"everyone reply\"'])assert.equal(G.collectiveReply(x),false,x);
});
test('one request produces separate own-runtime replies with personality, department, own model and grants; retry is idempotent',async()=>{
 const c=await fixture(),first=bodies.length,id=rid();script.push(answer('Main present'),answer('Charlie present'),answer('Hayden present'));
 const out=await group(c,undefined,id);assert.equal(out.statusCode,202,out.body);assert.equal(out.json().replyRound.total,3);await done(c);
 const saved=(await call('r-owner','GET',`/api/chat/conversations/${c.id}/messages`)).json();assert.equal(saved.messages.filter(m=>m.role==='user').length,1);
 assert.deepEqual(saved.messages.filter(m=>m.role==='assistant').slice(-3).map(m=>m.agentId),['r-agent','r-charlie','r-hayden']);
 const requests=bodies.slice(first);assert.equal(requests.length,3);
 for(const [i,agent,department] of [[0,'r-agent','management'],[1,'r-charlie','development'],[2,'r-hayden','marketing']]){assert.equal(requests[i].model,'qwen-'+agent);const system=requests[i].messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');assert.ok(system.includes('PERSONA_'+agent),agent+' persona');assert.ok(system.toLowerCase().includes(department),agent+' department');assert.match(system,/never impersonate/);}
 assert.ok(requests[0].tools.some(t=>t.function.name==='x_echo'));assert.ok(!requests[1].tools.some(t=>t.function.name==='x_echo'));
 const retry=await group(c,undefined,id);assert.equal(retry.statusCode,202);assert.equal(retry.json().replayed,true);await new Promise(r=>setTimeout(r,30));assert.equal(bodies.length,first+3);
 assert.equal((await call('r-other','GET',`/api/chat/conversations/${c.id}/messages`)).statusCode,404);
});
test('multiple explicit mentions call just those identities and preserve the common model override',async()=>{
 const c=await fixture(),first=bodies.length;await call('r-owner','PUT',`/api/chat/conversations/${c.id}`,{model:'qwen-override'});script.push(answer('Hayden'),answer('Charlie'));
 const out=await group(c,'@Hayden @Charlie please reply');assert.equal(out.statusCode,202,out.body);await done(c);
 const saved=(await call('r-owner','GET',`/api/chat/conversations/${c.id}/messages`)).json();assert.deepEqual(saved.messages.filter(m=>m.role==='assistant').slice(-2).map(m=>m.agentId),['r-hayden','r-charlie']);assert.deepEqual(bodies.slice(first).map(b=>b.model),['qwen-override','qwen-override']);
});
test('Stop pauses the round and never invokes remaining participants',async()=>{
 const c=await fixture(),first=bodies.length;hold={release:null};script.push([{message:{content:'Partial '},done:false},{message:{content:'finish'},done:true}]);
 const out=await group(c);assert.equal(out.statusCode,202,out.body);const id=out.json().runId;await until(()=>hold.release);const busy=await call('r-owner','POST',`/api/chat/conversations/${c.id}/runs`,{runId:rid(),message:'Do not interleave'});assert.equal(busy.statusCode,409);const stop=await call('r-owner','POST',`/api/chat/runs/${id}/stop`);assert.equal(stop.statusCode,200);hold.release();hold=null;await ended(id);await new Promise(r=>setTimeout(r,30));assert.equal(bodies.length,first+1);assert.equal(chatRuns.activeFor(c.id),undefined);assert.equal((await G.replyRoundStatus('r-owner',c.id)).state,'paused');
 const saved=(await call('r-owner','GET',`/api/chat/conversations/${c.id}/messages`)).json();assert.equal(saved.messages.at(-1).agentId,'r-agent');assert.equal(saved.messages.at(-1).status,'stopped');
});
test('missing runtime after restart pauses durably without repeating work',async()=>{
 const c=await fixture(),first=bodies.length,id=rid();db.prepare('INSERT INTO chat_reply_rounds(id,owner_id,session_id,participants,active_run_id) VALUES(?,?,?,?,?)').run(id,'r-owner',c.id,JSON.stringify([{id:'r-agent',runId:id},{id:'r-hayden',runId:rid()}]),id);assert.equal((await G.replyRoundStatus('r-owner',c.id)).state,'paused');assert.equal(await G.replyRoundStatus('r-other',c.id),null);assert.equal(bodies.length,first);
});
test('large groups are refused without silent truncation or model calls',async()=>{
 const c=await fixture(),first=bodies.length;for(let i=0;i<21;i++){const id='r-large-'+i;db.prepare('INSERT INTO agents_config(id,name,model,provider) VALUES(?,?,?,?)').run(id,'Member '+i,'qwen-test','ollama');await R.addAssistantMessage(c.id,{runId:rid(),content:'Joined',parts:[],status:'complete',durationMs:1,agentId:id});}const out=await group(c);assert.equal(out.statusCode,400);assert.equal(out.json().code,'group_too_large');assert.equal(bodies.length,first);
});
test('a model failure pauses the group instead of moving on to the next agent',async()=>{
 const c=await fixture(),first=bodies.length;script.push('missing');const out=await group(c);assert.equal(out.statusCode,202,out.body);await until(async()=>(await G.replyRoundStatus('r-owner',c.id))?.state==='paused');assert.equal(bodies.length,first+1);assert.equal(chatRuns.activeFor(c.id),undefined);
});
test('Stop during preparation revokes the reserved participant before a model can start',async()=>{
 const c=await fixture(),id=rid(),before=bodies.length;let received,release;
 const pending=G.dispatchReplyRound({userId:'r-owner',role:'owner',c,runId:id,message:'كل واحد يرد'},async input=>{received=input;await new Promise(resolve=>{release=resolve;});return {code:await input.canStart()?202:409,body:{code:'group_paused'}};});
 await until(()=>received);await G.stopReplyRound('r-owner',id);assert.equal(await received.canStart(),false);release();assert.equal((await pending).code,409);assert.equal((await G.replyRoundStatus('r-owner',c.id)).state,'paused');assert.equal(bodies.length,before);
});
const {conversationalSelection}=await import(join(backendDir,'src/services/chat-addressing.ts'));
const smallRoster=[{id:'r-agent',name:'Main Agent',department:null},{id:'r-hayden',name:'Hayden',department:'marketing'},{id:'r-charlie',name:'Charlie',department:'development'}];
test('natural addresses match participant names across Arabic spellings, not quoted reports or workspace outsiders',()=>{
 for(const text of ['هيدن كيفك ؟','كيفك هايدن','هيدن موجود ؟','Hayden how are you?','تشارلي كيفك','هلا هيدن'])assert.deepEqual(conversationalSelection(text,smallRoster).ids,[text.includes('تشارلي')?'r-charlie':'r-hayden'],text);
 for(const text of ['اشرح كلام هيدن','هيدن قال انه جاهز','"هيدن كيفك"','```هيدن كيفك```','Harper how are you'])assert.equal(conversationalSelection(text,smallRoster).ids,null,text);
 assert.equal(conversationalSelection('والباقين؟',smallRoster).others,true);
 assert.deepEqual(conversationalSelection('مستعدين الى العمل؟',smallRoster).ids,smallRoster.map(a=>a.id));
 const ambiguous=[{id:'a',name:'Hayden',department:'a'},{id:'b',name:'Haden',department:'b'}];assert.equal(conversationalSelection('هيدن كيفك',ambiguous).ambiguous.length,2);
});
test('plain-name greetings really call Hayden alone, and a singular follow-up stays with him',async()=>{
 const c=await fixture();
 for(const text of ['هيدن كيفك ؟','كيفك هايدن','هيدن موجود ؟','مستعد؟']){
  const before=bodies.length;script.push(answer('Hayden answers as himself'));const out=await group(c,text);assert.equal(out.statusCode,202,out.body);assert.equal(out.json().replyRound.total,1,text);await done(c);
  const rows=(await call('r-owner','GET',`/api/chat/conversations/${c.id}/messages`)).json().messages;assert.equal(rows.at(-1).agentId,'r-hayden',text);assert.equal(bodies.length,before+1,text);
 }
});
test('readiness addresses the current group; and the others selects only those who did not reply to the last question',async()=>{
 const c=await fixture(),question=rid();await R.addUserMessage(c.id,'مستعدين الى العمل',question);await R.addAssistantMessage(c.id,{runId:question,content:'Main ready',parts:[],status:'complete',durationMs:1,agentId:'r-agent'});
 const before=bodies.length;script.push(answer('Charlie ready'),answer('Hayden ready'));
 const out=await group(c,'والباقين ؟');assert.equal(out.statusCode,202,out.body);assert.equal(out.json().replyRound.total,2);await done(c);
 const saved=(await call('r-owner','GET',`/api/chat/conversations/${c.id}/messages`)).json().messages;assert.deepEqual(saved.filter(m=>m.role==='assistant').slice(-2).map(m=>m.agentId),['r-charlie','r-hayden']);assert.equal(bodies.length,before+2);
 const repeatId=rid(),beforeRepeat=bodies.length;script.push(answer('All participants already answered'));const repeated=await group(c,'والباقين؟',repeatId);assert.equal(repeated.statusCode,202,repeated.body);assert.equal(repeated.json().replyRound,undefined);await ended(repeatId);assert.equal(bodies.length,beforeRepeat+1);assert.match(JSON.stringify(bodies.at(-1).messages),/Every current participant has already replied/);
 script.push(answer('Main ready'),answer('Charlie ready'),answer('Hayden ready'));const readiness=await group(c,'مستعدين للعمل؟');assert.equal(readiness.json().replyRound.total,3);await done(c);
});
test('meeting attendance commands through the real chat API change presence without model calls or erased history',async()=>{
 const M=await import(join(backendDir,'src/services/meetings.ts'));db.prepare("UPDATE agents_config SET is_primary=CASE WHEN id='r-agent' THEN 1 ELSE 0 END").run();db.prepare("UPDATE agents_config SET role=CASE WHEN id='r-agent' THEN 'main' ELSE 'manager' END WHERE id IN ('r-agent','r-hayden','r-charlie')").run();
 const m=await M.createMeeting('r-owner',{requestId:rid(),title:'Natural attendance',objective:'Check attendance',selection:{mode:'agents',agentIds:['r-hayden','r-charlie'],departments:[],headsOnly:false}}),before=bodies.length;
 assert.equal(m.count,3);const c={id:m.conversationId};const opened=(await call('r-owner','GET',`/api/chat/conversations/${c.id}/messages`)).json();assert.deepEqual(opened.conversation.meeting,{id:m.id,state:'active'});
 for(const [text,count] of [['كل مدراء الاقسام تحضر للاجتماع',3],['يبقى بس قسم التطوير',2],['الكل تخرج يبقى بس الاساسي',1]]){
  const out=await group(c,text);assert.equal(out.statusCode,202,out.body);assert.equal(out.json().completed,true);assert.equal(out.json().assistantMessage.agentId,'r-agent');assert.equal((await M.getMeeting('r-owner',m.id)).count,count);
 }
 const rows=(await call('r-owner','GET',`/api/chat/conversations/${m.conversationId}/messages`)).json().messages;assert.equal(rows.filter(m=>m.role==='user').length,3);assert.equal(rows.filter(m=>m.role==='assistant').length,3);assert.equal(bodies.length,before);
 const absent=await group(c,'@Hayden please answer');assert.equal(absent.statusCode,400);assert.equal(bodies.length,before);
});
test.after(async()=>{await app.close();});
