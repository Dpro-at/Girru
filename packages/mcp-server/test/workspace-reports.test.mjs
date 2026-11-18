import test from 'node:test';
import assert from 'node:assert/strict';
import {callTool} from '../src/tools.ts';
test('Reports dispatch keeps explicit owner scope and separates publication from runs',async()=>{
 const calls=[];const backend={async request(method,path,body){calls.push({method,path,body});if(path==='/api/auth/me')return {user:{role:'owner',status:'active'}};return {reportId:'r-1',snapshotId:'s-1',sourceKind:'external_prepared'};}};
 const publication={requestId:'request-1',expectedRevision:1,projectId:null,sections:[{id:'summary',document:{schemaVersion:1,root:'r',elements:{r:{type:'Text',props:{content:'Synthetic prepared result'},children:[]}}}}]};
 const out=await callTool('workspace_reports',{operation:'publish',id:'r-1',publication},{backend});assert.notEqual(out.isError,true);assert.deepEqual(calls[1],{method:'POST',path:'/api/reports/r-1/publish',body:publication});assert.match(out.content[0].text,/no provider run/);
 for(const args of [{operation:'run',id:'r-1'},{operation:'schedule',id:'r-1'},{operation:'publish',id:'../bad',publication},{operation:'publish',id:'r-1',publication:{...publication,userId:'foreign'}},{operation:'publish',id:'r-1',publication:{...publication,projectId:undefined}},{operation:'publish',id:'r-1',publication:{...publication,sections:[]}}]){calls.length=0;assert.equal((await callTool('workspace_reports',args,{backend})).isError,true);assert.equal(calls.length,0);}
});
