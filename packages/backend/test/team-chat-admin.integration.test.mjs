import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';
const pgUrl=process.env.TEAM_ADMIN_PG_TEST_URL;
if(pgUrl){const target=new URL(pgUrl);assert.ok(['127.0.0.1','localhost'].includes(target.hostname)&&target.pathname.startsWith('/team_admin_test_'),'A dedicated local disposable PostgreSQL database is required');}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'girru-team-admin-db-'));process.env.HOME=root;process.env.AGENT_PLAYER_DATA_DIR=root;process.env.DATABASE_PATH=path.join(root,'test.db');process.env.AGENT_PLAYER_DB=pgUrl?'postgres':'sqlite';if(pgUrl)process.env.AGENT_PLAYER_PG_URL=pgUrl;process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const fetchBefore=globalThis.fetch;globalThis.fetch=async()=>{throw Error('External network forbidden in management acceptance');};
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase({path:process.env.DATABASE_PATH});await db.initialize();
const {getCredentialStorage}=await import('../src/credentials/storage.ts');await getCredentialStorage().initialize();
const {q}=await import('../src/repositories/sql-steps.ts');
const owner='management-owner';await q.run("INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,'synthetic','owner','active')",owner,'management@example.invalid','Management');
const {repositories}=await import('../src/repositories/index.ts');const {userActor}=await import('../src/repositories/actor.ts');const actor=userActor({id:owner,role:'owner'});
const lead=await repositories.agents.createConfig(actor,{name:'Synthetic Main',role:'main'});await repositories.agents.setPrimary(actor,lead.id);
const worker=await repositories.agents.createConfig(actor,{name:'Synthetic Worker',role:'specialist'});
const {createConversation}=await import('../src/repositories/chat-conversations.ts');const chat=await createConversation(owner,{title:'Synthetic management',agentId:lead.id});
const {createAgentToolsRegistry}=await import('../src/tools/index.ts');const {setAgentGrants}=await import('../src/tools/grants.ts');
const scope={workspaceDir:root,userId:owner,agentId:lead.id,sessionId:chat.id,chatPlan:true};let registry=await createAgentToolsRegistry(scope);
const names=['team_admin_read','team_agent_create','team_agent_update','team_personality_apply','team_specialty_apply'];await setAgentGrants(lead.id,{grants:names},owner,registry.listRegistered());registry=await createAgentToolsRegistry(scope);
const {mainAdminStep}=await import('../src/tools/tasks/team-admin-authority.ts');const {sql}=await import('../src/repositories/sql-steps.ts');assert.equal(await sql().read(mainAdminStep(scope)),true);
const {getApprovalDetail,approveAndRun}=await import('../src/tools/approvals.ts');
async function change(name,params){const pending=await registry.execute(name,params);assert.equal(pending.details?.status,'pending_approval',JSON.stringify(pending));assert.equal(pending.details?.status,'pending_approval',JSON.stringify(pending));const detail=await getApprovalDetail(pending.details.approvalId);assert.ok(detail?.paramsHash);const result=await approveAndRun(detail.id,owner,detail.paramsHash);return result.result;}
let created;
test('real approval replay creates once using UI repository defaults and no automatic privileged grants',async()=>{
 const before=Number((await q.one('SELECT COUNT(*) n FROM agents_config')).n);
 const pending=await registry.execute('team_agent_create',{draft:{name:'Chat-created Designer',role:'specialist',department:'design'}});assert.equal(Number((await q.one('SELECT COUNT(*) n FROM agents_config')).n),before);
 assert.equal(pending.details?.status,'pending_approval',JSON.stringify(pending));const detail=await getApprovalDetail(pending.details.approvalId);const execution=await approveAndRun(detail.id,owner,detail.paramsHash);assert.equal(execution.result.error,undefined,JSON.stringify(execution.result));created=execution.result.data.agent;
 assert.equal(Number((await q.one('SELECT COUNT(*) n FROM agents_config')).n),before+1);assert.equal(created.name,'Chat-created Designer');assert.equal(created.is_primary,0);
 assert.equal(Number((await q.one("SELECT COUNT(*) n FROM agent_tool_grants WHERE agent_id=? AND tool_name LIKE 'team_%'",created.id)).n),0);
 await assert.rejects(approveAndRun(detail.id,owner,detail.paramsHash));
});
test('real update enforces concurrency and changes only the approved safe fields',async()=>{
 assert.ok(created);const before=await repositories.agents.getConfig(actor,created.id);
 const out=await change('team_agent_update',{agentId:created.id,draft:{name:'Chat Designer Updated',expectedVersion:before.version}});assert.equal(out.error,undefined,JSON.stringify(out));
 const after=await repositories.agents.getConfig(actor,created.id);assert.equal(after.name,'Chat Designer Updated');assert.equal(after.is_primary,before.is_primary);assert.equal(after.model,before.model);
 const stale=await change('team_agent_update',{agentId:created.id,draft:{name:'Stale',expectedVersion:before.version}});assert.equal(stale.error,'version_conflict');assert.equal((await repositories.agents.getConfig(actor,created.id)).name,'Chat Designer Updated');
});
test('revoking primary status after a proposal refuses the replay without creating another agent',async()=>{
 const pending=await registry.execute('team_agent_create',{draft:{name:'Must Not Exist'}});assert.equal(pending.details?.status,'pending_approval',JSON.stringify(pending));const detail=await getApprovalDetail(pending.details.approvalId);await repositories.agents.setPrimary(actor,worker.id);
 const execution=await approveAndRun(detail.id,owner,detail.paramsHash);assert.equal(execution.result.error,'team_admin_forbidden');assert.equal(Number((await q.one('SELECT COUNT(*) n FROM agents_config WHERE name=?','Must Not Exist')).n),0);
 await repositories.agents.setPrimary(actor,lead.id);
});
test('real personality library create, assignment and impact-confirmed update preserve revisions',async()=>{
 const {PersonalityLibrary}=await import('../src/services/personality-library.ts');const library=new PersonalityLibrary();await library.initialize();const profile=structuredClone((await library.read('temperament-balanced')).profile);profile.name='Synthetic chat style';
 const saved=await change('team_personality_apply',{action:'save',id:'chat-style',draft:{revision:0,profile}});assert.equal(saved.error,undefined,JSON.stringify(saved));
 const info=await registry.execute('team_admin_read',{action:'personality_assignment',agentId:created.id});assert.equal(typeof info.data.personalityVersion,'number');
 assert.equal((await change('team_personality_apply',{action:'assign',agentId:created.id,draft:{id:'chat-style',revision:1,expectedVersion:info.data.personalityVersion,linked:true}})).error,undefined);
 const draft=structuredClone(profile);draft.traits.creativity=91;
 assert.equal((await change('team_personality_apply',{action:'save',id:'chat-style',draft:{revision:1,profile:draft}})).error,'review_required');
 const preview=await registry.execute('team_admin_read',{action:'personality_impact',id:'chat-style',draft:{revision:1,profile:draft}});assert.ok(preview.data.confirmation);
 const updated=await change('team_personality_apply',{action:'save',id:'chat-style',draft:{revision:1,profile:draft,confirmation:preview.data.confirmation}});assert.equal(updated.error,undefined,JSON.stringify(updated));assert.equal((await library.read('chat-style')).revision,2);
});
test('real specialty creation and assignment preserve existing agent permission/grant rows',async()=>{
 const {SpecialtyTemplates}=await import('../src/services/specialty-templates.ts');const store=new SpecialtyTemplates();const templateId=randomUUID();
 const draft={revision:0,name:'Synthetic chat specialty',department:'design',description:'Temporary role',instructions:'Work only on the synthetic project.',config:{primarySkill:null,skills:[],tools:[],memoryRead:[],memoryWrite:[],sharedMemory:false,modes:{browser:'ask',network:'ask',message:'ask',delete:'ask',install:'ask',money:'off',settings:'ask'}}};
 const saved=await change('team_specialty_apply',{action:'save',id:templateId,draft});assert.equal(saved.error,undefined,JSON.stringify(saved));
 await (await import('../src/tools/grants.ts')).loadAgentGrants(created.id,registry.listRegistered());
 const beforePermissions=await q.one('SELECT * FROM agent_permissions WHERE agent_id=?',created.id),beforeGrants=await q.all('SELECT * FROM agent_tool_grants WHERE agent_id=? ORDER BY tool_name',created.id);
 const linked=await change('team_specialty_apply',{action:'link',id:templateId,draft:{agentId:created.id,revision:1,linked:true}});assert.equal(linked.error,undefined,JSON.stringify(linked));
 assert.deepEqual(await q.one('SELECT * FROM agent_permissions WHERE agent_id=?',created.id),beforePermissions);assert.deepEqual(await q.all('SELECT * FROM agent_tool_grants WHERE agent_id=? ORDER BY tool_name',created.id),beforeGrants);assert.equal((await store.assigned(created.id)).templates[0].id,templateId);
});
test.after(async()=>{globalThis.fetch=fetchBefore;if(pgUrl)await (await import('../src/db/pg/pool.ts')).closePgPool();closeDatabase();fs.rmSync(root,{recursive:true,force:true});});
