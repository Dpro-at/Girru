import test from 'node:test';import assert from 'node:assert/strict';import {callTool,TOOL_DEFINITIONS} from '../src/tools.ts';
test('CP15 MCP: run_command sends one command for one project to the command route; waiting and off are told plainly',async()=>{
 const calls=[];let reply={ran:true,code:null,output:'Exit code 0 · 5 ms.\nclean'};
 const backend={async request(method,path,body){calls.push({method,path,body});return reply;}};
 assert.notEqual((await callTool('run_command',{projectId:'p1',command:'git status'},{backend})).isError,true);
 assert.deepEqual(calls.at(-1),{method:'POST',path:'/api/commands/run',body:{projectId:'p1',command:'git status'}});
 reply={ran:false,code:'waiting_for_run',approvalId:'a1',output:'waits'};
 const waiting=await callTool('run_command',{projectId:'p1',command:'git push',timeout:5000},{backend});
 assert.notEqual(waiting.isError,true);assert.match(JSON.stringify(waiting),/Approvals/);assert.equal(calls.at(-1).body.timeout,5000);
 reply={ran:false,code:'agent_commands_off',output:'off'};
 assert.equal((await callTool('run_command',{projectId:'p1',command:'ls'},{backend})).isError,true);
 const before=calls.length;
 for(const input of [{},{projectId:'p1'},{command:'ls'},{projectId:'../x',command:'ls'},{projectId:'p1',command:''},{projectId:'p1',command:'ls',timeout:0},{projectId:'p1',command:'ls',timeout:999999},{projectId:'p1',command:'ls',cwd:'/'}])assert.equal((await callTool('run_command',input,{backend})).isError,true,JSON.stringify(input));
 assert.equal(calls.length,before);
 assert.match(TOOL_DEFINITIONS.find(t=>t.name==='run_command').description,/Approvals/);
});
