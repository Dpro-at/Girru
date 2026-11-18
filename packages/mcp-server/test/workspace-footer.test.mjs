import test from 'node:test';import assert from 'node:assert/strict';import {callTool,TOOL_DEFINITIONS} from '../src/tools.ts';
test('footer MCP tool reads and changes only the footer route, never Settings',async()=>{
 const calls=[],backend={async request(method,path,body){calls.push({method,path,body});return {footer:{order:[],hidden:[]}};}};
 assert.notEqual((await callTool('workspace_footer',{operation:'read'},{backend})).isError,true);assert.deepEqual(calls.at(-1),{method:'GET',path:'/api/me/footer',body:undefined});
 assert.notEqual((await callTool('workspace_footer',{operation:'set',hidden:['board'],iconsOnly:true},{backend})).isError,true);assert.deepEqual(calls.at(-1),{method:'PUT',path:'/api/me/footer',body:{hidden:['board'],iconsOnly:true}});
 const before=calls.length;
 for(const input of [{operation:'set'},{operation:'set',hidden:['settings']},{operation:'set',hidden:['mcp']},{operation:'set',hidden:['chat','chat']},{operation:'set',order:'chat'},{operation:'set',iconsOnly:'yes'},{operation:'read',hidden:[]},{operation:'remove'},{operation:'set',extra:1}])assert.equal((await callTool('workspace_footer',input,{backend})).isError,true,JSON.stringify(input));
 assert.equal(calls.length,before);
 assert.ok(TOOL_DEFINITIONS.some(t=>t.name==='workspace_footer'));
 assert.notEqual((await callTool('workspace_footer',{operation:'set',hidden:['library']},{backend})).isError,true);assert.deepEqual(calls.at(-1).body,{hidden:['library']});
 assert.notEqual((await callTool('workspace_footer',{operation:'set',order:['reports','chat']},{backend})).isError,true);assert.deepEqual(calls.at(-1).body,{order:['reports','chat']});
 assert.match(TOOL_DEFINITIONS.find(t=>t.name==='workspace_footer').description,/reports/);
 assert.match(TOOL_DEFINITIONS.find(t=>t.name==='workspace_footer').description,/library/);
});
