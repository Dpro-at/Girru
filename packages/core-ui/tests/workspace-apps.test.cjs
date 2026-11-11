require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict');
const {allowedRequest,SessionClient}=require('../src/session.ts'),{allowed,project}=require('../scripts/application-server.cjs');
const {WORKSPACE_APPS_PATH,workspaceAppsResponse}=require('../src/apps-contract.js');
const sample={id:'mcp:00000000-0000-0000-0000-000000000001',name:'A connection',kind:'mcp',summary:'Tools',version:null,state:'disabled',sourceId:'00000000-0000-0000-0000-000000000001',permissions:['Choose agent access'],tools:0,removable:true};
test('unified app transport is exact, read-only and projects no secret or executable fields',()=>{
 for(const gate of [allowedRequest,allowed]){assert.equal(gate('GET',WORKSPACE_APPS_PATH),true);for(const path of ['/api/apps?url=/private','/api/apps/../secrets','/api/apps/','/api/apps%2f'])assert.equal(gate('GET',path),false);assert.equal(gate('POST',WORKSPACE_APPS_PATH,{}),false);assert.equal(gate('GET',WORKSPACE_APPS_PATH,{}),false);}
 const out=workspaceAppsResponse(200,{items:[{...sample,env:{secret:'PRIVATE-SECRET'},command:'PRIVATE-COMMAND',url:'PRIVATE-URL'}]});assert.ok(!JSON.stringify(out).includes('PRIVATE-'));assert.deepEqual(out,workspaceAppsResponse(200,out));
 assert.throws(()=>workspaceAppsResponse(200,{items:[sample,sample]}));assert.throws(()=>workspaceAppsResponse(200,{items:[{...sample,sourceId:'other'}]}));assert.throws(()=>workspaceAppsResponse(200,{items:[{...sample,kind:'builtin'}]}));assert.throws(()=>workspaceAppsResponse(200,{items:[{...sample,state:'installed-and-running'}]}));assert.throws(()=>workspaceAppsResponse(200,{items:Array(1001).fill(sample)}));assert.deepEqual(workspaceAppsResponse(503,{secret:'private'}),{code:'apps_unavailable'});
});
test('member session cannot forward the unified inventory',async()=>{
 let forwarded=0;const user={id:'apps-member',email:'member@example.invalid',username:'Member',role:'user'};const c=new SessionClient({mock:async r=>{if(r.path==='/api/auth/login')return {status:200,body:{token:'fixture',user}};if(r.path==='/api/auth/me')return {status:200,body:{user}};forwarded++;return {status:200,body:{items:[]}};}});c.selectMode('mock');await c.login(user.email,'fixture');await assert.rejects(c.request({method:'GET',path:WORKSPACE_APPS_PATH}));assert.equal(forwarded,0);
});

test('Store Browser app identity offers the same owner open action as the Browser workspace',()=>{
 const {tileActions}=require('../src/WorkspaceApplications.tsx');let opened=0;
 const actions=tileActions({id:'app:browser',kind:'added',name:'Browser'},{owner:true},{open:()=>opened++,onPermissions:()=>{},onAccountConnections:()=>{},canOpen:true});
 assert.equal(actions[0].label,'Open Browser');actions[0].run();assert.equal(opened,1);
 const disabled=tileActions({id:'app:browser',kind:'added',name:'Browser'},{owner:true},{open:()=>opened++,onPermissions:()=>{},onAccountConnections:()=>{},canOpen:false});assert.equal(disabled[0].disabled,true);
});
