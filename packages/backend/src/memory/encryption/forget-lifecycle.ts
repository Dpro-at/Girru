import type {EncryptedPersonForgetPlan} from './person-owner.js';
import type {VerifiedDisclosureInventory} from './disclosure-history.js';
import type {EncryptedMutationGuard} from './run-mutation-guard.js';
/** Explicit unlocked-owner lifecycle. No timers, original-profile discovery or implicit key custody. */
import {all,tableExists,type StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {forgetAuthenticatedEncryptedMemoryDatabase,forgetAuthenticatedEncryptedPersonDatabase,prepareAuthenticatedEncryptedForgetPlan,type PreparedEncryptedForgetPlan,type GraphForgetMutationJournal,type AuxiliaryForgetMutationJournal} from './forget-scrub-gateway.js';
import {finishAuthenticatedEncryptedForget,type ForgetCleanupEffects} from './forget-cleanup.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
type Services={captureDisclosureInventory?:()=>Promise<VerifiedDisclosureInventory|null>;auxiliaryMutationJournal?:AuxiliaryForgetMutationJournal;graphMutationJournal?:GraphForgetMutationJournal;runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>;effects:ForgetCleanupEffects;recordForgetAuthority?:(ids:readonly string[])=>Promise<boolean>};
export function createEncryptedForgetLifecycle(input:Services){
 const services={...input,effects:{...input.effects}};let state:'new'|'ready'|'stopping'|'stopped'='new',active:Promise<unknown>|undefined;
 const boundary=()=>{if(process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();if(typeof services.runner.inTransaction!=='function'||services.runner.inTransaction())throw new MemoryCipherError();};
 const perform=<T>(body:()=>Promise<T>):Promise<T>=>{try{boundary();if(state!=='ready'||active)throw new MemoryCipherError();const operation=body();active=operation;void operation.finally(()=>{if(active===operation)active=undefined;}).catch(()=>undefined);return operation;}catch{return Promise.reject(new MemoryCipherError());}};
 async function resume(){
  const owner=await services.runner.tx(()=>authenticatedMemoryOwnerStep(services.token),{immediate:true});if(!services.session.isUnlocked()||owner.ownerId!==services.session.capture().scope.ownerId)throw new MemoryCipherError();
  const jobs=await services.runner.read((function*(){if(!(yield* tableExists('memory_encryption_forget_jobs')))return[];return yield* all<{id:string}>("SELECT id FROM memory_encryption_forget_jobs WHERE owner_id=? AND status='pending' ORDER BY created_at,id LIMIT 100",owner.ownerId);})());
  const results=[];for(const job of jobs){if(state!=='ready')throw new MemoryCipherError();results.push(await finishAuthenticatedEncryptedForget({...services,jobId:job.id}));}return results;
 }
 return{
  async start(){boundary();if(state!=='new')throw new MemoryCipherError();state='ready';try{return await perform(resume);}catch(error){state='stopped';services.session.lock();throw error;}},
  resume:()=>perform(resume),
  previewForgetPlan:(id:string,personPlan?:EncryptedPersonForgetPlan,assertMutation?:EncryptedMutationGuard)=>perform(()=>prepareAuthenticatedEncryptedForgetPlan({...services,id,personPlan,assertMutation})),
  forgetPerson:(personPlan:EncryptedPersonForgetPlan,assertMutation?:EncryptedMutationGuard,preparedPlan?:PreparedEncryptedForgetPlan)=>perform(async()=>{const staged=await forgetAuthenticatedEncryptedPersonDatabase({...services,personPlan,assertMutation,preparedPlan});if(!staged.cleanupJobId)throw new MemoryCipherError();if(state!=='ready')return{completeForget:false,jobId:staged.cleanupJobId};boundary();return {...await finishAuthenticatedEncryptedForget({...services,jobId:staged.cleanupJobId}),documentsNeedOwnerReimport:staged.documentsNeedOwnerReimport===true,derivedContentNeedsOwnerReview:staged.derivedContentNeedsOwnerReview===true};}),
  forget:(id:string,assertMutation?:EncryptedMutationGuard,preparedPlan?:PreparedEncryptedForgetPlan)=>perform(async()=>{const staged=await forgetAuthenticatedEncryptedMemoryDatabase({...services,id,assertMutation,preparedPlan});if(!staged.cleanupJobId)throw new MemoryCipherError();if(state!=='ready')return{completeForget:false,jobId:staged.cleanupJobId};boundary();return {...await finishAuthenticatedEncryptedForget({...services,jobId:staged.cleanupJobId}),documentsNeedOwnerReimport:staged.documentsNeedOwnerReimport===true,derivedContentNeedsOwnerReview:staged.derivedContentNeedsOwnerReview===true};}),
  async stop(){if(state==='stopped')return;state='stopping';services.session.lock();try{await active;}catch{/* Durable pending tickets resume only after a new explicit unlock. */}state='stopped';},
  status:()=>state,
 };
}
export type EncryptedForgetLifecycle=ReturnType<typeof createEncryptedForgetLifecycle>;
/** Shared by the real app factory and synthetic Fastify acceptance. Never creates keys/services. */
export function registerEncryptedForgetLifecycleHooks(app:{addHook:(name:'onReady'|'onClose',hook:()=>Promise<void>)=>unknown},lifecycle:EncryptedForgetLifecycle){
 app.addHook('onReady',async()=>{await lifecycle.start();});app.addHook('onClose',async()=>{await lifecycle.stop();});
}
