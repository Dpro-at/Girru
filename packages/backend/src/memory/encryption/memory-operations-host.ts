import type {EncryptedPersonForgetPlan} from './person-owner.js';
import type {PreparedEncryptedForgetPlan} from './forget-scrub-gateway.js';
import type {VerifiedDisclosureInventory} from './disclosure-history.js';
import {validateEncryptedDocumentRuntimeCoverage} from './document-runtime-coverage.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
import type {GraphForgetMutationJournal,AuxiliaryForgetMutationJournal} from './forget-scrub-gateway.js';
import type {EncryptedMutationGuard} from './run-mutation-guard.js';
/** Explicit internal composition of existing Trash/restore/forget and historical-copy services.
 * External shared-file mutation remains unsupported and conservatively blocked. No app registration. */
import type {StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {createAuthenticatedExternalPlanHost} from './external-plan-host.js';
import {createEncryptedForgetLifecycle} from './forget-lifecycle.js';
import {createEncryptedForgetHostEffects} from './forget-host-effects.js';
import {deleteAuthenticatedEncryptedMemory,restoreAuthenticatedEncryptedMemory,restoreAuthenticatedEncryptedMemoryWithTopicFallback} from './trash-gateway.js';
import {assertNoUncoveredProjectCopiesStep,assertNoUncoveredExternalProjectCopiesStep} from './forget-coverage.js';
import type {MemoryReadIntent} from './read-audit.js';
import type {ExternalCopyReference,ExternalProjectionHold} from './external-copy-manifest.js';
import {MemoryCipherError} from './envelope.js';
type Plan={snapshotId:string;references:readonly ExternalCopyReference[];holds:readonly ExternalProjectionHold[]};
export function createEncryptedMemoryOperationsHost(input:{captureDisclosureInventory?:()=>Promise<VerifiedDisclosureInventory|null>;captureAuthority?:()=>Promise<MemoryRestoreAuthorityLease|null>;auxiliaryMutationJournal?:AuxiliaryForgetMutationJournal;graphMutationJournal?:GraphForgetMutationJournal;runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;lookupKey:Buffer;recordForgetAuthority?:(ids:readonly string[])=>Promise<boolean>;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>;profile:{profileRoot:string;memoryRoot:string;exportFiles:readonly string[];indexRunner:StepRunner|null}}){
 const {runner,token,session,recordRead}=input;if(!Buffer.isBuffer(input.lookupKey)||input.lookupKey.length!==32||typeof recordRead!=='function')throw new MemoryCipherError();
 const lookup=Buffer.from(input.lookupKey),external=createAuthenticatedExternalPlanHost({runner,token,session,lookupKey:lookup}),effects=createEncryptedForgetHostEffects({...input.profile,exportFiles:[...input.profile.exportFiles]});
 const forgetting=createEncryptedForgetLifecycle({runner,token,session,recordRead,effects,captureDisclosureInventory:input.captureDisclosureInventory,recordForgetAuthority:input.recordForgetAuthority,graphMutationJournal:input.graphMutationJournal,auxiliaryMutationJournal:input.auxiliaryMutationJournal});
 let state:'new'|'starting'|'ready'|'closing'|'closed'='new',active:Promise<unknown>|undefined;
 const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};
 const perform=<T>(body:()=>Promise<T>):Promise<T>=>{
  try{boundary();if(state!=='ready'||active)throw new MemoryCipherError();
   const operation=(async()=>{try{
    const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(!lease.isCurrent()||owner.ownerId!==lease.scope.ownerId)throw new MemoryCipherError();
    const result=await body();boundary();const current=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();
    if(state!=='ready'||!lease.isCurrent()||JSON.stringify(current)!==JSON.stringify(owner))throw new MemoryCipherError();return result;
   }catch(error){session.lock();throw error;}})();active=operation;void operation.finally(()=>{if(active===operation)active=undefined;}).catch(()=>undefined);return operation;
  }catch{return Promise.reject(new MemoryCipherError());}
 };
 const assertCovered=async()=>{
  await runner.tx(function*(){const owner=yield* authenticatedMemoryOwnerStep(token);yield* assertNoUncoveredExternalProjectCopiesStep(owner.ownerId);},{immediate:true});
  if(input.captureAuthority)await validateEncryptedDocumentRuntimeCoverage({runner,token,session,captureAuthority:input.captureAuthority,recordRead});
  else await runner.tx(function*(){const owner=yield* authenticatedMemoryOwnerStep(token);yield* assertNoUncoveredProjectCopiesStep(owner.ownerId);},{immediate:true});
 };
 return{
  async start(){boundary();if(state!=='new')throw new MemoryCipherError();state='starting';
   const operation=(async()=>{await external.initialize();if(state!=='starting')throw new MemoryCipherError();const resumed=await forgetting.start();boundary();if(state!=='starting')throw new MemoryCipherError();state='ready';return resumed;})();active=operation;
   try{return await operation;}catch(error){state='closed';session.lock();lookup.fill(0);await external.close();await forgetting.stop();throw error;}finally{if(active===operation)active=undefined;}
  },
  deleteToTrash:(id:string,assertMutation?:EncryptedMutationGuard)=>perform(async()=>{await assertCovered();return deleteAuthenticatedEncryptedMemory({runner,token,session,lookupKey:lookup,recordRead,id,assertMutation,captureAuthority:input.captureAuthority});}),
  restore:(id:string,confirmDropTopic=false,assertMutation?:EncryptedMutationGuard)=>perform(async()=>{if(typeof confirmDropTopic!=='boolean')throw new MemoryCipherError();await assertCovered();const request={runner,token,session,lookupKey:lookup,recordRead,id,assertMutation,captureAuthority:input.captureAuthority};return confirmDropTopic?restoreAuthenticatedEncryptedMemoryWithTopicFallback(request):restoreAuthenticatedEncryptedMemory(request);}),
  previewForgetPlan:(id:string,personPlan?:EncryptedPersonForgetPlan,assertMutation?:EncryptedMutationGuard)=>perform(()=>forgetting.previewForgetPlan(id,personPlan,assertMutation)),
  forgetPerson:(personPlan:EncryptedPersonForgetPlan,assertMutation?:EncryptedMutationGuard,preparedPlan?:PreparedEncryptedForgetPlan)=>perform(()=>forgetting.forgetPerson(personPlan,assertMutation,preparedPlan)),
  forget:(id:string,assertMutation?:EncryptedMutationGuard,preparedPlan?:PreparedEncryptedForgetPlan)=>perform(async()=>{await runner.tx(function*(){const owner=yield* authenticatedMemoryOwnerStep(token);yield* assertNoUncoveredExternalProjectCopiesStep(owner.ownerId);},{immediate:true});return forgetting.forget(id,assertMutation,preparedPlan);}),
  resumeCleanup:()=>perform(()=>forgetting.resume()),
  captureInventory:(plan:Plan)=>perform(()=>external.captureInventory(plan)),
  trackHistoricalCopies:()=>perform(()=>external.trackHistoricalCopies()),
  grantRoot:(scope:string,root:string,expiresAt:number)=>perform(()=>external.grantRoot(scope,root,expiresAt)),
  revokeRoot:(scope:string,root:string)=>perform(()=>external.revokeRoot(scope,root)),
  async stop(){if(state==='closed')return;state='closing';session.lock();await external.close();await forgetting.stop();try{await active;}catch{/* Durable tickets/history retain their own outcome. */}lookup.fill(0);state='closed';},
  status:()=>state,
 };
}
