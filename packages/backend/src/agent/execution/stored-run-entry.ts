import {AsyncLocalStorage} from 'node:async_hooks';
import {one,run} from '../../repositories/sql-steps.js';
import {LeaseLostError,RunCancelledError,RunPausedError,BudgetExceededError,type Lease} from '../../services/task-runs.js';
import {readStoredRunBindingStep} from '../../memory/encryption/stored-run-binding.js';
/** Real worker/control admission installed by the private native bootstrap. */
import type {StepRunner} from '../../repositories/sql-steps.js';
import {captureStoredRunControlClaim,inspectStoredRunControlClaim} from '../../memory/encryption/stored-run-control.js';
import {runWithStoredRunPrincipal,currentStoredRunPrincipal} from '../../memory/encryption/stored-run-principal.js';
import {isEncryptedMemoryProfileSelected} from '../../memory/encryption/consumer-host.js';
import {MemoryCipherError} from '../../memory/encryption/envelope.js';
export class StoredRunOperationInterrupted extends Error {constructor(){super('native-background-operation-interrupted');}}
export class StoredRunConsentUnavailable extends Error {constructor(){super('native-background-delegation-required');}}
type Entry={isCurrentOperation:()=>boolean;canClaimRun:(runId:string)=>Promise<boolean>;runner:StepRunner;run:<T>(operation:()=>Promise<T>)=>Promise<T>;auxiliary:<T>(operation:()=>Promise<T>,options:{maxWaitMs:number})=>Promise<T>};
const phases=new AsyncLocalStorage<{runId:string;workerId:string;started:boolean}>();
let installed:Entry|null=null;
export function installStoredRunExecution(value:Entry){if(installed||!value?.runner||typeof value.run!=='function'||typeof value.auxiliary!=='function'||typeof value.canClaimRun!=='function'||typeof value.isCurrentOperation!=='function')throw new MemoryCipherError();installed=Object.freeze({...value});const own=installed;return()=>{if(installed===own)installed=null;};}
export function withStoredRunControl<T>(operation:()=>Promise<T>):Promise<T>{if(installed)return installed.run(operation);if(isEncryptedMemoryProfileSelected())throw new MemoryCipherError();return operation();}
const detachedReleases=new Set<string>();
function releaseStep(lease:Lease,liveOnly:boolean){return function*(){const result=yield* run("UPDATE task_runs SET status='queued',status_reason='native-background-delegation-required',lease_owner=NULL,lease_expires_at=NULL,segment_started_ms=NULL WHERE id=? AND status='running' AND cancel_requested=0 AND lease_owner=? AND lease_generation=?"+(liveOnly?' AND lease_expires_at>?':''),lease.runId,lease.owner,lease.generation,...(liveOnly?[Date.now()]:[]));return result.changes===1;};}
function scheduleDetachedRelease(source:Entry,lease:Lease){
 const key=JSON.stringify([lease.runId,lease.owner,lease.generation]);if(detachedReleases.has(key))return;detachedReleases.add(key);
 // Never await this queue from the aborted parent: native park is waiting for that parent to unwind.
 void Promise.resolve().then(()=>source.auxiliary(async()=>{if(installed!==source)return false;return source.runner.tx(releaseStep(lease,false));},{maxWaitMs:60000})).catch(()=>false).finally(()=>{detachedReleases.delete(key);});
}
export async function withStoredRunClaim<T>(runId:string,workerId:string,operation:()=>Promise<T>,claimedLease?:Lease):Promise<T>{
 if(!installed){if(isEncryptedMemoryProfileSelected())throw new MemoryCipherError();return operation();}
 const source=installed,phase={runId,workerId,started:false};let knownLease=claimedLease;
 if(knownLease&&(knownLease.runId!==runId||knownLease.owner!==workerId||!Number.isSafeInteger(knownLease.generation)||knownLease.generation<1))throw new MemoryCipherError();
 const interrupted=()=>{if(!phase.started&&knownLease)scheduleDetachedRelease(source,knownLease);if(phase.started)throw new LeaseLostError();throw new StoredRunOperationInterrupted();};
 try{const claim=await captureStoredRunControlClaim({runner:source.runner,runId,workerId}),metadata=inspectStoredRunControlClaim(claim);if(!metadata)throw new MemoryCipherError();knownLease={runId,owner:workerId,generation:metadata.generation};return await phases.run(phase,()=>runWithStoredRunPrincipal(claim,operation));}
 catch(error){if(!source.isCurrentOperation())interrupted();if(phase.started&&error instanceof StoredRunConsentUnavailable)throw new LeaseLostError();
  if(!phase.started&&installed===source&&!(error instanceof LeaseLostError)&&!(error instanceof RunCancelledError)&&!(error instanceof RunPausedError)&&!(error instanceof BudgetExceededError)){
   try{const row=await source.runner.read(one<{status:string;cancel_requested:number;lease_owner:string|null}>('SELECT status,cancel_requested,lease_owner FROM task_runs WHERE id=?',runId));if(!row||row.lease_owner!==workerId||row.status!=='running')throw new LeaseLostError();if(row.cancel_requested===1)throw new RunCancelledError();const eligible=await source.canClaimRun(runId);if(!source.isCurrentOperation())interrupted();if(eligible===false)throw new StoredRunConsentUnavailable();}
   catch(classificationError){if(!source.isCurrentOperation())interrupted();throw classificationError;}
  }throw error;
 }
}
export function withStoredRunHeartbeat<T>(deadline:number,operation:()=>Promise<T>):Promise<T>{if(!installed){if(isEncryptedMemoryProfileSelected())throw new MemoryCipherError();return operation();}const remaining=Math.floor(deadline-Date.now());if(remaining<=0)throw new MemoryCipherError();return installed.auxiliary(operation,{maxWaitMs:Math.min(60000,remaining)});}

/** Missing delegation is a queued owner decision, never permission to claim or infer an owner. */
export async function canClaimStoredRun(runId:string):Promise<boolean>{if(!installed)return !isEncryptedMemoryProfileSelected();try{const bound=await installed.runner.read(readStoredRunBindingStep(runId));return !!bound&&typeof bound.owner_id==='string'&&!!bound.owner_id&&await installed.canClaimRun(runId)===true;}catch{return false;}}

/** Consent races before any model/context work release only the exact still-owned live lease. */
export async function releaseStoredRunForConsent(lease:Lease):Promise<boolean>{const source=installed;if(!source)return false;if(!source.isCurrentOperation()){scheduleDetachedRelease(source,lease);return true;}try{return await source.runner.tx(releaseStep(lease,true));}catch(error){if(!source.isCurrentOperation()){scheduleDetachedRelease(source,lease);return true;}throw error;}}


/** The actual model/tool invocation, not admission or context preparation, makes failure terminal. */
export function markStoredRunExecutionStarted():void{const phase=phases.getStore();if(!phase)return;const principal=currentStoredRunPrincipal();if(!principal||principal.control.runId!==phase.runId||principal.control.workerId!==phase.workerId||!principal.isCurrent())throw new StoredRunConsentUnavailable();phase.started=true;}
