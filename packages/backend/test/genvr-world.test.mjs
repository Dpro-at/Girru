import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
// GENVR-WORLD-01 P1: a world's folder and Girru project, who answers, and the Studio chat's model turn. Temp data only.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'girru-genvr-world-'));process.env.AGENT_PLAYER_DATA_DIR=root;process.env.DATABASE_PATH=path.join(root,'agent-player.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.GIRRU_GENVR_WORLDS=path.join(root,'genvr_Worlds');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES('world-owner','o@example.invalid','world-owner','fixture','owner','active')").run();
db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES('world-member','m@example.invalid','world-member','fixture','user','active')").run();
const {default:Fastify}=await import('fastify');const {registerAuthGate}=await import('../src/auth/auth-gate.ts');const {generateToken}=await import('../src/auth/jwt.ts');
const {genvrRoutes}=await import('../src/api/routes/genvr.ts');const {genvrWorldRoutes}=await import('../src/api/routes/genvr-world.ts');
const {worldFolderName,protocolReply,parseTurn,modelLabel,withoutThinking}=await import('../src/services/genvr-world.ts');
const seen=[];
const deps={ollama:async opts=>{seen.push(opts);return {content:'Placing a tree.',toolCalls:[{id:'call-0',tool:'place_item',arguments:{itemId:'oak'}},{id:'call-1',tool:'share_studio',arguments:{}},{id:'call-2',tool:'not_offered',arguments:{}}],assistant:{role:'assistant',content:''},model:opts.model};},
 subscription:async(model,folder,prompt)=>{seen.push({model,folder,prompt});return JSON.stringify({type:'tools',text:'Two steps.',calls:[{name:'get_world_summary',arguments:{}},{name:'share_studio',arguments:{}}]});}};
const app=Fastify();registerAuthGate(app);await app.register(genvrRoutes);await app.ready();
const worldApp=Fastify();registerAuthGate(worldApp);await worldApp.register(genvrWorldRoutes,{deps});await worldApp.ready();
const headers=id=>({authorization:'Bearer '+generateToken(id,1)});const owner=headers('world-owner'),member=headers('world-member');
const project={format:'genvr-studio',version:1,id:'rooftop-city',title:'Rooftop city',world:{items:[]},play:{devices:['computer']}};
test.after(async()=>{await app.close();await worldApp.close();closeDatabase();fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
const tools=[{type:'function',function:{name:'place_item',description:'Place one item.',parameters:{type:'object',properties:{itemId:{type:'string'}}}}},{type:'function',function:{name:'get_world_summary',description:'Read the world.',parameters:{type:'object'}}},{type:'function',function:{name:'share_studio',description:'Share.',parameters:{type:'object'}}}];
const turn={messages:[{role:'system',content:'You build worlds.'},{role:'user',content:'Put a tree here'}],tools};

test('folder names stay inside the worlds folder',()=>{
 assert.equal(worldFolderName('Rooftop city'),'Rooftop city');assert.equal(worldFolderName('../../etc/passwd'),'etc passwd');assert.equal(worldFolderName('  ...  '),'World');assert.equal(worldFolderName('CON'),'World');assert.equal(worldFolderName('مدينة السطوح'),'مدينة السطوح');
 assert.equal(modelLabel('subscription:claude'),'Claude Code');assert.equal(modelLabel('subscription:codex/gpt-5'),'Codex');assert.equal(modelLabel('qwen3:4b'),'qwen3:4b');
});

test('opening a world makes its folder and Girru project once; rename keeps them',async()=>{
 assert.equal((await app.inject({method:'PUT',url:'/api/genvr/projects/'+project.id,headers:owner,payload:{project,revision:0}})).statusCode,200);
 assert.equal((await worldApp.inject({method:'POST',url:'/api/genvr/worlds/rooftop-city/open',payload:{name:'Rooftop city'}})).statusCode,401);
 assert.equal((await worldApp.inject({method:'POST',url:'/api/genvr/worlds/rooftop-city/open',headers:member,payload:{name:'Rooftop city'}})).statusCode,403);
 const first=await worldApp.inject({method:'POST',url:'/api/genvr/worlds/rooftop-city/open',headers:owner,payload:{name:'Rooftop city'}});assert.equal(first.statusCode,200);
 const body=first.json(),folder=path.join(fs.realpathSync(process.env.GIRRU_GENVR_WORLDS),'Rooftop city');
 assert.ok(fs.statSync(path.join(folder,'documents')).isDirectory());assert.ok(fs.statSync(path.join(folder,'exports')).isDirectory());assert.ok(fs.existsSync(path.join(folder,'README.md')));
 const chat=db.prepare('SELECT name,folder FROM chat_projects WHERE id=? AND user_id=?').get(body.chatProjectId,'world-owner');assert.equal(chat.folder,folder);assert.equal(chat.name,'World · Rooftop city');
 assert.ok(body.answerer&&body.answerer.name&&/^#[0-9a-f]{6}$/i.test(body.answerer.color));
 // The Studio renamed it: same folder, same project.
 db.prepare("UPDATE genvr_projects SET title='Roof city' WHERE id='rooftop-city'").run();
 const again=(await worldApp.inject({method:'POST',url:'/api/genvr/worlds/rooftop-city/open',headers:owner,payload:{name:'Roof city'}})).json();
 assert.equal(again.chatProjectId,body.chatProjectId);assert.equal(again.folder,body.folder);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_projects WHERE user_id=?').get('world-owner').n,1);
 // A second world with the same name gets its own folder.
 const twin=(await worldApp.inject({method:'POST',url:'/api/genvr/worlds/rooftop-two/open',headers:owner,payload:{name:'Rooftop city'}})).json();assert.ok(twin.folder.endsWith('Rooftop city 2'));
 for(const payload of [{},{name:'x',extra:1},{name:5}])assert.equal((await worldApp.inject({method:'POST',url:'/api/genvr/worlds/rooftop-city/open',headers:owner,payload})).statusCode,400);
 assert.equal((await worldApp.inject({method:'POST',url:'/api/genvr/worlds/..%2Fkeys/open',headers:owner,payload:{name:'x'}})).statusCode,400);
});

test('the last agent chosen in a world answers there',async()=>{
 const agents=db.prepare("SELECT id,name FROM agents_config WHERE id<>'small-local-agent' ORDER BY id").all();assert.ok(agents.length>0);
 const pick=agents.at(-1);
 const chosen=await worldApp.inject({method:'PUT',url:'/api/genvr/worlds/rooftop-city/agent',headers:owner,payload:{agentId:pick.id}});assert.equal(chosen.statusCode,200);assert.equal(chosen.json().answerer.id,pick.id);
 assert.equal((await worldApp.inject({method:'POST',url:'/api/genvr/worlds/rooftop-city/open',headers:owner,payload:{name:'Roof city'}})).json().answerer.id,pick.id);
 assert.equal((await worldApp.inject({method:'PUT',url:'/api/genvr/worlds/rooftop-city/agent',headers:owner,payload:{agentId:'no-such-agent'}})).statusCode,400);
 assert.equal((await worldApp.inject({method:'PUT',url:'/api/genvr/worlds/never-opened/agent',headers:owner,payload:{agentId:pick.id}})).statusCode,404);
});

test('a turn answers as the world agent; owner-only and unknown tools never reach the Studio',async()=>{
 const agent=db.prepare("SELECT agent_id FROM genvr_worlds WHERE project_id='rooftop-city'").get().agent_id;
 db.prepare("UPDATE agents_config SET model='qwen3:4b' WHERE id=?").run(agent);
 const r=await worldApp.inject({method:'POST',url:'/api/genvr/worlds/rooftop-city/turn',headers:owner,payload:turn});assert.equal(r.statusCode,200);
 const b=r.json();assert.equal(b.content,'Placing a tree.');assert.deepEqual(b.tool_calls,[{function:{name:'place_item',arguments:{itemId:'oak'}}}]);assert.equal(b.answerer.id,agent);
 const call=seen.at(-1);assert.equal(call.model,'qwen3:4b');assert.ok(!call.tools.some(t=>t.name==='share_studio'));assert.match(call.systemPrompt,/Roof city/);assert.match(call.systemPrompt,/You build worlds\./);assert.ok(call.messages.every(m=>m.role!=='system'));
 assert.equal((await worldApp.inject({method:'POST',url:'/api/genvr/worlds/never-opened/turn',headers:owner,payload:turn})).statusCode,409);
 assert.equal((await worldApp.inject({method:'POST',url:'/api/genvr/worlds/rooftop-city/turn',headers:member,payload:turn})).statusCode,403);
 for(const payload of [{messages:[],tools},{messages:turn.messages,tools,extra:1},{messages:[{role:'boss',content:'x'}],tools},{messages:turn.messages,tools:[{type:'function',function:{name:'Bad-Name',description:'',parameters:{}}}]}])
  assert.equal((await worldApp.inject({method:'POST',url:'/api/genvr/worlds/rooftop-city/turn',headers:owner,payload})).statusCode,400);
});

test('a coding-app agent answers through the GenVR tool protocol in the world folder',async()=>{
 const agent=db.prepare("SELECT agent_id,folder FROM genvr_worlds WHERE project_id='rooftop-city'").get();
 db.prepare("UPDATE agents_config SET model='subscription:claude' WHERE id=?").run(agent.agent_id);
 const before=process.env.DPRO_SUBSCRIPTION_CHAT;process.env.DPRO_SUBSCRIPTION_CHAT='1';
 try{
  const b=(await worldApp.inject({method:'POST',url:'/api/genvr/worlds/rooftop-city/turn',headers:owner,payload:turn})).json();
  assert.equal(b.content,'Two steps.');assert.deepEqual(b.tool_calls,[{function:{name:'get_world_summary',arguments:{}}}]);assert.equal(b.answerer.detail,'Claude Code');
  const call=seen.at(-1);assert.equal(call.folder,agent.folder);assert.match(call.prompt,/GenVR tool protocol/);assert.doesNotMatch(call.prompt,/"share_studio"/);
 }finally{if(before===undefined)delete process.env.DPRO_SUBSCRIPTION_CHAT;else process.env.DPRO_SUBSCRIPTION_CHAT=before;}
 delete process.env.DPRO_SUBSCRIPTION_CHAT;
 const off=await worldApp.inject({method:'POST',url:'/api/genvr/worlds/rooftop-city/turn',headers:owner,payload:turn});assert.equal(off.statusCode,409);assert.equal(off.json().code,'model_unavailable');
});

test('protocol replies: plain text is an answer, only offered tools come back',()=>{
 const offered=new Set(['place_item']);
 assert.deepEqual(protocolReply('Hello there',offered),{content:'Hello there',tool_calls:[]});
 assert.deepEqual(protocolReply('```json\n{"type":"answer","text":"Done"}\n```',offered),{content:'Done',tool_calls:[]});
 assert.deepEqual(protocolReply('{"type":"tools","text":"Go","calls":[{"name":"place_item","arguments":{"itemId":"oak"}},{"name":"rm_rf","arguments":{}}]}',offered).tool_calls,[{function:{name:'place_item',arguments:{itemId:'oak'}}}]);
 assert.throws(()=>parseTurn({messages:[{role:'user',content:'x'},{role:'assistant',content:'y'}],tools:[]}));
});

test('a thinking model\'s reasoning never reaches the chat',()=>{
 assert.equal(withoutThinking('<think>plan</think> Hello'),'Hello');assert.equal(withoutThinking('long reasoning </think> I placed it.'),'I placed it.');assert.equal(withoutThinking('Plain'),'Plain');
});
