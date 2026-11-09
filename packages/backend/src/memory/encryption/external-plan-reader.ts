/** Authenticated observation reader/revalidator. Never performs file effects or certifies rollback custody. */
import type {StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {openMemoryText,MemoryCipherError} from './envelope.js';
import {loadExternalPlanCheckpointStep} from './external-plan-checkpoints.js';
import {parseExternalPlanSnapshot,type ExternalPlanSnapshot} from './external-plan-schema.js';
import {prepareAuthorizedExternalReferencePlan,type ExternalRootPermissionRequest} from './external-reference-plan.js';
import type {ExternalPlanIntent} from './external-reference-gateway.js';
async function readCheckpoint(input:{runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;checkpointId:string;recordIntent:(intent:ExternalPlanIntent)=>Promise<boolean>;authorizeRoot:(request:ExternalRootPermissionRequest)=>Promise<boolean>},accountingOnly=false):Promise<ExternalPlanSnapshot|null>{
 const {runner,token,session,checkpointId,recordIntent,authorizeRoot}=input;let key:Buffer|undefined;
 try{
  const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};
  boundary();if(typeof recordIntent!=='function'||typeof authorizeRoot!=='function')throw new MemoryCipherError();
  const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});if(owner.ownerId!==lease.scope.ownerId)throw new MemoryCipherError();
  const check=async()=>{boundary();if(!lease.isCurrent())throw new MemoryCipherError();const fresh=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();};
  await check();const row=await runner.tx(()=>loadExternalPlanCheckpointStep(owner.ownerId,checkpointId),{immediate:true});if(!row){await check();return null;}
  // The identifier column names the exact checkpoint being opened, not a filesystem path.
  if(await recordIntent({purpose:'external-forget-plan-history',ownerId:owner.ownerId,snapshotId:row.id,referenceCount:0,holdCount:0})!==true)throw new MemoryCipherError();
  await check();const material=await lease.resolveKey({user_id:owner.ownerId});key=material.key;await check();
  const observed=parseExternalPlanSnapshot(openMemoryText(row.ciphertext,key,material.id,{...lease.scope,recordId:row.snapshotId,field:'external-reference-plan'}),owner.ownerId,row.snapshotId);
  await check();
  const references=observed.plan.map(item=>item.reference),holds=[...new Map(observed.plan.map(item=>[item.hold.scope,item.hold])).values()];
  if(accountingOnly){
   // Historical holds/paths are evidence only. Require TODAY's explicit exact-root grant for inspection.
   const roots=[...new Map(observed.plan.map(item=>[JSON.stringify([item.scope,item.root]),item])).values()];
   for(const item of roots){await check();if(await authorizeRoot({purpose:'encrypted-forget-plan',ownerId:owner.ownerId,scope:item.scope,root:item.root,reference:{...item.reference}})!==true)throw new MemoryCipherError();await check();}
  }else{
   const current=await prepareAuthorizedExternalReferencePlan({runner,ownerId:owner.ownerId,references,holds,authorizeRoot:async request=>{await check();const allowed=await authorizeRoot(request);await check();return allowed;}});
   if(JSON.stringify(current)!==JSON.stringify(observed.plan))throw new MemoryCipherError();
  }
  await check();const fresh=await runner.tx(()=>loadExternalPlanCheckpointStep(owner.ownerId,row.id),{immediate:true});
  if(!fresh||fresh.snapshotId!==row.snapshotId||fresh.ciphertext!==row.ciphertext)throw new MemoryCipherError();
  await check();return observed;
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}

export const revalidateAuthenticatedExternalPlanCheckpoint=(input:Parameters<typeof readCheckpoint>[0])=>readCheckpoint(input,false);
/** Accounting only: historical grants/holds never become current execution authority. */
export const readAuthenticatedExternalPlanCheckpointForAccounting=(input:Parameters<typeof readCheckpoint>[0])=>readCheckpoint(input,true);
