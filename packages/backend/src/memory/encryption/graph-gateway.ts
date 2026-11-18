import {beforeEncryptedMemoryEffect,memoryEffectDigest} from './memory-effect.js';
/** Audited owner graph review and atomic metadata reseal; never populates legacy graph tables. */
import {one,dialect,type StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {loadEncryptedOwnerRow} from './owner-row-loader.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {decryptMemoryRow} from './row-codec.js';
import {prepareEncryptedContentUpdate} from './content-update.js';
import {commitEncryptedContentStep,canonicalEncryptedRow} from './content-commit.js';
import {encryptedGraphReview,reviewedEncryptedGraphMetadata} from './graph-projection.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
type Input={runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;lookupKey:Buffer;id:string;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>};
export async function reviewAuthenticatedEncryptedGraph(input:Input,decision?:{reviewHash:string;action:'approve'|'reject'}){
 const {runner,token,session,id,recordRead}=input;let key:Buffer|undefined,lookup:Buffer|undefined;
 try{
  if(!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(id)||!Buffer.isBuffer(input.lookupKey)||input.lookupKey.length!==32)throw new MemoryCipherError();lookup=Buffer.from(input.lookupKey);
  const selectedDecision=decision?{...decision}:undefined,boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};boundary();
  const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(owner.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  const check=async()=>{boundary();const fresh=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();};
  const source=await loadEncryptedOwnerRow(runner,'memories',owner.ownerId,id);await check();if(!source||source.status!=='active')throw new MemoryCipherError();
  if(await recordRead({readerKind:'user',readerId:owner.ownerId,purpose:'view',records:[{table:'memories',id}]})!==true)throw new MemoryCipherError();await check();
  const material=await lease.resolveKey({user_id:owner.ownerId});key=material.key;await check();const plain=decryptMemoryRow('memories',source,lease.scope,key,material.id),preview=encryptedGraphReview(plain,lookup);
  if(!selectedDecision){await check();await runner.tx(function*(){
   const fresh=yield* authenticatedMemoryOwnerStep(token),driver=yield* dialect();if(JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();
   const current=yield* one<Record<string,unknown>>(`SELECT * FROM memories WHERE user_id=? AND id=?${driver==='postgres'?' FOR UPDATE':''}`,owner.ownerId,id);
   if(!current||canonicalEncryptedRow(current)!==canonicalEncryptedRow(source)||!lease.isCurrent())throw new MemoryCipherError();
  },{immediate:true});await check();return preview;}
  const metadata=reviewedEncryptedGraphMetadata(plain,lookup,selectedDecision.reviewHash,selectedDecision.action),authorize=(row:Readonly<Record<string,unknown>>)=>row.user_id===owner.ownerId&&row.status==='active';
  const replacement=prepareEncryptedContentUpdate(source,{metadata},lease.scope,key,material.id,authorize,true),operationKey=key,lookupKey=lookup;
  await check();await beforeEncryptedMemoryEffect({runner,action:'review-graph',auth:owner,isCurrent:()=>lease.isCurrent()&&Date.now()<owner.validUntil,targetDigest:memoryEffectDigest([source,replacement,selectedDecision])});await runner.tx(function*(){
   const fresh=yield* authenticatedMemoryOwnerStep(token);if(JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();
   yield* commitEncryptedContentStep(source,replacement,lease.scope,operationKey,material.id,'owner:'+owner.ownerId,lookupKey);
   if(!lease.isCurrent()||Date.now()>=owner.validUntil||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();
  },{immediate:true});await check();return{memoryId:id,decision:selectedDecision.action};
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);lookup?.fill(0);}
}
