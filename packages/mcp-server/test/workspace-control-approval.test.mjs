import test from 'node:test';
import assert from 'node:assert/strict';
import {callTool,TOOL_DEFINITIONS} from '../src/tools.ts';
test('Exported control has no apply/approval authority and declares every accepted selector',async()=>{
 let calls=0;const backend={async request(){calls++;throw Error('Unexpected request');}};
 for(const args of [{operation:'apply',id:'operation-1'},{operation:'approve',id:'operation-1'},{operation:'delete',id:'operation-1'},{operation:'request',body:{operationId:'operation-1',fingerprint:'a'.repeat(64),confirmed:true}},{operation:'preview',body:{requestId:'request-1',kind:'agent',action:'create',expectedRevision:0,draft:{name:'Synthetic'},source:'native'}},{operation:'preview',body:{requestId:'request-1',kind:'agent',action:'create',expectedRevision:0,draft:{name:'Synthetic'},userId:'foreign'}}]){const result=await callTool('workspace_control',args,{backend});assert.equal(result.isError,true,JSON.stringify(args));assert.equal(calls,0);}
 const schema=TOOL_DEFINITIONS.find(t=>t.name==='workspace_control').inputSchema;assert.deepEqual(schema.properties.operation.enum,['options','preview','request','status','history']);for(const key of ['operation','id','body'])assert.ok(Object.hasOwn(schema.properties,key));assert.equal(schema.additionalProperties,false);
});
test('Exported control dispatches only scoped server previews, real requests and status',async()=>{
 const calls=[];const backend={async request(method,path,body){calls.push({method,path,body});if(path==='/api/auth/me')return {user:{role:'owner',status:'active'}};return {operationId:'operation-1',state:'pending',approvalId:'approval-1'};}};
 const body={requestId:'request-1',kind:'agent',action:'create',expectedRevision:0,draft:{name:'Synthetic'}};assert.notEqual((await callTool('workspace_control',{operation:'preview',body},{backend})).isError,true);assert.deepEqual(calls.at(-1),{method:'POST',path:'/api/workspace-control/preview',body});
 const request={operationId:'operation-1',fingerprint:'a'.repeat(64)};await callTool('workspace_control',{operation:'request',body:request},{backend});assert.deepEqual(calls.at(-1),{method:'POST',path:'/api/workspace-control/request',body:request});await callTool('workspace_control',{operation:'status',id:'operation-1'},{backend});assert.equal(calls.at(-1).path,'/api/workspace-control/operation-1');assert.ok(calls.every(c=>!c.path.endsWith('/approve')&&!c.path.endsWith('/apply')));
});
