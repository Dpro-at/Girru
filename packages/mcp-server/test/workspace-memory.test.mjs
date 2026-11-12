import test from 'node:test';
import assert from 'node:assert/strict';
import {callTool,TOOL_DEFINITIONS,publicToolCatalogue} from '../src/tools.ts';
import {BackendError} from '../src/backend.ts';

const scope='project:demo-project',resource='memory-1',proposalId='proposal-1';
const memory={id:resource,drawerId:scope,type:'fact',content:'The synthetic release is Friday.',preview:'Release is Friday.',importance:8,layer:'factual',createdAt:'2026-11-08T12:00:00Z',source:'owner',usedIn:2,trust:'checked',validity:{version:3,trust:'checked'},metadata:{token:'secret-value'},embedding:[1,2],userId:'owner-private',system_prompt:'internal prompt'};
const review={id:proposalId,drawerId:scope,status:'pending',source:'learning',baseRevision:2,createdAt:'2026-11-08T12:00:00Z',note:'Check the date',counts:{add:0,update:1,delete:0},userId:'owner-private',baseHash:'secret-hash',reviewHash:'approval-secret',changes:[{op:'update',id:resource,before:{type:'fact',importance:8,content:'Thursday'},after:{type:'fact',importance:8,content:'Friday'}}]};
function fixture(extra={}){const calls=[];const routes={
 '/api/memory/mcp-proposals/context?scope=project%3Ademo-project':{scope,revision:2},
 '/api/auth/me':{user:{id:'owner',role:'owner',status:'active'}},
 '/api/memory/scopes/memories?scope=project%3Ademo-project&limit=20&q=release':{scope,items:[memory],total:1,nextCursor:null},
 '/api/memory/scopes/memories?scope=project%3Ademo-project&limit=1':{scope,items:[memory],total:1,facets:{type:{fact:1},layer:{factual:1}}},
 ['/api/memory/scopes/memories/'+resource]:{memory},
 ['/api/memory/'+resource+'/versions']:{memoryId:resource,versions:[{memoryId:resource,drawerKind:'project',drawerKey:'demo-project',version:1,change:'create',type:'fact',content:'Thursday',createdAt:'2026-11-07T12:00:00Z',snapshot:'SECRET-SNAPSHOT'}]},
 '/api/memory/proposals?status=pending':{proposals:[review,{...review,id:'foreign-review',drawerId:'project:other'}]},
 ['/api/memory/proposals/'+proposalId]:review,...extra};
 return {calls,backend:{async request(method,path,body){calls.push({method,path,body});assert.equal(method,'GET');assert.equal(body,undefined);if(!Object.hasOwn(routes,path))throw Error('Unexpected '+path);if(routes[path]instanceof Error)throw routes[path];return structuredClone(routes[path]);}}};}

test('workspace_memory exposes read-only schema and exact scoped routes without models or writes',async()=>{
 const {calls,backend}=fixture();const outputs=[];
 for(const args of [{operation:'search',scope,query:'release'},{operation:'read',scope,id:resource},{operation:'versions',scope,id:resource},{operation:'status',scope},{operation:'reviews',scope},{operation:'review',scope,id:proposalId}]){
  const out=await callTool('workspace_memory',args,{backend});assert.notEqual(out.isError,true,out.content[0].text);outputs.push(out);
 }
 assert.equal(calls.length,14);assert.ok(calls.every(c=>c.method==='GET'&&c.body===undefined));assert.equal(outputs[0].structuredContent.searchKind,'saved_text_filter');assert.equal(outputs[0].structuredContent.modelCalls,0);assert.equal(outputs[1].structuredContent.memory.version,3);assert.equal(outputs[2].structuredContent.versions[0].content,'Thursday');assert.equal(outputs[3].structuredContent.types.fact,1);assert.equal(outputs[4].structuredContent.proposals.length,1);assert.equal(outputs[5].structuredContent.changes[0].after.content,'Friday');
 assert.doesNotMatch(JSON.stringify(outputs),/secret-value|owner-private|internal prompt|approval-secret|secret-hash|SECRET-SNAPSHOT|foreign-review|embedding/);
 const def=TOOL_DEFINITIONS.find(t=>t.name==='workspace_memory');assert.equal(def.annotations.readOnlyHint,false);assert.equal(def.inputSchema.additionalProperties,false);assert.deepEqual(def.inputSchema.required,['operation','scope']);
});

test('workspace_memory rejects unknown fields, implicit scope, write operations and invalid bounds before any request',async()=>{
 const {calls,backend}=fixture();const inputs=[{}, {operation:'search',query:'x'},{operation:'search',scope:'company',query:'x'},{operation:'search',scope:'kind:project',query:'x'},{operation:'search',scope:'project:../x',query:'x'},{operation:'search',scope:'task:a/b',query:'x'},
 ...['save','correct','approve','reject','restore','forget','delete','empty','access'].map(operation=>({operation,scope})),
 {operation:'read',scope,id:'../secret'},{operation:'read',scope,id:resource,ownerId:'other'},{operation:'search',scope,query:' '},{operation:'search',scope,query:'x',limit:0},{operation:'search',scope,query:'x',limit:51},{operation:'search',scope,query:'x',cursor:'x&owner=other'},{operation:'versions',scope,id:resource,limit:21},{operation:'status',scope,fresh:true},{operation:'reviews',scope,status:'any'},{operation:'review',scope,id:proposalId,body:{confirmed:true}}];
 for(const input of inputs){const out=await callTool('workspace_memory',input,{backend});assert.equal(out.isError,true,JSON.stringify(input));assert.match(out.content[0].text,/Invalid arguments/);}
 assert.equal(calls.length,0);
});

test('workspace_memory requires an active owner and preserves backend denial after revocation',async()=>{
 for(const user of [{role:'user',status:'active'},{role:'owner',status:'disabled'},{role:'admin',status:'active'}]){const {calls,backend}=fixture({'/api/memory/mcp-proposals/context?scope=project%3Ademo-project':{scope,revision:2},
 '/api/auth/me':{user}});const out=await callTool('workspace_memory',{operation:'status',scope},{backend});assert.equal(out.isError,true);assert.equal(calls.length,1);assert.match(out.content[0].text,/active owner/);}
 for(const status of [401,403,404,409]){const {backend}=fixture({['/api/memory/scopes/memories/'+resource]:new BackendError('Denied after scope changed',status)});const out=await callTool('workspace_memory',{operation:'read',scope,id:resource},{backend});assert.equal(out.isError,true);assert.match(out.content[0].text,/Denied after scope changed/);}
});

test('workspace_memory refuses cross-drawer results and history before exposing text',async()=>{
 for(const operation of ['read','versions']){const {calls,backend}=fixture({['/api/memory/scopes/memories/'+resource]:{memory:{...memory,drawerId:'project:other',content:'FOREIGN-TEXT'}}});const out=await callTool('workspace_memory',{operation,scope,id:resource},{backend});assert.equal(out.isError,true);assert.equal(calls.length,2);assert.doesNotMatch(JSON.stringify(out),/FOREIGN-TEXT/);}
 const {backend}=fixture({['/api/memory/'+resource+'/versions']:{memoryId:resource,versions:[{memoryId:resource,drawerKind:'project',drawerKey:'other',content:'FOREIGN-HISTORY'}]}});const out=await callTool('workspace_memory',{operation:'versions',scope,id:resource},{backend});assert.equal(out.isError,true);assert.doesNotMatch(JSON.stringify(out),/FOREIGN-HISTORY/);
 const other=fixture({['/api/memory/proposals/'+proposalId]:{...review,drawerId:'project:other',note:'FOREIGN-NOTE'}});const rejected=await callTool('workspace_memory',{operation:'review',scope,id:proposalId},{backend:other.backend});assert.equal(rejected.isError,true);assert.doesNotMatch(JSON.stringify(rejected),/FOREIGN-NOTE/);
});

test('workspace_memory uses exact drawer keys, bounded results and opaque cursor encoding',async()=>{
 const path='/api/memory/scopes/memories?scope=project%3Ademo-project&limit=1&q=release&cursor=abc%2B%2F%3D';const {calls,backend}=fixture({[path]:{scope,items:[memory],total:2,nextCursor:'next_cursor'}});
 const out=await callTool('workspace_memory',{operation:'search',scope,query:' release ',limit:1,cursor:'abc+/='},{backend});assert.notEqual(out.isError,true);assert.equal(calls.at(-1).path,path);assert.equal(out.structuredContent.nextCursor,'next_cursor');
 const stale=fixture({'/api/memory/scopes/memories?scope=project%3Ademo-project&limit=20&q=release':{scope:'project:new-key',items:[],total:0}});assert.equal((await callTool('workspace_memory',{operation:'search',scope,query:'release'},{backend:stale.backend})).isError,true);
});

test('workspace_memory strips credential-shaped content and truncates current text',async()=>{
 const content='password=never-return-me Bearer secret-token sk-abcdefghijklmnop -----BEGIN PRIVATE KEY-----secret body-----END PRIVATE KEY-----\n'+'x'.repeat(13000);
 const {backend}=fixture({['/api/memory/scopes/memories/'+resource]:{memory:{...memory,content}}});const out=await callTool('workspace_memory',{operation:'read',scope,id:resource},{backend});assert.notEqual(out.isError,true);assert.equal(out.structuredContent.memory.redacted,true);assert.equal(out.structuredContent.memory.contentTruncated,true);assert.doesNotMatch(JSON.stringify(out),/never-return-me|secret-token|sk-abcdefghijklmnop|secret body/);assert.ok(Buffer.byteLength(JSON.stringify(out.structuredContent))<13000);
});

test('public catalogue covers definitions and registered dispatch and matches README rows',async()=>{
 const {readFileSync}=await import('node:fs');const catalogue=publicToolCatalogue();assert.equal(catalogue.length,TOOL_DEFINITIONS.length);assert.equal(new Set(catalogue.map(x=>x.name)).size,catalogue.length);assert.equal(catalogue.length,30);
 const readme=readFileSync(new URL('../README.md',import.meta.url),'utf8');const documented=[...readme.matchAll(/^\| `([^`]+)` \|/gm)].map(m=>m[1]);assert.deepEqual(documented.sort(),catalogue.map(t=>t.name).sort());
 for(const t of catalogue){const documentedRow=readme.split('\n').find(line=>line.startsWith('| `'+t.name+'` |'));for(const op of t.operations)assert.ok(documentedRow.includes('`'+op+'`'),'Missing operation documentation '+t.name+'.'+op);const out=await callTool(t.name,{}, {backend:{async request(){throw new BackendError('Synthetic denial',403);}}});assert.doesNotMatch(out.content[0].text,/^Unknown tool/);assert.ok(readme.includes('`'+t.name+'`'));}
});


test('workspace_memory prepares proposals without exposing approval authority',async()=>{
 const calls=[];const backend={async request(method,path,body){calls.push({method,path,body});if(path==='/api/auth/me')return {user:{role:'owner',status:'active'}};assert.equal(method,'POST');assert.equal(path,'/api/memory/mcp-proposals');return {proposalId:'proposal-new',scope,status:'pending',saved:false,replayed:false};}};
 const add={operation:'propose_add',scope,agentId:'existing-agent',requestId:'request-1',expectedRevision:0,after:{type:'fact',importance:7,content:'Synthetic proposed fact'}};
 const response=await callTool('workspace_memory',add,{backend});assert.notEqual(response.isError,true);assert.equal(response.structuredContent.pendingApproval,true);assert.equal(response.structuredContent.saved,false);assert.equal(calls.length,2);assert.deepEqual(calls[1].body,add);assert.match(response.content[0].text,/No approved memory was saved/);
 for(const input of [{...add,userId:'foreign'},{...add,source:'agent'},{...add,after:{...add.after,content:' '}},{...add,agentId:undefined},{...add,requestId:'../bad'},{...add,expectedRevision:undefined},{...add,operation:'propose_update',id:'memory-1',expectedVersion:1},{...add,after:{...add.after,type:'executable'}},{...add,after:{...add.after,confirmed:true}}]){calls.length=0;const out=await callTool('workspace_memory',input,{backend});assert.equal(out.isError,true);assert.equal(calls.length,0);}
});
