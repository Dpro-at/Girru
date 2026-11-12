import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-apps-'));process.env.AGENT_PLAYER_DATA_DIR=root;process.env.DATABASE_PATH=path.join(root,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');delete process.env.AGENT_EXEC_TOOLS;
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
for(const [id,role]of [['apps-owner','owner'],['apps-admin','admin'],['apps-member','user']])db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,'fixture',?,'active')").run(id,id+'@example.invalid',id,role);
const {default:Fastify}=await import('fastify'),{registerAuthGate}=await import('../src/auth/auth-gate.ts'),{generateToken}=await import('../src/auth/jwt.ts'),{workspaceAppsRoutes}=await import('../src/api/routes/workspace-apps.ts'),{mcpServersRoutes}=await import('../src/api/routes/mcp-servers.ts'),{listWorkspaceApps}=await import('../src/services/workspace-apps.ts');
const app=Fastify();registerAuthGate(app);await app.register(workspaceAppsRoutes);await app.register(mcpServersRoutes);await app.ready();
const h=id=>({authorization:'Bearer '+generateToken(id,1)}),owner=h('apps-owner');
const get=()=>app.inject({url:'/api/apps',headers:owner});
test.after(async()=>{await app.close();closeDatabase();fs.rmSync(root,{recursive:true,force:true});});
test('app inventory is owner-only and rejects query/mutation escape hatches',async()=>{
 assert.equal((await app.inject({url:'/api/apps'})).statusCode,401);
 for(const id of ['apps-admin','apps-member'])assert.equal((await app.inject({url:'/api/apps',headers:h(id)})).statusCode,403);
 assert.equal((await app.inject({url:'/api/apps?url=https://example.invalid',headers:owner})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url:'/api/apps',headers:owner,payload:{install:'anything'}})).statusCode,404);
});
test('one inventory joins existing registries without duplicate GenVR or a second installation table',async()=>{
 const tables=()=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();await (await import('../src/services/genvr-account.ts')).genvrConnection('apps-owner');const before=tables();
 const result=await get();assert.equal(result.statusCode,200,result.body);assert.equal(result.headers['cache-control'],'no-store');
 assert.deepEqual(result.json().items.map(x=>[x.id,x.kind]),[['terminal','builtin'],['code','builtin'],['genvr','api']]);assert.equal(result.json().items.find(x=>x.id==='genvr').state,'not_connected');assert.ok(result.json().items.find(x=>x.id==='genvr').permissions.includes('Account access is reviewed in Apps › Accounts'));assert.ok(!JSON.stringify(result.json()).includes('reviewed in Connections'));assert.deepEqual(tables(),before);
});
test('adding, duplicate refusal, disabling and removal reuse the actual MCP registry',async()=>{
 const created=await app.inject({method:'POST',url:'/api/mcp/servers',headers:owner,payload:{name:'sample-app',description:'A synthetic tool connection',transport:'http',url:'http://127.0.0.1:9/mcp'}});
 assert.equal(created.statusCode,201,created.body);const server=created.json();assert.equal(server.enabled,false);
 const row=(await get()).json().items.find(x=>x.id==='mcp:'+server.id);assert.equal(row.kind,'mcp');assert.equal(row.state,'disabled');assert.equal(row.removable,true);assert.equal(row.sourceId,server.id);
 const duplicate=await app.inject({method:'POST',url:'/api/mcp/servers',headers:owner,payload:{name:'sample-app',transport:'http',url:'http://127.0.0.1:9/mcp'}});assert.ok([400,409].includes(duplicate.statusCode));assert.equal((await get()).json().items.filter(x=>x.sourceId===server.id).length,1);
 assert.equal((await app.inject({method:'POST',url:'/api/mcp/servers/'+server.id+'/disable',headers:owner})).statusCode,200);
 assert.equal((await app.inject({method:'DELETE',url:'/api/mcp/servers/'+server.id,headers:owner})).statusCode,200);assert.ok(!(await get()).json().items.some(x=>x.sourceId===server.id));
});
test('inventory strips executable, URL, secret and account payloads and derives honest states',async()=>{
 const id='00000000-0000-0000-0000-000000000001';let live='connected',enabled=true,active=true,lastError=null;
 const account={id:'genvr',status:'connected',account:{name:'PRIVATE-ACCOUNT'},scopes:[],pending:{userCode:'PRIVATE-CODE'},accessToken:'PRIVATE-TOKEN'};
 const source={servers:async()=>[{id,name:'fixture',description:'Tools',get enabled(){return enabled;},get active(){return active;},get lastError(){return lastError;},transport:'stdio',tools:[{}],command:'PRIVATE-COMMAND',env:{key:'PRIVATE-SECRET'},headers:{Authorization:'PRIVATE-HEADER'},url:'PRIVATE-URL'}],account:async user=>{assert.equal(user,'apps-owner');return account;},state:()=>live};
 let result=await listWorkspaceApps('apps-owner',source);assert.ok(!JSON.stringify(result).includes('PRIVATE-'));assert.equal(result.items.at(-1).state,'connected');assert.equal(result.items.at(-1).tools,1);
 for(const [on,allowed,error,state]of [[false,true,null,'disabled'],[true,false,null,'attention'],[true,true,'failed','attention']]){enabled=on;active=allowed;lastError=error;assert.equal((await listWorkspaceApps('apps-owner',source)).items.at(-1).state,state);}
 enabled=true;active=true;lastError=null;live='disconnected';assert.equal((await listWorkspaceApps('apps-owner',source)).items.at(-1).state,'disconnected');
});
test('a failed source is unavailable instead of fabricating a disconnected app list',async()=>{
 const unavailable=Fastify();unavailable.decorateRequest('authUser',null);unavailable.addHook('onRequest',async request=>{request.authUser={id:'apps-owner',role:'owner'};});await unavailable.register(workspaceAppsRoutes,{sources:{servers:async()=>{throw Error('PRIVATE-FAILURE');},account:async()=>({status:'not_connected'}),state:()=>''}});
 const r=await unavailable.inject({url:'/api/apps'});assert.equal(r.statusCode,503);assert.deepEqual(r.json(),{code:'apps_unavailable'});await unavailable.close();
});

test('GenVR runtime removal is separate from the preserved account connection',async()=>{
 const source={servers:async()=>[],account:async()=>({status:'connected'}),state:()=>'',genvr:()=>null};
 const item=async()=> (await listWorkspaceApps('apps-owner',source)).items.find(x=>x.id==='genvr');
 assert.equal((await item()).runtime,'missing');assert.equal((await item()).removable,false);
 source.genvr=()=>({source:'installed',version:'0.3.0-preview.22'});
 assert.equal((await item()).runtime,'installed');assert.equal((await item()).removable,true);assert.equal((await item()).state,'connected');
 source.genvr=()=>({source:'bundled',version:'0.3.0-preview.22'});
 assert.equal((await item()).removable,false);
});

test('real My apps metadata remains available without an SDK after removal',async()=>{
 const oldRoot=process.env.GIRRU_APP_RUNTIMES_DIR,oldBundled=process.env.GIRRU_GENVR_BUNDLED;
 process.env.GIRRU_APP_RUNTIMES_DIR=path.join(root,'empty-runtimes');process.env.GIRRU_GENVR_BUNDLED='0';
 try{const response=await get();assert.equal(response.statusCode,200);assert.equal(response.json().items.find(x=>x.id==='genvr').runtime,'missing');}
 finally{if(oldRoot===undefined)delete process.env.GIRRU_APP_RUNTIMES_DIR;else process.env.GIRRU_APP_RUNTIMES_DIR=oldRoot;if(oldBundled===undefined)delete process.env.GIRRU_GENVR_BUNDLED;else process.env.GIRRU_GENVR_BUNDLED=oldBundled;}
});
