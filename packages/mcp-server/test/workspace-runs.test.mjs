import test from 'node:test';import assert from 'node:assert/strict';import {callTool,TOOL_DEFINITIONS} from '../src/tools.ts';
// RUNS-01: the Runs read tool calls only the runs routes; schedule changes stay in the app.
test('workspace_runs reads runs and schedules, stops and retries through the backend gates',async()=>{
 const calls=[],backend={async request(method,path,body){calls.push({method,path,body});if(path.startsWith('/api/runs/item/')&&method==='GET')return {run:{id:'chat:r1'},steps:[],log:[],copy:'Run: x'};if(path.startsWith('/api/runs/schedules'))return {schedules:[],runs:[]};return {runs:[{id:'chat:r1'}],next:5,counts:{running:1,waiting:0},ok:true};}};
 assert.ok(TOOL_DEFINITIONS.some(t=>t.name==='workspace_runs'));
 assert.notEqual((await callTool('workspace_runs',{operation:'list'},{backend})).isError,true);assert.deepEqual(calls.at(-1),{method:'GET',path:'/api/runs?place=running',body:undefined});
 await callTool('workspace_runs',{operation:'list',place:'failed',kind:'job',agentId:'a-1',query:'mail',before:9},{backend});assert.equal(calls.at(-1).path,'/api/runs?place=failed&kind=job&agent=a-1&q=mail&before=9');
 const got=await callTool('workspace_runs',{operation:'get',id:'chat:r1'},{backend});assert.notEqual(got.isError,true);assert.equal(calls.at(-1).path,'/api/runs/item/chat%3Ar1');
 await callTool('workspace_runs',{operation:'schedules'},{backend});assert.equal(calls.at(-1).path,'/api/runs/schedules');
 await callTool('workspace_runs',{operation:'schedule_runs',id:'job:abc'},{backend});assert.equal(calls.at(-1).path,'/api/runs/schedules/job%3Aabc/runs');
 await callTool('workspace_runs',{operation:'stop',id:'task:t1'},{backend});assert.deepEqual(calls.at(-1),{method:'POST',path:'/api/runs/item/task%3At1/stop',body:{}});
 await callTool('workspace_runs',{operation:'retry',id:'chat:r1'},{backend});assert.deepEqual(calls.at(-1),{method:'POST',path:'/api/runs/item/chat%3Ar1/retry',body:{}});
 await callTool('workspace_runs',{operation:'schedule_task',instructions:'Sum up the mails',every:'daily',at:'08:30',notify:'all',newChat:false},{backend});assert.deepEqual(calls.at(-1),{method:'POST',path:'/api/runs/schedules',body:{instructions:'Sum up the mails',every:'daily',at:'08:30',notify:'all',newChat:false}});
 const before=calls.length;
 for(const input of [{operation:'pause',id:'job:a'},{operation:'resume'},{operation:'run_now',id:'job:a'},{operation:'list',place:'everything'},{operation:'list',kind:'x'},{operation:'get',id:'../x'},{operation:'get'},{operation:'schedule_runs',id:'chat:r1'},{operation:'list',before:-1},{operation:'list',extra:1},{operation:'stop',id:'x'},{operation:'schedule_task',instructions:'',every:'daily',at:'08:30'},{operation:'schedule_task',instructions:'x',every:'monthly',at:'08:30'},{operation:'schedule_task',instructions:'x',every:'daily',at:'8'},{operation:'schedule_task',instructions:'x',every:'daily',at:'08:30',action:'api-call'}])assert.equal((await callTool('workspace_runs',input,{backend})).isError,true,JSON.stringify(input));
 assert.equal(calls.length,before,'refused calls reach nothing');
 assert.match((await callTool('workspace_runs',{operation:'pause',id:'job:a'},{backend})).content[0].text,/Runs › Scheduled/);
});
test('the footer tool knows the runs section',async()=>{
 const calls=[],backend={async request(method,path,body){calls.push({method,path,body});return {footer:{}};}};
 assert.notEqual((await callTool('workspace_footer',{operation:'set',hidden:['runs']},{backend})).isError,true);assert.deepEqual(calls.at(-1).body,{hidden:['runs']});
 assert.match(TOOL_DEFINITIONS.find(t=>t.name==='workspace_footer').description,/runs/);
});
