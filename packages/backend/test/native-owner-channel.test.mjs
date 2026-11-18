/** Deferred synthetic private-channel fixtures; fake physical leases here establish no production authority. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {createNativeMemoryOwnerChannel} from '../src/memory/encryption/native-owner-channel.ts';
import {createSelectedOperationCoordinator} from '../src/memory/encryption/selected-operation-coordinator.ts';
const require=createRequire(import.meta.url),{createMemoryNativeOwnerChannel}=require('../../desktop/src/memory-native-owner-channel.cjs'),W=require('../../identity/src/memory-native-owner-wire.cjs');
const opaque=()=>randomBytes(32).toString('base64url');
function fixture({dropEnded=false}={}){
 let parentLive=true,physical=true,ownerValid=true,poisoned=false,backend,native;const trace=[];
 const coordinator=createSelectedOperationCoordinator({runner:{dialect:'sqlite',inTransaction:()=>false,read:async()=>{throw Error('no synthetic SQL');},tx:async()=>{throw Error('no synthetic SQL');}},launchId:'synthetic-channel-launch',onPoison:()=>{poisoned=true;}});
 const binding={launchId:opaque(),epoch:opaque()};
 const dispatch=(peer,message)=>{const copy=structuredClone(message);queueMicrotask(()=>{void peer().handleMessage(copy).catch(()=>{});});};
 backend=createNativeMemoryOwnerChannel({binding,coordinator,timeoutMs:25,parentIsCurrent:()=>parentLive,send:message=>{trace.push('node:'+message.kind);dispatch(()=>native,message);},captureControlFence:async()=>({storageId:'synthetic-physical-exclusive-storage',isCurrent:()=>physical}),captureOwnerContext:async()=>({ownerId:'synthetic-owner',sessionId:'synthetic-session',isCurrent:()=>ownerValid,validateCurrent:async()=>ownerValid&&physical}),nodeHandlers:{},onProofRevoked:()=>{},onPoison:()=>{poisoned=true;parentLive=false;}});
 native=createMemoryNativeOwnerChannel({binding,timeoutMs:25,childIsCurrent:()=>parentLive,send:message=>{trace.push('native:'+message.kind);if(dropEnded&&message.kind==='ended')return;dispatch(()=>backend,message);},stopChild:async()=>{parentLive=false;},producers:{handlers:{}},serviceFactory:channel=>({profiles:async()=>{assert.equal(await channel.getOwnerFrame().validateCurrent(),true);assert.equal(coordinator.status(),'exclusive');return [];},close:async()=>{}})});
 return {backend,native,coordinator,trace,revoke:()=>{ownerValid=false;},losePhysical:()=>{physical=false;},get poisoned(){return poisoned;},async close(){await backend.close();await native.close();}};
}
test('native terminal ACK precedes release of the actual initiating coordinator exclusive frame',async()=>{const f=fixture();try{await f.coordinator.runOperation(async()=>{assert.deepEqual(await f.backend.request('profiles',{}),[]);assert.equal(f.coordinator.status(),'open');});assert.ok(f.trace.indexOf('native:ended')>f.trace.indexOf('node:end'));assert.equal(f.poisoned,false);}finally{await f.close();}});
test('missing terminal ACK poisons rather than releasing writers automatically',async()=>{const f=fixture({dropEnded:true});try{await assert.rejects(f.coordinator.runOperation(()=>f.backend.request('profiles',{})));assert.equal(f.coordinator.status(),'closed');assert.equal(f.poisoned,true);}finally{await f.close();}});
test('a physical control fence loss refuses before any native owner operation',async()=>{const f=fixture();try{f.losePhysical();await assert.rejects(f.coordinator.runOperation(()=>f.backend.request('profiles',{})));assert.equal(f.coordinator.status(),'closed');assert.equal(f.trace.includes('node:call'),false);}finally{await f.close();}});
test('closed private schema refuses remote SQL, callback names, and injected handles',()=>{const common={v:1,type:'memory-owner-channel',binding:{launchId:opaque(),epoch:opaque()},frameId:opaque(),id:opaque(),kind:'inner',direction:'node',input:{}};assert.throws(()=>W.parse({...common,method:'executeSQL'}));assert.throws(()=>W.parse({...common,method:'challenge/readback',callback:'isCurrent'}));assert.throws(()=>W.handle({kind:'owner',handle:opaque(),metadata:{isCurrent:()=>true}}));});
test('private key byte transfer buffers can be explicitly zeroed without retaining base64 secrets',()=>{const source={keyBytes:Array(32).fill(7)},copy=W.data(source);W.wipeKeyBytes(source);assert.deepEqual(source.keyBytes,Array(32).fill(0));assert.deepEqual(copy.keyBytes,Array(32).fill(7));W.wipeKeyBytes(copy);assert.deepEqual(copy.keyBytes,Array(32).fill(0));});
test('foundation bootstrap has no owner/session authority and cannot carry an owner claim',()=>{
 const packet={v:1,type:'memory-owner-channel',binding:{launchId:opaque(),epoch:opaque()},frameId:opaque(),id:opaque(),kind:'open',owner:null,mode:'foundation',profileId:'synthetic-owned-profile',foundation:{controlStorageId:'synthetic-control',operationId:'synthetic-operation'}};
 assert.equal(W.parse(packet).owner,null);
 assert.throws(()=>W.parse({...packet,owner:{ownerId:'forged-owner',sessionId:'forged-session',controlStorageId:'synthetic-control',operationId:'synthetic-operation'}}));
 assert.throws(()=>W.parse({...packet,foundation:{...packet.foundation,current:true}}));
});
test('presence proof metadata can cross the private channel but executable proof predicates cannot',()=>{
 const common={kind:'challenge',handle:opaque(),metadata:{role:'memory-presence-proof',profileId:'synthetic-profile',presence:{v:1,ownerId:'synthetic-owner',tables:[],sha256:'0'.repeat(64)},mutationAdmission:{purpose:'memory-profile-write',operationId:'synthetic-operation'}}};
 assert.equal(W.handle(common).metadata.role,'memory-presence-proof');
 assert.throws(()=>W.handle({...common,metadata:{...common.metadata,isCurrent:()=>true}}));
});
