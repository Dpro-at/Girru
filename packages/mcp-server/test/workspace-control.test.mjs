import test from 'node:test';
import assert from 'node:assert/strict';
import {callTool} from '../src/tools.ts';
test('Draft and chat schemas refuse apply, identity and unconfirmed effects before a request',async()=>{
 let calls=0;const backend={async request(){calls++;throw Error('No request expected');}};
 for(const [name,args]of [['workspace_drafts',{operation:'apply',id:'d'}],['workspace_drafts',{operation:'prepare',body:{kind:'agent',action:'create',requestId:'d',expectedFingerprint:'new',draft:{name:'Demo'},userId:'foreign'}}],['chats',{operation:'send',id:'chat-1',body:{requestId:'r',agentId:'a',projectId:null,message:'Hi',confirmed:false}}],['chats',{operation:'messages',id:'chat-1',limit:21}]]){const out=await callTool(name,args,{backend});assert.equal(out.isError,true);assert.equal(calls,0);}
});
test('Rules read and overlaps do not call a model or mutate a rule',async()=>{
 const row={id:'11111111-1111-1111-1111-111111111111',text:'Synthetic rule',when:null,version:1};const paths=[];const backend={async request(method,path){paths.push(path);assert.equal(method,'GET');return path==='/api/agent-rules'?{rules:[row],suggestions:[]}:{rules:[row,{...row,id:'22222222-2222-2222-2222-222222222222'}]};}};
 const read=await callTool('workspace_rules',{operation:'read',id:row.id},{backend});assert.equal(read.structuredContent.rule.text,row.text);
 const overlaps=await callTool('workspace_rules',{operation:'conflicts',agentId:'synthetic-agent'},{backend});assert.equal(overlaps.structuredContent.modelCalls,0);assert.equal(overlaps.structuredContent.checked,false);assert.equal(overlaps.structuredContent.candidates[0].reason,'duplicate_text');assert.ok(paths.every(x=>!x.includes('/conflicts')));
});
