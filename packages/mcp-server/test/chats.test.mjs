// CHAT-BUILD-01 stage 2: the chats tool reads the sidebar and changes only what the owner asked for.
import test from 'node:test';import assert from 'node:assert/strict';import {callTool,TOOL_DEFINITIONS} from '../src/tools.ts';

const CID='3f0c2b6e-1d2a-4f4e-9b1a-6c7d8e9f0a1b',PID='9a8b7c6d-1d2a-4f4e-9b1a-6c7d8e9f0a1b';
function fake(){const calls=[];return {calls,backend:{async request(method,path,body){calls.push({method,path,body});
 if(method==='GET'&&path==='/api/chat/conversations')return {conversations:[{id:CID,title:'Plan the site',preview:'',projectId:PID,pinned:false,archived:true,parentId:PID,running:true,waiting:2,updatedAt:'2026-10-27 10:00:00',agentId:'secret-agent'}]};
 if(method==='GET'&&path==='/api/chat/projects')return {projects:[{id:PID,name:'Website',folder:'/Users/me/site',repoUrl:'x'}]};
 if(method==='GET'&&path===`/api/chat/conversations/${CID}/usage`)return {usage:[{model:'qwen3:8b',tokensIn:900,tokensOut:120,replies:2}]};
 if(method==='GET'&&path===`/api/chat/conversations/${CID}/team`)return {team:[{agentId:'qa',agentName:'QA Tester',model:'subscription:claude',status:'answered',at:'x'}]};
 if(method==='GET'&&path===`/api/chat/conversations/${CID}/schedule`)return {schedule:{every:'daily',at:'09:00',weekday:null,message:'secret plan',paused:false,nextRun:'2026-10-28T08:00:00Z'}};
 if(method==='PUT'&&path===`/api/chat/conversations/${CID}`)return {conversation:{id:CID,title:body.title??'Plan the site',preview:'',projectId:'projectId' in body?body.projectId:PID,pinned:!!body.pinned,archived:!!body.archived,updatedAt:''}};
 throw Error('unexpected '+method+' '+path);}}};}

test('chats: list and projects read the sidebar; writes go to the one chat with only the asked field',async()=>{
 const {calls,backend}=fake();
 const list=await callTool('chats',{operation:'list'},{backend});
 assert.deepEqual(list.structuredContent.chats,[{id:CID,name:'Plan the site',projectId:PID,pinned:false,mode:'auto',thinking:'normal',archived:true,openedFrom:PID,workingNow:true,waitingForOwner:2,updatedAt:'2026-10-27 10:00:00'}]);
 assert.deepEqual((await callTool('chats',{operation:'projects'},{backend})).structuredContent.projects,[{id:PID,name:'Website',folder:'/Users/me/site',folders:[]}]);
 assert.equal((await callTool('chats',{operation:'rename',id:CID,title:' New name '},{backend})).structuredContent.chat.name,'New name');
 await callTool('chats',{operation:'pin',id:CID,pinned:true},{backend});
 await callTool('chats',{operation:'archive',id:CID,archived:false},{backend});
 await callTool('chats',{operation:'move',id:CID,projectId:null},{backend});
 await callTool('chats',{operation:'set_mode',id:CID,mode:'ask'},{backend});
 await callTool('chats',{operation:'set_thinking',id:CID,thinking:'deep'},{backend});
 assert.deepEqual(calls.filter(c=>c.method==='PUT').map(c=>c.body),[{title:'New name'},{pinned:true},{archived:false},{projectId:null},{mode:'ask'},{thinking:'deep'}]);
});

test('chats: bad input is refused before the backend; deletion and invalid message bounds are refused',async()=>{
 const {calls,backend}=fake();
 for(const input of [{operation:'delete',id:CID},{operation:'messages',id:CID,limit:21},{operation:'rename',id:'../x',title:'a'},{operation:'rename',id:CID,title:''},{operation:'pin',id:CID,pinned:'yes'},{operation:'archive',id:CID},{operation:'move',id:CID,projectId:'a/b'},{operation:'list',id:CID},{operation:'set_mode',id:CID,mode:'accept_edits'},{operation:'variables',projectId:'../x'}]){
  const r=await callTool('chats',input,{backend});assert.equal(r.isError,true,JSON.stringify(input));
 }
 assert.equal(calls.length,0);
 assert.match(TOOL_DEFINITIONS.find(t=>t.name==='chats').description,/explicit instruction/);
});

test('chats: status reads tokens by model, the team and the schedule (never the message text)',async()=>{
 const {backend}=fake();
 const r=await callTool('chats',{operation:'status',id:CID},{backend});
 assert.equal(r.structuredContent.usage[0].model,'qwen3:8b');
 assert.deepEqual(r.structuredContent.team,[{agent:'QA Tester',app:'Claude Code',model:'subscription:claude',status:'answered',at:'x'}]);
 assert.deepEqual(r.structuredContent.models,[{app:'Claude Code',agents:['QA Tester']}],'CH12: the apps used, as in the side panel');
 assert.equal(r.structuredContent.schedule.every,'daily');
 assert.doesNotMatch(JSON.stringify(r),/secret plan/);
});

test('chats: pull_request reads the project branch’s pull request (read-only), or says it is unavailable',async()=>{
 const calls=[];const answers=[{pr:{number:38,title:'Fixes',state:'merged',url:'https://github.com/acme/widgets/pull/38',checks:'passing'}},{pr:null,unavailable:true},{pr:null}];
 const backend={async request(method,path){calls.push({method,path});return answers.shift();}};
 const merged=await callTool('chats',{operation:'pull_request',projectId:PID},{backend});
 assert.deepEqual(merged.structuredContent.pullRequest,{number:38,title:'Fixes',state:'merged',url:'https://github.com/acme/widgets/pull/38',checks:'passing'});
 const off=await callTool('chats',{operation:'pull_request',projectId:PID},{backend});
 assert.equal(off.structuredContent.unavailable,true);assert.match(off.content[0].text,/PR state unavailable/);
 assert.equal((await callTool('chats',{operation:'pull_request',projectId:PID},{backend})).structuredContent.pullRequest,null);
 assert.deepEqual(calls,[...Array(3)].map(()=>({method:'GET',path:`/api/chat/projects/${PID}/pr`})));
 assert.equal((await callTool('chats',{operation:'pull_request',projectId:'../x'},{backend})).isError,true);
 assert.equal(calls.length,3);
});

// CH4/CH8: the side panel layout (order, folded parts, One column / Side by side) through the same route as the window.
test('chats: panel reads and set_panel changes only the asked side panel fields; bad input never reaches the backend',async()=>{
 const calls=[];let saved={order:['place','team','results','memory','mcp'],folded:[],diff:'unified'};
 const backend={async request(method,path,body){calls.push({method,path,body});assert.equal(path,'/api/chat/panel');if(method==='PUT')saved={...saved,...body};return {panel:{...saved,extra:'x'}};}};
 const read=await callTool('chats',{operation:'panel'},{backend});
 assert.deepEqual(read.structuredContent.panel,{order:['place','team','results','memory','mcp'],folded:[],diff:'unified'});
 const set=await callTool('chats',{operation:'set_panel',order:['team','place'],folded:['mcp'],diff:'split'},{backend});
 assert.deepEqual(calls.at(-1),{method:'PUT',path:'/api/chat/panel',body:{order:['team','place'],folded:['mcp'],diff:'split'}});
 assert.equal(set.structuredContent.panel.diff,'split');assert.doesNotMatch(JSON.stringify(set.structuredContent),/extra/);
 await callTool('chats',{operation:'set_panel',diff:'unified'},{backend});
 assert.deepEqual(calls.at(-1).body,{diff:'unified'},'only what changes is sent');
 const before=calls.length;
 for(const input of [{operation:'set_panel'},{operation:'set_panel',order:['place','place']},{operation:'set_panel',order:['chat']},{operation:'set_panel',folded:'mcp'},{operation:'set_panel',diff:'side'},{operation:'set_panel',diff:'split',sidebar:true},{operation:'panel',diff:'split'},{operation:'set_panel',order:['place','team','results','memory','mcp','place']}])
  assert.equal((await callTool('chats',input,{backend})).isError,true,JSON.stringify(input));
 assert.equal(calls.length,before);
 const def=TOOL_DEFINITIONS.find(t=>t.name==='chats');
 assert.ok(def.inputSchema.properties.operation.enum.includes('set_panel'));assert.match(def.description,/set_panel/);assert.match(def.description,/explicit instruction/);
});

test('chats: a session that is not the owner gets the owner-only answer and nothing changes',async()=>{
 const {BackendError}=await import('../src/backend.ts');
 const backend={async request(){throw new BackendError('The saved Girru session is not the owner account; these tools are owner-only.',403);}};
 for(const input of [{operation:'panel'},{operation:'set_panel',diff:'split'}]){const r=await callTool('chats',input,{backend});assert.equal(r.isError,true);assert.match(r.content[0].text,/owner/);}
});

test('CH12: replyApp names the app for each model id the way the side panel does',async()=>{
 const {replyApp}=await import('../src/tools.ts');
 assert.equal(replyApp('subscription:codex/gpt-6'),'Codex');
 assert.equal(replyApp('subscription:gemini'),'Gemini');
 assert.equal(replyApp('subscription:claude:abc'),'Claude Code');
 assert.equal(replyApp('claude-opus-5-5'),'Claude');
 assert.equal(replyApp('qwen3:8b'),'On this computer');
});
