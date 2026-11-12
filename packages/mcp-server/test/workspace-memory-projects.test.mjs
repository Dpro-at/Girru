// MEM-READ-01 MR3: workspace_memory projects / mark_project. Library folders come back apart as notProjects.
import test from 'node:test';
import assert from 'node:assert/strict';
import {callTool} from '../src/tools.ts';

const p=(slug,extra={})=>({slug,name:slug,memories:3,archived:false,mergedInto:null,...extra});
function fixture(){const calls=[];return {calls,backend:{async request(method,path,body){calls.push({method,path,body});
 if(path==='/api/auth/me')return {user:{id:'owner',role:'owner',status:'active'}};
 if(method==='GET'&&path==='/api/memory/scopes/tree')return {projects:[p('grenzer'),p('bubbletea-v1-3-10',{notProject:true,notProjectReason:'Go library'}),p('old',{archived:true})]};
 if(method==='POST'&&path==='/api/memory/scopes/projects/bubbletea-v1-3-10/kind')return {slug:'bubbletea-v1-3-10',kind:body.kind,before:'library'};
 throw Error('Unexpected '+method+' '+path);}}};}

test('projects lists the owner projects with library folders apart',async()=>{
 const {backend}=fixture();const out=await callTool('workspace_memory',{operation:'projects',scope:'owner'},{backend});
 assert.notEqual(out.isError,true,out.content[0].text);
 assert.deepEqual(out.structuredContent.projects.map(x=>x.slug),['grenzer']);
 assert.deepEqual(out.structuredContent.notProjects,[{slug:'bubbletea-v1-3-10',name:'bubbletea-v1-3-10',memories:3,reason:'Go library'}]);
});
test('mark_project is the owner choice; bad input never reaches the backend',async()=>{
 const {backend,calls}=fixture();const out=await callTool('workspace_memory',{operation:'mark_project',scope:'owner',slug:'bubbletea-v1-3-10',kind:'project'},{backend});
 assert.notEqual(out.isError,true,out.content[0].text);assert.equal(out.structuredContent.kind,'project');
 assert.ok(calls.some(c=>c.method==='POST'&&c.body.kind==='project'));
 for(const bad of [{operation:'mark_project',scope:'project:grenzer',slug:'grenzer',kind:'project'},{operation:'mark_project',scope:'owner',slug:'../x',kind:'project'},{operation:'mark_project',scope:'owner',slug:'grenzer',kind:'maybe'}]){
  calls.length=0;const r=await callTool('workspace_memory',bad,{backend});assert.equal(r.isError,true);assert.equal(calls.length,0);}
});
