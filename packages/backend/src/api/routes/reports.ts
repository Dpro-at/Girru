import {publishPreparedReport} from '../../services/report-publication.js';
import type {FastifyInstance} from 'fastify';
import {createHash} from 'node:crypto';
import {authorizeActiveRoleAsync} from '../../auth/route-guards.js';
import {ReportError,listReports,readReport,saveReport,setReportSchedule,reportRow,admitReportRun,finishReportRun,reportCanStart,isBoardReport,captureBoardReport} from '../../services/reports.js';
import {findConversation} from '../../repositories/chat-conversations.js';
type StartTurn=typeof import('./chat-conversations.js').startTurn;
export async function reportRoutes(app:FastifyInstance,options:{start?:StartTurn;ensureRecovery?:()=>Promise<unknown>}={}){
 const register=(method:'GET'|'POST'|'PUT',url:string,action:(owner:string,request:any)=>Promise<unknown>)=>app.route({method,url,config:{access:'owner'},bodyLimit:65536,async handler(request,reply){const owner=await authorizeActiveRoleAsync(request,reply,['owner']);if(!owner)return reply;await (options.ensureRecovery?options.ensureRecovery():(await import('./chat-conversations.js')).ensureChatRecovery());try{return await action(owner,request);}catch(e){if(e instanceof ReportError)return reply.code(e.status).send({code:e.code});throw e;}}});
 register('GET','/api/reports',async(owner,r)=>{if(Object.keys(r.query??{}).length)throw new ReportError(400,'invalid_report');return listReports(owner);});
 register('POST','/api/reports',async(owner,r)=>saveReport(owner,null,r.body));
 register('GET','/api/reports/:id',async(owner,r)=>{if(Object.keys(r.query??{}).some(k=>k!=='snapshotId'))throw new ReportError(400,'invalid_report');return readReport(owner,r.params.id,r.query?.snapshotId);});
 register('PUT','/api/reports/:id',async(owner,r)=>saveReport(owner,r.params.id,r.body));
 register('POST','/api/reports/:id/publish',async(owner,r)=>publishPreparedReport(owner,r.params.id,r.body));
 register('PUT','/api/reports/:id/schedule',async(owner,r)=>setReportSchedule(owner,r.params.id,r.body));
 register('POST','/api/reports/:id/run',async(owner,r)=>{
  if(!r.body||typeof r.body!=='object'||Array.isArray(r.body)||Object.keys(r.body).some((k:string)=>!['requestId','expectedRevision'].includes(k))||typeof r.body.requestId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(r.body.requestId)||!Number.isSafeInteger(r.body.expectedRevision)||r.body.expectedRevision<1)throw new ReportError(400,'invalid_report');
  const report=await reportRow(owner,r.params.id),c=await findConversation(owner,report.session_id);if(!c)throw new ReportError(404,'report_not_found');
  const runId='report-'+createHash('sha256').update(owner+'\n'+report.id+'\n'+r.body.requestId).digest('hex').slice(0,48),admission=await admitReportRun(owner,c.id,runId,false,r.body.expectedRevision);if(!admission)throw new ReportError(404,'report_not_found');if(admission.replayed)return {runId,conversationId:c.id,status:'accepted',replayed:true};
  try{if(isBoardReport(admission.row))return await captureBoardReport(owner,report.id,runId);const out=await (options.start??(await import('./chat-conversations.js')).startTurn)({userId:owner,role:'owner',c,runId,message:admission.message,agentId:admission.row.agent_id,canStart:()=>reportCanStart(owner,report.id,Number(admission.row.revision)),onFinished:status=>finishReportRun(owner,c.id,runId,status)});if(out.code!==202){await finishReportRun(owner,c.id,runId,'refused');throw new ReportError(out.code,'report_run_refused');}return {runId,conversationId:c.id,status:'running'};}catch(e){await finishReportRun(owner,c.id,runId,'failed').catch(()=>null);throw e;}
 });
}
