/** Internal authenticated plan capture. No filesystem effects or implicit application registration. */
import type {StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {MemoryCipherError,sealMemoryText} from './envelope.js';
import {prepareAuthorizedExternalReferencePlan,type ExternalRootPermissionRequest} from './external-reference-plan.js';
import {classifyExternalCopiesStep,type ExternalCopyClass} from './external-copy-classification.js';
import {inventoryAuthorizedExternalCopies} from './external-copy-inventory.js';
import {pinAuthorizedExternalRoot,type ExternalRootIdentity} from './external-root-identity.js';
import type {ExternalCopyReference,ExternalProjectionHold} from './external-copy-manifest.js';
export type ExternalPlanIntent={purpose:'external-forget-plan'|'external-forget-plan-history';ownerId:string;snapshotId:string;referenceCount:number;holdCount:number};
export async function captureAuthenticatedExternalReferencePlan(input:{runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;snapshotId:string;pinRoots?:boolean;inventoryCopies?:boolean;references:readonly ExternalCopyReference[];holds:readonly ExternalProjectionHold[];authorizeRoot:(request:ExternalRootPermissionRequest)=>Promise<boolean>;recordIntent:(intent:ExternalPlanIntent)=>Promise<boolean>}):Promise<{snapshotId:string;ciphertext:string}>{
 const {runner,token,session,snapshotId,authorizeRoot,recordIntent }=input,inventoryCopies=input.inventoryCopies===true,pinRoots=input.pinRoots===true||inventoryCopies;let key:Buffer|undefined;
 try{
  if(runner.inTransaction?.()!==false||typeof authorizeRoot!=='function'||typeof recordIntent!=='function'||typeof snapshotId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(snapshotId))throw new MemoryCipherError();
  const boundary=()=>{if(process.env.AGENT_PLAYER_READONLY==='1'||runner.inTransaction?.()!==false)throw new MemoryCipherError();};
  boundary();const references=structuredClone(input.references),holds=structuredClone(input.holds);
  if(!Array.isArray(references)||references.length>3000||!Array.isArray(holds)||holds.length>1000)throw new MemoryCipherError();
  const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});
  if(owner.ownerId!==lease.scope.ownerId)throw new MemoryCipherError();
  const check=async()=>{boundary();if(!lease.isCurrent())throw new MemoryCipherError();const fresh=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();};
  await check();
  // Host must persist this identifier-only intent before acknowledging it. Never send paths to audit.
  if(await recordIntent({purpose:'external-forget-plan',ownerId:owner.ownerId,snapshotId,referenceCount:references.length,holdCount:holds.length})!==true)throw new MemoryCipherError();
  await check();
  const plan=await prepareAuthorizedExternalReferencePlan({runner,ownerId:owner.ownerId,references,holds,authorizeRoot:async request=>{await check();const allowed=await authorizeRoot(request);await check();return allowed;}});
  const identities:ExternalRootIdentity[]=[],inventories:Array<{ownerId:string;scope:string;root:string;files:Array<{path:string;bytes:number;sha256:string;classification:ExternalCopyClass}>}>=[];
  if(pinRoots){
   const roots=[...new Map(plan.map(item=>[JSON.stringify([item.scope,item.root]),item])).values()];
   if(roots.length>32)throw new MemoryCipherError();
   for(const item of roots){await check();identities.push(await pinAuthorizedExternalRoot({purpose:'encrypted-forget-plan',ownerId:owner.ownerId,scope:item.scope,root:item.root,reference:{...item.reference}},async request=>{await check();const allowed=await authorizeRoot(request);await check();return allowed;}));}
   if(inventoryCopies){
    let total=0;
    for(let i=0;i<roots.length;i++){
     const item=roots[i]!,identity=identities[i]!;
     const files=await inventoryAuthorizedExternalCopies(identity,{purpose:'encrypted-forget-plan',ownerId:owner.ownerId,scope:item.scope,root:item.root,reference:{...item.reference}},async request=>{await check();const allowed=await authorizeRoot(request);await check();return allowed;},8388608-total);
     total+=files.reduce((sum,file)=>sum+file.bytes,0);if(total>8388608)throw new MemoryCipherError();
     await check();const classified=await runner.tx(()=>classifyExternalCopiesStep(owner.ownerId,item.scope,item.root,files),{immediate:true});await check();
     inventories.push({ownerId:owner.ownerId,scope:item.scope,root:item.root,files:classified});
    }
   }
   const current=await prepareAuthorizedExternalReferencePlan({runner,ownerId:owner.ownerId,references,holds,authorizeRoot:async request=>{await check();const allowed=await authorizeRoot(request);await check();return allowed;}});
   if(JSON.stringify(current)!==JSON.stringify(plan))throw new MemoryCipherError();
  }
  await check();const material=await lease.resolveKey({user_id:owner.ownerId});key=material.key;
  await check();
  const ciphertext=sealMemoryText(JSON.stringify(inventoryCopies?{v:4,ownerId:owner.ownerId,snapshotId,plan,identities,inventories}:pinRoots?{v:2,ownerId:owner.ownerId,snapshotId,plan,identities}:{v:1,ownerId:owner.ownerId,snapshotId,plan}),key,material.id,{...lease.scope,recordId:snapshotId,field:'external-reference-plan'});
  await check();return{snapshotId,ciphertext};
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
