/** One owned child admission boundary. Every selected runner user must enter before authentication. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import type {Step,StepRunner} from '../../repositories/sql-steps.js';
import {MemoryCipherError} from './envelope.js';

type Operation={id:string;controller:AbortController;sql:number;ended:boolean;suspended:boolean;cleanups:Set<()=>void>};
type ParkRequest={mutationId:string;launchId:string;serial:number;suspendedOperationId:string|null};
function fail():never{throw new MemoryCipherError();}
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
export function createSelectedOperationCoordinator(input:{runner:StepRunner;launchId:string;onPoison:()=>void;drainTimeoutMs?:number}){
 if(!input.runner||typeof input.runner.inTransaction!=='function'||!validId(input.launchId)||typeof input.onPoison!=='function')fail();
 const timeout=input.drainTimeoutMs??15000;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>60000)fail();
 const context=new AsyncLocalStorage<Operation>(),operations=new Map<string,Operation>(),wake=new Set<()=>void>(),runners=new Set<StepRunner>();
 const noTransactions=()=>[...runners].every(candidate=>candidate.inTransaction?.()===false);
 let auxiliaryWaiting=0;
 let phase:'open'|'exclusive'|'parking'|'parked'|'closed'='open',serial=0,pending:ParkRequest|undefined;
 let exclusiveOwner:{operation:Operation;id:string}|undefined;
 const isClosed=()=>phase==='closed';
 const canExecute=(op:Operation)=>phase==='open'||phase==='exclusive'&&exclusiveOwner?.operation===op;
 const notify=()=>{for(const callback of [...wake])callback();};
 const poison=()=>{phase='closed';for(const op of operations.values())op.controller.abort();notify();try{input.onPoison();}catch{/* Remain closed even when teardown itself fails. */}};
 const active=()=>[...operations.values()].filter(op=>!op.ended&&!op.suspended);
 function check(){const op=context.getStore();if(!op||!canExecute(op)||operations.get(op.id)!==op||op.ended||op.suspended||op.controller.signal.aborted)fail();return op;}
 function* guarded<T>(step:Step<T>):Step<T>{
  check();let next=step.next();
  while(!next.done){check();let operation=next.value;if(operation.kind==='tx'){const body=operation.body;operation={...operation,body:()=>guarded(body())};}
   try{next=step.next(yield operation);}catch(error){next=step.throw(error);}check();
  }check();return next.value;
 }
 async function sql<T>(fn:()=>Promise<T>):Promise<T>{const op=check();op.sql++;try{return await fn();}finally{op.sql--;notify();}}
 function guardRunner(candidate:StepRunner):StepRunner{
  if(phase!=='open'&&!(phase==='exclusive'&&context.getStore()===exclusiveOwner?.operation)||!candidate||typeof candidate.inTransaction!=='function'||typeof candidate.read!=='function'||typeof candidate.tx!=='function')fail();
  runners.add(candidate);return Object.freeze({dialect:candidate.dialect,inTransaction:()=>candidate.inTransaction!(),read:<T>(step:Step<T>)=>sql(()=>candidate.read(guarded(step))),tx:<T>(body:()=>Step<T>,options?:Parameters<StepRunner['tx']>[1])=>sql(()=>candidate.tx(()=>guarded(body()),options)),
   ...(candidate.readSync?{readSync:<T>(step:Step<T>):T=>{const op=check();op.sql++;try{return candidate.readSync!(guarded(step));}finally{op.sql--;notify();}}}:{}),
  });
 }
 const runner=guardRunner(input.runner);
 async function runOperation<T>(operation:(lease:{id:string;signal:AbortSignal;isCurrent:()=>boolean})=>Promise<T>):Promise<T>{
  if(phase!=='open'||context.getStore())fail();const op:Operation={id:randomUUID(),controller:new AbortController(),sql:0,ended:false,suspended:false,cleanups:new Set()};operations.set(op.id,op);
  return context.run(op,async()=>{try{const result=await operation({id:op.id,signal:op.controller.signal,isCurrent:()=>canExecute(op)&&!op.ended&&!op.suspended&&!op.controller.signal.aborted&&operations.get(op.id)===op});check();if(exclusiveOwner?.operation===op)fail();return result;}finally{for(const cleanup of [...op.cleanups]){try{cleanup();}catch{poison();}}op.ended=true;if(op.sql!==0||op.suspended||exclusiveOwner?.operation===op)poison();operations.delete(op.id);notify();}});
 }
 /** Trusted scheduler/control bookkeeping gets a fresh operation, never an inherited or message-supplied ID.
  * Waiting work is not admitted and cannot hold up a native drain. No permission is granted here. */
 function runAuxiliaryOperation<T>(operation:(lease:{id:string;signal:AbortSignal;isCurrent:()=>boolean})=>Promise<T>,options:{signal?:AbortSignal;maxWaitMs?:number}={}):Promise<T>{
  const maxWaitMs=options.maxWaitMs??timeout;if(typeof operation!=='function'||!Number.isSafeInteger(maxWaitMs)||maxWaitMs<1||maxWaitMs>60000||auxiliaryWaiting>=128||phase==='closed'||options.signal!==undefined&&!(options.signal instanceof AbortSignal)||options.signal?.aborted)return Promise.reject(new MemoryCipherError());
  auxiliaryWaiting++;
  return context.exit(()=>new Promise<T>((resolve,reject)=>{
   let settled=false,timer:ReturnType<typeof setTimeout>|undefined;
   const cleanup=()=>{wake.delete(attempt);if(timer)clearTimeout(timer);options.signal?.removeEventListener('abort',abort);auxiliaryWaiting--;};
   const abort=()=>{if(settled)return;settled=true;cleanup();reject(new MemoryCipherError());};
   const attempt=()=>{if(settled)return;if(phase==='closed'||options.signal?.aborted){abort();return;}if(phase!=='open')return;
    settled=true;cleanup();context.exit(()=>runOperation(async lease=>{if(options.signal?.aborted)fail();const admitted=context.getStore();if(!admitted||admitted.id!==lease.id)fail();const externalAbort=()=>admitted.controller.abort();options.signal?.addEventListener('abort',externalAbort,{once:true});try{return await operation(lease);}finally{options.signal?.removeEventListener('abort',externalAbort);}})).then(resolve,reject);
   };
   wake.add(attempt);options.signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,maxWaitMs);attempt();
  }));
 }
 /** Called by the private transport in the initiating operation's own async context, never from renderer IDs. */
 async function park(request:{mutationId:string;suspendCurrent:boolean},validateFrozen?:()=>boolean){
  if(phase!=='open'&&phase!=='exclusive'||!validId(request.mutationId)||typeof request.suspendCurrent!=='boolean')fail();
  const initiating=context.getStore(),resumePhase=phase;if(resumePhase==='exclusive'&&(!initiating||exclusiveOwner?.operation!==initiating||!request.suspendCurrent))fail();if(request.suspendCurrent&&(!initiating||initiating.sql!==0||initiating.ended||initiating.controller.signal.aborted)||!request.suspendCurrent&&initiating)fail();
  // Synchronous admission stop precedes cancellation and the first await.
  phase='parking';if(initiating)initiating.suspended=true;
  const ticket:ParkRequest={mutationId:request.mutationId,launchId:input.launchId,serial:++serial,suspendedOperationId:initiating?.id??null};pending=ticket;
  for(const op of operations.values())if(op!==initiating)op.controller.abort();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   await new Promise<void>((resolve,reject)=>{const settled=()=>{if(phase==='closed'){cleanup();reject(new MemoryCipherError());return;}if(active().length===0&&[...operations.values()].every(op=>op.sql===0)&&noTransactions()){cleanup();resolve();}};const cleanup=()=>{wake.delete(settled);if(timer)clearTimeout(timer);};wake.add(settled);timer=setTimeout(()=>{cleanup();reject(new MemoryCipherError());},timeout);settled();});
   if(phase!=='parking'||pending!==ticket||initiating&&(initiating.ended||operations.get(initiating.id)!==initiating))fail();
   if(validateFrozen!==undefined){
    if(typeof validateFrozen!=='function'||!initiating||!request.suspendCurrent)fail();const retained=exclusiveOwner;exclusiveOwner=retained??{operation:initiating,id:randomUUID()};phase='exclusive';initiating.suspended=false;
    try{if(validateFrozen()!==true||initiating.sql!==0||!noTransactions())fail();}finally{initiating.suspended=true;exclusiveOwner=retained;if(!isClosed())phase='parking';}
   }
   phase='parked';
   let used=false;
   const current=()=>!used&&phase==='parked'&&pending===ticket&&active().length===0&&[...operations.values()].every(op=>op.sql===0)&&noTransactions()&&(!initiating||!initiating.ended&&operations.get(initiating.id)===initiating&&!initiating.controller.signal.aborted);
   return Object.freeze({...ticket,activeOperations:0 as const,activeTransactions:0 as const,isCurrent:current,
    resume(){if(!current())fail();used=true;pending=undefined;if(initiating)initiating.suspended=false;phase=resumePhase;notify();},
    fail(){if(used)return;used=true;poison();},
   });
  }catch{poison();fail();}
 }
 /** Retain a native synchronous iterator until its actual cursor closes, including operation cleanup. */
 function trackIterator(closeCursor:()=>void){
  const op=check();if(typeof closeCursor!=='function')fail();op.sql++;let released=false;
  const release=()=>{if(released)return;released=true;op.cleanups.delete(cleanup);op.sql--;notify();};
  const cleanup=()=>{const result=closeCursor() as unknown;if(result&&typeof (result as {then?:unknown}).then==='function')fail();release();};
  op.cleanups.add(cleanup);return Object.freeze({isCurrent:()=>!released&&context.getStore()===op&&canExecute(op)&&!op.ended&&!op.suspended&&!op.controller.signal.aborted,release});
 }
 /** Freeze other control writers across native owner review, while the actual initiating operation can provision. */
 async function acquireExclusive(){
  const op=check();if(phase!=='open'||op.sql!==0||exclusiveOwner)fail();phase='parking';op.suspended=true;
  for(const other of operations.values())if(other!==op)other.controller.abort();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   await new Promise<void>((resolve,reject)=>{const ready=()=>{if(phase==='closed'){cleanup();reject(new MemoryCipherError());return;}if(active().length===0&&[...operations.values()].every(entry=>entry.sql===0)&&noTransactions()){cleanup();resolve();}};const cleanup=()=>{wake.delete(ready);if(timer)clearTimeout(timer);};wake.add(ready);timer=setTimeout(()=>{cleanup();reject(new MemoryCipherError());},timeout);ready();});
   if(phase!=='parking'||op.ended||op.controller.signal.aborted||operations.get(op.id)!==op)fail();
   const held={operation:op,id:randomUUID()};exclusiveOwner=held;op.suspended=false;phase='exclusive';let used=false;
   const isCurrent=()=>!used&&exclusiveOwner===held&&phase!=='closed'&&phase!=='open'&&!op.ended&&!op.controller.signal.aborted&&operations.get(op.id)===op;
   return Object.freeze({id:held.id,operationId:op.id,isCurrent,
    release(){if(!isCurrent()||phase!=='exclusive'||op.suspended||op.sql!==0||!noTransactions())fail();used=true;exclusiveOwner=undefined;phase='open';notify();},
    fail(){if(used)return;used=true;poison();},
   });
  }catch{poison();fail();}
 }
 /** A local one-use continuation for an IPC reply arriving outside the initiating async context.
  * Only the request producer receives it; an operation ID from a message cannot reconstruct it. */
 function captureSuspension(){
  const captured=check();if(captured.sql!==0)fail();let consumed=false;
  return Object.freeze({operationId:captured.id,isCurrent:()=>!consumed&&canExecute(captured)&&!captured.ended&&!captured.suspended&&!captured.controller.signal.aborted&&captured.sql===0&&operations.get(captured.id)===captured,
   park(mutationId:string,validateFrozen?:()=>boolean){if(consumed||!canExecute(captured)||captured.ended||captured.sql!==0||captured.controller.signal.aborted||operations.get(captured.id)!==captured)fail();consumed=true;return context.run(captured,()=>park({mutationId,suspendCurrent:true},validateFrozen));},
  });
 }
 return Object.freeze({runner,guardRunner,runOperation,runAuxiliaryOperation,trackIterator,canExecute:()=>{try{check();return true;}catch{return false;}},async runEffect<T>(effect:()=>Promise<T>):Promise<T>{return sql(async()=>{const result=await effect();check();return result;});},park,acquireExclusive,captureSuspension,currentOperationId:()=>context.getStore()?.id??null,status:()=>phase,close(){poison();}});
}
