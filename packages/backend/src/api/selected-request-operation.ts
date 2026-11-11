/** Request admission starts before authentication and spans the complete Fastify response lifecycle. */
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {MemoryCipherError} from '../memory/encryption/envelope.js';
export type SelectedRequestOperation=<T>(operation:()=>Promise<T>)=>Promise<T>;
export function registerSelectedRequestOperations(app:FastifyInstance,runOperation:SelectedRequestOperation){
 if(typeof runOperation!=='function')throw new MemoryCipherError();const active=new WeakMap<FastifyRequest,{finish:()=>void;abort:()=>void}>();
 app.addHook('onRequest',(request,reply,done)=>{let entered=false;void runOperation(async()=>{entered=true;await new Promise<void>((resolve,reject)=>{let complete=false;const settle=(error:boolean)=>{if(complete)return;complete=true;active.delete(request);error?reject(new MemoryCipherError()):resolve();};active.set(request,{finish:()=>settle(false),abort:()=>settle(true)});done();});}).catch(()=>{active.delete(request);if(!reply.sent&&!request.raw.destroyed)void reply.code(409).send({error:'Selected memory operation unavailable',code:'encrypted_memory_unavailable'});else if(!entered&&!request.raw.destroyed)request.raw.destroy();});});
 app.addHook('onResponse',async request=>{active.get(request)?.finish();});
 app.addHook('onRequestAbort',async request=>{active.get(request)?.abort();});
 app.addHook('onTimeout',async request=>{active.get(request)?.abort();});
}
