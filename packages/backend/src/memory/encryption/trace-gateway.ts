import {issueTraceTimingMaintenanceAudit} from './internal-maintenance-audit.js';
import {refreshVerifiedProfilePresenceScope} from './profile-presence-lifecycle.js';
import {readMemoryControlStep,memoryControlQuery} from './control-runner.js';
import {prepareTraceAuxiliaryMaintenance} from './trace-auxiliary-maintenance.js';
import type {AuxiliaryRootLease} from './auxiliary-root-gateway.js';
import type {AuxiliaryForgetMutationJournal} from './forget-scrub-gateway.js';
import {beforeEncryptedMemoryEffect,captureCurrentMemoryEffectAdmission,memoryEffectDigest} from './memory-effect.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
import {encryptedDocumentTraceReferences} from './document-reader.js';
import type {MemoryReadIntent} from './read-audit.js';
/** Encrypted recall provenance for a trusted run. Never stores plaintext memory excerpts or arbitrary trace fields. */
import {one,run,dialect,type StepRunner,type SqlParam} from '../../repositories/sql-steps.js';
import type {TraceRecord} from '../context/trace.js';
import {projectStep} from '../scopes/store.js';
import {drawerId} from '../drawers.js';
import {authenticatedMemoryRunStep,captureAuthenticatedMemoryRun} from './auth-capture.js';
import {createMemoryRevisionValidator} from './revision-validator.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {loadEncryptedOwnerRow} from './owner-row-loader.js';
import {encryptMemoryRow,decryptMemoryRow} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import {MemoryCipherError} from './envelope.js';
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value);
const count=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=10000000;
export async function saveAuthenticatedEncryptedRecallTrace(input:{runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;run:Parameters<typeof captureAuthenticatedMemoryRun>[2];trace:TraceRecord;recordRead?:(intent:MemoryReadIntent)=>Promise<boolean>;captureAuthority?:()=>Promise<MemoryRestoreAuthorityLease|null>;captureAuxiliaryRoot?:()=>Promise<AuxiliaryRootLease|null>;auxiliaryMutationJournal?:AuxiliaryForgetMutationJournal}){
 const {runner,token,session}=input;let key:Buffer|undefined,auxiliary:Awaited<ReturnType<typeof prepareTraceAuxiliaryMaintenance>>|undefined;
 try{
  const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};boundary();
  const supplied=input.trace;if(!supplied||!id(supplied.runId)||!id(supplied.sessionId)||!Array.isArray(supplied.items)||supplied.items.length>64||!supplied.context)throw new MemoryCipherError();
  const runScope={...input.run,delegatedFrom:[...input.run.delegatedFrom],drawers:input.run.drawers.map(drawer=>({...drawer}))};
  const trace={...supplied,items:supplied.items.map(item=>({...item,...(item.cite?{cite:{...item.cite}}:{})})),context:JSON.parse(JSON.stringify(supplied.context)) as TraceRecord['context']};
  if(trace.agentId!==runScope.agentId||runScope.audience!=='owner'||!count(trace.packChars)||!count(trace.promptTokens)||typeof trace.packHit!=='boolean')throw new MemoryCipherError();
  const context=trace.context;
  if(Object.keys(context).some(field=>!['keptTurns','summarisedTurns','summaries','droppedTurns','fromCache','budgetTokens','numCtx','drawers'].includes(field))||!['keptTurns','summarisedTurns','droppedTurns','budgetTokens','numCtx'].every(field=>count(context[field as keyof typeof context]))||!Array.isArray(context.summaries)||context.summaries.length>64||context.summaries.some(summary=>!summary||Object.keys(summary).sort().join(',')!=='id,source,turns'||!id(summary.id)||!count(summary.turns)||!['model','fallback','inline'].includes(summary.source))||!context.fromCache||Object.keys(context.fromCache).sort().join(',')!=='pack,recall'||typeof context.fromCache.pack!=='boolean'||typeof context.fromCache.recall!=='boolean')throw new MemoryCipherError();
  if(context.drawers&&(Object.keys(context.drawers).sort().join(',')!=='loaded,noAccess'||!Array.isArray(context.drawers.loaded)||!Array.isArray(context.drawers.noAccess)||context.drawers.loaded.length>64||context.drawers.noAccess.length>64||context.drawers.loaded.some(drawer=>!runScope.drawers.some(open=>drawerId(open)===drawer))||context.drawers.noAccess.some(drawer=>typeof drawer!=='string'||drawer.length>512)))throw new MemoryCipherError();
  const seen=new Set<string>();
  for(const item of trace.items){if(Object.keys(item).some(field=>!(item.kind==='document'?['kind','id','drawer','why','score','cite']:['kind','id','drawer','why','score']).includes(field))||!['memory','fact','handoff','document'].includes(item.kind)||!id(item.id)||seen.has(item.kind+':'+item.id)||!(item.kind==='fact'?['pinned']:item.kind==='handoff'?['handoff']:item.kind==='document'?['document']:['pinned','topic','graph','meaning','keyword']).includes(item.why)||item.score!==undefined&&(typeof item.score!=='number'||!Number.isFinite(item.score)||item.score<0)||item.drawer!==null&&typeof item.drawer!=='string')throw new MemoryCipherError();if(item.kind==='document'&&(!/^[a-f0-9]{32}$/.test(item.id)||!item.cite||Object.keys(item.cite).sort().join(',')!=='file,heading,page'||typeof item.cite.file!=='string'||Buffer.byteLength(item.cite.file)>16384||item.cite.file.includes('\0')||item.cite.heading!==null&&(typeof item.cite.heading!=='string'||Buffer.byteLength(item.cite.heading)>16384)||item.cite.page!==null&&(!Number.isSafeInteger(item.cite.page)||item.cite.page<1)))throw new MemoryCipherError();seen.add(item.kind+':'+item.id);}
  const lease=session.capture(),auth=await captureAuthenticatedMemoryRun(runner,token,runScope);boundary();if(auth.ownerId!==trace.userId||auth.ownerId!==lease.scope.ownerId)throw new MemoryCipherError();
  const validate=createMemoryRevisionValidator(runner,auth.revision,session.lock),check=async()=>{boundary();if(!lease.isCurrent()||await validate()!==true)throw new MemoryCipherError();boundary();if(!lease.isCurrent())throw new MemoryCipherError();};await check();
  const conversation=await readMemoryControlStep(runner,one('SELECT id FROM chat_sessions WHERE id=? AND user_id=?',trace.sessionId,auth.ownerId));await check();if(!conversation)throw new MemoryCipherError();
  const expected=new Map<string,{table:'memories'|'memory_pinned_facts'|'agent_handoffs';row:Record<string,unknown>}>();let referenceBytes=0;
  const activeProject=runScope.project&&auth.access.pinnedFacts.project?await readMemoryControlStep(runner,projectStep(auth.ownerId,runScope.project)):null;await check();
  const documentIds=trace.items.filter(item=>item.kind==='document').map(item=>item.id);if(documentIds.length&&(typeof input.recordRead!=='function'||typeof input.captureAuthority!=='function'))throw new MemoryCipherError();
  const documentReferences=documentIds.length?await encryptedDocumentTraceReferences({runner,token,session,run:runScope,recordRead:input.recordRead!,captureAuthority:input.captureAuthority!,ids:documentIds}):[],documentEvidence=new Map<string,{table:'doc_index_sources'|'doc_index_files'|'doc_index_chunks'|'memory_encryption_document_admissions';id:string;cipher:string}>();await check();
  for(const item of trace.items){
   if(item.kind==='document'){const reference=documentReferences.find(reference=>reference.id===item.id);if(!reference||item.drawer!==reference.drawer||JSON.stringify(item.cite)!==JSON.stringify(reference.cite))throw new MemoryCipherError();for(const evidence of reference.evidence){const identity=evidence.table+':'+evidence.id,prior=documentEvidence.get(identity);if(prior&&prior.cipher!==evidence.cipher)throw new MemoryCipherError();documentEvidence.set(identity,evidence);}continue;}
   const table=item.kind==='memory'?'memories':item.kind==='fact'?'memory_pinned_facts':'agent_handoffs';
   const row=await loadEncryptedOwnerRow(runner,table,auth.ownerId,item.id);await check();if(!row)throw new MemoryCipherError();
   if(item.kind==='memory'){if(!auth.access.authorize(row)||item.drawer!==null&&item.drawer!==drawerId({kind:row.drawer_kind as 'owner'|'project',key:String(row.drawer_key??'')}))throw new MemoryCipherError();}
   else if(item.kind==='fact'){
    const permitted=row.scope_kind==='company'?auth.access.pinnedFacts.company&&row.scope_id==='':row.scope_kind==='project'?auth.access.pinnedFacts.project&&activeProject&&!activeProject.archived&&row.scope_id===activeProject.slug:row.scope_kind==='department'?auth.access.pinnedFacts.department&&activeProject&&!activeProject.archived&&row.scope_id===activeProject.departmentId:false;
    if(!permitted||item.drawer!==(row.scope_kind==='company'?'company':row.scope_kind+':'+row.scope_id))throw new MemoryCipherError();
   }else if(row.agent_id!==runScope.agentId||row.scope_kind!=='conversation'||row.scope_id!==trace.sessionId)throw new MemoryCipherError();
   referenceBytes+=Buffer.byteLength(canonicalEncryptedRow(row));if(referenceBytes>8*1024*1024)throw new MemoryCipherError();expected.set(item.kind+':'+item.id,{table,row});
  }
  const items=JSON.stringify(trace.items),contextText=JSON.stringify(context);if(Buffer.byteLength(items)+Buffer.byteLength(contextText)>65536)throw new MemoryCipherError();
  const material=await lease.resolveKey({user_id:auth.ownerId});key=material.key;await check();const plain={run_id:trace.runId,user_id:auth.ownerId,session_id:trace.sessionId,agent_id:runScope.agentId,items,context:contextText,pack_hit:trace.packHit?1:0,pack_chars:trace.packChars,prompt_tokens:trace.promptTokens,ttft_ms:null,created_at:new Date().toISOString(),uses_indexed:1},cipher=encryptMemoryRow('memory_recall_traces',plain,lease.scope,key,material.id);
  if(await runner.read(one('SELECT run_id FROM memory_recall_traces WHERE run_id=?',trace.runId)))throw new MemoryCipherError();await check();
  if(!input.recordRead||!input.captureAuxiliaryRoot||!input.auxiliaryMutationJournal)throw new MemoryCipherError();
  auxiliary=await prepareTraceAuxiliaryMaintenance({runner,auth,session,runId:trace.runId,agentId:runScope.agentId,memoryIds:[...expected.values()].filter(reference=>reference.table==='memories').map(reference=>String(reference.row.id)).sort(),traceDigest:memoryEffectDigest(cipher),createdAt:plain.created_at,validate:check,recordRead:input.recordRead,captureAuxiliaryRoot:input.captureAuxiliaryRoot,auxiliaryMutationJournal:input.auxiliaryMutationJournal});await check();
  const targetDigest=memoryEffectDigest([cipher,[...expected.values()],[...documentEvidence.values()],auxiliary.digest]);
  await beforeEncryptedMemoryEffect({runner,action:'save-trace',auth,isCurrent:()=>lease.isCurrent()&&Date.now()<auth.revision.validUntil,targetDigest});await check();await auxiliary.prepare(captureCurrentMemoryEffectAdmission(runner,'save-trace',targetDigest),targetDigest);await check();
  await runner.tx(function*(){
   const fresh=yield* authenticatedMemoryRunStep(token,runScope);if(JSON.stringify(fresh.revision)!==JSON.stringify(auth.revision)||!lease.isCurrent())throw new MemoryCipherError();
   if((yield* dialect())==='postgres')yield* run('LOCK TABLE memories,memory_pinned_facts,agent_handoffs,memory_recall_traces,memory_encryption_auxiliary,doc_index_sources,doc_index_files,doc_index_chunks,memory_encryption_document_admissions IN SHARE ROW EXCLUSIVE MODE');
   if(!(yield* memoryControlQuery(()=>one('SELECT id FROM chat_sessions WHERE id=? AND user_id=?',trace.sessionId,auth.ownerId))))throw new MemoryCipherError();
   for(const {table,row:before} of expected.values()){const current=yield* one<Record<string,unknown>>(`SELECT * FROM ${table} WHERE id=? AND ${table==='memories'?'user_id':'owner_id'}=?`,String(before.id),auth.ownerId);if(!current||table==='memories'&&!fresh.access.authorize(current)||canonicalEncryptedRow(current)!==canonicalEncryptedRow(before))throw new MemoryCipherError();}
   for(const evidence of documentEvidence.values()){const current=yield* one<Record<string,unknown>>(`SELECT * FROM ${evidence.table} WHERE id=? AND owner_id=?`,evidence.id,auth.ownerId);if(!current||canonicalEncryptedRow(current)!==evidence.cipher)throw new MemoryCipherError();}
   const currentProject=runScope.project&&fresh.access.pinnedFacts.project?yield* memoryControlQuery(()=>projectStep(auth.ownerId,runScope.project!)):null;if(JSON.stringify(currentProject)!==JSON.stringify(activeProject))throw new MemoryCipherError();
   if(yield* one('SELECT run_id FROM memory_recall_traces WHERE run_id=?',trace.runId))throw new MemoryCipherError();
   if(!auxiliary)throw new MemoryCipherError();yield* auxiliary.writeStep();
   const fields=Object.keys(cipher);yield* run(`INSERT INTO memory_recall_traces(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,...fields.map(field=>cipher[field as keyof typeof cipher] as SqlParam));
   const stored=yield* one<Record<string,unknown>>('SELECT * FROM memory_recall_traces WHERE run_id=? AND user_id=?',trace.runId,auth.ownerId);if(!stored||canonicalEncryptedRow(stored)!==canonicalEncryptedRow(cipher)||!lease.isCurrent()||Date.now()>=auth.revision.validUntil)throw new MemoryCipherError();
  },{immediate:true});await auxiliary.commit();await check();return{runId:trace.runId};
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);auxiliary?.close();}
}

/** Timing is authenticated bound metadata: reseal the whole row instead of issuing a legacy plaintext UPDATE. */
export async function setAuthenticatedEncryptedTraceTiming(input:{runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;run:Parameters<typeof captureAuthenticatedMemoryRun>[2];runId:string;ms:number;recordRead:(intent:import('./read-audit.js').MemoryReadIntent)=>Promise<boolean>}){
 const {runner,token,session,runId,recordRead}=input,ms=Math.round(input.ms);let key:Buffer|undefined;
 try{
  if(!id(runId)||!Number.isFinite(input.ms)||ms<0||ms>600000)throw new MemoryCipherError();const runScope={...input.run,delegatedFrom:[...input.run.delegatedFrom],drawers:input.run.drawers.map(drawer=>({...drawer}))},lease=session.capture(),auth=await captureAuthenticatedMemoryRun(runner,token,runScope);
  if(auth.ownerId!==lease.scope.ownerId||runScope.audience!=='owner')throw new MemoryCipherError();const validate=createMemoryRevisionValidator(runner,auth.revision,session.lock),check=async()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1'||!lease.isCurrent()||await validate()!==true||!lease.isCurrent())throw new MemoryCipherError();};await check();
  const row=await loadEncryptedOwnerRow(runner,'memory_recall_traces',auth.ownerId,runId);await check();if(!row)return false;if(row.agent_id!==runScope.agentId)throw new MemoryCipherError();
  if(row.ttft_ms!==null)return false;const presence=await refreshVerifiedProfilePresenceScope(runner,auth.ownerId);await check();const timingAudit=issueTraceTimingMaintenanceAudit({runner,auth,presence,runId,row});if(await recordRead(timingAudit)!==true)throw new MemoryCipherError();await refreshVerifiedProfilePresenceScope(runner,auth.ownerId);await check();
  const material=await lease.resolveKey({user_id:auth.ownerId});key=material.key;await check();const plain=decryptMemoryRow('memory_recall_traces',row,lease.scope,key,material.id),cipher=encryptMemoryRow('memory_recall_traces',{...plain,ttft_ms:ms},lease.scope,key,material.id);
  await beforeEncryptedMemoryEffect({runner,action:'time-trace',auth,isCurrent:()=>lease.isCurrent()&&Date.now()<auth.revision.validUntil,targetDigest:memoryEffectDigest([runId,row,cipher])});await check();
  await runner.tx(function*(){const fresh=yield* authenticatedMemoryRunStep(token,runScope);if(JSON.stringify(fresh.revision)!==JSON.stringify(auth.revision)||!lease.isCurrent())throw new MemoryCipherError();
   const driver=yield* dialect(),current=yield* one<Record<string,unknown>>(`SELECT * FROM memory_recall_traces WHERE run_id=? AND user_id=?${driver==='postgres'?' FOR UPDATE':''}`,runId,auth.ownerId);if(!current||canonicalEncryptedRow(current)!==canonicalEncryptedRow(row))throw new MemoryCipherError();
   const fields=Object.keys(cipher).filter(field=>!['run_id','user_id'].includes(field));const changed=yield* run(`UPDATE memory_recall_traces SET ${fields.map(field=>field+'=?').join(',')} WHERE run_id=? AND user_id=?`,...fields.map(field=>cipher[field] as SqlParam),runId,auth.ownerId);if(changed.changes!==1)throw new MemoryCipherError();
   const stored=yield* one<Record<string,unknown>>('SELECT * FROM memory_recall_traces WHERE run_id=? AND user_id=?',runId,auth.ownerId);if(!stored||canonicalEncryptedRow(stored)!==canonicalEncryptedRow(cipher)||!lease.isCurrent()||Date.now()>=auth.revision.validUntil)throw new MemoryCipherError();
  },{immediate:true});await check();return true;
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
