// RULES-01: workspace_rules reads the owner's rules, suggests one, and changes only through the owner routes.
import test from 'node:test';import assert from 'node:assert/strict';import {callTool,TOOL_DEFINITIONS} from '../src/tools.ts';

const RID='3f0c2b6e-1d2a-4f4e-9b1a-6c7d8e9f0a1b';
const R={id:RID,text:'Chat in Arabic',projectId:null,who:'all',targets:[],paused:false,status:'active',source:'owner',reason:null,version:1,createdAt:'x',createdBy:'secret-owner-id'};
function fake(){const calls=[];return {calls,backend:{async request(method,path,body){calls.push({method,path,body});
 if(method==='GET'&&path==='/api/agent-rules')return {rules:[R,{...R,id:'b',paused:true}],suggestions:[{...R,id:'c',status:'suggested',source:'agent',reason:'why'}],departments:['development']};
 if(method==='GET'&&path.startsWith('/api/agent-rules/effective?'))return {rules:[R]};
 if(method==='POST'&&path==='/api/agent-rules/suggestions')return {rule:{...R,...body,status:'suggested'}};
 if(method==='POST'&&path==='/api/agent-rules')return {rule:{...R,...body}};
 if(method==='PUT'&&path===`/api/agent-rules/${RID}`)return {rule:{...R,...body}};
 if(method==='POST'&&path===`/api/agent-rules/${RID}/delete`)return {ok:true};
 if(method==='POST'&&path===`/api/agent-rules/${RID}/accept`)return {rule:{...R}};
 throw Error('unexpected '+method+' '+path);}}};}

test('workspace_rules: list and effective read; only rule fields come back', async () => {
 const {backend}=fake();
 const r=await callTool('workspace_rules',{operation:'list'},{backend});
 assert.match(r.content[0].text,/2 rules \(0 come with Girru, 0 always on, 1 paused\), 1 suggestions waiting/);
 assert.deepEqual(Object.keys(r.structuredContent.rules[0]).sort(),['id','locked','paused','projectId','reason','source','status','targets','text','version','when','who']);
 assert.doesNotMatch(JSON.stringify(r),/secret-owner-id/);
 const e=await callTool('workspace_rules',{operation:'effective',agentId:'a-dev',projectId:'p1'},{backend});
 assert.equal(e.structuredContent.rules[0].text,'Chat in Arabic');
});

test('workspace_rules: suggest waits for the owner; every change and every decision on a suggestion is refused over MCP', async () => {
 const {backend,calls}=fake();
 const s=await callTool('workspace_rules',{operation:'suggest',text:'Ask me before you go on',when:'a hand-off fails twice',reason:'missed steps'},{backend});
 assert.match(s.content[0].text,/waits for the owner/);
 assert.deepEqual(calls.at(-1),{method:'POST',path:'/api/agent-rules/suggestions',body:{text:'Ask me before you go on',when:'a hand-off fails twice',reason:'missed steps'}});
 assert.equal(s.structuredContent.rule.when,'a hand-off fails twice');
 const before=calls.length;
 for(const op of ['create','edit','pause','delete','undo_delete','restore_version','accept','dismiss','starter','approve','set']){
  const r=await callTool('workspace_rules',{operation:op,id:RID},{backend});
  assert.equal(r.isError,true,op);
 }
 assert.equal(calls.length,before,'no write reaches the backend');
 for(const bad of [{operation:'list',text:'x'},{operation:'suggest',text:'x',paused:true}]){
  const r=await callTool('workspace_rules',bad,{backend});assert.equal(r.isError,true,JSON.stringify(bad));
 }
 const def=TOOL_DEFINITIONS.find(t=>t.name==='workspace_rules');
 assert.deepEqual(def.inputSchema.properties.operation.enum,['list','read','conflicts','effective','versions','files','suggest']);
 assert.match(def.description,/stay with the owner in the app/);
});
