import {beforeEncryptedMemoryEffect,memoryEffectDigest} from './memory-effect.js';
import {assertEncryptedDocumentRuntimeCoverageStep,type DocumentRuntimeCoverage} from './document-runtime-coverage.js';
import {assertNoUncoveredExternalProjectCopiesStep} from './forget-coverage.js';
import {stampEncryptedRunLineage,type captureEncryptedRunWriteAdmission} from './run-admission.js';
import {memoryControlQuery} from './control-runner.js';
/** Explicit authenticated encrypted creation. Reuses existing retention/history/index code; no plaintext projections. */
import {packVector} from '../vectors.js';
import type {EmbeddingResult} from '../embedding.js';
import {one,run,type StepRunner,type SqlParam} from '../../repositories/sql-steps.js';
import {captureAuthenticatedMemoryRun,authenticatedMemoryRunStep} from './auth-capture.js';
import {createMemoryRevisionValidator} from './revision-validator.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {newMemory} from '../learning.js';
import {normalizeDrawer,type DrawerRef} from '../drawers.js';
import type {VersionEntry} from '../versions.js';
import {recordEncryptedVersionStep} from './version-writer.js';
import {memoryRowSurfaceManifest,encryptMemoryRow,decryptMemoryRow,attachEncryptedRunProducer} from './row-codec.js';
import {syncEncryptedTopicIndexStep,verifyEncryptedTopicClaimStep} from './topic-index.js';
import {assertNoUncoveredProjectCopiesStep} from './forget-coverage.js';
import {MemoryCipherError} from './envelope.js';
import {canonicalEncryptedRow} from './content-commit.js';
import {provenanceOf} from '../validity.js';
export async function createAuthenticatedEncryptedMemory(input:{documentCoverage?:DocumentRuntimeCoverage;producerAdmission?:NonNullable<ReturnType<typeof captureEncryptedRunWriteAdmission>>;runner:StepRunner;token:string;run:Parameters<typeof authenticatedMemoryRunStep>[1];session:ReturnType<typeof createMemoryUnlockSession>;lookupKey:Buffer;drawer:DrawerRef;entry:VersionEntry;topic?:string|null;embedDocument?:(text:string)=>Promise<EmbeddingResult>}){
 const {runner,token,session}=input;let key:Buffer|undefined,lookup:Buffer|undefined,generatedVector:Buffer|undefined;
 try{
  const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};boundary();
  if(!Buffer.isBuffer(input.lookupKey)||input.lookupKey.length!==32)throw new MemoryCipherError();lookup=Buffer.from(input.lookupKey);
  const lease=session.capture(),drawer=normalizeDrawer(input.drawer),entry={...input.entry},topic=input.topic??null,runScope={...input.run,delegatedFrom:[...input.run.delegatedFrom],drawers:input.run.drawers.map(d=>({...d}))};
  if(!['owner','project'].includes(drawer.kind)||typeof entry.content!=='string'||!entry.content.trim()||entry.content.length>50000||typeof entry.type!=='string'||!/^[a-z][a-z_-]{0,31}$/.test(entry.type)||!Number.isInteger(entry.importance)||entry.importance<1||entry.importance>10||topic!==null&&(typeof topic!=='string'||!topic.trim()||Buffer.byteLength(topic)>512))throw new MemoryCipherError();
  const auth=await captureAuthenticatedMemoryRun(runner,token,runScope);boundary();if(auth.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  const validate=createMemoryRevisionValidator(runner,auth.revision,session.lock),metadata={user_id:auth.ownerId,status:'active',drawer_kind:drawer.kind,drawer_key:drawer.key??''};
  if(!auth.access.authorizeWrite(metadata))throw new MemoryCipherError();
  const check=async()=>{boundary();if(!lease.isCurrent()||await validate()!==true)throw new MemoryCipherError();boundary();if(!lease.isCurrent())throw new MemoryCipherError();};
  await check();await runner.tx(function*(){if(input.documentCoverage){yield* assertNoUncoveredExternalProjectCopiesStep(auth.ownerId);yield* assertEncryptedDocumentRuntimeCoverageStep(input.documentCoverage,runner,auth.ownerId);}else yield* assertNoUncoveredProjectCopiesStep(auth.ownerId);},{immediate:true});await check();
  const material=await lease.resolveKey(metadata);key=material.key;await check();
  const provenance=provenanceOf({metadataSource:'agent',sourceAgentId:runScope.agentId});
  const memory=newMemory(auth.ownerId,drawer,entry,{source:'agent',sourceAgentId:runScope.agentId},topic),surface=memoryRowSurfaceManifest().find(s=>s.table==='memories')!;
  const plain:Record<string,unknown>=Object.fromEntries([surface.owner,surface.id,...surface.bound,...surface.clear,...surface.text,...surface.binary].map(field=>[field,null]));
  Object.assign(plain,{...metadata,id:memory.id,type:memory.type,content:memory.content,memory_layer:memory.memoryLayer,metadata:JSON.stringify(memory.metadata),importance_score:memory.importanceScore,created_at:memory.createdAt.toISOString(),last_accessed_at:memory.lastAccessedAt,access_count:0,expiry_timestamp:memory.expiryTimestamp??null,consolidation_status:'pending',topic_key:topic,source_agent_id:runScope.agentId,source:provenance.source,source_ref:provenance.sourceRef,trust:provenance.trust,valid_from:memory.createdAt.toISOString(),visibility:'private',is_team_critical:0,quality_score:50,completeness_score:0.5,clarity_score:0.5,usefulness_score:0.5,auto_enriched:0,needs_improvement:0});
  if(input.embedDocument){const embedded=await input.embedDocument(entry.content);await check();if(!embedded||!Number.isInteger(embedded.dims)||embedded.dims<1||embedded.dims>8192||embedded.vector.length!==embedded.dims||embedded.vector.some(value=>!Number.isFinite(value)||Math.abs(value)>3.4028234663852886e38)||typeof embedded.model!=='string'||!embedded.model||embedded.model.length>256)throw new MemoryCipherError();try{generatedVector=packVector(embedded.vector);Object.assign(plain,{embedding:null,embedding_vec:generatedVector,embedding_model:embedded.model,embedding_dims:embedded.dims});}finally{embedded.vector.fill(0);}}
  if(input.documentCoverage){await input.documentCoverage.refresh();await check();}
  if(input.producerAdmission){if(input.producerAdmission.agentId!==runScope.agentId||!input.producerAdmission.isCurrent())throw new MemoryCipherError();plain.metadata=stampEncryptedRunLineage(plain,input.producerAdmission,key);}
  if(!auth.access.authorizeWrite(plain))throw new MemoryCipherError();const tagged=input.producerAdmission?attachEncryptedRunProducer('memories',plain,lease.scope,input.producerAdmission):plain,cipher=encryptMemoryRow('memories',tagged,lease.scope,key,material.id),operationKey=key,lookupKey=lookup;
  await beforeEncryptedMemoryEffect({runner,action:'create-memory',auth,isCurrent:()=>lease.isCurrent()&&Date.now()<auth.revision.validUntil&&(!input.producerAdmission||input.producerAdmission.isCurrent()),targetDigest:memoryEffectDigest([plain.id,cipher,drawer])});
  await runner.tx(function*(){
   const fresh=yield* authenticatedMemoryRunStep(token,runScope);if(JSON.stringify(fresh.revision)!==JSON.stringify(auth.revision)||!fresh.access.authorizeWrite(plain)||!lease.isCurrent()||input.producerAdmission&&!input.producerAdmission.isCurrent())throw new MemoryCipherError();
   if(input.documentCoverage){yield* assertNoUncoveredExternalProjectCopiesStep(auth.ownerId);yield* assertEncryptedDocumentRuntimeCoverageStep(input.documentCoverage,runner,auth.ownerId);}else yield* assertNoUncoveredProjectCopiesStep(auth.ownerId);
   if(drawer.kind==='project'&&(yield* memoryControlQuery(()=>one('SELECT 1 AS archived FROM memory_project_scopes WHERE owner_id=? AND slug=? AND archived_at IS NOT NULL',auth.ownerId,drawer.key!))))throw new MemoryCipherError();
   if(yield* one('SELECT 1 AS occupied FROM memories WHERE id=?',plain.id as string))throw new MemoryCipherError();
   const fields=Object.keys(cipher);yield* run(`INSERT INTO memories(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,...fields.map(f=>cipher[f] as SqlParam));
   yield* syncEncryptedTopicIndexStep(plain,lookupKey);yield* verifyEncryptedTopicClaimStep(plain,lookupKey);
   const versionId=yield* recordEncryptedVersionStep({memoryId:plain.id as string,userId:auth.ownerId,drawer,change:'create',entry,sourceRow:tagged,actor:'agent:'+runScope.agentId},lease.scope,operationKey,material.id);
   const row=yield* one<Record<string,unknown>>('SELECT * FROM memories WHERE id=? AND user_id=?',plain.id as string,auth.ownerId);
   const normalize=(value:Record<string,unknown>)=>Object.fromEntries(Object.entries(value).map(([field,data])=>[field,['is_team_critical','auto_enriched','needs_improvement'].includes(field)&&typeof data==='boolean'?Number(data):data]));
   if(!row||canonicalEncryptedRow(normalize(decryptMemoryRow('memories',row,lease.scope,operationKey,material.id)))!==canonicalEncryptedRow(normalize(plain)))throw new MemoryCipherError();
   if(input.documentCoverage)yield* assertEncryptedDocumentRuntimeCoverageStep(input.documentCoverage,runner,auth.ownerId);
   if(!versionId||!lease.isCurrent()||input.producerAdmission&&!input.producerAdmission.isCurrent()||Date.now()>=auth.revision.validUntil||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();
  },{immediate:true});await check();return{id:plain.id as string,encrypted:true as const};
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);lookup?.fill(0);generatedVector?.fill(0);}
}
