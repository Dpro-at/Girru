import {captureLogicalMemoryParentsMetadataStep,loadLogicalMemoryParentPayloadStep,openLogicalMemoryParents} from './logical-memory-parents.js';
import {isTrustedEncryptedPersonForgetPlan,type EncryptedPersonForgetPlan} from './person-owner.js';
import {assertNoUnresolvedDisclosureHolds,type VerifiedDisclosureInventory} from './disclosure-history.js';
import {createHash} from 'node:crypto';
import {canonicalEncryptedRow} from './content-commit.js';
import {beforeEncryptedMemoryEffect,memoryEffectDigest,isProtectedMemoryRunner} from './memory-effect.js';
import {openAuxiliaryRecords,prepareAuxiliaryRecords,replaceAuxiliaryRecordsStep} from './auxiliary-records.js';
import {forgetAuxiliaryMemories} from './auxiliary-bundle.js';
import {prepareExtraMemoryForget,writeExtraMemoryForgetStep} from './forget-extra-surfaces.js';
import {verifiedEncryptedMemoryLineageSources} from './memory-lineage.js';
import {openLegacyGraphRecords,prepareLegacyGraphRecords,replaceLegacyGraphRecordsStep} from './legacy-graph-records.js';
import {forgetLegacyGraphMemory,captureLegacyGraphBundle,type LegacyGraphMemory} from './legacy-graph-bundle.js';
import {DOCUMENT_FORGET_TABLES,prepareDocumentForget,writeDocumentForgetStep} from './document-forget.js';
import type {EncryptedMutationGuard} from './run-mutation-guard.js';
/** Internal owner-authenticated scrub stage. Does NOT delete the source/history or claim complete forgetting. */
import type {StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {decryptMemoryRow,memoryRowSurfaceManifest,type MemoryRowTable} from './row-codec.js';
import type {MemoryReadIntent} from './read-audit.js';
import {prepareEncryptedForgetBatchScrub,type ScrubTable} from './forget-scrub.js';
import {loadEncryptedForgetRows,encryptedForgetRowsStep,sameForgetRows,writeEncryptedScrubRowsStep} from './forget-scrub-store.js';
import {deleteEncryptedForgottenSourceStep} from './forget-delete.js';
import {assertNoUncoveredProjectCopiesStep,assertNoUncoveredExternalProjectCopiesStep} from './forget-coverage.js';
import {PROJECT_SUMMARY_TOPIC} from '../project-summary.js';
import {normalizeDrawer,defaultDrawerForType} from '../drawers.js';
import {MemoryCipherError} from './envelope.js';
export type PreparedGraphForgetMutation={isCurrent:()=>boolean;commit:()=>Promise<boolean>};
export type GraphForgetMutationJournal=(before:readonly Record<string,unknown>[],after:readonly Record<string,unknown>[])=>Promise<PreparedGraphForgetMutation>;
export type PreparedAuxiliaryForgetMutation={purpose:'memory-auxiliary';isCurrent:()=>boolean;commit:()=>Promise<boolean>};
export type AuxiliaryForgetMutationJournal=(before:readonly Record<string,unknown>[],after:readonly Record<string,unknown>[])=>Promise<PreparedAuxiliaryForgetMutation>;
type Input={preparedPlan?:PreparedEncryptedForgetPlan;personPlan?:EncryptedPersonForgetPlan;captureDisclosureInventory?:()=>Promise<VerifiedDisclosureInventory|null>;auxiliaryMutationJournal?:AuxiliaryForgetMutationJournal;graphMutationJournal?:GraphForgetMutationJournal;runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;id:string;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>;recordForgetAuthority?:(ids:readonly string[])=>Promise<boolean>;assertMutation?:EncryptedMutationGuard};
export type PreparedEncryptedForgetPlan=Readonly<{kind:'prepared-encrypted-forget';ownerId:string;memberId:string;runner:StepRunner;targetIds:readonly string[];graphEntityIds:readonly string[];personKey:string|null;reviewDigest:string;isCurrent:()=>boolean;assertCurrentStep:()=>Generator<any,void,any>}>;
const preparedPlans=new WeakSet<object>();
export function isTrustedPreparedEncryptedForgetPlan(value:unknown):value is PreparedEncryptedForgetPlan{return !!value&&typeof value==='object'&&preparedPlans.has(value as object);}
export type EncryptedForgetDatabaseResult={relatedMemories:number;proposals:number;summaries:number;completeForget:false;cleanupJobId?:string;sourceDeleted?:boolean;memoryIds?:readonly string[];documentsNeedOwnerReimport?:boolean;derivedContentNeedsOwnerReview?:boolean};
async function scrub(input:Input,forgetSource:boolean,planning:true):Promise<PreparedEncryptedForgetPlan>;
async function scrub(input:Input,forgetSource?:boolean,planning?:false):Promise<EncryptedForgetDatabaseResult>;
async function scrub(input:Input,forgetSource=false,planning=false):Promise<EncryptedForgetDatabaseResult|PreparedEncryptedForgetPlan>{
 const runner=input.runner,token=input.token,session=input.session,id=input.id,recordRead=input.recordRead,recordForgetAuthority=input.recordForgetAuthority,assertMutation=input.assertMutation;let key:Buffer|undefined,logical:ReturnType<typeof openLogicalMemoryParents>|undefined;
 try{
  if(typeof id!=='string'||!id||Buffer.byteLength(id)>256)throw new MemoryCipherError();const lease=session.capture();
  const owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});if(owner.ownerId!==lease.scope.ownerId)throw new MemoryCipherError();
  const personPlan=input.personPlan;if(personPlan&&(!forgetSource||!isTrustedEncryptedPersonForgetPlan(personPlan)||personPlan.runner!==runner||personPlan.ownerId!==owner.ownerId||personPlan.memberId!==lease.scope.memberId||!personPlan.memoryIds.length||personPlan.memoryIds[0]!==id))throw new MemoryCipherError();if(forgetSource&&!planning&&isProtectedMemoryRunner(runner)&&typeof recordForgetAuthority!=='function')throw new MemoryCipherError();
  if(forgetSource&&!planning&&isProtectedMemoryRunner(runner)&&!isTrustedPreparedEncryptedForgetPlan(input.preparedPlan))throw new MemoryCipherError();
  const check=async()=>{if(!lease.isCurrent()||JSON.stringify(await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true}))!==JSON.stringify(owner))throw new MemoryCipherError();};
  await check();if(forgetSource)await runner.tx(()=>assertNoUncoveredExternalProjectCopiesStep(owner.ownerId),{immediate:true});const rows=await loadEncryptedForgetRows(runner,owner.ownerId);await check();
  const logicalMetadata=forgetSource?await runner.tx(()=>captureLogicalMemoryParentsMetadataStep(owner.ownerId),{immediate:true}):null;await check();
  const live=rows.memories.filter(r=>r.id===id),history=rows.memory_versions.filter(r=>r.memory_id===id);
  if(!live.length&&!history.length)throw new MemoryCipherError();
  const records:MemoryReadIntent['records']=forgetSource?memoryRowSurfaceManifest().flatMap(surface=>rows[surface.table as MemoryRowTable].map(row=>({table:surface.table as MemoryRowTable,id:String(row[surface.id])}))):[...rows.memories.map(r=>({table:'memories' as const,id:String(r.id)})),...(forgetSource?rows.memory_versions:history).map(r=>({table:'memory_versions' as const,id:String(r.id)})),...rows.memory_file_proposals.map(r=>({table:'memory_file_proposals' as const,id:String(r.id)})),...rows.memory_weekly_summaries.map(r=>({table:'memory_weekly_summaries' as const,id:String(r.id)})),...(forgetSource?DOCUMENT_FORGET_TABLES.flatMap(table=>rows[table].map(r=>({table,id:String(r.id)}))):[]),...(forgetSource?rows.memory_encryption_legacy_graph.map(r=>({table:'memory_encryption_legacy_graph' as const,id:String(r.id)})):[])];
  for(let start=0;start<records.length;start+=500){if(await recordRead({readerKind:'user',readerId:owner.ownerId,purpose:'tool',records:records.slice(start,start+500)})!==true)throw new MemoryCipherError();await check();}
  const logicalCipher=logicalMetadata?await runner.tx(()=>loadLogicalMemoryParentPayloadStep(logicalMetadata),{immediate:true}):[];await check();for(const row of logicalCipher){const captured=rows.memory_versions.find(expected=>expected.id===row.id);if(!captured||canonicalEncryptedRow(captured)!==canonicalEncryptedRow(row))throw new MemoryCipherError();}
  const material=await lease.resolveKey(live[0]??history[0]);key=material.key;await check();if(logicalMetadata)logical=openLogicalMemoryParents(logicalMetadata,logicalCipher,lease.scope,key,material.id,()=>lease.isCurrent()&&Date.now()<owner.validUntil);
  const types=new Set<string>();let source:Record<string,unknown>|undefined;
  const texts=new Set<string>();let bytes=0;const add=(v:unknown)=>{if(typeof v==='string'&&v&&!texts.has(v)){bytes+=Buffer.byteLength(v);if(texts.size>=5000||bytes>8*1024*1024)throw new MemoryCipherError();texts.add(v);}};
  for(const r of live){const plain=decryptMemoryRow('memories',r,lease.scope,key,material.id);source=plain;add(plain.content);if(typeof plain.type==='string')types.add(plain.type);}
  for(const r of history){const plain=decryptMemoryRow('memory_versions',r,lease.scope,key,material.id);if(!live.length&&(!source||Number(plain.version)>Number(source.version)))source=plain;if(typeof plain.type==='string')types.add(plain.type);add(plain.content);if(plain.snapshot!==null){if(typeof plain.snapshot!=='string')throw new MemoryCipherError();const snapshot=JSON.parse(plain.snapshot);if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))throw new MemoryCipherError();add(snapshot.format==='girru-encrypted-trash-row'?snapshot.row?.content:snapshot.content);const snapshotType=snapshot.format==='girru-encrypted-trash-row'?snapshot.row?.type:snapshot.type;if(typeof snapshotType==='string')types.add(snapshotType);}}
  if(forgetSource&&!live.length){const archived=logical?.trashRows.find(row=>row.id===id);if(archived)source=archived;}
  const cascade:Record<string,unknown>[]=[],initialIds=personPlan?[...personPlan.memoryIds]:[id],initialSources=source?[source]:[];
  for(const selectedId of initialIds.slice(1)){const cipher=rows.memories.find(row=>row.id===selectedId),plain=cipher?decryptMemoryRow('memories',cipher,lease.scope,key,material.id):logical?.trashRows.find(row=>row.id===selectedId);if(!plain)throw new MemoryCipherError();cascade.push(plain);initialSources.push(plain);}
  if(forgetSource){const projectKeys=new Set(initialSources.filter(row=>row.drawer_kind==='project').map(row=>String(row.drawer_key))),known=new Set(initialIds);for(const r of rows.memories){if(known.has(String(r.id)))continue;const plain=decryptMemoryRow('memories',r,lease.scope,key,material.id);if(plain.drawer_kind==='project'&&projectKeys.has(String(plain.drawer_key))&&plain.topic_key===PROJECT_SUMMARY_TOPIC){cascade.push(plain);known.add(String(plain.id));}}}
  if(forgetSource){
   const known=new Set([id,...cascade.map(row=>String(row.id))]),plain=rows.memories.map(row=>decryptMemoryRow('memories',row,lease.scope,key!,material.id));let changed=true;
   while(changed){changed=false;for(const row of plain){const rowId=String(row.id);if(known.has(rowId))continue;const sources=verifiedEncryptedMemoryLineageSources(row,lease.scope,key);if(sources?.some(source=>source.kind==='memory'&&known.has(source.id))){known.add(rowId);cascade.push(row);changed=true;}}}
  }
  const targetIds=[id,...cascade.map(r=>String(r.id))];
  for(const plain of cascade){add(plain.content);if(typeof plain.type==='string')types.add(plain.type);}
  for(const r of rows.memory_versions)if(cascade.some(c=>c.id===r.memory_id)){const plain=decryptMemoryRow('memory_versions',r,lease.scope,key,material.id);add(plain.content);if(typeof plain.type==='string')types.add(plain.type);if(typeof plain.snapshot==='string'){const snapshot=JSON.parse(plain.snapshot);if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))throw new MemoryCipherError();add(snapshot.format==='girru-encrypted-trash-row'?snapshot.row?.content:snapshot.content);const snapshotType=snapshot.format==='girru-encrypted-trash-row'?snapshot.row?.type:snapshot.type;if(typeof snapshotType==='string')types.add(snapshotType);}}
  if(forgetSource&&([owner.ownerId,...targetIds].some(value=>! /^(?!\.\.?$)[A-Za-z0-9_.@-]{1,200}$/.test(value))||!types.size||[...types].some(value=>! /^[a-z][a-z_-]{0,31}$/.test(value))))throw new MemoryCipherError();
  const updates:{table:ScrubTable;row:Record<string,unknown>}[]=[],at=new Date().toISOString(),valid=()=>lease.isCurrent()&&Date.now()<owner.validUntil;
  for(const table of ['memories','memory_file_proposals','memory_weekly_summaries'] as const)for(const cipher of (forgetSource&&table!=='memories'?[]:rows[table])){if(forgetSource&&table==='memories'&&targetIds.includes(String(cipher.id)))continue;const next=prepareEncryptedForgetBatchScrub(table,cipher,[...targetIds],[...texts],owner.ownerId,at,lease.scope,key,material.id,valid);if(next)updates.push({table,row:next});}
  const documentReset=forgetSource?prepareDocumentForget({rows,scope:lease.scope,key,keyId:material.id,actorId:owner.ownerId,at,isCurrent:valid}):null;
  const invalidatedTrashIds=logical?.trashRows.map(row=>String(row.id))??[],removedParents=new Set([...targetIds,...invalidatedTrashIds]);
  let graphAfter:Record<string,unknown>[]|undefined;
  if(forgetSource&&rows.memory_encryption_legacy_graph.length){
   const liveMemories:LegacyGraphMemory[]=rows.memories.map(cipher=>{const row=decryptMemoryRow('memories',cipher,lease.scope,key!,material.id);return{id:String(row.id),user_id:String(row.user_id),content:String(row.content),status:row.status as string|null,drawer_kind:row.drawer_kind as string|null,drawer_key:row.drawer_key as string|null};}),graphMemories:LegacyGraphMemory[]=[...liveMemories,...(logical?.memories.filter(row=>!liveMemories.some(live=>live.id===row.id))??[])];
   let bundle=openLegacyGraphRecords(rows.memory_encryption_legacy_graph,graphMemories,lease.scope,key,material.id);if(!bundle)throw new MemoryCipherError();const entityIds=new Set(personPlan?.graphEntityIds??[]);if([...entityIds].some(entityId=>!bundle!.rows.memory_graph_entities.some(entity=>entity.id===entityId&&entity.kind==='person')))throw new MemoryCipherError();for(const targetId of removedParents)bundle=forgetLegacyGraphMemory(bundle,targetId);
   if(entityIds.size){const links=new Set(bundle.rows.memory_graph_links.filter(row=>entityIds.has(String(row.src_id))||entityIds.has(String(row.dst_id))).map(row=>row.id));bundle.rows.memory_graph_entities=bundle.rows.memory_graph_entities.filter(row=>!entityIds.has(String(row.id)));bundle.rows.memory_graph_mentions=bundle.rows.memory_graph_mentions.filter(row=>!entityIds.has(String(row.entity_id)));bundle.rows.memory_graph_links=bundle.rows.memory_graph_links.filter(row=>!links.has(row.id));bundle.rows.memory_graph_link_sources=bundle.rows.memory_graph_link_sources.filter(row=>!links.has(row.link_id));}
   const remaining=graphMemories.filter(memory=>!removedParents.has(memory.id));bundle=captureLegacyGraphBundle(bundle,remaining);graphAfter=prepareLegacyGraphRecords(bundle,remaining,lease.scope,key,material.id,at);
  }
  const extraReset=forgetSource?prepareExtraMemoryForget({rows,scope:lease.scope,key,keyId:material.id,actorId:owner.ownerId,at,isCurrent:valid}):null;
  let auxiliaryAfter:Record<string,unknown>[]|undefined;
  if(forgetSource&&rows.memory_encryption_auxiliary.length){
   const parents={memories:(logical?.memories??rows.memories.map(row=>({id:String(row.id),user_id:String(row.user_id)}))).map(row=>({id:String(row.id),user_id:String(row.user_id)})),imports:rows.memory_import_batches.map(row=>({id:String(row.id),user_id:String(row.user_id)}))};
   const before=openAuxiliaryRecords(rows.memory_encryption_auxiliary,parents,lease.scope,key,material.id);if(!before)throw new MemoryCipherError();
   const cleared={...before,rows:{...before.rows,memory_quality_history:[],memory_enrichment_log:[]}},remaining={...parents,memories:rows.memories.filter(row=>!targetIds.includes(String(row.id))).map(row=>({id:String(row.id),user_id:owner.ownerId}))};auxiliaryAfter=prepareAuxiliaryRecords(forgetAuxiliaryMemories(cleared,parents,[...removedParents]),remaining,lease.scope,key,material.id,at);
  }
  let disclosure:VerifiedDisclosureInventory|undefined,disclosureReceipt:string|undefined;
  const assertDisclosure=async()=>{if(!input.captureDisclosureInventory){if(isProtectedMemoryRunner(runner))throw new MemoryCipherError();return;}const proof=await input.captureDisclosureInventory();if(!proof)throw new MemoryCipherError();assertNoUnresolvedDisclosureHolds(proof,targetIds);if(disclosureReceipt!==undefined&&disclosureReceipt!==proof.receiptId)throw new MemoryCipherError();disclosure=proof;disclosureReceipt=proof.receiptId;};
  // Validate every affected drawer before any durable authority or native mutation is prepared.
  // The same guard is repeated in the write transaction after all asynchronous boundaries.
  if(assertMutation){if(!source)throw new MemoryCipherError();await runner.tx(function*(){
   if(!valid()||JSON.stringify(yield* authenticatedMemoryOwnerStep(token))!==JSON.stringify(owner)||!sameForgetRows(rows,yield* encryptedForgetRowsStep(owner.ownerId)))throw new MemoryCipherError();
   for(const target of [source!,...cascade])yield* assertMutation(target);
  },{immediate:true});await check();}
  if(personPlan){if(!isTrustedEncryptedPersonForgetPlan(personPlan))throw new MemoryCipherError();await runner.tx(personPlan.assertCurrentStep,{immediate:true});await check();}
  await assertDisclosure();await check();
  const targets=Object.freeze([...new Set(targetIds)].sort()),entities=Object.freeze([...(personPlan?.graphEntityIds??[])].sort());
  const reviewDigest=memoryEffectDigest(['prepared-encrypted-forget',owner.ownerId,lease.scope.memberId,targets,entities,personPlan?.digest??null,disclosureReceipt??null,memoryRowSurfaceManifest().map(surface=>[surface.table,rows[surface.table as MemoryRowTable].map(row=>[String(row[surface.id]),createHash('sha256').update(canonicalEncryptedRow(row)).digest('hex')])])]);
  if(input.preparedPlan){
   const approved=input.preparedPlan;
   if(!forgetSource||planning||!isTrustedPreparedEncryptedForgetPlan(approved)||approved.runner!==runner||approved.ownerId!==owner.ownerId||approved.memberId!==lease.scope.memberId||approved.reviewDigest!==reviewDigest||!approved.isCurrent())throw new MemoryCipherError();
   await runner.tx(approved.assertCurrentStep,{immediate:true});await check();
  }
  if(planning){
   if(!forgetSource)throw new MemoryCipherError();
   const assertCurrentStep=function*():Generator<any,void,any>{
    if(!valid()||JSON.stringify(yield* authenticatedMemoryOwnerStep(token))!==JSON.stringify(owner)||!sameForgetRows(rows,yield* encryptedForgetRowsStep(owner.ownerId)))throw new MemoryCipherError();
    if(personPlan)yield* personPlan.assertCurrentStep();
    if(logicalMetadata){const fresh=yield* loadLogicalMemoryParentPayloadStep(logicalMetadata);for(const row of fresh){const captured=rows.memory_versions.find(expected=>expected.id===row.id);if(!captured||canonicalEncryptedRow(captured)!==canonicalEncryptedRow(row))throw new MemoryCipherError();}}
    yield* assertNoUncoveredExternalProjectCopiesStep(owner.ownerId);
   };
   await runner.tx(assertCurrentStep,{immediate:true});await check();
   const plan:PreparedEncryptedForgetPlan=Object.freeze({kind:'prepared-encrypted-forget',ownerId:owner.ownerId,memberId:lease.scope.memberId,runner,targetIds:targets,graphEntityIds:entities,personKey:personPlan?.personKey??null,reviewDigest,isCurrent:valid,assertCurrentStep});
   preparedPlans.add(plan);return plan;
  }
  const effectRows=memoryRowSurfaceManifest().map(surface=>[surface.table,rows[surface.table as MemoryRowTable].map(row=>[String(row[surface.id]),createHash('sha256').update(canonicalEncryptedRow(row)).digest('hex')])]);
  await beforeEncryptedMemoryEffect({runner,action:'forget-memory',auth:owner,isCurrent:valid,targetDigest:memoryEffectDigest([forgetSource?'source-and-references':'references-only',id,targetIds,personPlan?.digest??null,effectRows])});await check();
  // Record every grouped source identity BEFORE deleting. A failed DB stage may conservatively
  // invalidate older backups; it must never delete first and then lose the anti-resurrection head.
  if(forgetSource&&recordForgetAuthority){await check();if(await recordForgetAuthority(Object.freeze([...targetIds]))!==true)throw new MemoryCipherError();await check();}
  let graphMutation:PreparedGraphForgetMutation|undefined;if(forgetSource&&(rows.memory_encryption_legacy_graph.length||input.graphMutationJournal)){if(!input.graphMutationJournal)throw new MemoryCipherError();const copy=(values:readonly Record<string,unknown>[])=>Object.freeze(values.map(row=>Object.freeze({...row})));graphMutation=await input.graphMutationJournal(copy(rows.memory_encryption_legacy_graph),copy(graphAfter??[]));await check();if(!graphMutation||!graphMutation.isCurrent())throw new MemoryCipherError();}
  let auxiliaryMutation:PreparedAuxiliaryForgetMutation|undefined;
  if(forgetSource){if(!input.auxiliaryMutationJournal)throw new MemoryCipherError();const copy=(values:readonly Record<string,unknown>[])=>Object.freeze(values.map(row=>Object.freeze({...row})));auxiliaryMutation=await input.auxiliaryMutationJournal(copy(rows.memory_encryption_auxiliary),copy(auxiliaryAfter??[]));await check();if(auxiliaryMutation?.purpose!=='memory-auxiliary'||!auxiliaryMutation.isCurrent())throw new MemoryCipherError();}
  const operationKey=key;
  await assertDisclosure();await check();const staged=await runner.tx(function*(){
   if(JSON.stringify(yield* authenticatedMemoryOwnerStep(token))!==JSON.stringify(owner)||!valid()||graphMutation&& !graphMutation.isCurrent()||auxiliaryMutation&&!auxiliaryMutation.isCurrent())throw new MemoryCipherError();
   if(disclosure)assertNoUnresolvedDisclosureHolds(disclosure,targetIds);
   if(!sameForgetRows(rows,yield* encryptedForgetRowsStep(owner.ownerId)))throw new MemoryCipherError();
   if(forgetSource)yield* assertNoUncoveredExternalProjectCopiesStep(owner.ownerId);
   if(assertMutation){if(!source)throw new MemoryCipherError();for(const target of [source,...cascade])yield* assertMutation(target);}
   yield* writeEncryptedScrubRowsStep(owner.ownerId,updates);
   const expected={...rows,memories:[...rows.memories],memory_file_proposals:[...rows.memory_file_proposals],memory_weekly_summaries:[...rows.memory_weekly_summaries]};
   for(const {table,row} of updates)expected[table]=expected[table].map(r=>r.id===row.id?row:r);
   if(documentReset){yield* writeDocumentForgetStep(owner.ownerId,documentReset.rows);yield* assertNoUncoveredProjectCopiesStep(owner.ownerId);Object.assign(expected,documentReset.rows);}
   if(graphAfter){yield* replaceLegacyGraphRecordsStep(owner.ownerId,rows.memory_encryption_legacy_graph,graphAfter);expected.memory_encryption_legacy_graph=[...graphAfter].sort((a,b)=>String(a.id).localeCompare(String(b.id)));}
   if(extraReset){yield* writeExtraMemoryForgetStep(owner.ownerId,extraReset);Object.assign(expected,extraReset);}
   if(auxiliaryAfter){yield* replaceAuxiliaryRecordsStep(owner.ownerId,rows.memory_encryption_auxiliary,auxiliaryAfter);expected.memory_encryption_auxiliary=[...auxiliaryAfter].sort((a,b)=>String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0);}
   let cleanupJobId:string|undefined;
   if(forgetSource){
    if(!source||source.change==='forget')throw new MemoryCipherError();const drawer=source.drawer_kind==null?defaultDrawerForType(String(source.type)):normalizeDrawer({kind:source.drawer_kind,key:source.drawer_key??''});
    const additionalMemories:Record<string,unknown>[]=[];
    for(const extra of cascade){const extraId=String(extra.id),extraDrawer=normalizeDrawer({kind:extra.drawer_kind,key:extra.drawer_key??''});const removed=yield* deleteEncryptedForgottenSourceStep(owner.ownerId,extraId,extraDrawer,[...types],[...texts],lease.scope,operationKey,material.id,owner.ownerId,valid,[],false);additionalMemories.push({memoryId:extraId,types:[...types],texts:[...texts],drawer:extraDrawer,tombstoneId:removed.tombstone.id});expected.memory_versions=expected.memory_versions.filter(r=>r.memory_id!==extraId).concat(removed.tombstone);}
    const forgotten=yield* deleteEncryptedForgottenSourceStep(owner.ownerId,id,drawer,[...types],[...texts],lease.scope,operationKey,material.id,owner.ownerId,valid,additionalMemories);cleanupJobId=forgotten.jobId;
    expected.memories=expected.memories.filter(r=>!targetIds.includes(String(r.id)));expected.memory_versions=expected.memory_versions.filter(r=>r.memory_id!==id).concat(forgotten.tombstone).sort((a,b)=>String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0);
   }
   if(!sameForgetRows(expected,yield* encryptedForgetRowsStep(owner.ownerId))||JSON.stringify(yield* authenticatedMemoryOwnerStep(token))!==JSON.stringify(owner)||!valid()||graphMutation&&!graphMutation.isCurrent()||auxiliaryMutation&&!auxiliaryMutation.isCurrent())throw new MemoryCipherError();
   if(disclosure)assertNoUnresolvedDisclosureHolds(disclosure,targetIds);
   return {relatedMemories:updates.filter(u=>u.table==='memories').length,proposals:extraReset?.memory_file_proposals.length??updates.filter(u=>u.table==='memory_file_proposals').length,summaries:extraReset?.memory_weekly_summaries.length??updates.filter(u=>u.table==='memory_weekly_summaries').length,...(forgetSource?{cleanupJobId,sourceDeleted:true,memoryIds:Object.freeze([...targetIds]),documentsNeedOwnerReimport:documentReset?.documentsNeedOwnerReimport===true,derivedContentNeedsOwnerReview:true}:{}),completeForget:false as const};
  },{immediate:true});
  if(graphMutation){if(!graphMutation.isCurrent()||await graphMutation.commit()!==true)throw new MemoryCipherError();await check();}if(auxiliaryMutation){if(!auxiliaryMutation.isCurrent()||await auxiliaryMutation.commit()!==true)throw new MemoryCipherError();await check();}return staged;
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);if(logical)for(const row of logical.trashRows)for(const value of Object.values(row))if(Buffer.isBuffer(value))value.fill(0);}
}

export const scrubAuthenticatedEncryptedMemoryReferences=(input:Input)=>scrub(input);
/** Returns a durable pending cleanup ticket; never claims files/caches/ledger completed. */
export const forgetAuthenticatedEncryptedMemoryDatabase=(input:Input)=>scrub(input,true);

/** One owner-derived person plan, one authority stage and one SQL transaction; no per-ID partial commits. */
export function forgetAuthenticatedEncryptedPersonDatabase(input:Omit<Input,'id'|'personPlan'>&{personPlan:EncryptedPersonForgetPlan}){if(!isTrustedEncryptedPersonForgetPlan(input.personPlan)||!input.personPlan.memoryIds.length)return Promise.reject(new MemoryCipherError());return scrub({...input,id:input.personPlan.memoryIds[0]},true);}

/** Owner-only dry preparation: audits/decrypts and validates the entire cascade, without authority or mutation. */
export const prepareAuthenticatedEncryptedForgetPlan=(input:Input)=>scrub(input,true,true);
