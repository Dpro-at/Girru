import {forUpdate} from '../db/pg/dialect.js';
import {BOARD_REPORT_VIEWS,projectBoardSections,BoardReportSourceError,type BoardReportView} from './report-board-source.js';
/** Owner-scoped report definitions, presentation and immutable completed-run snapshots. No renderer or provider fetches. */
import {randomUUID,createHash} from 'node:crypto';
import {q,sql,one,all,run,lockName,dialect,type Step} from '../repositories/sql-steps.js';
import {findConversation,findProject} from '../repositories/chat-conversations.js';
import {validateDisplayDocument} from './display-documents.js';
import {reportCalendar,nextReportOccurrence} from './report-calendar.js';
export class ReportError extends Error{constructor(public status:number,public code:string){super(code);}}
const bad=():never=>{throw new ReportError(400,'invalid_report');},missing=():never=>{throw new ReportError(404,'report_not_found');},conflict=():never=>{throw new ReportError(409,'report_changed');};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max:number)=>{if(typeof v!=='string'||!v.trim()||v.length>max)return bad();return v.trim();};
async function assertOwner(owner:string){const user=await q.one<{role:string;status:string}>('SELECT role,status FROM users WHERE id=?',owner);if(user?.role!=='owner'||user.status!=='active')throw new ReportError(403,'report_forbidden');}
export function* ownerStep(owner:string):Step<void>{const user=yield* one<{role:string;status:string}>('SELECT role,status FROM users WHERE id=?',owner);if(user?.role!=='owner'||user.status!=='active')throw new ReportError(403,'report_forbidden');}
export type ReportSection={id:string;title:string;size:'compact'|'wide';importance:'low'|'normal'|'high';preferredType:string;boardView?:BoardReportView};
function presentation(v:unknown):{source?:'agent'|'project_tasks';sections:ReportSection[]}{
 if(!object(v)||Object.keys(v).some(k=>!['source','sections'].includes(k))||v.source!==undefined&&!['agent','project_tasks'].includes(v.source)||!Array.isArray(v.sections)||!v.sections.length||v.sections.length>24)return bad();
 const seen=new Set<string>();return {...(v.source?{source:v.source}:{}),sections:v.sections.map((r:any)=>{if(!object(r)||Object.keys(r).some(k=>!['id','title','size','importance','preferredType','boardView'].includes(k))||!id(r.id)||seen.has(r.id)||!['compact','wide'].includes(r.size)||!['low','normal','high'].includes(r.importance)||!['Card','Text','Metric','Table','BarChart','LineChart','PieChart','Timeline'].includes(r.preferredType))return bad();if(v.source==='project_tasks'?typeof r.boardView!=='string'||!Object.hasOwn(BOARD_REPORT_VIEWS,r.boardView)||r.preferredType!==BOARD_REPORT_VIEWS[r.boardView as BoardReportView]:r.boardView!==undefined)return bad();seen.add(r.id);return {...r,title:text(r.title,160)} as ReportSection;})};
}
export type ReportRow={id:string;owner_id:string;session_id:string;title:string;instructions:string;agent_id:string;project_id:string|null;revision:number;presentation_json:string;latest_snapshot_id:string|null;status:string;last_error:string|null;request_hash:string};
async function accessible(owner:string,row:ReportRow){
 const user=await q.one<{role:string;status:string}>('SELECT role,status FROM users WHERE id=?',owner);if(user?.role!=='owner'||user.status!=='active')return missing();
 const c=await findConversation(owner,row.session_id);if(!c||c.archived||(c.agentId??null)!==row.agent_id||(c.projectId??null)!==(row.project_id??null))return missing();
 if(row.project_id){const p=await findProject(owner,row.project_id);if(!p||(p as {archived?:boolean}).archived)return missing();}
 if(!await q.one('SELECT id FROM agents_config WHERE id=?',row.agent_id))return missing();return row;
}
export async function reportRow(owner:string,key:string){if(!id(key))return missing();const row=await q.one<ReportRow>('SELECT * FROM display_reports WHERE owner_id=? AND id=?',owner,key);return row?accessible(owner,row):missing();}
function view(r:ReportRow){return {id:r.id,title:r.title,instructions:r.instructions,agentId:r.agent_id,projectId:r.project_id,revision:Number(r.revision),presentation:JSON.parse(r.presentation_json),status:r.status,lastError:r.last_error,conversationId:r.session_id};}
/** Transaction-local publication admission reuses the same owner/session/project association checks. */
export function* reportScopeStep(owner:string,row:ReportRow):Step<void>{
 yield* ownerStep(owner);const d=yield* dialect();
 const c=yield* one<{agent_id:string|null;project_id:string|null;archived_at:string|null}>('SELECT agent_id,project_id,archived_at FROM chat_sessions WHERE user_id=? AND id=?'+forUpdate(d),owner,row.session_id);
 if(!c||c.archived_at||c.agent_id!==row.agent_id||(c.project_id??null)!==(row.project_id??null))return missing();
 if(row.project_id&&!(yield* one('SELECT id FROM chat_projects WHERE user_id=? AND id=?'+forUpdate(d),owner,row.project_id)))return missing();
 if(!(yield* one('SELECT id FROM agents_config WHERE id=?',row.agent_id)))return missing();
}
export async function listReports(owner:string){await assertOwner(owner);const rows=await q.all<ReportRow>('SELECT * FROM display_reports WHERE owner_id=? ORDER BY updated_at DESC,id LIMIT 100',owner),result=[];for(const row of rows){try{await accessible(owner,row);result.push(view(row));}catch(e){if(!(e instanceof ReportError))throw e;}}return {reports:result};}
export async function readReport(owner:string,key:string,snapshotId?:string){
 const r=await reportRow(owner,key);if(snapshotId!==undefined&&!id(snapshotId))return bad();
 const snapshot=await q.one<any>('SELECT * FROM display_report_snapshots WHERE owner_id=? AND report_id=? AND id=?',owner,key,snapshotId??r.latest_snapshot_id??'');
 if(snapshotId&&!snapshot)return missing();
 const history=await q.all('SELECT id,captured_at AS "capturedAt",definition_revision AS revision FROM display_report_snapshots WHERE owner_id=? AND report_id=? ORDER BY captured_at DESC,id DESC LIMIT 50',owner,key);
 const schedule=await q.one<any>('SELECT paused,next_run,last_result,calendar_json FROM chat_schedules WHERE user_id=? AND session_id=?',owner,r.session_id);
 const provenance=snapshot?await q.one('SELECT source_kind AS \"sourceKind\",published_at AS \"publishedAt\" FROM display_report_publications WHERE owner_id=? AND snapshot_id=?',owner,snapshot.id):null;
 return {report:view(r),snapshot:snapshot?{id:snapshot.id,runId:snapshot.run_id,revision:Number(snapshot.definition_revision),presentation:JSON.parse(snapshot.presentation_json),sections:JSON.parse(snapshot.sections_json),capturedAt:snapshot.captured_at,...(provenance?{provenance}:{} )}:null,history,schedule:schedule?.calendar_json?{calendar:JSON.parse(schedule.calendar_json),paused:!!schedule.paused,nextRun:schedule.next_run,lastResult:schedule.last_result}:null};
}
export async function saveReport(owner:string,key:string|null,input:unknown){
 await assertOwner(owner);
 if(!object(input)||Object.keys(input).some(k=>!['requestId','expectedRevision','title','instructions','agentId','projectId','presentation'].includes(k))||!Number.isSafeInteger(input.expectedRevision)||!id(input.agentId)||input.projectId!=null&&!id(input.projectId))return bad();
 const b={title:text(input.title,160),instructions:text(input.instructions,3000),agentId:input.agentId,projectId:input.projectId??null,presentation:presentation(input.presentation)};
 if(b.presentation.source==='project_tasks'&&!b.projectId)return bad();
 if(!await q.one('SELECT id FROM agents_config WHERE id=?',b.agentId))return bad();if(b.projectId&&!await findProject(owner,b.projectId))return missing();
 if(!key){
  if(input.expectedRevision!==0||!id(input.requestId))return bad();const hash=createHash('sha256').update(JSON.stringify(b)).digest('hex');const old=await q.one<ReportRow>('SELECT * FROM display_reports WHERE owner_id=? AND request_id=?',owner,input.requestId);if(old){if(old.request_hash!==hash)return conflict();return readReport(owner,old.id);}
  const reportId=randomUUID(),sessionId=randomUUID();
  const chosen=await sql().tx(function*(){yield* lockName('report-create:'+owner+':'+input.requestId);yield* ownerStep(owner);const prior=yield* one<ReportRow>('SELECT * FROM display_reports WHERE owner_id=? AND request_id=?',owner,input.requestId);if(prior){if(prior.request_hash!==hash)return conflict();return prior.id;}yield* run('INSERT INTO chat_sessions(id,user_id,title,model,agent_id,project_id,mode,thinking) VALUES(?,?,?,?,?,?,?,?)',sessionId,owner,'Report: '+b.title,'default',b.agentId,b.projectId,'ask','normal');yield* run('INSERT INTO display_reports(id,owner_id,request_id,request_hash,session_id,title,instructions,agent_id,project_id,presentation_json) VALUES(?,?,?,?,?,?,?,?,?,?)',reportId,owner,input.requestId,hash,sessionId,b.title,b.instructions,b.agentId,b.projectId,JSON.stringify(b.presentation));return reportId;},{immediate:true});return readReport(owner,chosen);

 }
 const row=await reportRow(owner,key);if(Number(row.revision)!==input.expectedRevision)return conflict();
 await sql().tx(function*(){yield* lockName('report:'+key);yield* ownerStep(owner);const changed=yield* run('UPDATE display_reports SET title=?,instructions=?,agent_id=?,project_id=?,presentation_json=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=? AND id=? AND revision=?',b.title,b.instructions,b.agentId,b.projectId,JSON.stringify(b.presentation),owner,key,input.expectedRevision);if(!changed.changes)return conflict();yield* run('UPDATE chat_sessions SET agent_id=?,project_id=? WHERE user_id=? AND id=?',b.agentId,b.projectId,owner,row.session_id);yield* run('UPDATE chat_schedules SET paused=1 WHERE user_id=? AND session_id=?',owner,row.session_id);},{immediate:true});return readReport(owner,key);
}
export function reportPrompt(row:ReportRow){return `Prepare the saved report using only sources you are currently authorized to read. Do not send messages or trade. Never invent data. If a source is unavailable, say so in that section. Return ONLY JSON: {"schemaVersion":1,"sections":[{"id":"section ID","document":{"schemaVersion":1,"root":"r","elements":{"r":{"type":"Text","props":{"content":"result"},"children":[]}}},"dataAsOf":null,"sourceLabel":"source name"}]}. Use the listed section IDs and preferred display types. Source timestamps are optional; do not claim data was collected just because this request ran.\nReport: ${row.title}\nInstructions: ${row.instructions}\nPresentation (data): ${row.presentation_json}`;}
export async function setReportSchedule(owner:string,key:string,input:unknown,now=new Date()){
 if(!object(input)||Object.keys(input).some(k=>!['expectedRevision','calendar','paused'].includes(k))||!Number.isSafeInteger(input.expectedRevision)||typeof input.paused!=='boolean')return bad();
 const row=await reportRow(owner,key);let calendar;try{calendar=reportCalendar(input.calendar);}catch{return bad();}const next=nextReportOccurrence(calendar,now).toISOString(),message='Generate saved report '+key;
 await sql().tx(function*(){yield* lockName('report:'+key);yield* ownerStep(owner);const changed=yield* run('UPDATE display_reports SET revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_id=? AND revision=?',key,owner,input.expectedRevision);if(!changed.changes)return conflict();yield* run(`INSERT INTO chat_schedules(session_id,user_id,every,at_time,weekday,message,paused,next_run,calendar_json) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET every=excluded.every,at_time=excluded.at_time,weekday=excluded.weekday,message=excluded.message,paused=excluded.paused,next_run=excluded.next_run,calendar_json=excluded.calendar_json,updated_at=CURRENT_TIMESTAMP`,row.session_id,owner,calendar.every,calendar.at,calendar.weekday??null,message,input.paused?1:0,next,JSON.stringify(calendar));},{immediate:true});return readReport(owner,key);
}
function* approvalBaseline(owner:string,session:string):Step<string>{const ids=yield* all<{id:string}>('SELECT id FROM tool_approvals WHERE user_id=? AND session_id=? LIMIT 5001',owner,session);if(ids.length>5000)throw new ReportError(409,'report_approval_history_limit');return JSON.stringify(ids.map(x=>x.id));}
export async function admitReportRun(owner:string,session:string,runId:string,scheduled=false,expectedRevision?:number){
 const row=await q.one<ReportRow>('SELECT * FROM display_reports WHERE owner_id=? AND session_id=?',owner,session);if(!row)return null;await accessible(owner,row);
 if(scheduled){const schedule=await q.one<{paused:number}>('SELECT paused FROM chat_schedules WHERE user_id=? AND session_id=?',owner,session);if(!schedule||schedule.paused)throw new ReportError(409,'report_schedule_paused');}
 let replayed=false;await sql().tx(function*(){yield* lockName('report:'+row.id);yield* ownerStep(owner);const old=yield* one<any>('SELECT * FROM display_report_attempts WHERE report_id=? AND run_id=? AND owner_id=?',row.id,runId,owner);if(old){if(expectedRevision!==undefined&&Number(old.definition_revision)!==expectedRevision)return conflict();replayed=true;return;}if(expectedRevision!==undefined&&Number(row.revision)!==expectedRevision)return conflict();const active=yield* one('SELECT run_id FROM display_report_attempts WHERE report_id=? AND state IN (?,?,?)',row.id,'starting','running','waiting');if(active)throw new ReportError(409,'report_busy');const current=yield* run('UPDATE display_reports SET status=?,last_error=NULL WHERE owner_id=? AND id=? AND revision=?','running',owner,row.id,row.revision);if(!current.changes)return conflict();const baseline=yield* approvalBaseline(owner,session);yield* run('INSERT INTO display_report_attempts(report_id,run_id,owner_id,definition_revision,approval_baseline_json,state,started_at) VALUES(?,?,?,?,?,?,?)',row.id,runId,owner,row.revision,baseline,'starting',new Date().toISOString());},{immediate:true});return {row,message:reportPrompt(row),replayed};
}
export function resultSections(textValue:string,layout:{sections:ReportSection[]}){
 if(textValue.length>128000)return bad();let payload:any;try{payload=JSON.parse(textValue.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{return bad();}
 if(!object(payload)||payload.schemaVersion!==1||Object.keys(payload).some(k=>!['schemaVersion','sections'].includes(k))||!Array.isArray(payload.sections)||payload.sections.length!==layout.sections.length)return bad();
 const seen=new Set<string>();for(const s of payload.sections){if(!object(s)||Object.keys(s).some(k=>!['id','document','sourceLabel','dataAsOf'].includes(k))||!layout.sections.some(x=>x.id===s.id)||seen.has(s.id))return bad();seen.add(s.id);}
 return layout.sections.map(section=>{const value=payload.sections.find((s:any)=>s.id===section.id);if(!value)return {id:section.id,document:{schemaVersion:1,root:'r',elements:{r:{type:'Text',props:{content:'No result was produced for this section.'},children:[]}}},sourceLabel:'Unavailable',dataAsOf:null};const result=validateDisplayDocument(value.document);if(!result.ok||result.warnings.length)return bad();if(value.dataAsOf!=null&&(typeof value.dataAsOf!=='string'||!Number.isFinite(Date.parse(value.dataAsOf))))return bad();return {id:section.id,document:result.document,sourceLabel:typeof value.sourceLabel==='string'?value.sourceLabel.slice(0,200):'Agent result',dataAsOf:value.dataAsOf??null};});
}
export async function finishReportRun(owner:string,session:string,runId:string,status:string){
 const row=await q.one<ReportRow>('SELECT * FROM display_reports WHERE owner_id=? AND session_id=?',owner,session);if(!row)return;await accessible(owner,row);
 const attempt=await q.one<any>('SELECT * FROM display_report_attempts WHERE report_id=? AND run_id=? AND owner_id=?',row.id,runId,owner);if(!attempt||['complete','failed','superseded'].includes(attempt.state))return;
 const baseline=new Set<string>(JSON.parse(attempt.approval_baseline_json));
 const approvals=await q.all<{id:string;status:string}>('SELECT id,status FROM tool_approvals WHERE user_id=? AND session_id=? LIMIT 5001',owner,session);
 const newApprovals=approvals.filter(a=>!baseline.has(a.id));for(const decision of newApprovals)if(['executed','failed','denied','expired'].includes(decision.status))await recordReportApprovalDecision(decision.id);
 const pending=newApprovals.length>0||approvals.some(a=>['pending','approved'].includes(a.status));
 const decided=await q.one('SELECT approval_id FROM display_report_approval_decisions WHERE report_id=? AND run_id=?',row.id,runId);
 if((pending||decided)&&status==='complete'){
  const waitAt=new Date().toISOString();await sql().tx(function*(){yield* lockName('report:'+row.id);yield* ownerStep(owner);yield* run("UPDATE display_report_attempts SET state='waiting',finished_at=? WHERE report_id=? AND run_id=? AND state IN ('starting','running','waiting')",waitAt,row.id,runId);yield* run("UPDATE display_reports SET status='waiting',last_error=NULL WHERE owner_id=? AND id=? AND revision=?",owner,row.id,attempt.definition_revision);},{immediate:true});return;
 }
 const journal=await q.one<any>('SELECT state,ended_at,agent_id FROM chat_run_journal WHERE run_id=? AND user_id=? AND session_id=?',runId,owner,session);const answer=await q.one<any>("SELECT content,status FROM chat_messages WHERE run_id=? AND session_id=? AND role='assistant' ORDER BY id DESC LIMIT 1",runId,session);
 let sections:unknown,error:string|null=null;try{if(status!=='complete'||journal?.state!=='complete'||!journal.ended_at||journal.agent_id!==row.agent_id||answer?.status!=='complete')throw Error('run_incomplete');if(Number(row.revision)!==Number(attempt.definition_revision))throw Error('definition_changed');sections=resultSections(answer.content,JSON.parse(row.presentation_json));}catch(e){error=e instanceof ReportError?'invalid_report_result':e instanceof Error&&['run_incomplete','definition_changed'].includes(e.message)?e.message:'report_result_failed';}
 const now=new Date().toISOString(),snapshotId=randomUUID();
 await sql().tx(function*(){yield* lockName('report:'+row.id);yield* ownerStep(owner);const current=yield* one<ReportRow>('SELECT * FROM display_reports WHERE owner_id=? AND id=?',owner,row.id);if(!current||Number(current.revision)!==Number(attempt.definition_revision))error='definition_changed';const changed=yield* run("UPDATE display_report_attempts SET state=?,finished_at=?,error=? WHERE report_id=? AND run_id=? AND state IN ('starting','running','waiting')",error?'failed':'complete',now,error,row.id,runId);if(!changed.changes)return;if(!error){yield* run('INSERT INTO display_report_snapshots(id,report_id,owner_id,run_id,definition_revision,presentation_json,sections_json,captured_at) VALUES(?,?,?,?,?,?,?,?)',snapshotId,row.id,owner,runId,row.revision,row.presentation_json,JSON.stringify(sections),now);yield* run('UPDATE display_reports SET latest_snapshot_id=?,status=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_id=? AND revision=?',snapshotId,'complete',row.id,owner,row.revision);}else yield* run('UPDATE display_reports SET status=?,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_id=?','failed',error,row.id,owner);},{immediate:true});
}

/** Current scope and definition are rechecked immediately before starting a report writer. */
export async function reportCanStart(owner:string,key:string,revision:number,scheduled=false){
 try{const row=await reportRow(owner,key);if(Number(row.revision)!==revision)return false;if(scheduled){const s=await q.one<{paused:number}>('SELECT paused FROM chat_schedules WHERE user_id=? AND session_id=?',owner,row.session_id);if(!s||s.paused)return false;}return true;}catch{return false;}
}
/** Restart reconciliation observes durable evidence only; never reruns a model or a tool. */
export async function reconcileReportAttempts(){
 const pending=await q.all<any>("SELECT a.*,r.session_id FROM display_report_attempts a JOIN display_reports r ON r.id=a.report_id WHERE a.state IN ('starting','running','waiting') ORDER BY a.started_at LIMIT 100");
 for(const a of pending){
  if(a.state==='waiting'){const waiting=await q.one("SELECT id FROM tool_approvals WHERE user_id=? AND session_id=? AND status IN ('pending','approved') LIMIT 1",a.owner_id,a.session_id);const decided=await q.one('SELECT approval_id FROM display_report_approval_decisions WHERE report_id=? AND run_id=?',a.report_id,a.run_id);if(waiting||decided||Date.now()-Date.parse(a.finished_at??a.started_at)<10000)continue;}
  const j=await q.one<any>('SELECT state FROM chat_run_journal WHERE run_id=? AND user_id=? AND session_id=?',a.run_id,a.owner_id,a.session_id);
  if(j?.state==='complete')await finishReportRun(a.owner_id,a.session_id,a.run_id,'complete').catch(()=>null);
  else if(j&&j.state!=='running'||!j&&Date.now()-Date.parse(a.started_at)>10000)await finishReportRun(a.owner_id,a.session_id,a.run_id,'interrupted').catch(()=>null);
 }
}

/** Bind the existing owner-decided continuation to its waiting report, without replaying its original tools. */
export async function resumeReportAfterApproval(owner:string,session:string,runId:string):Promise<false|{row:ReportRow}|null>{
 const row=await q.one<ReportRow>('SELECT * FROM display_reports WHERE owner_id=? AND session_id=?',owner,session);if(!row)return null;await accessible(owner,row);
 return sql().tx(function*():Step<false|{row:ReportRow}>{yield* lockName('report:'+row.id);yield* ownerStep(owner);const existing=yield* one('SELECT run_id FROM display_report_attempts WHERE report_id=? AND run_id=?',row.id,runId);if(existing)return false;const latest=yield* one<ReportRow>('SELECT * FROM display_reports WHERE owner_id=? AND id=?',owner,row.id);if(!latest||Number(latest.revision)!==Number(row.revision))return false;const prior=yield* one<any>("SELECT * FROM display_report_attempts WHERE report_id=? AND owner_id=? AND state='waiting' ORDER BY started_at DESC LIMIT 1",row.id,owner);if(!prior)return false;if(Number(prior.definition_revision)!==Number(row.revision)){yield* run("UPDATE display_report_attempts SET state='failed',error='definition_changed' WHERE report_id=? AND run_id=?",row.id,prior.run_id);return false;}if(yield* one("SELECT run_id FROM display_report_attempts WHERE report_id=? AND state IN ('starting','running')",row.id))return false;yield* run("UPDATE display_report_attempts SET state='superseded' WHERE report_id=? AND run_id=?",row.id,prior.run_id);const baseline=yield* approvalBaseline(owner,session);yield* run('INSERT INTO display_report_attempts(report_id,run_id,owner_id,definition_revision,parent_run_id,approval_baseline_json,state,started_at) VALUES(?,?,?,?,?,?,?,?)',row.id,runId,owner,row.revision,prior.run_id,baseline,'starting',new Date().toISOString());yield* run("UPDATE display_reports SET status='running',last_error=NULL WHERE owner_id=? AND id=?",owner,row.id);return {row};},{immediate:true});
}

/** A decision arriving before writer release is durable; no approval/tool is executed here. */
export async function recordReportApprovalDecision(approvalId:string){
 const a=await q.one<any>("SELECT user_id,session_id,status FROM tool_approvals WHERE id=?",approvalId);if(!a?.user_id||!a.session_id||!['executed','failed','denied','expired'].includes(a.status))return;
 const row=await q.one<ReportRow>('SELECT * FROM display_reports WHERE owner_id=? AND session_id=?',a.user_id,a.session_id);if(!row)return;await accessible(a.user_id,row);
 await sql().tx(function*(){yield* lockName('report:'+row.id);yield* ownerStep(a.user_id);const active=yield* one<any>("SELECT run_id FROM display_report_attempts WHERE report_id=? AND state IN ('starting','running','waiting') ORDER BY started_at DESC LIMIT 1",row.id);if(!active)return;yield* run('INSERT INTO display_report_approval_decisions(approval_id,report_id,run_id,owner_id,session_id) VALUES(?,?,?,?,?) ON CONFLICT(approval_id) DO NOTHING',approvalId,row.id,active.run_id,a.user_id,a.session_id);},{immediate:true});
}
export async function decidedReportApprovals(owner?:string,session?:string){
 return q.all<{approval_id:string}>(`SELECT d.approval_id FROM display_report_approval_decisions d JOIN display_report_attempts a ON a.report_id=d.report_id AND a.run_id=d.run_id WHERE a.state='waiting' ${owner?'AND d.owner_id=? AND d.session_id=?':''} AND NOT EXISTS (SELECT 1 FROM display_report_attempts n WHERE n.report_id=d.report_id AND n.run_id=('approval-' || d.approval_id)) ORDER BY a.started_at LIMIT 100`,...(owner?[owner,session!]:[]));
}

export const isBoardReport=(row:ReportRow)=>JSON.parse(row.presentation_json).source==='project_tasks';
/** Deterministic source capture, independent of models/tools, committed atomically with its immutable snapshot. */
export async function captureBoardReport(owner:string,key:string,runId:string,scheduled=false){
 const initial=await reportRow(owner,key);if(!isBoardReport(initial))return bad();
 try{await sql().tx(function*(){
  yield* lockName('report:'+key);const d=yield* dialect();const user=yield* one<any>('SELECT role,status FROM users WHERE id=?'+forUpdate(d),owner);if(user?.role!=='owner'||user.status!=='active')throw new ReportError(403,'report_forbidden');
  const row=yield* one<ReportRow>('SELECT * FROM display_reports WHERE owner_id=? AND id=?',owner,key);
  const attempt=yield* one<any>('SELECT * FROM display_report_attempts WHERE report_id=? AND run_id=? AND owner_id=?',key,runId,owner);
  if(attempt?.state==='complete')return;
  if(!row||!attempt||attempt.state!=='starting'||Number(row.revision)!==Number(attempt.definition_revision)||!row.project_id||!isBoardReport(row))return conflict();
  const c=yield* one<any>('SELECT user_id,agent_id,project_id,archived_at FROM chat_sessions WHERE id=?'+forUpdate(d),row.session_id);
  if(!c||c.user_id!==owner||c.archived_at||c.agent_id!==row.agent_id||c.project_id!==row.project_id)return missing();
  if(scheduled){const schedule=yield* one<any>('SELECT paused FROM chat_schedules WHERE user_id=? AND session_id=?',owner,row.session_id);if(!schedule||schedule.paused)throw new ReportError(409,'report_schedule_paused');}
  const now=new Date().toISOString(),snapshotId=randomUUID(),layout=JSON.parse(row.presentation_json);
  const sections=yield* projectBoardSections(owner,row.project_id,layout.sections,now);
  for(const section of sections as any[]){const result=validateDisplayDocument(section.document);if(!result.ok||result.warnings.length)throw new ReportError(400,'invalid_report_result');}
  if(JSON.stringify(sections).length>128000)throw new ReportError(409,'report_source_limit');
  yield* run('INSERT INTO display_report_snapshots(id,report_id,owner_id,run_id,definition_revision,presentation_json,sections_json,captured_at) VALUES(?,?,?,?,?,?,?,?)',snapshotId,key,owner,runId,row.revision,row.presentation_json,JSON.stringify(sections),now);
  yield* run("UPDATE display_report_attempts SET state='complete',finished_at=? WHERE report_id=? AND run_id=?",now,key,runId);
  yield* run("UPDATE display_reports SET latest_snapshot_id=?,status='complete',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE owner_id=? AND id=?",snapshotId,owner,key);
 },{immediate:true});}catch(e){if(e instanceof BoardReportSourceError)throw new ReportError(e.message==='report_source_limit'?409:404,e.message);throw e;}
 return {runId,conversationId:initial.session_id,status:'complete'};
}
