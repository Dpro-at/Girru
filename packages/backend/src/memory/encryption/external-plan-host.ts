/** Explicit internal host composition. Never auto-registers routes, grants roots or touches files. */
import {randomUUID} from 'node:crypto';
import {one,tableExists,type StepRunner} from '../../repositories/sql-steps.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {createExternalRootPermissionService} from './external-root-permissions.js';
import {mergeExternalCopyHistory} from './external-copy-history.js';
import {listExternalPlanCheckpointIdsStep} from './external-plan-checkpoints.js';
import {revalidateAuthenticatedExternalPlanCheckpoint,readAuthenticatedExternalPlanCheckpointForAccounting} from './external-plan-reader.js';
import {createExternalPlanCheckpointStore} from './external-plan-checkpoints.js';
import {createExternalPlanIntentStore} from './external-plan-intent-store.js';
import {captureAuthenticatedExternalReferencePlan} from './external-reference-gateway.js';
import {captureExternalCopyReferencesStep,assertExternalCopyReferencesCurrentStep} from './external-copy-manifest.js';
import {externalReferenceLocationStep} from './external-reference-plan.js';
import {claimEncryptedProjectionHoldStep} from './projection-hold.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import type {ExternalCopyReference,ExternalProjectionHold} from './external-copy-manifest.js';
import {MemoryCipherError} from './envelope.js';
export function createAuthenticatedExternalPlanHost(input:{runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;lookupKey:Buffer}){
 const {runner,token,session}=input,permissions=createExternalRootPermissionService({runner,token,lookupKey:input.lookupKey});
 let state:'new'|'initializing'|'ready'|'closed'='new',active:Promise<unknown>|undefined,store:ReturnType<typeof createExternalPlanIntentStore>|undefined,checkpoints:ReturnType<typeof createExternalPlanCheckpointStore>|undefined;
 const ready=()=>{if(state!=='ready'||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};
 const perform=<T>(body:()=>Promise<T>)=>{try{ready();if(active)throw new MemoryCipherError();const operation=body();active=operation;void operation.finally(()=>{if(active===operation)active=undefined;}).catch(()=>undefined);return operation;}catch{return Promise.reject(new MemoryCipherError());}};
 const persist=async(operation:()=>Promise<{snapshotId:string;ciphertext:string}>)=>{
  try{
   const lease=session.capture(),captured=await operation();ready();if(!lease.isCurrent()||!checkpoints)throw new MemoryCipherError();
   const before=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});if(before.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
   await checkpoints.append(captured);ready();
   const after=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});ready();
   if(!lease.isCurrent()||JSON.stringify(after)!==JSON.stringify(before))throw new MemoryCipherError();return captured;
  }catch(error){session.lock();throw error;}
 };
 return{
  async initialize(){
   if(state!=='new')throw new MemoryCipherError();state='initializing';
   const operation=(async()=>{
    const owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});
    if(state!=='initializing'||session.capture().scope.ownerId!==owner.ownerId)throw new MemoryCipherError();
    store=createExternalPlanIntentStore(runner,owner.ownerId);await permissions.initialize();
    if(state!=='initializing')throw new MemoryCipherError();await store.initialize();
    if(state!=='initializing')throw new MemoryCipherError();checkpoints=createExternalPlanCheckpointStore(runner,owner.ownerId);await checkpoints.initialize();if(state!=='initializing')throw new MemoryCipherError();state='ready';
   })();active=operation;
   try{await operation;}catch(error){state='closed';permissions.close();session.lock();throw error;}finally{if(active===operation)active=undefined;}
  },
  /** Only explicit authenticated owner commands may invoke grants/revocations. */
  grantRoot:(scope:string,root:string,expiresAt:number)=>perform(()=>permissions.grant(scope,root,expiresAt)),
  revokeRoot:(scope:string,root:string)=>perform(()=>permissions.revoke(scope,root)),
  capture:(plan:{snapshotId:string;references:readonly ExternalCopyReference[];holds:readonly ExternalProjectionHold[]})=>perform(()=>persist(()=>captureAuthenticatedExternalReferencePlan({runner,token,session,snapshotId:plan.snapshotId,references:plan.references,holds:plan.holds,
   recordIntent:async intent=>{ready();if(!store)throw new MemoryCipherError();const ack=await store.append(intent);ready();return ack;},
   authorizeRoot:async request=>{ready();const allowed=await permissions.authorizeRoot(request);ready();return allowed;},
  }))),
  captureRoots:(plan:{snapshotId:string;references:readonly ExternalCopyReference[];holds:readonly ExternalProjectionHold[]})=>perform(()=>persist(()=>captureAuthenticatedExternalReferencePlan({runner,token,session,snapshotId:plan.snapshotId,references:plan.references,holds:plan.holds,pinRoots:true,
   recordIntent:async intent=>{ready();if(!store)throw new MemoryCipherError();const ack=await store.append(intent);ready();return ack;},
   authorizeRoot:async request=>{ready();const allowed=await permissions.authorizeRoot(request);ready();return allowed;},
  }))),
  captureInventory:(plan:{snapshotId:string;references:readonly ExternalCopyReference[];holds:readonly ExternalProjectionHold[]})=>perform(()=>persist(()=>captureAuthenticatedExternalReferencePlan({runner,token,session,snapshotId:plan.snapshotId,references:plan.references,holds:plan.holds,inventoryCopies:true,
   recordIntent:async intent=>{ready();if(!store)throw new MemoryCipherError();const ack=await store.append(intent);ready();return ack;},
   authorizeRoot:async request=>{ready();const allowed=await permissions.authorizeRoot(request);ready();return allowed;},
  }))),
  captureCurrentInventory:()=>perform(()=>persist(async()=>{
   const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});ready();if(owner.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
   const references=await runner.tx(()=>captureExternalCopyReferencesStep(owner.ownerId),{immediate:true});ready();
   const locations=await runner.tx(function*(){const result=[];for(const reference of references){const location=yield* externalReferenceLocationStep(owner.ownerId,reference);result.push({reference,...location});}return result;},{immediate:true});ready();
   for(const item of locations){if(!lease.isCurrent()||await permissions.authorizeRoot({purpose:'encrypted-forget-plan',ownerId:owner.ownerId,scope:item.scope,root:item.root,reference:{...item.reference}})!==true)throw new MemoryCipherError();ready();}
   const snapshotId=randomUUID();if(!store||await store.append({purpose:'external-forget-plan',ownerId:owner.ownerId,snapshotId,referenceCount:references.length,holdCount:new Set(locations.map(item=>item.scope)).size})!==true)throw new MemoryCipherError();ready();
   const holds=await runner.tx(function*(){const fresh=yield* authenticatedMemoryOwnerStep(token);if(JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();yield* assertExternalCopyReferencesCurrentStep(owner.ownerId,references);const result:ExternalProjectionHold[]=[];
    for(const scope of [...new Set(locations.map(item=>item.scope))].sort()){
     const prior=(yield* tableExists('memory_encryption_projection_holds'))?yield* one<{owner_id:string;hold_id:string;generation:number|string;state:string}>('SELECT owner_id,hold_id,generation,state FROM memory_encryption_projection_holds WHERE scope=?',scope):undefined;
     if(prior?.state==='held'){if(prior.owner_id!==owner.ownerId||!prior.hold_id||!Number.isSafeInteger(Number(prior.generation))||Number(prior.generation)<1)throw new MemoryCipherError();result.push({scope,id:prior.hold_id,generation:Number(prior.generation)});}
     else{const hold=yield* claimEncryptedProjectionHoldStep(owner.ownerId,scope);result.push({scope,...hold});}
    }return result;
   },{immediate:true});ready();
   return captureAuthenticatedExternalReferencePlan({runner,token,session,snapshotId,references,holds,inventoryCopies:true,
    recordIntent:async intent=>{ready();if(!store)throw new MemoryCipherError();return store.append(intent);},authorizeRoot:async request=>{ready();return permissions.authorizeRoot(request);},
   });
  })),
  revalidateCheckpoint:(checkpointId:string)=>perform(()=>revalidateAuthenticatedExternalPlanCheckpoint({runner,token,session,checkpointId,
   recordIntent:async intent=>{ready();if(!store)throw new MemoryCipherError();const ack=await store.append(intent);ready();return ack;},
   authorizeRoot:async request=>{ready();const allowed=await permissions.authorizeRoot(request);ready();return allowed;},
  })),
  trackHistoricalCopies:()=>perform(async()=>{try{
   const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});ready();if(!lease.isCurrent()||lease.scope.ownerId!==owner.ownerId)throw new MemoryCipherError();
   const ids=await runner.tx(()=>listExternalPlanCheckpointIdsStep(owner.ownerId),{immediate:true});if(ids.length>100)throw new MemoryCipherError();const observations=[];let bytes=0;
   for(const entry of ids){ready();if(!lease.isCurrent())throw new MemoryCipherError();const snapshot=await readAuthenticatedExternalPlanCheckpointForAccounting({runner,token,session,checkpointId:entry.id,
    recordIntent:async intent=>{ready();if(!store)throw new MemoryCipherError();return store.append(intent);},authorizeRoot:async request=>{ready();return permissions.authorizeRoot(request);},
   });if(!snapshot)throw new MemoryCipherError();bytes+=Buffer.byteLength(JSON.stringify(snapshot));if(bytes>2097152)throw new MemoryCipherError();observations.push({checkpointId:entry.id,snapshot});}
   const roots=[...new Map(observations.flatMap(observation=>observation.snapshot.plan).map(item=>[JSON.stringify([item.scope,item.root]),item])).values()];
   for(const item of roots){ready();if(!lease.isCurrent()||await permissions.authorizeRoot({purpose:'encrypted-forget-plan',ownerId:owner.ownerId,scope:item.scope,root:item.root,reference:{...item.reference}})!==true){session.lock();throw new MemoryCipherError();}}
   const fresh=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});ready();if(!lease.isCurrent()||JSON.stringify(fresh)!==JSON.stringify(owner))throw new MemoryCipherError();return mergeExternalCopyHistory(observations);
  }catch(error){session.lock();throw error;}}),
  async close(){state='closed';permissions.close();session.lock();try{await active;}catch{/* An interrupted capture never grants filesystem effects. */}},
  status:()=>state,
 };
}
