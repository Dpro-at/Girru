import {beforeEncryptedMemoryEffect,memoryEffectDigest} from './memory-effect.js';
import {validateEncryptedDocumentRuntimeCoverage,assertEncryptedDocumentRuntimeCoverageStep} from './document-runtime-coverage.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
import {canonicalEncryptedRow} from './content-commit.js';
import {memoryTopicLookupToken} from './topic-lookup.js';
import type {EncryptedMutationGuard} from './run-mutation-guard.js';
/** Internal owner-only encrypted Trash composition; no app routes or background activation. */
import {one,run,dialect,type StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {loadEncryptedOwnerRow} from './owner-row-loader.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import type {MemoryReadIntent} from './read-audit.js';
import {deleteEncryptedMemoryToTrashStep} from './trash-delete.js';
import {restoreEncryptedMemoryFromTrashStep} from './trash-restore.js';
import {decryptMemoryRow} from './row-codec.js';
import {prepareEncryptedTrashRestore,prepareEncryptedTrashSnapshot} from './trash-snapshot.js';
import {normalizeDrawer,defaultDrawerForType} from '../drawers.js';
import {findEncryptedTopicCandidateStep,verifyEncryptedTopicClaimStep} from './topic-index.js';
import {assertNoUncoveredProjectCopiesStep,assertNoUncoveredExternalProjectCopiesStep} from './forget-coverage.js';
import {MemoryCipherError} from './envelope.js';
type Input={captureAuthority?:()=>Promise<MemoryRestoreAuthorityLease|null>;runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;id:string;lookupKey:Buffer;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>;assertMutation?:EncryptedMutationGuard};
async function change(input:Input,operation:'delete'|'restore',allowTopicDrop=false){
 let key:Buffer|undefined,lookup:Buffer|undefined;
 const runner=input.runner,token=input.token,session=input.session,id=input.id,recordRead=input.recordRead,assertMutation=input.assertMutation;
 try{
  const boundary=()=>{if(process.env.AGENT_PLAYER_READONLY==='1'||runner.inTransaction?.()!==false)throw new MemoryCipherError();};
  boundary();
  if(typeof id!=='string'||!id||Buffer.byteLength(id)>256||!Buffer.isBuffer(input.lookupKey)||input.lookupKey.length!==32)throw new MemoryCipherError();lookup=Buffer.from(input.lookupKey);
  const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});
  if(owner.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  const check=async()=>{try{boundary();if(!lease.isCurrent())throw new MemoryCipherError();const current=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(current)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();}catch{session.lock();throw new MemoryCipherError();}};
  await check();const coverage=input.captureAuthority?await validateEncryptedDocumentRuntimeCoverage({runner,token,session,captureAuthority:input.captureAuthority,recordRead}):null;await check();await runner.tx(()=>coverage?assertNoUncoveredExternalProjectCopiesStep(owner.ownerId):assertNoUncoveredProjectCopiesStep(owner.ownerId),{immediate:true});
  const table=operation==='delete'?'memories':'memory_versions';
  const cipher=await loadEncryptedOwnerRow(runner,table,owner.ownerId,id,operation==='restore');await check();if(!cipher)throw new MemoryCipherError();
  // This records a decrypt intent, never a claim that the mutation committed.
  if(await recordRead({readerKind:'user',readerId:owner.ownerId,purpose:'tool',records:[{table,id:String(cipher.id)}]})!==true)throw new MemoryCipherError();await check();
  const material=await lease.resolveKey(cipher);key=material.key;await check();
  let conflict:Record<string,unknown>|undefined;
  if(operation==='restore'&&allowTopicDrop){
   const history=decryptMemoryRow('memory_versions',cipher,lease.scope,key,material.id);
   if(history.change!=='delete'||typeof history.snapshot!=='string'||history.memory_id!==id)throw new MemoryCipherError();
   const restored=prepareEncryptedTrashRestore(history.snapshot,id,lease.scope,key,material.id,()=>lease.isCurrent()),plain=decryptMemoryRow('memories',restored,lease.scope,key,material.id);
   const drawer=plain.drawer_kind==null?defaultDrawerForType(String(plain.type)):normalizeDrawer({kind:plain.drawer_kind,key:plain.drawer_key??''});
   if(typeof plain.topic_key==='string'&&plain.topic_key){
    const lookupForRead=lookup;
    const candidate=await runner.tx(()=>findEncryptedTopicCandidateStep(owner.ownerId,drawer,plain.topic_key as string,lookupForRead));await check();
    if(candidate){const row=await loadEncryptedOwnerRow(runner,'memories',owner.ownerId,candidate);await check();if(!row)throw new MemoryCipherError();
     if(await recordRead({readerKind:'user',readerId:owner.ownerId,purpose:'tool',records:[{table:'memories',id:candidate}]})!==true)throw new MemoryCipherError();await check();conflict=row;
    }
   }
  }
  const operationKey=key,lookupKey=lookup,valid=()=>lease.isCurrent()&&Date.now()<owner.validUntil&&process.env.AGENT_PLAYER_READONLY!=='1';
  let target:Record<string,unknown>;
  if(operation==='delete'){prepareEncryptedTrashSnapshot(cipher,lease.scope,operationKey,material.id,valid);target=decryptMemoryRow('memories',cipher,lease.scope,operationKey,material.id);}
  else{const history=decryptMemoryRow('memory_versions',cipher,lease.scope,operationKey,material.id);if(history.change!=='delete'||history.memory_id!==id||typeof history.snapshot!=='string'||typeof history.reason==='string'&&history.reason.startsWith('merged from project:'))throw new MemoryCipherError();target=decryptMemoryRow('memories',prepareEncryptedTrashRestore(history.snapshot,id,lease.scope,operationKey,material.id,valid),lease.scope,operationKey,material.id);const drawer=target.drawer_kind==null?defaultDrawerForType(String(target.type)):normalizeDrawer({kind:target.drawer_kind,key:target.drawer_key??''});if(history.drawer_kind!==drawer.kind||history.drawer_key!==(drawer.key??''))throw new MemoryCipherError();}
  await runner.tx(function*(){
   if(JSON.stringify(yield* authenticatedMemoryOwnerStep(token))!==JSON.stringify(owner)||!valid())throw new MemoryCipherError();
   if(coverage){yield* assertNoUncoveredExternalProjectCopiesStep(owner.ownerId);yield* assertEncryptedDocumentRuntimeCoverageStep(coverage,runner,owner.ownerId);}else yield* assertNoUncoveredProjectCopiesStep(owner.ownerId);
   if(operation==='delete'){const current=yield* one<Record<string,unknown>>('SELECT * FROM memories WHERE id=? AND user_id=?',id,owner.ownerId);if(!current||canonicalEncryptedRow(current)!==canonicalEncryptedRow(cipher))throw new MemoryCipherError();yield* verifyEncryptedTopicClaimStep(target,lookupKey);}
   else{const latest=yield* one<Record<string,unknown>>('SELECT * FROM memory_versions WHERE memory_id=? ORDER BY version DESC LIMIT 1',id);if(!latest||canonicalEncryptedRow(latest)!==canonicalEncryptedRow(cipher)||(yield* one('SELECT id FROM memories WHERE id=?',id))||(yield* one('SELECT memory_id FROM memory_encryption_topics WHERE owner_id=? AND memory_id=?',owner.ownerId,id)))throw new MemoryCipherError();
    const drawer=target.drawer_kind==null?defaultDrawerForType(String(target.type)):normalizeDrawer({kind:target.drawer_kind,key:target.drawer_key??''}),topic=typeof target.topic_key==='string'&&target.topic_key?yield* findEncryptedTopicCandidateStep(owner.ownerId,drawer,target.topic_key,lookupKey):null;
    if(topic&&!conflict||conflict&&topic!==conflict.id)throw new MemoryCipherError();
    if(conflict){const occupied=decryptMemoryRow('memories',conflict,lease.scope,operationKey,material.id),current=yield* one<Record<string,unknown>>('SELECT * FROM memories WHERE id=? AND user_id=?',String(occupied.id),owner.ownerId),otherDrawer=occupied.drawer_kind==null?defaultDrawerForType(String(occupied.type)):normalizeDrawer({kind:occupied.drawer_kind,key:occupied.drawer_key??''}),token=memoryTopicLookupToken(target.topic_key as string|null,lookupKey,owner.ownerId,drawer);if(!current||canonicalEncryptedRow(current)!==canonicalEncryptedRow(conflict)||occupied.id===id||occupied.status!=='active'||!token||drawer.kind!==otherDrawer.kind||(drawer.key??'')!==(otherDrawer.key??'')||memoryTopicLookupToken(occupied.topic_key as string|null,lookupKey,owner.ownerId,otherDrawer)!==token)throw new MemoryCipherError();yield* verifyEncryptedTopicClaimStep(occupied,lookupKey);}
   }
   if(assertMutation)yield* assertMutation(target);if(!valid())throw new MemoryCipherError();
  },{immediate:true});await check();
  await beforeEncryptedMemoryEffect({runner,action:operation==='delete'?'trash-memory':'restore-memory',auth:owner,isCurrent:valid,targetDigest:memoryEffectDigest([id,operation,allowTopicDrop,cipher,conflict??null])});await check();if(coverage)await coverage.refresh();await check();
  return await runner.tx(function*(){
   const current=yield* authenticatedMemoryOwnerStep(token);
   if(JSON.stringify(current)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();
   const valid=()=>lease.isCurrent()&&Date.now()<owner.validUntil&&process.env.AGENT_PLAYER_READONLY!=='1';
   if((yield* dialect())==='postgres')yield* run('LOCK TABLE memories,memory_versions IN SHARE ROW EXCLUSIVE MODE');
   if(coverage){yield* assertNoUncoveredExternalProjectCopiesStep(owner.ownerId);yield* assertEncryptedDocumentRuntimeCoverageStep(coverage,runner,owner.ownerId);}else yield* assertNoUncoveredProjectCopiesStep(owner.ownerId);if(!valid())throw new MemoryCipherError();
   if(assertMutation){
    let target=cipher;
    if(operation==='restore'){const history=decryptMemoryRow('memory_versions',cipher,lease.scope,operationKey,material.id);if(typeof history.snapshot!=='string')throw new MemoryCipherError();target=prepareEncryptedTrashRestore(history.snapshot,id,lease.scope,operationKey,material.id,valid);}
    yield* assertMutation(decryptMemoryRow('memories',target,lease.scope,operationKey,material.id));
   }
   const result=operation==='delete'
    ?yield* deleteEncryptedMemoryToTrashStep(cipher,lease.scope,operationKey,material.id,lookupKey,owner.ownerId,'moved to Trash',valid)
    :yield* restoreEncryptedMemoryFromTrashStep(cipher,lease.scope,operationKey,material.id,lookupKey,owner.ownerId,valid,conflict);
   const final=yield* authenticatedMemoryOwnerStep(token);
   if(JSON.stringify(final)!==JSON.stringify(owner)||!valid())throw new MemoryCipherError();return {id:result,topicKeyDropped:!!conflict};
  },{immediate:true});
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);lookup?.fill(0);}
}
export const deleteAuthenticatedEncryptedMemory=(input:Input)=>change(input,'delete').then(result=>result.id);
export const restoreAuthenticatedEncryptedMemory=(input:Input)=>change(input,'restore').then(result=>result.id);
/** Explicit parity path: only a verified, audited live conflict can drop the restored topic. */
export const restoreAuthenticatedEncryptedMemoryWithTopicFallback=(input:Input)=>change(input,'restore',true);
