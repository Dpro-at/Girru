import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import{randomBytes,randomUUID}from'node:crypto';
const pg=process.env.REPORTS_TEST_PG_URL;if(pg){const u=new URL(pg);assert.ok(['127.0.0.1','localhost'].includes(u.hostname)&&u.pathname.startsWith('/reports_test_'));}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'girru-reports-data-'));process.env.HOME=root;process.env.AGENT_PLAYER_DATA_DIR=root;process.env.AGENT_PLAYER_CONFIG_DIR=path.join(root,'config');process.env.DATABASE_PATH=path.join(root,'auth.sqlite');process.env.AGENT_PLAYER_DB=pg?'postgres':'sqlite';if(pg)process.env.AGENT_PLAYER_PG_URL=pg;process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.AGENT_PLAYER_BACKGROUND='0';globalThis.fetch=async()=>{throw Error('No external network in reports acceptance');};
const{getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=pg?null:getDatabase({path:process.env.DATABASE_PATH});if(db)await db.initialize();
const{q}=await import('../src/repositories/sql-steps.ts');const R=await import('../src/services/reports.ts');const C=await import('../src/repositories/chat-conversations.ts');const J=await import('../src/repositories/chat-recovery.ts');
for(const[id,role]of[['report-owner','owner'],['report-other','owner'],['report-member','user']])await q.run("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'synthetic',?,'active',1)",id,id+'@example.invalid',id,role);
await q.run("INSERT INTO agents_config(id,name,role,provider,model) VALUES('report-agent','Report helper','specialist','ollama','synthetic')");
const{default:Fastify}=await import('fastify');const{reportRoutes}=await import('../src/api/routes/reports.ts');const{generateToken}=await import('../src/auth/jwt.ts');const app=Fastify();const starts=[];let ready;
const start=async input=>{starts.push(input);assert.equal(await input.canStart(),true);await J.acceptChatRun({run_id:input.runId,session_id:input.c.id,user_id:input.userId,agent_id:input.agentId,started_at:Date.now()},input.message);return {code:202,body:{runId:input.runId}};};
await app.register(reportRoutes,{start,ensureRecovery:async()=>{ready??=J.recoverChatRuns();await ready;await R.reconcileReportAttempts();}});
const call=(method,url,payload,user='report-owner')=>app.inject({method,url,payload,headers:{authorization:'Bearer '+generateToken(user)}});
const presentation={sections:[{id:'summary',title:'My overview',size:'wide',importance:'high',preferredType:'Text'},{id:'tasks',title:'My tasks',size:'compact',importance:'normal',preferredType:'Table'}]};
const draft=(extra={})=>({requestId:randomUUID(),expectedRevision:0,title:'Personal report',instructions:'Summarize only synthetic data.',agentId:'report-agent',projectId:null,presentation:structuredClone(presentation),...extra});
const document=content=>({schemaVersion:1,root:'r',elements:{r:{type:'Text',props:{content},children:[]}}});
const result=()=>JSON.stringify({schemaVersion:1,sections:presentation.sections.map(s=>({id:s.id,document:document('Synthetic '+s.title),sourceLabel:'Synthetic fixture',dataAsOf:null}))});
async function create(extra={}){const out=await call('POST','/api/reports',draft(extra));assert.equal(out.statusCode,200,out.body);return out.json().report;}
async function complete(run,text=result(),status='complete'){await C.addAssistantMessage(run.c.id,{runId:run.runId,agentId:run.agentId,content:text,parts:[],status,durationMs:1});await J.finishChatRun(run.runId,status);await run.onFinished(status);}
let report;
test('definitions are owner isolated, idempotent and individually configurable without running providers',async()=>{
 const input=draft(),before=starts.length,a=await call('POST','/api/reports',input);assert.equal(a.statusCode,200,a.body);report=a.json().report;assert.deepEqual(report.presentation,presentation);
 assert.equal((await call('POST','/api/reports',input)).json().report.id,report.id);assert.equal(starts.length,before);
 assert.equal((await call('POST','/api/reports',{...input,title:'Changed'})).statusCode,409);
 assert.equal((await call('GET','/api/reports/'+report.id,undefined,'report-other')).statusCode,404);assert.equal((await call('GET','/api/reports',undefined,'report-member')).statusCode,403);
 assert.equal((await call('POST','/api/reports',{...draft(),ownerId:'report-other'})).statusCode,400);
});
test('manual generation replays stable request ids, publishes only completed durable results and keeps immutable history',async()=>{
 const key={requestId:randomUUID(),expectedRevision:report.revision},before=starts.length;
 const run=await call('POST',`/api/reports/${report.id}/run`,key);assert.equal(run.statusCode,200,run.body);assert.equal(starts.length,before+1);
 await complete(starts.at(-1));const detail=(await call('GET','/api/reports/'+report.id)).json();assert.ok(detail.snapshot);assert.equal(detail.history.length,1);
 const replay=await call('POST',`/api/reports/${report.id}/run`,key);assert.equal(replay.json().replayed,true);assert.equal(starts.length,before+1);
 const fail=await call('POST',`/api/reports/${report.id}/run`,{requestId:randomUUID(),expectedRevision:report.revision});assert.equal(fail.statusCode,200);await complete(starts.at(-1),'not a report');
 const after=(await call('GET','/api/reports/'+report.id)).json();assert.equal(after.snapshot.id,detail.snapshot.id);assert.equal(after.report.status,'failed');assert.equal(after.history.length,1);
});
test('stale revisions, concurrent runs and foreign snapshots refuse safely; presentation changes do not rewrite history',async()=>{
 const before=(await call('GET','/api/reports/'+report.id)).json();const update={...draft(),expectedRevision:report.revision,presentation:{sections:[...presentation.sections].reverse()}};
 const saved=await call('PUT','/api/reports/'+report.id,update);assert.equal(saved.statusCode,200,saved.body);report=saved.json().report;
 assert.equal((await call('PUT','/api/reports/'+report.id,update)).statusCode,409);assert.equal((await call('GET',`/api/reports/${report.id}?snapshotId=${randomUUID()}`)).statusCode,404);
 const old=(await call('GET',`/api/reports/${report.id}?snapshotId=${before.snapshot.id}`)).json();assert.equal(old.snapshot.presentation.sections[0].id,'summary');assert.equal(old.report.presentation.sections[0].id,'tasks');
 await call('POST',`/api/reports/${report.id}/run`,{requestId:randomUUID(),expectedRevision:report.revision});assert.equal((await call('POST',`/api/reports/${report.id}/run`,{requestId:randomUUID(),expectedRevision:report.revision})).statusCode,409);await complete(starts.at(-1));
});
test('explicit calendars save per owner into the existing worker table, not another scheduler',async()=>{
 const out=await call('PUT',`/api/reports/${report.id}/schedule`,{expectedRevision:report.revision,calendar:{every:'monthly',at:'09:00',timezone:'Europe/Vienna',day:31},paused:false});assert.equal(out.statusCode,200,out.body);report=out.json().report;
 assert.equal(out.json().schedule.calendar.day,31);assert.equal(out.json().schedule.paused,false);
 assert.equal(Number((await q.one('SELECT COUNT(*) n FROM chat_schedules WHERE user_id=? AND session_id=?','report-owner',report.conversationId)).n),1);
 const before=starts.length;await call('GET','/api/reports/'+report.id);assert.equal(starts.length,before,'viewing a report must not dispatch work');
});
test('approval waiting and owner-decided continuation preserve linkage, current writer and eventual publication',async()=>{
 await call('POST',`/api/reports/${report.id}/run`,{requestId:randomUUID(),expectedRevision:report.revision});const rootRun=starts.at(-1),approval=randomUUID();
 await q.run("INSERT INTO tool_approvals(id,status,user_id,session_id,agent_id,tool_name,params_encrypted,params_iv,params_tag) VALUES(?,'pending',?,?,?,'fixture','synthetic','synthetic','synthetic')",approval,'report-owner',report.conversationId,'report-agent');
 await complete(rootRun,'Waiting for your approval.');assert.equal((await R.readReport('report-owner',report.id)).report.status,'waiting');
 await q.run("UPDATE tool_approvals SET status='executed' WHERE id=?",approval);const nextId='approval-'+approval,admission=await R.resumeReportAfterApproval('report-owner',report.conversationId,nextId);assert.ok(admission);
 const continuation={...rootRun,runId:nextId,onFinished:status=>R.finishReportRun('report-owner',report.conversationId,nextId,status)};await start(continuation);await complete(continuation);
 const saved=await R.readReport('report-owner',report.id);assert.equal(saved.snapshot.runId,nextId);assert.equal((await q.one('SELECT parent_run_id FROM display_report_attempts WHERE run_id=?',nextId)).parent_run_id,rootRun.runId);
 assert.equal(await R.resumeReportAfterApproval('report-owner',report.conversationId,nextId),false);
});
test('mutable chat agent or project scope cannot become a saved report writer',async()=>{
 await q.run("INSERT INTO agents_config(id,name,provider,model) VALUES('other-report-agent','Other','ollama','synthetic')");await q.run('UPDATE chat_sessions SET agent_id=? WHERE id=?','other-report-agent',report.conversationId);
 assert.equal((await call('GET','/api/reports/'+report.id)).statusCode,404);assert.equal(await R.reportCanStart('report-owner',report.id,report.revision),false);
 await q.run('UPDATE chat_sessions SET agent_id=? WHERE id=?','report-agent',report.conversationId);
});
test('fast approval decisions before writer release wait durably and continue once without premature publication',async()=>{
 const r=await create();await call('POST',`/api/reports/${r.id}/run`,{requestId:randomUUID(),expectedRevision:r.revision});const run=starts.at(-1),approval=randomUUID();
 await q.run("INSERT INTO tool_approvals(id,status,user_id,session_id,agent_id,tool_name,params_encrypted,params_iv,params_tag) VALUES(?,'denied',?,?,?,?,?,?,?)",approval,'report-owner',r.conversationId,'report-agent','synthetic','fixture','fixture','fixture');
 await complete(run);let detail=await R.readReport('report-owner',r.id);assert.equal(detail.report.status,'waiting');assert.equal(detail.history.length,0);assert.ok((await R.decidedReportApprovals('report-owner',r.conversationId)).some(x=>x.approval_id===approval));
 const resumed=await R.resumeReportAfterApproval('report-owner',r.conversationId,'approval-'+approval);assert.ok(resumed);assert.equal(await R.resumeReportAfterApproval('report-owner',r.conversationId,'approval-'+approval),false);assert.equal((await R.decidedReportApprovals('report-owner',r.conversationId)).length,0);
 const next={...run,runId:'approval-'+approval,onFinished:status=>R.finishReportRun('report-owner',r.conversationId,'approval-'+approval,status)};await start(next);await complete(next);detail=await R.readReport('report-owner',r.id);assert.equal(detail.history.length,1);
});
test('restart reconciliation publishes completed journal evidence without rerunning a provider',async()=>{
 const r=await create();await call('POST',`/api/reports/${r.id}/run`,{requestId:randomUUID(),expectedRevision:r.revision});const run=starts.at(-1);
 await C.addAssistantMessage(run.c.id,{runId:run.runId,agentId:run.agentId,content:result(),parts:[],status:'complete',durationMs:1});await J.finishChatRun(run.runId,'complete');const before=starts.length;
 await R.reconcileReportAttempts();await R.reconcileReportAttempts();const detail=await R.readReport('report-owner',r.id);assert.equal(detail.history.length,1);assert.equal(starts.length,before);
});
test('existing schedule worker claims a calendar once and generic chat edits cannot replace report schedules',async()=>{
 const S=await import('../src/services/chat-schedules.ts');const r=await create();await R.setReportSchedule('report-owner',r.id,{expectedRevision:r.revision,calendar:{every:'daily',at:'09:00',timezone:'UTC'},paused:false});
 await q.run('UPDATE chat_schedules SET paused=1');await q.run("UPDATE chat_schedules SET paused=0,next_run='2026-11-01T09:00:00.000Z' WHERE session_id=?",r.conversationId);
 let sends=0;const dispatch=async(owner,session,message,runId)=>{assert.equal(message,'Generate saved report '+r.id);const a=await R.admitReportRun(owner,session,runId,true);assert.ok(a);sends++;await R.finishReportRun(owner,session,runId,'refused');return false;};
 await S.runDueSchedules(dispatch,new Date('2026-11-02T10:00:00Z'));await S.runDueSchedules(dispatch,new Date('2026-11-02T10:00:00Z'));assert.equal(sends,1);
 await assert.rejects(()=>S.deleteSchedule('report-owner',r.conversationId));await q.run('UPDATE chat_schedules SET paused=1 WHERE session_id=?',r.conversationId);await assert.rejects(()=>R.admitReportRun('report-owner',r.conversationId,'paused-test',true));
});
test('project board reports count scoped saved tasks, preserve Markdown progress and never start a provider',async()=>{
 const project=await C.createProject('report-owner',{name:'Synthetic board project'}),other=await C.createProject('report-owner',{name:'Other synthetic project'}),foreign=await C.createProject('report-other',{name:'Foreign synthetic project'});
 const session=await C.createConversation('report-owner',{projectId:project.id,agentId:'report-agent',mode:'ask',thinking:'normal'});
 for(const[id,owner]of[['source-board','report-owner'],['foreign-board','report-other']]){await q.run('INSERT INTO boards(id,owner_id,name) VALUES(?,?,?)',id,owner,id);for(const [suffix,position]of[['todo',0],['done',1]])await q.run('INSERT INTO board_columns(id,board_id,name,position) VALUES(?,?,?,?)',id+'-'+suffix,id,suffix,position);}
 for(const[id,board,column,chat,archived]of[['open-card','source-board','todo',session.id,0],['done-card','source-board','done',null,0],['foreign-card','foreign-board','todo',session.id,0],['archived-card','source-board','todo',session.id,1],['different-file-project','source-board','todo',session.id,0]])await q.run('INSERT INTO board_cards(id,board_id,column_id,title,created_by,conversation_id,due_date,archived,position) VALUES(?,?,?,?,?,?,?,?,0)',id,board,board+'-'+column,id,'report-owner',chat,'2000-01-01',archived);
 await q.run('INSERT INTO task_file_cards(card_id,project_id,task_no,block,finished) VALUES(?,?,?,?,1)','done-card',project.id,'T-1',JSON.stringify({done:['Implemented synthetic feature'],left:[],next:['Owner review']}));
 await q.run('INSERT INTO task_file_cards(card_id,project_id,task_no,block) VALUES(?,?,?,?)','different-file-project',other.id,'T-2','{}');
 await q.run('INSERT INTO board_card_agents(card_id,agent_id) VALUES(?,?)','open-card','report-agent');
 const views={summary:'Text',tasks:'Table',progress:'Table',states:'BarChart',completed:'Metric',open:'Metric',overdue:'Metric'};
 const boardPresentation={source:'project_tasks',sections:Object.entries(views).map(([boardView,preferredType])=>({id:boardView,title:boardView,size:'wide',importance:'normal',preferredType,boardView}))};
 const payload=draft({projectId:project.id,presentation:boardPresentation});assert.equal((await call('POST','/api/reports',{...payload,requestId:randomUUID(),projectId:null})).statusCode,400);assert.equal((await call('POST','/api/reports',{...payload,requestId:randomUUID(),projectId:foreign.id})).statusCode,404);
 const r=await create({projectId:project.id,presentation:boardPresentation}),before=starts.length,key={requestId:randomUUID(),expectedRevision:r.revision};
 const generated=await call('POST',`/api/reports/${r.id}/run`,key);assert.equal(generated.statusCode,200,generated.body);assert.equal(generated.json().status,'complete');assert.equal(starts.length,before);
 let detail=await R.readReport('report-owner',r.id);const sections=detail.snapshot.sections;const props=id=>sections.find(s=>s.id===id).document.elements.r.props;
 assert.equal(props('completed').value,'1');assert.equal(props('open').value,'1');assert.equal(props('overdue').value,'1');assert.equal(props('tasks').data.length,2);assert.ok(props('tasks').data.some(x=>x.agents==='Report helper'));assert.match(JSON.stringify(props('progress')),/Implemented synthetic feature/);assert.ok(!JSON.stringify(sections).includes('foreign-card'));assert.ok(!JSON.stringify(sections).includes('different-file-project'));assert.equal(sections.find(s=>s.id==='tasks').tasks.length,2);
 assert.equal((await call('POST',`/api/reports/${r.id}/run`,key)).json().replayed,true);assert.equal((await R.readReport('report-owner',r.id)).history.length,1);
 const snapshot=detail.snapshot.id;await q.run("UPDATE board_cards SET column_id='source-board-done' WHERE id='open-card'");await call('POST',`/api/reports/${r.id}/run`,{requestId:randomUUID(),expectedRevision:r.revision});detail=await R.readReport('report-owner',r.id);assert.equal(detail.snapshot.sections.find(s=>s.id==='completed').document.elements.r.props.value,'2');assert.equal((await R.readReport('report-owner',r.id,snapshot)).snapshot.sections.find(s=>s.id==='completed').document.elements.r.props.value,'1');
 const scheduled=await R.setReportSchedule('report-owner',r.id,{expectedRevision:r.revision,calendar:{every:'daily',at:'09:00',timezone:'UTC'},paused:false}),runId='board-scheduled-capture';const admitted=await R.admitReportRun('report-owner',r.conversationId,runId,true);await R.captureBoardReport('report-owner',r.id,runId,true);assert.ok(admitted);assert.equal(starts.length,before);assert.equal(scheduled.report.revision,2);
 // Transferring the project revokes access and capture without rewriting old snapshots.
 await q.run('UPDATE chat_projects SET user_id=? WHERE id=?','report-other',project.id);assert.equal((await call('GET','/api/reports/'+r.id)).statusCode,404);await assert.rejects(()=>R.captureBoardReport('report-owner',r.id,'revoked'));
});
test.after(async()=>{await app.close();if(pg)await(await import('../src/db/pg/pool.ts')).closePgPool();closeDatabase();fs.rmSync(root,{recursive:true,force:true});});
