import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import Module from 'node:module';
import ts from 'typescript';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../src');
// Compile actual modules with explicit test dependencies. Any unlisted import fails closed.
function load(file,dependencies){const filename=path.join(source,file),module=new Module(filename);module.filename=filename;module.require=name=>{if(!(name in dependencies))throw Error('Unexpected dependency: '+name);return dependencies[name];};module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);return module.exports;}
let facts,reads,calls,approvals,mode,granted,tickets,views;
function reset(){facts={role:'owner',is_primary:1,parent_agent_id:null,agent_id:'main',archived_at:null};reads=0;calls=[];approvals=0;mode='allow';granted=true;tickets=new WeakSet();views=[];}
function stepRun(step){let next=step.next();while(!next.done){reads++;next=step.next(next.value==='all'?[]:facts);}return next.value;}
const sqlModule={one:function*(...args){return yield args;},all:function*(){return yield 'all';},sql:()=>({read:async step=>stepRun(step)}),sqliteSync:stepRun};
const actorModule={userActor:x=>Object.freeze({kind:'user',userId:x.id,role:x.role}),actorFromToolContextAsync:async c=>({kind:'agent',userId:c.userId,agentId:c.agentId,role:'owner'})};
const authority=load('tools/tasks/team-admin-authority.ts',{'../../repositories/sql-steps.js':sqlModule,'../../repositories/actor.js':actorModule});
const agents={listConfigs:async()=>[],getConfig:async()=>({id:'worker',name:'Before',version:3}),createConfig:async(a,d)=>{calls.push({action:'create',actor:a,draft:d});return {id:'new',name:d.name,version:1,api_key:'NEVER-RETURN',api_key_credential_id:'NEVER-RETURN'};},updateConfig:async(a,id,d)=>{calls.push({action:'update',actor:a,id,draft:d});return {id,name:d.name??'Before',version:4};}};
class Personalities{async initialize(){}async list(){return [];}async read(id){return {id};}async preview(id,draft){return {id,draft,confirmation:'impact'};}async assignment(id){return {id};}async save(owner,id,draft){calls.push({action:'personality.save',owner,id,draft});return {id,revision:2};}async assign(owner,id,draft){calls.push({action:'personality.assign',owner,id,draft});return {version:4};}async tune(){return {};}async mode(){return {};}}
class Specialties{async list(){return [];}async read(id){return {id};}async impact(id,draft){return {id,draft};}async assigned(id){return {id};}async save(id,draft){calls.push({action:'specialty.save',id,draft});return {id};}async link(owner,id,draft){calls.push({action:'specialty.link',owner,id,draft});return {};}}
const admin=load('tools/tasks/team-admin.ts',{'node:crypto':{randomUUID:()=> 'generated-test-id'},'./team-admin-authority.js':authority,'../../repositories/index.js':{repositories:{agents,audit:{record:async(actor,entry)=>calls.push({action:'audit',actor,entry})}}},'../../services/personality-library.js':{PersonalityLibrary:Personalities},'../../services/specialty-templates.js':{SpecialtyTemplates:Specialties},'../../services/model-catalogue.js':{loadModelCatalogue:async()=>({models:[{id:'local',provider:'local'}]}),canonicalModelSelection:()=>({model:'local',provider:'local'})},'../../services/task-file.js':{agentRenamed:async id=>calls.push({action:'renamed',id})},'../../services/personality-store.js':{getCurrentPersonality:async()=>({version:3,locked:false})},'../../services/personality-record.js':{writePersonalityView:async id=>views.push(id)},'../../repositories/sql-steps.js':sqlModule});
const grantModule={defaultGrants:()=>({}),isToolGranted:()=>granted,grantCallRefusal:()=>granted?null:{content:[],error:'grant_refused'}};
const {ToolsRegistry}=load('tools/registry.ts',{
 './tasks/team-admin-authority.js':authority,'../auth/verification/reviewer-quorum.js':{requiresReviewerApproval:async()=>false},'../services/chat-run-context.js':{currentChatRun:()=>undefined},'./agent-permissions.js':{modeFor:()=>mode,permissionCategory:()=> 'settings'},'./exec-policy.js':{execToolRefusal:()=>({error:'exec'}),isToolAllowedByExecPolicy:()=>true,isToolObjectAllowedByExecPolicy:()=>true,isToolExecClass:()=>false},'./channel-policy.js':{channelToolCallRefusal:()=>null,isToolAllowedInChannel:()=>true},'./grants.js':grantModule,'./approvals.js':{approvalCategory:t=>t.requiresApproval?'settings':null,isConfinedChannelReply:()=>false,consumeApprovalTicket:t=>{if(!t||!tickets.has(t))return false;tickets.delete(t);return true;},requestApproval:async()=>{approvals++;return {content:[],error:'waiting_approval'};}},'../repositories/actor.js':actorModule,'../mcp-client/config.js':{NO_MCP_AGENTS:new Set()},'../services/chat-secrets.js':{hasSecretRef:()=>false,resolveSecretRefs:async()=>{throw Error('Secret resolution forbidden');},scrubSecretValues:x=>x,vaultToolResult:async(_c,r)=>r}
});
const context=(extra={})=>({userId:'owner',agentId:'main',sessionId:'chat',chatPlan:true,workspaceDir:'/synthetic',teamAdminAvailable:true,...extra});
function registry(c=context()){const r=new ToolsRegistry(c);for(const tool of admin.teamAdminTools)r.register(tool);return r;}
const approved=()=>{const t={};tickets.add(t);return {approvalTicket:t};};
test.beforeEach(reset);
test('only the live primary agent in an owner chat is eligible',async()=>{
 for(const extra of [{chatPlan:false},{toolPolicy:{}},{taskId:'task'},{taskRun:{}},{delegation:{}},{delegatedFrom:['lead']}]){assert.equal(await authority.mainAdminEligible(context(extra)),false);}
 assert.equal(reads,0);
 for(const change of [{role:'admin'},{role:'user'},{is_primary:0},{parent_agent_id:'parent'},{agent_id:'other'},{archived_at:'archived'}]){facts={role:'owner',is_primary:1,parent_agent_id:null,agent_id:'main',archived_at:null,...change};assert.equal(await authority.mainAdminEligible(context()),false);}
 facts={role:'owner',is_primary:1,parent_agent_id:null,agent_id:'main',archived_at:null};assert.equal(await authority.mainAdminEligible(context()),true);
});
test('offering hints never authorize execution and ungranted tools never request approval',async()=>{
 const r=registry(context({teamAdminAvailable:false}));assert.deepEqual(r.getAll(),[]);facts.is_primary=0;assert.equal((await r.execute('team_agent_create',{draft:{name:'Worker'}},approved())).error,'team_admin_forbidden');
 facts.is_primary=1;granted=false;assert.equal((await r.execute('team_agent_create',{draft:{name:'Worker'}})).error,'grant_refused');assert.equal(approvals,0);assert.equal(calls.length,0);
});
test('allow mode cannot bypass one-time owner approval and body fields cannot supply it',async()=>{
 const r=registry(),params={draft:{name:'Worker'}};assert.equal((await r.execute('team_agent_create',params)).error,'waiting_approval');assert.equal(calls.length,0);
 const ticket=approved().approvalTicket;assert.equal((await r.execute('team_agent_create',{...params,approvalTicket:ticket})).error,'waiting_approval');assert.equal(calls.length,0);
});
test('settings off denies before approval; revoked primary denies even with a valid ticket',async()=>{
 const r=registry();mode='off';assert.ok((await r.execute('team_agent_create',{draft:{name:'Worker'}})).error);assert.equal(approvals,0);mode='allow';facts.is_primary=0;assert.equal((await r.execute('team_agent_create',{draft:{name:'Worker'}},approved())).error,'team_admin_forbidden');assert.equal(calls.length,0);
});
test('approved create uses the existing repository and keeps agent attribution without secrets',async()=>{
 const r=registry(),params={draft:{name:'Worker',department:'design',modelSelection:'local'}};const before=JSON.stringify(params);const options=approved();const out=await r.execute('team_agent_create',params,options);assert.equal(out.error,undefined);assert.equal(JSON.stringify(params),before);assert.doesNotMatch(JSON.stringify(out),/NEVER-RETURN|credential|api_key/);
 assert.deepEqual(calls[0].actor,{kind:'user',userId:'owner',role:'owner'});assert.equal(calls[0].draft.model,'local');assert.equal(calls[1].actor.kind,'agent');assert.equal(calls[1].entry.metadata.agentId,'main');
 assert.equal((await r.execute('team_agent_create',params,options)).error,'waiting_approval');assert.equal(calls.filter(x=>x.action==='create').length,1);
});
test('direct execution and forbidden configuration fields cannot create an agent',async()=>{
 assert.equal((await admin.teamAgentCreate.execute({draft:{name:'Worker'}},context())).error,'team_admin_forbidden');
 for(const key of ['is_primary','api_key','capabilities','parent_agent_id','cron_enabled','grants'])assert.equal((await registry().execute('team_agent_create',{draft:{name:'Worker',[key]:true}},approved())).error,'invalid_input');
 assert.equal((await registry().execute('team_agent_create',{draft:{name:'Worker',role:'main'}},approved())).error,'invalid_role');assert.equal(calls.filter(x=>x.action==='create').length,0);
});
test('updates require the current version and reuse UI rename projection',async()=>{
 const r=registry();assert.equal((await r.execute('team_agent_update',{agentId:'worker',draft:{name:'After',expectedVersion:2}},approved())).error,'version_conflict');assert.equal(calls.length,0);
 assert.equal((await r.execute('team_agent_update',{agentId:'worker',draft:{name:'After',expectedVersion:3}},approved())).error,undefined);assert.ok(calls.some(x=>x.action==='renamed'));assert.equal(calls.find(x=>x.action==='update').draft.expectedVersion,3);
});
test('library creation/edit/assignment reuse revision-bearing services and expose no deletion',async()=>{
 const r=registry();assert.equal((await r.execute('team_personality_apply',{action:'save',id:'style',draft:{revision:0,profile:{name:'Style'}}},approved())).error,undefined);
 assert.equal((await r.execute('team_personality_apply',{action:'assign',agentId:'worker',draft:{id:'style',revision:1,expectedVersion:3,linked:true}},approved())).error,undefined);assert.deepEqual(views,['worker']);
 assert.equal((await r.execute('team_specialty_apply',{action:'save',id:'specialty',draft:{revision:0}},approved())).error,undefined);
 assert.equal((await r.execute('team_specialty_apply',{action:'link',id:'specialty',draft:{agentId:'worker',revision:1,linked:true}},approved())).error,undefined);
 for(const name of ['team_personality_apply','team_specialty_apply'])assert.equal((await r.execute(name,{action:'delete',id:'style'},approved())).error,'invalid_input');
 assert.ok(calls.some(x=>x.action==='personality.save'&&x.draft.revision===0));assert.ok(calls.some(x=>x.action==='specialty.link'&&x.draft.linked));assert.equal(r.listRegistered().length,5);
});

test('library create generates IDs and cannot accept an injected existing ID',async()=>{
 const r=registry();
 for(const name of ['team_personality_apply','team_specialty_apply']){
  const out=await r.execute(name,{action:'create',draft:{revision:0}},approved());assert.equal(out.error,undefined);
  assert.equal((await r.execute(name,{action:'create',id:'existing',draft:{revision:0}},approved())).error,'invalid_input');
 }
 assert.ok(calls.some(x=>x.action==='personality.save'&&x.id==='personality-generated-test-id'));
 assert.ok(calls.some(x=>x.action==='specialty.save'&&x.id==='generated-test-id'));
});
