import {bumpAccessVersionStep} from '../scopes/access.js';
/** Explicit same-process control authority, separate from ciphertext storage. No default DB or copied users. */
import {AsyncLocalStorage} from 'node:async_hooks';
import type {Step,StepRunner} from '../../repositories/sql-steps.js';
import {MemoryCipherError} from './envelope.js';
type Binding={authRunner:StepRunner;isCurrent:()=>boolean};
const active=new AsyncLocalStorage<Binding>(),bindings=new WeakMap<StepRunner,Binding>();
const check=(binding:Binding)=>{let valid=false;try{valid=binding.isCurrent()===true;}catch{}if(!valid)throw new MemoryCipherError();};
/** Only trusted host code supplies this lease; it must freeze all real control writers before revocation ACK. */
export function bindMemoryControlRunner(dataRunner:StepRunner,authRunner:StepRunner,isCurrent:()=>boolean):StepRunner{
 if(!dataRunner||!authRunner||typeof isCurrent!=='function'||dataRunner===authRunner||bindings.has(dataRunner)||dataRunner.dialect!=='sqlite'||authRunner.dialect!=='sqlite'||typeof authRunner.readSync!=='function')throw new MemoryCipherError();const binding={authRunner,isCurrent};check(binding);
 const scoped=<T>(operation:()=>Promise<T>)=>active.run(binding,async()=>{check(binding);const result=await operation();check(binding);return result;});
 const runner:StepRunner={dialect:dataRunner.dialect,inTransaction:()=>dataRunner.inTransaction?.()??true,read:step=>scoped(()=>dataRunner.read(step)),tx:(body,options)=>scoped(()=>dataRunner.tx(body,options))};bindings.set(runner,binding);return runner;
}
/** Async revision checkpoints use the same explicit control connection and validate the native lease around awaits. */
export async function readMemoryControlStep<T>(runner:StepRunner,step:Step<T>):Promise<T>{
 const binding=bindings.get(runner);if(!binding)return runner.read(step);check(binding);const value=await binding.authRunner.read(step);check(binding);return value;
}
export function hasMemoryControlBinding(runner:StepRunner):boolean{return bindings.has(runner);}
/** Fixed control-domain query, including a legitimate missing-row result, within a data transaction. */
export function* memoryControlQuery<T>(step:()=>Step<T>):Step<T>{const binding=active.getStore();if(!binding)return yield* step();check(binding);if(!binding.authRunner.readSync)throw new MemoryCipherError();const value=binding.authRunner.readSync(step());check(binding);return value;}


/** A fixed control mutation under the actual guarded authority connection; no caller SQL crosses this boundary. */
export async function bumpMemoryControlAccessVersion(runner:StepRunner,ownerId:string):Promise<number>{const binding=bindings.get(runner);if(!binding)return runner.tx(()=>bumpAccessVersionStep(ownerId),{immediate:true});check(binding);const version=await binding.authRunner.tx(()=>bumpAccessVersionStep(ownerId),{immediate:true});check(binding);return version;}
