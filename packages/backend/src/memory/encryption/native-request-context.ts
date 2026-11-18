/** Actual Fastify lifecycle admission before authentication; JWTs remain private in this control Node. */
import {AsyncLocalStorage} from 'node:async_hooks';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {withMemoryCodingAppReadOrigin} from './read-origin-context.js';
import {MemoryCipherError} from './envelope.js';
type Operation={id:string;signal:AbortSignal;isCurrent:()=>boolean};
type Physical={storageId:string;isCurrent:()=>boolean};
type State={request:FastifyRequest;operation:Operation;physical:Physical;active:boolean;finish:()=>void};
export function createNativeRequestContext(input:{authRunner:StepRunner;coordinator:{currentOperationId:()=>string|null;runOperation:<T>(operation:(lease:Operation)=>Promise<T>)=>Promise<T>;close:()=>void};captureControlFence:()=>Promise<Physical>;refreshBeforeAuthentication:(request:FastifyRequest,operation:Operation)=>Promise<void>}){
 if(!input?.authRunner||input.authRunner.dialect!=='sqlite'||typeof input.authRunner.readSync!=='function'||typeof input.captureControlFence!=='function'||typeof input.refreshBeforeAuthentication!=='function'||typeof input.coordinator?.runOperation!=='function'||typeof input.coordinator?.close!=='function')throw new MemoryCipherError();
 const scope=new AsyncLocalStorage<State>(),requests=new WeakMap<FastifyRequest,State>(),held=new Set<State>();let registered=false,closed=false;
 const active=()=>{const state=scope.getStore();if(!state||closed||!state.active||state.operation.signal.aborted||!state.operation.isCurrent()||!state.physical.isCurrent()||input.coordinator.currentOperationId()!==state.operation.id)throw new MemoryCipherError();return state;};
 function currentRequestAuthority(){try{const state=active(),user=state.request.authUser,actor=state.request.actor,authorization=state.request.headers.authorization;if(!user||user.role!=='owner'||!actor||actor.kind!=='user'||actor.userId!==user.id||typeof authorization!=='string')return null;const match=/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization);if(!match)return null;const token=match[1];
  const current=()=>{try{if(active()!==state)return false;const owner=input.authRunner.readSync!(authenticatedMemoryOwnerStep(token));return owner.ownerId===user.id&&Date.now()<owner.validUntil;}catch{return false;}};
  if(!current())return null;return Object.freeze({ownerId:user.id,token,isCurrent:current});
 }catch{return null;}}
 return Object.freeze({currentRequestAuthority,captureRequestAuthority:async()=>{const current=currentRequestAuthority();if(!current)throw new MemoryCipherError();return current;},
  currentOperation(){const state=active();return Object.freeze({operationId:state.operation.id,controlStorageId:state.physical.storageId,isCurrent:()=>{try{return active()===state;}catch{return false;}}});},
  currentRequest(){return active().request;},
  register(app:FastifyInstance){if(registered||closed)throw new MemoryCipherError();registered=true;
   // Must be installed after the launch-token guard, before auth/status/runtime hooks.
   app.addHook('onRequest',(request,reply,done)=>{
    let handedOff=false;
    void input.coordinator.runOperation(async operation=>{
     const physical=await input.captureControlFence();if(!physical?.isCurrent()||typeof physical.storageId!=='string'||!operation.isCurrent())throw new MemoryCipherError();
     let finish!:()=>void;const completion=new Promise<void>(resolve=>{finish=resolve;}),state:State={request,operation,physical,active:true,finish};requests.set(request,state);held.add(state);
     const ended=()=>{state.active=false;state.finish();};reply.raw.once('finish',ended);reply.raw.once('close',ended);
     try{return await scope.run(state,()=>{const admitted=async()=>{await input.refreshBeforeAuthentication(request,operation);if(!state.active||!operation.isCurrent()||operation.signal.aborted||!physical.isCurrent())throw new MemoryCipherError();handedOff=true;done();await completion;};return request.headers['x-girru-memory-reader']==='coding-app'?withMemoryCodingAppReadOrigin(admitted):admitted();});}
     finally{state.active=false;reply.raw.off('finish',ended);reply.raw.off('close',ended);requests.delete(request);held.delete(state);}
    }).catch(()=>{if(!handedOff)done(new MemoryCipherError());else if(!reply.raw.writableEnded)reply.raw.destroy();});
   });
   app.addHook('onResponse',async request=>{requests.get(request)?.finish();});
   app.addHook('onClose',async()=>{closed=true;for(const state of held){state.active=false;state.finish();}input.coordinator.close();});
  },
  close(){closed=true;for(const state of held){state.active=false;state.finish();}input.coordinator.close();},
 });
}
