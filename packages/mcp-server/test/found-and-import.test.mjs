import test from 'node:test';import assert from 'node:assert/strict';import {callTool,TOOL_DEFINITIONS} from '../src/tools.ts';
const scanId='33333333-3333-4333-8333-333333333333',sourceId='44444444-4444-4444-8444-444444444444',hash='b'.repeat(64),root='a'.repeat(32);
const view={scannedAt:'2026-10-26T10:00:00.000Z',roots:[{id:root,name:'agent_player',path:'/Users/x/private/agent_player'}],items:[
 {id:'1'.repeat(32),kind:'skill',name:'content-studio',from:'~/.claude/skills/content-studio/SKILL.md',rootId:root,state:'new',text:'SECRET-TEXT'},
 {id:'2'.repeat(32),kind:'mcp',name:'calendar',from:'~/.claude.json · 1 secret inside',rootId:null,state:'imported',env:{KEY:'sk-live-value'}},
 {id:'3'.repeat(32),kind:'mcp',name:'hidden-one',from:'~/.codex/config.toml',rootId:null,state:'ignored'},
 {id:'4'.repeat(32),kind:'ssh',name:'prod',from:'~/.ssh/config',rootId:null,state:'new'}]};
function fixture(preview={name:'files',transport:'stdio',command:'npx',args:['files-mcp'],url:null,envNames:[],headerNames:[],hash,existingId:null}){
 const calls=[];const backend={async request(method,path,body){calls.push({method,path,body});
  if(path==='/api/memory/import/discovery')return view;
  if(path==='/api/mcp-import/found')return {rows:[{key:'c'.repeat(64),name:'calendar',transport:'stdio',target:'npx calendar',secretNames:['KEY'],sources:[{origin:'Claude',file:'/Users/x/.claude.json',key:'calendar'},{origin:'Codex',file:'/Users/x/.codex/config.toml',key:'calendar'}],state:'added',serverId:null,issue:null,env:{KEY:'sk-live-value'}}],girru:[{name:'dpro-memory',title:'Girru memory',apps:['Claude']}],skipped:0};
  if(path==='/api/mcp-import/scan')return {id:scanId,skipped:0,sources:[{id:sourceId,name:'files',origin:'claude',supported:true,issue:null}]};
  if(path==='/api/mcp-import/preview')return preview;
  if(path==='/api/mcp-import/import')return {id:'00000000-0000-0000-0000-000000000009',duplicate:false};
  throw Error('unexpected '+path);}};return {backend,calls};}
test('found lists what was found elsewhere: names, places and state only, read only',async()=>{
 const f=fixture();
 const skills=await callTool('skill_library',{operation:'found'},{backend:f.backend});assert.notEqual(skills.isError,true);
 assert.deepEqual(skills.structuredContent.items,[{name:'content-studio',place:'agent_player',state:'new'}]);
 const mcp=await callTool('workspace_apps',{operation:'found'},{backend:f.backend});assert.notEqual(mcp.isError,true);
 assert.deepEqual(mcp.structuredContent.rows,[{name:'calendar',state:'added',kind:'program',from:['Claude','Codex'],secretNames:['KEY']}]);
 assert.deepEqual(mcp.structuredContent.girru,[{name:'Girru memory',writtenInto:['Claude']}]);
 const text=JSON.stringify([skills,mcp]);assert.doesNotMatch(text,/SKILL\.md|\.claude|private|SECRET-TEXT|sk-live|hidden-one|prod/);
 assert.ok(f.calls.every(c=>c.method==='GET'&&['/api/memory/import/discovery','/api/mcp-import/found'].includes(c.path)));
 for(const [tool,args] of [['skill_library',{operation:'found',id:'x'}],['workspace_apps',{operation:'found',scanId}]]){const n=f.calls.length;assert.equal((await callTool(tool,args,{backend:f.backend})).isError,true);assert.equal(f.calls.length,n);}
});
test('adding what the folder scan found is refused with a clear owner-in-the-app message',async()=>{
 const f=fixture();
 for(const [tool,args] of [['skill_library',{operation:'add_found'}],['skill_library',{operation:'import_found'}],['workspace_apps',{operation:'add_found'}],['workspace_apps',{operation:'import_found'}]]){const r=await callTool(tool,args,{backend:f.backend});assert.equal(r.isError,true);assert.match(r.content[0].text,/owner in the app/);}
 assert.equal(f.calls.length,0);
});
test('coding-app connections: look and preview read; import is bound to the hash and always lands off',async()=>{
 const f=fixture();
 const look=await callTool('workspace_apps',{operation:'look'},{backend:f.backend});assert.notEqual(look.isError,true);assert.deepEqual(f.calls.at(-1),{method:'POST',path:'/api/mcp-import/scan',body:{}});assert.equal(look.structuredContent.sources[0].id,sourceId);
 const p=await callTool('workspace_apps',{operation:'preview',scanId,sourceId},{backend:f.backend});assert.notEqual(p.isError,true);assert.deepEqual(f.calls.at(-1),{method:'POST',path:'/api/mcp-import/preview',body:{scanId,sourceId}});assert.equal(p.structuredContent.hash,hash);assert.equal(p.structuredContent.ownerOnly,false);
 const i=await callTool('workspace_apps',{operation:'import',scanId,sourceId,hash},{backend:f.backend});assert.notEqual(i.isError,true);
 assert.deepEqual(f.calls.at(-1),{method:'POST',path:'/api/mcp-import/import',body:{scanId,sourceId,hash}});assert.equal(i.structuredContent.enabled,false);
 assert.ok(!f.calls.some(c=>/enable|approve|grant|secret|credential/.test(c.path)),'never turns on, allows a program or touches secrets');
});
test('import refusals: no hash, a changed hash, secrets, extra fields or bad ids never import',async()=>{
 const f=fixture();
 for(const args of [{operation:'import',scanId,sourceId},{operation:'import',scanId,sourceId,hash:'x'},{operation:'import',scanId:'../x',sourceId,hash},{operation:'import',scanId,sourceId,hash,enabled:true},{operation:'import',scanId,sourceId,hash,env:{KEY:'v'}},{operation:'preview',scanId},{operation:'look',scanId},{operation:'enable',id:sourceId}]){const n=f.calls.length;assert.equal((await callTool('workspace_apps',args,{backend:f.backend})).isError,true,JSON.stringify(args));assert.equal(f.calls.length,n,JSON.stringify(args));}
 const changed=await callTool('workspace_apps',{operation:'import',scanId,sourceId,hash:'c'.repeat(64)},{backend:f.backend});assert.equal(changed.isError,true);assert.match(changed.content[0].text,/changed/);
 const s=fixture({name:'paid',transport:'http',command:null,args:[],url:'https://example.test/mcp',envNames:[],headerNames:['Authorization'],hash,existingId:null});
 const p=await callTool('workspace_apps',{operation:'preview',scanId,sourceId},{backend:s.backend});assert.equal(p.structuredContent.ownerOnly,true);assert.deepEqual(p.structuredContent.secretNames,['Authorization']);
 const r=await callTool('workspace_apps',{operation:'import',scanId,sourceId,hash},{backend:s.backend});assert.equal(r.isError,true);assert.match(r.content[0].text,/secrets/);
 assert.ok(!f.calls.concat(s.calls).some(c=>c.path==='/api/mcp-import/import'));
});
test('descriptions say writes need the owner’s explicit instruction and turning on stays in the app',()=>{
 const apps=TOOL_DEFINITIONS.find(t=>t.name==='workspace_apps'),skills=TOOL_DEFINITIONS.find(t=>t.name==='skill_library');
 for(const op of ['found','look','preview','import'])assert.ok(apps.inputSchema.properties.operation.enum.includes(op),op);
 assert.ok(skills.inputSchema.properties.operation.enum.includes('found'));
 assert.match(apps.description,/explicit instruction/);assert.match(apps.description,/always off/);assert.match(apps.description,/turning on/);
 assert.match(skills.description,/Write only on the owner’s explicit instruction: add/);
 for(const t of [apps,skills])assert.ok(!t.inputSchema.properties.operation.enum.some(o=>/enable|add_found|import_found|grant|secret/.test(o)));
});
