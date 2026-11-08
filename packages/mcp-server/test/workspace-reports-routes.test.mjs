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

test('Reports prepared publication uses authenticated actual routes with synthetic storage', {skip:!process.env.MCP_MEMORY_BACKEND_DIR},async()=>{
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
  await app.register((await load('api/routes/auth.ts')).authRoutes);await app.register((await load('api/routes/reports.ts')).reportRoutes,{ensureRecovery:async()=>undefined});
  await app.ready();const {generateToken}=await load('auth/jwt.ts');

  const {createProject}=await load('repositories/chat-conversations.ts');const project=await createProject('mcp-owner',{name:'Synthetic Publication Project'});
  await q.run("INSERT INTO agents_config (id,name,provider,model,is_primary) VALUES ('synthetic-main','Synthetic Main','ollama','off',1)");
  const agentId='synthetic-main';let actor='mcp-owner';const backend={async request(method,path,body){const response=await app.inject({method,url:path,...(body?{payload:body}:{}),headers:{authorization:'Bearer '+generateToken(actor,1)}});if(response.statusCode>=400)throw new BackendError(response.json().code??response.json().message??response.json().error,response.statusCode);return response.json();}};
  const tool=async args=>callTool('workspace_reports',args,{backend});
  const definition={requestId:'synthetic-report',expectedRevision:0,title:'Synthetic prepared report',instructions:'Display supplied results only',agentId,projectId:project.id,presentation:{sections:[{id:'summary',title:'Summary',size:'wide',importance:'normal',preferredType:'Text'}]}};
  const created=await tool({operation:'create',definition});assert.notEqual(created.isError,true,JSON.stringify(created));const report=created.structuredContent.report;
  const document={schemaVersion:1,root:'r',elements:{r:{type:'Text',props:{content:'Synthetic external prepared summary'},children:[]}}};
  const publication={requestId:'publish-1',expectedRevision:1,projectId:project.id,sections:[{id:'summary',document,sourceLabel:'Synthetic fixture',dataAsOf:null}]};
  const outputs=await Promise.all([tool({operation:'publish',id:report.id,publication}),tool({operation:'publish',id:report.id,publication})]);for(const out of outputs)assert.notEqual(out.isError,true,JSON.stringify(out));assert.equal(outputs[0].structuredContent.snapshotId,outputs[1].structuredContent.snapshotId);
  const read=await tool({operation:'read',id:report.id});assert.equal(read.structuredContent.snapshot.sections[0].document.elements.r.props.content,'Synthetic external prepared summary');assert.equal(read.structuredContent.snapshot.provenance.sourceKind,'external_prepared');assert.equal(read.structuredContent.history.length,1);
  for(const invalid of [{...publication,projectId:null},{...publication,requestId:'stale',expectedRevision:2},{...publication,sections:[{...publication.sections[0],sourceLabel:'changed'}]},{...publication,requestId:'foreign-task',sections:[{...publication.sections[0],tasks:[{cardId:'foreign'}]}]},{...publication,requestId:'bad-json',sections:[{id:'summary',document:{schemaVersion:1,root:'r',elements:{r:{type:'script',props:{src:'https://invalid.test'},children:[]}}}}]},{...publication,requestId:'oversized',sections:[{...publication.sections[0],sourceLabel:'x'.repeat(65000)}]}])assert.equal((await tool({operation:'publish',id:report.id,publication:invalid})).isError,true,JSON.stringify(invalid).slice(0,200));
  assert.equal((await q.one('SELECT COUNT(*) AS n FROM chat_run_journal')).n,0);assert.equal((await q.one('SELECT COUNT(*) AS n FROM display_report_attempts')).n,0);assert.equal((await q.one('SELECT COUNT(*) AS n FROM display_report_publications')).n,1);
  actor='mcp-foreign';assert.equal((await tool({operation:'read',id:report.id})).isError,true);assert.equal((await tool({operation:'publish',id:report.id,publication})).isError,true);actor='mcp-owner';
  const {reportPublishTool}=await load('tools/tasks/report-publication.ts');const {bindOwnerCommand}=await load('tools/tasks/team-admin-authority.ts');
  const context={workspaceDir:home,userId:actor,agentId,sessionId:report.conversationId,chatPlan:true};assert.ok((await reportPublishTool.execute({reportId:report.id,publication},context)).error);
  const bound=await bindOwnerCommand(context,'report_publish',true);const native=await reportPublishTool.execute({reportId:report.id,publication:{...publication,requestId:'native-publish'}},bound);assert.equal(native.error,undefined,JSON.stringify(native));assert.equal(native.data.sourceKind,'external_prepared');
  const updated=await tool({operation:'update',id:report.id,definition:{...definition,expectedRevision:1,presentation:{sections:[{...definition.presentation.sections[0],id:'fresh-summary'}]}}});assert.notEqual(updated.isError,true,JSON.stringify(updated));
  const oldReplay=await tool({operation:'publish',id:report.id,publication});assert.notEqual(oldReplay.isError,true,JSON.stringify(oldReplay));assert.equal(oldReplay.structuredContent.snapshotId,outputs[0].structuredContent.snapshotId,'Replay retains its original snapshot after layout update');
  assert.equal((await tool({operation:'publish',id:report.id,publication:{...publication,requestId:'wrong-new-layout',expectedRevision:2}})).isError,true);
  const {flushAuditWrites}=await load('services/audit-logger.ts');await flushAuditWrites();const audits=await q.all("SELECT resource_id,success,metadata FROM audit_logs WHERE action='report_publication.prepare'");const auditText=JSON.stringify(audits);assert.match(auditText,/published/);assert.match(auditText,/replayed/);assert.match(auditText,/refused/);assert.doesNotMatch(auditText,/Synthetic external prepared summary|Synthetic fixture|sections|document/);assert.ok(audits.every(row=>String(row.resource_id).length<129));
  assert.equal(networks,0);
 }finally{if(app)await app.close();if(pg)await pg.closePgPool();if(db)db.closeDatabase();globalThis.fetch=fetchBefore;process.chdir(previous);rmSync(home,{recursive:true,force:true});}
});
