// Opt-in acceptance of the MCP adapter against real routes and temporary databases.
// MCP_MEMORY_BACKEND_DIR must point to a disposable copy of packages/backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {callTool} from '../src/tools.ts';
import {BackendError} from '../src/backend.ts';

test('Control review drafts and bounded chat use real authenticated temporary routes', {skip:!process.env.MCP_MEMORY_BACKEND_DIR},async()=>{
 const source=resolve(process.env.MCP_MEMORY_BACKEND_DIR),previous=process.cwd(),home=mkdtempSync(join(tmpdir(),'mcp-memory-routes-'));
 mkdirSync(join(home,'.data'),{recursive:true});process.chdir(home);
 Object.assign(process.env,{HOME:home,AGENT_PLAYER_CONFIG_DIR:join(home,'config'),DATABASE_PATH:join(home,'.data','test.sqlite'),JWT_SECRET:randomBytes(64).toString('hex'),ENCRYPTION_KEY:randomBytes(32).toString('hex'),NODE_ENV:'test',OLLAMA_URL:'http://127.0.0.1:9',MEMORY_GRAPH_MODEL:'off'});
 const load=p=>import(join(source,'src',p));const fetchBefore=globalThis.fetch;let networks=0;
 globalThis.fetch=async()=>{networks++;throw Error('Network/model access forbidden in memory acceptance');};
 let app,db,pg;
 try{
  const database=await load('db/database.ts');db=database;await database.getDatabase({path:process.env.DATABASE_PATH}).initialize();
  if(process.env.AGENT_PLAYER_DB==='postgres'){
   pg=await load('db/pg/pool.ts');const {runPgMigrations}=await load('db/pg/migrate.ts');await runPgMigrations(await pg.getPgPool());
  }
  const {q,sql}=await load('repositories/sql-steps.ts');
  for(const [id,role]of [['mcp-owner','owner'],['mcp-foreign','owner'],['mcp-member','user']]){
   const values=[id,id+'@example.test',id,role];const statement="INSERT INTO users (id,email,username,password_hash,role,status,email_verified) VALUES (?,?,?,'x',?,'active',1)";
   await q.run(statement,...values);
   if(process.env.AGENT_PLAYER_DB==='postgres')database.getDatabase({path:process.env.DATABASE_PATH}).prepare(statement).run(...values);
  }
  const {default:Fastify}=await import(join(source,'node_modules/fastify/fastify.js'));
  app=Fastify();(await load('auth/auth-gate.ts')).registerAuthGate(app);
  await app.register((await load('api/routes/auth.ts')).authRoutes);await app.register((await load('api/routes/workspace-drafts.ts')).workspaceDraftRoutes);await app.register((await load('api/routes/mcp-chat.ts')).mcpChatRoutes,{start:async input=>{starts++;assert.equal(input.model,'subscription:codex/synthetic-fixture');if(staleModel){await q.run('UPDATE chat_sessions SET model=? WHERE id=?','subscription:gemini/synthetic-fixture',input.c.id);assert.equal(await input.canStart(),false);return {code:409};}assert.equal(await input.canStart(),true);if(uncertain)throw Error('Synthetic interrupted admission');return {code:202,body:{runId:input.runId}};}});
  await app.ready();const {generateToken}=await load('auth/jwt.ts');


  let starts=0,uncertain=false,staleModel=false,actor='mcp-owner';
  const backend={async request(method,path,body){const response=await app.inject({method,url:path,...(body?{payload:body}:{}),headers:{authorization:'Bearer '+generateToken(actor,1)}});if(response.statusCode>=400)throw new BackendError(response.json().error,response.statusCode);return response.json();}};
  const drafts=async args=>callTool('workspace_drafts',args,{backend});
  const {STARTERS}=await load('services/personality-library-profile.ts');
  const authored={skill:{name:'Synthetic skill',description:'Temporary guidance',content:'# Synthetic guidance\nRead only source fixtures.'},personality:{profile:STARTERS[0].profile},specialty:{name:'Synthetic job',department:'Engineering',description:'Fixture specialty',instructions:'Inspect synthetic fixtures'},rule:{text:'Use synthetic data only',projectId:null},agent:{name:'Synthetic proposed agent',description:'Not actually created'}};
  const before={agents:(await q.one('SELECT COUNT(*) AS n FROM agents_config')).n,rules:(await q.one('SELECT COUNT(*) AS n FROM agent_rules')).n,skills:(await q.one('SELECT COUNT(*) AS n FROM central_skills')).n};
  for(const [kind,draft]of Object.entries(authored)){const args={operation:'prepare',body:{requestId:'create-'+kind,kind,action:'create',expectedFingerprint:'new',draft}};const out=await drafts(args);assert.notEqual(out.isError,true,JSON.stringify(out));assert.equal(out.structuredContent.applied,false);assert.equal((await drafts(args)).structuredContent.id,out.structuredContent.id);const read=await drafts({operation:'read',id:out.structuredContent.id});assert.deepEqual(read.structuredContent.draft,draft);}
  assert.equal((await q.one('SELECT COUNT(*) AS n FROM agents_config')).n,before.agents);assert.equal((await q.one('SELECT COUNT(*) AS n FROM agent_rules')).n,before.rules);assert.equal((await q.one('SELECT COUNT(*) AS n FROM central_skills')).n,before.skills);
  await q.run("INSERT INTO agents_config (id,name,provider,model) VALUES ('synthetic-chat-agent','Synthetic','ollama','off')");
  await q.run("INSERT INTO central_skills (id,name,description,version,revision,content_hash,origin) VALUES ('synthetic-skill','Synthetic skill','Fixture','1.0',1,?,'local')",'a'.repeat(64));
  const context=(await drafts({operation:'context',body:{kind:'skill',targetId:'synthetic-skill'}})).structuredContent;
  const update={operation:'prepare',body:{requestId:'update-skill',kind:'skill',action:'update',targetId:'synthetic-skill',expectedFingerprint:context.fingerprint,draft:{content:'# Proposed new guidance'}}};assert.notEqual((await drafts(update)).isError,true);
  await q.run('UPDATE central_skills SET revision=2 WHERE id=?','synthetic-skill');assert.equal((await drafts({...update,body:{...update.body,requestId:'stale-update'}})).isError,true);
  const assignmentContext=(await drafts({operation:'context',body:{kind:'skill',targetId:'synthetic-skill',agentId:'synthetic-chat-agent'}})).structuredContent;
  const assignment=await drafts({operation:'prepare',body:{requestId:'assignment',kind:'skill',action:'assign',targetId:'synthetic-skill',agentId:'synthetic-chat-agent',expectedFingerprint:assignmentContext.fingerprint,draft:{}}});assert.notEqual(assignment.isError,true);assert.equal((await q.one('SELECT COUNT(*) AS n FROM central_agent_skills')).n,0);
  for(const draft of [{name:'Bad',tools:['shell']},{name:'Bad',is_primary:1},{name:'Bad',provider:'paid'},{name:'Bad',description:'password=synthetic-secret'}])assert.equal((await drafts({operation:'prepare',body:{requestId:'bad-'+Object.keys(draft)[1],kind:'agent',action:'create',expectedFingerprint:'new',draft}})).isError,true);
  const first=(await drafts({operation:'list'})).structuredContent.drafts[0];actor='mcp-foreign';assert.equal((await drafts({operation:'read',id:first.id})).isError,true);actor='mcp-member';assert.equal((await drafts({operation:'list'})).isError,true);actor='mcp-owner';
  const {createConversation,addUserMessage,createProject}=await load('repositories/chat-conversations.ts');const project=await createProject(actor,{name:'Synthetic chat project'}),c=await createConversation(actor,{title:'Synthetic chat',agentId:'synthetic-chat-agent',projectId:project.id,model:'subscription:codex/synthetic-fixture'});
  await addUserMessage(c.id,'Synthetic message password=never-return-this','synthetic-seed-run');
  const messages=await callTool('chats',{operation:'messages',id:c.id,limit:1},{backend});assert.notEqual(messages.isError,true,JSON.stringify(messages));assert.doesNotMatch(JSON.stringify(messages),/never-return-this/);assert.equal(messages.structuredContent.messages[0].redacted,true);
  const body={requestId:'send-once',message:'Inspect synthetic fixture only',agentId:'synthetic-chat-agent',projectId:project.id,confirmed:true};
  const send=async b=>callTool('chats',{operation:'send',id:c.id,body:b},{backend});const outputs=await Promise.all([send(body),send(body)]);for(const out of outputs)assert.notEqual(out.isError,true,JSON.stringify(out));assert.equal(starts,1);assert.equal(outputs[0].structuredContent.runId,outputs[1].structuredContent.runId);
  for(const b of [{...body,message:'changed'},{...body,requestId:'missing-confirm',confirmed:false},{...body,requestId:'wrong-project',projectId:null},{...body,requestId:'wrong-agent',agentId:'foreign-agent'},{...body,requestId:'identity',userId:'mcp-foreign'}])assert.equal((await send(b)).isError,true);assert.equal(starts,1);
  uncertain=true;assert.equal((await send({...body,requestId:'uncertain'})).isError,true);const uncertainReplay=await send({...body,requestId:'uncertain'});assert.equal(uncertainReplay.structuredContent.state,'reserved');assert.equal(uncertainReplay.structuredContent.started,null);assert.equal(starts,2);
  actor='mcp-foreign';assert.equal((await callTool('chats',{operation:'messages',id:c.id},{backend})).isError,true);assert.equal((await send({...body,requestId:'foreign'})).isError,true);actor='mcp-owner';
  const foreignProject=await createProject('mcp-foreign',{name:'Foreign synthetic project'});await q.run('UPDATE chat_sessions SET project_id=? WHERE id=?',foreignProject.id,c.id);assert.equal((await send({...body,requestId:'foreign-project-link',projectId:foreignProject.id})).isError,true,'Echoing a foreign project association grants no ownership');assert.equal(starts,2);await q.run('UPDATE chat_sessions SET project_id=? WHERE id=?',project.id,c.id);
  const deletedProject=await createProject(actor,{name:'Deleted synthetic project'}),dangling=await createConversation(actor,{agentId:'synthetic-chat-agent',projectId:deletedProject.id});await q.run('DELETE FROM chat_projects WHERE id=?',deletedProject.id);const deletedSend=await callTool('chats',{operation:'send',id:dangling.id,body:{...body,requestId:'deleted-project-link',projectId:deletedProject.id}},{backend});assert.equal(deletedSend.isError,true);assert.equal(starts,2);
  uncertain=false;staleModel=true;const staleModelSend=await send({...body,requestId:'stale-model-before-start'});assert.equal(staleModelSend.isError,true);assert.equal(starts,3,'Changed saved model is refused before launch');
  const {flushAuditWrites}=await load('services/audit-logger.ts');await flushAuditWrites();const audits=await q.all("SELECT action,resource_id,success,metadata FROM audit_logs WHERE action IN ('workspace_draft.prepare','mcp_chat.send')");const auditText=JSON.stringify(audits);for(const outcome of ['created','replayed','submitted','refused','uncertain'])assert.match(auditText,new RegExp(outcome));assert.doesNotMatch(auditText,/Proposed new guidance|Read only source fixtures|Inspect synthetic fixture|never-return-this|password=|content_hash|expectedFingerprint/);assert.ok(audits.every(row=>JSON.parse(row.metadata).contentIncluded===false));
  await q.run('DROP TABLE audit_logs');const afterAuditFailure=await drafts({operation:'prepare',body:{requestId:'audit-failure-still-durable',kind:'agent',action:'create',expectedFingerprint:'new',draft:{name:'Synthetic audit failure check'}}});assert.notEqual(afterAuditFailure.isError,true,JSON.stringify(afterAuditFailure));assert.ok(await q.one('SELECT id FROM workspace_control_drafts WHERE id=?',afterAuditFailure.structuredContent.id));await flushAuditWrites();
  assert.equal(networks,0);
 }finally{if(app)await app.close();if(pg)await pg.closePgPool();if(db)db.closeDatabase();globalThis.fetch=fetchBefore;process.chdir(previous);rmSync(home,{recursive:true,force:true});}
});
