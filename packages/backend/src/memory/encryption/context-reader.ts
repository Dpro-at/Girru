/** Selected-run context on existing pack rendering; no legacy cache, graph or document reader fallback. */
import {randomUUID} from 'node:crypto';
import {all,dialect,run as sqlRun,type StepRunner} from '../../repositories/sql-steps.js';
import {renderContextPackRows,type PackInput} from '../context/pack.js';
import {loadEncryptedMemoryCandidates} from './candidate-loader.js';
import {loadEncryptedOwnerRow} from './owner-row-loader.js';
import {canonicalEncryptedRow} from './content-commit.js';
import {memoryRowSurfaceManifest} from './row-codec.js';
import {captureAuthenticatedMemoryRun,authenticatedMemoryRunStep} from './auth-capture.js';
import {createMemoryRevisionValidator} from './revision-validator.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {listAuthenticatedEncryptedRunMemories} from './run-list-reader.js';
import {readAuthenticatedEncryptedPinnedFacts} from './pinned-reader.js';
import {readAuthenticatedEncryptedHandoff} from './handoff-gateway.js';
import {handoffBlock} from '../handoff/store.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
export async function readAuthenticatedEncryptedContext(input:{runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;run:Parameters<typeof captureAuthenticatedMemoryRun>[2];persona:string;reader?:{kind:'coding-app';id:string};callerLease?:{isCurrent:()=>boolean;validateCurrent:()=>Promise<boolean>};allowPinned?:Parameters<typeof readAuthenticatedEncryptedPinnedFacts>[0]['allow'];handoffScope?:Parameters<typeof readAuthenticatedEncryptedHandoff>[0]['scope'];recordRead:(intent:MemoryReadIntent)=>Promise<boolean>}){
 const {runner,token,session,recordRead}=input,reader=input.reader?{...input.reader}:undefined,caller=input.callerLease?{isCurrent:input.callerLease.isCurrent.bind(input.callerLease),validateCurrent:input.callerLease.validateCurrent.bind(input.callerLease)}:undefined;
 try{
  if(reader&&(!caller||reader.kind!=='coding-app'||!reader.id||reader.id.length>128))throw new MemoryCipherError();
  const persona=input.persona,scope=input.handoffScope?{...input.handoffScope}:undefined;
  if(typeof persona!=='string'||Buffer.byteLength(persona)>128*1024)throw new MemoryCipherError();
  const run={...input.run,delegatedFrom:[...input.run.delegatedFrom],drawers:input.run.drawers.map(drawer=>({...drawer}))},lease=session.capture(),auth=await captureAuthenticatedMemoryRun(runner,token,run);
  if(auth.ownerId!==lease.scope.ownerId||run.audience!=='owner')throw new MemoryCipherError();const validate=createMemoryRevisionValidator(runner,auth.revision,session.lock),check=async()=>{if(caller&&(!caller.isCurrent()||await caller.validateCurrent()!==true||!caller.isCurrent()))throw new MemoryCipherError();if(!lease.isCurrent()||await validate()!==true||!lease.isCurrent())throw new MemoryCipherError();};await check();
  const evidence=new Map<string,{table:MemoryReadIntent['records'][number]['table'];id:string;cipher:string}>();
  let memoryEvidence:Map<string,string>|undefined;
  const auditedRead=async(intent:MemoryReadIntent)=>{
   await check();
   if(intent.records.some(item=>item.table==='memories')&&!memoryEvidence){const candidates=await loadEncryptedMemoryCandidates(runner,auth.ownerId);await check();memoryEvidence=new Map(candidates.map(row=>[String(row.id),canonicalEncryptedRow(row)]));}
   for(const item of intent.records){let cipher:string|undefined;if(item.table==='memories')cipher=memoryEvidence?.get(item.id);else{const surface=memoryRowSurfaceManifest().find(surface=>surface.table===item.table);if(!surface)throw new MemoryCipherError();const row=await loadEncryptedOwnerRow(runner,surface.table,auth.ownerId,item.id);await check();if(row)cipher=canonicalEncryptedRow(row);}if(!cipher)throw new MemoryCipherError();const identity=item.table+':'+item.id,prior=evidence.get(identity);if(prior&&prior.cipher!==cipher)throw new MemoryCipherError();evidence.set(identity,{...item,cipher});if(evidence.size>6000)throw new MemoryCipherError();}
   return recordRead(reader?{...intent,readerKind:'coding-app',readerId:reader.id}:intent);
  };
  const request={runner,token,session,run,recordRead:auditedRead},rows=await listAuthenticatedEncryptedRunMemories(request);await check();
  const scopeFacts=await readAuthenticatedEncryptedPinnedFacts({...request,allow:input.allowPinned?{...input.allowPinned}:undefined});await check();const handoff=scope?await readAuthenticatedEncryptedHandoff({...request,scope}):null;await check();
  const handoffText=handoff?handoffBlock(handoff):'';
  const packInput:PackInput={userId:auth.ownerId,agentId:run.agentId,drawers:run.drawers,persona,scopeFacts,handoff:handoff&&scope?{id:handoff.id,scope:scope.kind+':'+scope.id,text:handoffText}:null};
  const now=Date.now(),packRows=rows.filter(row=>(row.expiry_timestamp===null||Number(row.expiry_timestamp)>now)&&(Number(row.importance_score??0)>=0.9||row.topic_key!==null||typeof row.metadata==='string'&&JSON.parse(row.metadata).pinned===true)).sort((a,b)=>Number(b.importance_score??0)-Number(a.importance_score??0)||String(a.created_at).localeCompare(String(b.created_at))||String(a.id).localeCompare(String(b.id))).map(row=>({id:String(row.id),type:String(row.type),content:String(row.content),metadata:row.metadata as string|null,importance_score:row.importance_score as number|null,topic_key:row.topic_key as string|null,dk:String(row.drawer_kind),dkey:String(row.drawer_key??''),expiry_timestamp:row.expiry_timestamp as number|null,created_at:String(row.created_at)}));
  const rendered=renderContextPackRows(packInput,packRows,randomUUID());await check();
  await runner.tx(function*(){const fresh=yield* authenticatedMemoryRunStep(token,run);if(JSON.stringify(fresh.revision)!==JSON.stringify(auth.revision)||!lease.isCurrent()||caller&&!caller.isCurrent())throw new MemoryCipherError();
   if((yield* dialect())==='postgres')yield* sqlRun('LOCK TABLE memories,memory_pinned_facts,agent_handoffs IN SHARE MODE');
   const grouped=new Map<string,Array<{id:string;cipher:string}>>();for(const item of evidence.values()){const group=grouped.get(item.table)??[];group.push(item);grouped.set(item.table,group);}
   for(const [table,items] of grouped){const surface=memoryRowSurfaceManifest().find(surface=>surface.table===table);if(!surface)throw new MemoryCipherError();for(let offset=0;offset<items.length;offset+=500){const batch=items.slice(offset,offset+500),expected=new Map(batch.map(item=>[item.id,item.cipher])),rows=yield* all<Record<string,unknown>>(`SELECT * FROM ${surface.table} WHERE ${surface.owner}=? AND ${surface.id} IN (${batch.map(()=>'?').join(',')})`,auth.ownerId,...batch.map(item=>item.id));if(rows.length!==batch.length||rows.some(row=>canonicalEncryptedRow(row)!==expected.get(String(row[surface.id]))))throw new MemoryCipherError();}}
   if(!lease.isCurrent()||Date.now()>=auth.revision.validUntil)throw new MemoryCipherError();
  },{immediate:true});await check();
  return{...rendered,hit:false as const};
 }catch{session.lock();throw new MemoryCipherError();}
}
