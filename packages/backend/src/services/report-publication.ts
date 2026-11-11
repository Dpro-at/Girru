import {auditMcpOutcome} from './mcp-audit.js';
/** Publish already-prepared display data, without a provider run, file read or authority from JSON. */
import {createHash,randomUUID} from 'node:crypto';
import {one,run,sql,lockName,type Step} from '../repositories/sql-steps.js';
import {ReportError,reportRow,reportScopeStep,resultSections,type ReportRow} from './reports.js';
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const bad=():never=>{throw new ReportError(400,'invalid_report_publication');};
function canonical(value:any):string{if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';}
async function publishPreparedReportInner(owner:string,key:string,input:unknown,effectGuard?:()=>Step<void>){
 if(!object(input)||Object.keys(input).some(k=>!['requestId','expectedRevision','projectId','sections'].includes(k))||!id(input.requestId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||!Object.hasOwn(input,'projectId')||(input.projectId!==null&&!id(input.projectId))||!Array.isArray(input.sections)||Buffer.byteLength(JSON.stringify(input))>60000)return bad();
 const report=await reportRow(owner,key);if((report.project_id??null)!==input.projectId)throw new ReportError(404,'report_not_found');
 const fingerprint=createHash('sha256').update(canonical({expectedRevision:input.expectedRevision,projectId:input.projectId,sections:input.sections})).digest('hex');
 return sql().tx(function*(){if(effectGuard)yield* effectGuard();
  yield* lockName('report:'+key);
  const current=yield* one<ReportRow>('SELECT * FROM display_reports WHERE owner_id=? AND id=?',owner,key);if(!current)throw new ReportError(404,'report_not_found');yield* reportScopeStep(owner,current);
  if((current.project_id??null)!==input.projectId)throw new ReportError(404,'report_not_found');
  const prior=yield* one<{payload_hash:string;snapshot_id:string}>('SELECT payload_hash,snapshot_id FROM display_report_publications WHERE owner_id=? AND report_id=? AND request_id=?',owner,key,input.requestId);
  if(prior){if(prior.payload_hash!==fingerprint)throw new ReportError(409,'publication_request_changed');if(!(yield* one('SELECT id FROM display_report_snapshots WHERE owner_id=? AND report_id=? AND id=?',owner,key,prior.snapshot_id)))throw new ReportError(409,'publication_unavailable');return {reportId:key,snapshotId:prior.snapshot_id,replayed:true,sourceKind:'external_prepared'};}
  if(Number(current.revision)!==input.expectedRevision)throw new ReportError(409,'report_changed');
  const sections=resultSections(JSON.stringify({schemaVersion:1,sections:input.sections}),JSON.parse(current.presentation_json));
  // Only new publication is validated against its locked current definition; replay keeps its original snapshot.
  for(const section of sections)if(section.sourceLabel==='Agent result')section.sourceLabel='External prepared result';
  if(yield* one("SELECT run_id FROM display_report_attempts WHERE owner_id=? AND report_id=? AND state IN ('starting','running','waiting') LIMIT 1",owner,key))throw new ReportError(409,'report_busy');
  const snapshotId=randomUUID(),capturedAt=new Date().toISOString(),runId='external-'+snapshotId;
  yield* run('INSERT INTO display_report_snapshots(id,report_id,owner_id,run_id,definition_revision,presentation_json,sections_json,captured_at) VALUES(?,?,?,?,?,?,?,?)',snapshotId,key,owner,runId,current.revision,current.presentation_json,JSON.stringify(sections),capturedAt);
  yield* run("INSERT INTO display_report_publications(owner_id,report_id,request_id,payload_hash,snapshot_id,source_kind,published_at) VALUES(?,?,?,?,?,'external_prepared',?)",owner,key,input.requestId,fingerprint,snapshotId,capturedAt);
  yield* run("UPDATE display_reports SET latest_snapshot_id=?,status='complete',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_id=? AND revision=?",snapshotId,key,owner,current.revision);
  return {reportId:key,snapshotId,replayed:false,sourceKind:'external_prepared'};
 });
}

export async function publishPreparedReport(owner:string,key:string,input:unknown,effectGuard?:()=>Step<void>){try{const receipt=await publishPreparedReportInner(owner,key,input,effectGuard);auditMcpOutcome(owner,'report_publication.prepare','report',key,receipt.replayed?'replayed':'published');return receipt;}catch(error){auditMcpOutcome(owner,'report_publication.prepare','report',key,'refused',error instanceof ReportError?error.status:500);throw error;}}
