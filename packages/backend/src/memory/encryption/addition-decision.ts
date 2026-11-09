import {captureCurrentEncryptedProposalOrigin} from './proposal-origin.js';
import {validateEncryptedDocumentRuntimeCoverage,assertEncryptedDocumentRuntimeCoverageStep} from './document-runtime-coverage.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
import {approvedEncryptedProposalMetadata} from './memory-lineage.js';
import {beforeEncryptedMemoryEffect,memoryEffectDigest} from './memory-effect.js';
import {memoryControlQuery} from './control-runner.js';
/** Reviewed owner decision for a single encrypted addition. No model-selected approval or plaintext fallback. */
import {one,run,type StepRunner,type SqlParam} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {loadEncryptedOwnerRow} from './owner-row-loader.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {encryptMemoryRow,decryptMemoryRow,memoryRowSurfaceManifest,carryEncryptedProposalContentProducer} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import {proposalReviewHash,lockDrawer,type MemoryChange} from '../memory-files.js';
import {normalizeDrawer,drawerId} from '../drawers.js';
import {drawerRevisionStep} from '../versions.js';
import {newMemory} from '../learning.js';
import {provenanceOf} from '../validity.js';
import {isMemoryType} from '../types.js';
import {recordEncryptedVersionStep} from './version-writer.js';
import {syncEncryptedTopicIndexStep} from './topic-index.js';
import {assertNoUncoveredProjectCopiesStep,assertNoUncoveredExternalProjectCopiesStep} from './forget-coverage.js';
import {encryptedAdditionBaseHash} from './proposal-create.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
export async function decideAuthenticatedEncryptedAddition(input:{captureAuthority?:()=>Promise<MemoryRestoreAuthorityLease|null>;runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;proposalId:string;reviewHash:string;decision:'approve'|'reject';lookupKey:Buffer;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>}){
 const {runner,token,session,proposalId,reviewHash,decision,recordRead}=input;let key:Buffer|undefined,lookup:Buffer|undefined;
 try{
  const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};boundary();if(!['approve','reject'].includes(decision)||typeof reviewHash!=='string'||!/^[a-f0-9]{64}$/.test(reviewHash)||!Buffer.isBuffer(input.lookupKey)||input.lookupKey.length!==32)throw new MemoryCipherError();lookup=Buffer.from(input.lookupKey);
  const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(owner.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  const check=async()=>{boundary();const current=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(current)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();};
  const captured=await loadEncryptedOwnerRow(runner,'memory_file_proposals',owner.ownerId,proposalId);await check();if(!captured)throw new MemoryCipherError();
  if(await recordRead({readerKind:'user',readerId:owner.ownerId,purpose:'tool',records:[{table:'memory_file_proposals',id:proposalId}]})!==true)throw new MemoryCipherError();await check();const material=await lease.resolveKey({user_id:owner.ownerId});key=material.key;await check();
  const proposal=decryptMemoryRow('memory_file_proposals',captured,lease.scope,key,material.id);if(proposal.status!=='pending'||proposal.decision!==null||proposal.conflict_with!==null||!['agent','import','owner'].includes(String(proposal.source))||['import','owner'].includes(String(proposal.source))&&proposal.created_by!==owner.ownerId||typeof proposal.changes!=='string')throw new MemoryCipherError();
  const changes=JSON.parse(proposal.changes) as MemoryChange[];if(!Array.isArray(changes)||!changes.length||changes.length>(proposal.source==='import'?200:1)||changes.some(change=>change.op!=='add'||Object.keys(change).sort().join(',')!=='after,op'))throw new MemoryCipherError();
  const entries=changes.map(change=>{if(change.op!=='add')throw new MemoryCipherError();return change.after;});
  for(const entry of entries)if(!entry||Object.keys(entry).sort().join(',')!=='content,importance,type'||!isMemoryType(entry.type)||typeof entry.content!=='string'||!entry.content.trim()||entry.content.length>50000||!Number.isInteger(entry.importance)||entry.importance<1||entry.importance>10)throw new MemoryCipherError();
  const drawer=normalizeDrawer({kind:proposal.drawer_kind,key:proposal.drawer_key??''});if(!['owner','project'].includes(drawer.kind)||!Number.isSafeInteger(proposal.base_revision)||typeof proposal.base_hash!=='string'||proposal.base_hash!==encryptedAdditionBaseHash(owner.ownerId,drawer,proposal.base_revision as number))throw new MemoryCipherError();
  const hash=proposalReviewHash({id:proposalId,drawerId:drawerId(drawer),baseRevision:proposal.base_revision as number,baseHash:proposal.base_hash,source:proposal.source as 'agent'|'import'|'owner',changes});if(hash!==reviewHash)throw new MemoryCipherError();
  const origin=decision==='approve'?await captureCurrentEncryptedProposalOrigin({runner,proposal,scope:lease.scope,captureAuthority:input.captureAuthority}):undefined;await check();
  const documentCoverage=decision==='approve'&&input.captureAuthority?await validateEncryptedDocumentRuntimeCoverage({runner,token,session,captureAuthority:input.captureAuthority,recordRead}):null;await check();
  const preparedMemories=decision==='approve'?entries.map(entry=>{
    const memory=newMemory(owner.ownerId,drawer,entry,{source:proposal.source,proposalId}),provenance=provenanceOf({metadataSource:proposal.source,sourceAgentId:['import','owner'].includes(String(proposal.source))?null:String(proposal.agent_id),ownerWrote:true}),surface=memoryRowSurfaceManifest().find(s=>s.table==='memories')!;
    const plain:Record<string,unknown>=Object.fromEntries([surface.owner,surface.id,...surface.bound,...surface.clear,...surface.text,...surface.binary].map(field=>[field,null]));
    Object.assign(plain,{id:memory.id,user_id:owner.ownerId,type:entry.type,content:entry.content,memory_layer:memory.memoryLayer,status:'active',metadata:JSON.stringify(memory.metadata),importance_score:memory.importanceScore,created_at:memory.createdAt.toISOString(),last_accessed_at:memory.lastAccessedAt,access_count:0,expiry_timestamp:memory.expiryTimestamp??null,consolidation_status:'pending',drawer_kind:drawer.kind,drawer_key:drawer.key??'',source_agent_id:['import','owner'].includes(String(proposal.source))?null:proposal.agent_id,source:provenance.source,source_ref:provenance.sourceRef,trust:provenance.trust,valid_from:memory.createdAt.toISOString(),visibility:'private',is_team_critical:0,quality_score:50,completeness_score:0.5,clarity_score:0.5,usefulness_score:0.5,auto_enriched:0,needs_improvement:0});
    const metadata=approvedEncryptedProposalMetadata(proposal,plain,lease.scope);if(metadata!==null)plain.metadata=metadata;const tagged=carryEncryptedProposalContentProducer(proposal,plain,lease.scope),cipher=encryptMemoryRow('memories',tagged,lease.scope,key!,material.id);return{memory,entry,plain:tagged,cipher};
  }):[];
  await runner.tx(function*(){if(JSON.stringify(yield* authenticatedMemoryOwnerStep(token))!==JSON.stringify(owner)||!lease.isCurrent()||origin&&!origin.isCurrent())throw new MemoryCipherError();const current=yield* one<Record<string,unknown>>('SELECT * FROM memory_file_proposals WHERE id=? AND user_id=?',proposalId,owner.ownerId);if(!current||canonicalEncryptedRow(current)!==canonicalEncryptedRow(captured))throw new MemoryCipherError();if(decision==='approve'){if(documentCoverage){yield* assertNoUncoveredExternalProjectCopiesStep(owner.ownerId);yield* assertEncryptedDocumentRuntimeCoverageStep(documentCoverage,runner,owner.ownerId);}else yield* assertNoUncoveredProjectCopiesStep(owner.ownerId);if((yield* drawerRevisionStep(owner.ownerId,drawer))!==proposal.base_revision)throw new MemoryCipherError();if(drawer.kind==='project'&&(yield* memoryControlQuery(()=>one('SELECT 1 AS archived FROM memory_project_scopes WHERE owner_id=? AND slug=? AND archived_at IS NOT NULL',owner.ownerId,drawer.key!))))throw new MemoryCipherError();for(const item of preparedMemories)if(yield* one('SELECT id FROM memories WHERE id=?',item.memory.id))throw new MemoryCipherError();}},{immediate:true});await check();
  await beforeEncryptedMemoryEffect({runner,action:'decide-addition',auth:owner,isCurrent:()=>lease.isCurrent()&&(!origin||origin.isCurrent())&&Date.now()<owner.validUntil,targetDigest:memoryEffectDigest([proposalId,reviewHash,decision,captured,preparedMemories.map(item=>item.cipher)])});await check();if(documentCoverage)await documentCoverage.refresh();await check();
  const operationKey=key,lookupKey=lookup;
  const result=await runner.tx(function*(){
   const currentOwner=yield* authenticatedMemoryOwnerStep(token);if(JSON.stringify(currentOwner)!==JSON.stringify(owner)||!lease.isCurrent()||origin&&!origin.isCurrent())throw new MemoryCipherError();yield* lockDrawer(owner.ownerId,drawer);
   const current=yield* one<Record<string,unknown>>('SELECT * FROM memory_file_proposals WHERE id=? AND user_id=?',proposalId,owner.ownerId);if(!current||canonicalEncryptedRow(current)!==canonicalEncryptedRow(captured))throw new MemoryCipherError();
   let memoryId:string|null=null,revision:number|null=null;const memoryIds:string[]=[];
   if(decision==='approve'){
    if(documentCoverage){yield* assertNoUncoveredExternalProjectCopiesStep(owner.ownerId);yield* assertEncryptedDocumentRuntimeCoverageStep(documentCoverage,runner,owner.ownerId);}else yield* assertNoUncoveredProjectCopiesStep(owner.ownerId);if((yield* drawerRevisionStep(owner.ownerId,drawer))!==proposal.base_revision)throw new MemoryCipherError();
    if(drawer.kind==='project'&&(yield* memoryControlQuery(()=>one('SELECT 1 AS archived FROM memory_project_scopes WHERE owner_id=? AND slug=? AND archived_at IS NOT NULL',owner.ownerId,drawer.key!))))throw new MemoryCipherError();
    for(const item of preparedMemories){const {memory,entry,plain,cipher}=item;
    const fields=Object.keys(cipher);yield* run(`INSERT INTO memories(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,...fields.map(f=>cipher[f] as SqlParam));
    const storedMemory=yield* one<Record<string,unknown>>('SELECT * FROM memories WHERE id=? AND user_id=?',memory.id,owner.ownerId);if(!storedMemory||canonicalEncryptedRow(storedMemory)!==canonicalEncryptedRow(cipher))throw new MemoryCipherError();
    yield* syncEncryptedTopicIndexStep(plain,lookupKey);yield* recordEncryptedVersionStep({memoryId:memory.id,userId:owner.ownerId,drawer,change:'create',entry,actor:owner.ownerId,proposalId,sourceRow:plain},lease.scope,operationKey,material.id);memoryIds.push(memory.id);memoryId=memoryIds[0];revision=yield* drawerRevisionStep(owner.ownerId,drawer);
    }
   }
   const replacement=encryptMemoryRow('memory_file_proposals',{...proposal,status:decision==='approve'?'approved':'rejected',decided_by:owner.ownerId,decided_at:new Date().toISOString(),applied_revision:revision,decision:decision==='approve'?'keep_new':'keep_old'},lease.scope,operationKey,material.id),fields=Object.keys(replacement).filter(f=>!['id','user_id'].includes(f));
   const changed=yield* run(`UPDATE memory_file_proposals SET ${fields.map(f=>f+'=?').join(',')} WHERE id=? AND user_id=? AND status='pending' AND changes=?`,...fields.map(f=>replacement[f] as SqlParam),proposalId,owner.ownerId,captured.changes as string);if(changed.changes!==1)throw new MemoryCipherError();
   if(documentCoverage)yield* assertEncryptedDocumentRuntimeCoverageStep(documentCoverage,runner,owner.ownerId);
   const stored=yield* one<Record<string,unknown>>('SELECT * FROM memory_file_proposals WHERE id=? AND user_id=?',proposalId,owner.ownerId);if(!stored||canonicalEncryptedRow(stored)!==canonicalEncryptedRow(replacement)||!lease.isCurrent()||origin&&!origin.isCurrent()||Date.now()>=owner.validUntil||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();return{proposalId,memoryId,decision,...(proposal.source==='import'?{memoryIds}:{})};
  },{immediate:true});await check();return result;
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);lookup?.fill(0);}
}
