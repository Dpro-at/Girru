// Deferred whole-task fixtures; no SQL/profile/model execution.
import test from 'node:test';import assert from 'node:assert/strict';
import {createEncryptedMemoryStorageAdapter} from '../src/memory/encryption/storage-adapter.ts';
const scope={agentId:'synthetic-agent',delegatedFrom:[],drawers:[{kind:'owner'}],project:null,audience:'owner'};
test('storage mutations refuse absent trusted owner intent even if a runtime is ready',async()=>{
 let calls=0;const runtime={status:()=> 'ready',ownerId:'synthetic-owner',async mutateForRun(){calls++;return{};}};
 const storage=createEncryptedMemoryStorageAdapter({runtime,resolveRun:async()=>scope});
 for(const operation of ['trash','restore','forget'])await assert.rejects(storage[operation]('synthetic-memory'));assert.equal(calls,0);
});
test('storage destructive operation retains run scope and requires explicit host authorization',async()=>{
 const calls=[];const runtime={status:()=> 'ready',ownerId:'synthetic-owner',async mutateForRun(request){calls.push(request);return{changed:true};}};
 const storage=createEncryptedMemoryStorageAdapter({runtime,resolveRun:async()=>scope,authorizeMutation:async(operation,id)=>operation==='restore'&&id==='synthetic-memory'});
 await assert.rejects(storage.forget('synthetic-memory'));assert.deepEqual(await storage.restore('synthetic-memory'),{changed:true});assert.deepEqual(calls,[{run:scope,id:'synthetic-memory',operation:'restore'}]);
});
