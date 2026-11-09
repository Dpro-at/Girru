import {assertNoUnresolvedDisclosureHolds,type VerifiedDisclosureInventory} from './disclosure-history.js';
import {beforeEncryptedMemoryEffect,memoryEffectDigest,isProtectedMemoryRunner} from './memory-effect.js';
/** Explicit standalone post-commit worker. Host must invoke OUTSIDE any enclosing DB transaction. */
import {one,run,type StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {openMemoryText,sealMemoryText,MemoryCipherError} from './envelope.js';
import {loadEncryptedOwnerRow} from './owner-row-loader.js';
import {decryptMemoryRow} from './row-codec.js';
import type {MemoryReadIntent} from './read-audit.js';
export type ForgetCleanupPlan={v:1;ownerId:string;memoryId:string;types:string[];texts:string[];drawer:{kind:string;key?:string};tombstoneId:string};
export type ForgetCleanupEffects={ledger:(plan:ForgetCleanupPlan)=>Promise<boolean>;index:(plan:ForgetCleanupPlan)=>Promise<boolean>;files:(plan:ForgetCleanupPlan)=>Promise<boolean>;caches:(plan:ForgetCleanupPlan)=>Promise<boolean>};
export async function finishAuthenticatedEncryptedForget(input:{captureDisclosureInventory?:()=>Promise<VerifiedDisclosureInventory|null>;runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;jobId:string;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>;effects:ForgetCleanupEffects}){
 const {runner,token,session,jobId,recordRead}=input,effects={...input.effects};let key:Buffer|undefined;
 try{
  if(process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();
  if(typeof runner.inTransaction!=='function'||runner.inTransaction())throw new MemoryCipherError();
  if(typeof jobId!=='string'||!jobId||jobId.length>256||['ledger','index','files','caches'].some(k=>typeof effects[k as keyof ForgetCleanupEffects]!=='function'))throw new MemoryCipherError();
  const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});if(owner.ownerId!==lease.scope.ownerId)throw new MemoryCipherError();
  const check=async()=>{if(process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();if(runner.inTransaction?.()!==false||!lease.isCurrent()||JSON.stringify(await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true}))!==JSON.stringify(owner))throw new MemoryCipherError();};
  await check();const job=await runner.read(one<{id:string;owner_id:string;memory_id:string;tombstone_id:string;plan:string;status:string}>(`SELECT id,owner_id,memory_id,tombstone_id,status,CASE WHEN ${runner.dialect==='sqlite'?'length(CAST(plan AS BLOB))':'octet_length(plan)'}<=2097152 THEN plan ELSE NULL END AS plan FROM memory_encryption_forget_jobs WHERE id=? AND owner_id=?`,jobId,owner.ownerId));
  if(!job||!['pending','complete'].includes(job.status)||typeof job.plan!=='string'||Buffer.byteLength(job.plan)>2*1024*1024)throw new MemoryCipherError();
  const audit=async(id:string)=>{if(await recordRead({readerKind:'user',readerId:owner.ownerId,purpose:'tool',records:[{table:'memory_versions',id}]})!==true)throw new MemoryCipherError();await check();};
  await audit(job.tombstone_id);const material=await lease.resolveKey({user_id:owner.ownerId});key=material.key;await check();
  const context={ownerId:owner.ownerId,memberId:lease.scope.memberId,recordId:jobId,field:job.status==='complete'?'forget-cleanup-complete':'forget-cleanup-plan'};
  const raw=JSON.parse(openMemoryText(job.plan,key,material.id,context));
  let plans:ForgetCleanupPlan[]=[],targets:{memoryId:string;tombstoneId:string}[];
  if(job.status==='complete'){
   if(raw?.v!==1||raw.jobId!==jobId||raw.complete!==true||!Array.isArray(raw.targets))throw new MemoryCipherError();targets=raw.targets;
  }else{
   if(raw?.v!==1||raw.ownerId!==owner.ownerId||raw.memoryId!==job.memory_id||raw.tombstoneId!==job.tombstone_id||!Array.isArray(raw.additionalMemories??[]))throw new MemoryCipherError();
   plans=[raw,...(raw.additionalMemories??[]).map((p:Record<string,unknown>)=>({...p,v:1,ownerId:owner.ownerId}))];
   for(const plan of plans)if(!Array.isArray(plan.types)||plan.types.length>1000||plan.types.some(t=>typeof t!=='string')||!Array.isArray(plan.texts)||plan.texts.length>1000||plan.texts.some(t=>typeof t!=='string'))throw new MemoryCipherError();
   targets=plans.map(p=>({memoryId:p.memoryId,tombstoneId:p.tombstoneId}));
  }
  if(!targets.length||targets.length>1000||targets[0].memoryId!==job.memory_id||targets[0].tombstoneId!==job.tombstone_id||new Set(targets.map(t=>t.memoryId)).size!==targets.length||targets.some(t=>typeof t.memoryId!=='string'||!t.memoryId||t.memoryId.length>256||typeof t.tombstoneId!=='string'||!t.tombstoneId||t.tombstoneId.length>256))throw new MemoryCipherError();
  for(const target of targets){if(target.tombstoneId!==job.tombstone_id)await audit(target.tombstoneId);const cipher=await loadEncryptedOwnerRow(runner,'memory_versions',owner.ownerId,target.tombstoneId);if(!cipher)throw new MemoryCipherError();const tombstone=decryptMemoryRow('memory_versions',cipher,lease.scope,key,material.id);if(tombstone.memory_id!==target.memoryId||tombstone.change!=='forget'||tombstone.content!==null||tombstone.snapshot!==null)throw new MemoryCipherError();}
  const validate=async()=>{await check();for(const target of targets){const state=await runner.read(one<{n:number;bad:number;live:number}>("SELECT (SELECT count(*) FROM memory_versions WHERE user_id=? AND memory_id=? AND id=? AND change='forget') n,(SELECT count(*) FROM memory_versions WHERE user_id=? AND memory_id=? AND id<>?) bad,(SELECT count(*) FROM memories WHERE id=?) live",owner.ownerId,target.memoryId,target.tombstoneId,owner.ownerId,target.memoryId,target.tombstoneId,target.memoryId));if(!state||Number(state.n)!==1||Number(state.bad)!==0||Number(state.live)!==0)throw new MemoryCipherError();}};
  await validate();if(job.status==='complete')return{completeForget:true,jobId,forgottenIds:targets.map(t=>t.memoryId)};
  let disclosureReceipt:string|undefined;const assertDisclosure=async()=>{if(!input.captureDisclosureInventory){if(isProtectedMemoryRunner(runner))throw new MemoryCipherError();return;}const inventory=await input.captureDisclosureInventory();if(!inventory)throw new MemoryCipherError();assertNoUnresolvedDisclosureHolds(inventory,targets.map(target=>target.memoryId));if(disclosureReceipt!==undefined&&disclosureReceipt!==inventory.receiptId)throw new MemoryCipherError();disclosureReceipt=inventory.receiptId;};await assertDisclosure();await validate();
  await beforeEncryptedMemoryEffect({runner,action:'cleanup-forget',auth:owner,isCurrent:()=>lease.isCurrent()&&Date.now()<owner.validUntil&&process.env.AGENT_PLAYER_READONLY!=='1',targetDigest:memoryEffectDigest([jobId,job.plan,targets])});await validate();
  for(const stage of ['ledger','index','files','caches'] as const)for(const plan of plans){await assertDisclosure();await validate();if(await effects[stage](structuredClone(plan))!==true)return{completeForget:false,jobId,pendingStage:stage,pendingMemoryId:plan.memoryId};}
  await assertDisclosure();await validate();const receipt=sealMemoryText(JSON.stringify({v:1,jobId,targets,complete:true}),key,material.id,{...context,field:'forget-cleanup-complete'});
  await runner.tx(function*(){const fresh=yield* authenticatedMemoryOwnerStep(token);if(JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();const result=yield* run("UPDATE memory_encryption_forget_jobs SET status='complete',plan=? WHERE id=? AND owner_id=? AND status='pending' AND plan=?",receipt,jobId,owner.ownerId,job.plan);if(result.changes!==1)throw new MemoryCipherError();},{immediate:true});
  return{completeForget:true,jobId,forgottenIds:targets.map(t=>t.memoryId)};
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
