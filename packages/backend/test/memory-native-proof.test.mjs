/** Deferred synthetic transport fixtures: no native OS custody or real-profile acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {createMemoryNativeProofClient} from '../src/memory/encryption/native-proof-client.ts';
const require=createRequire(import.meta.url),C=require('../../identity/src/memory-native-proof.cjs'),{createMemoryNativeProofRegistry}=require('../../desktop/src/memory-native-proof-registry.cjs');
const opaque=()=>crypto.randomBytes(32).toString('base64url');
async function connected(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'memory-proof-client-')));const native=path.join(root,'native'),capsules=path.join(root,'capsules'),profile=path.join(root,'profile'),journal=path.join(root,'journal');for(const p of [native,capsules,profile,journal])fs.mkdirSync(p,{mode:0o700});
 const binding={launchId:opaque(),childEpoch:opaque(),profileId:'synthetic-profile',storageId:'synthetic-owned-sqlite',journalStorageId:'synthetic-owned-journal'};
 const anchor={v:1,ownerId:'synthetic-owner',memberId:'synthetic-member',authorityId:'synthetic-authority',keyId:'synthetic-key',epoch:1,forgetSequence:0,forgetMac:'0'.repeat(64)};
 const state={owned:true,currentOperation:null,parked:false,suspended:null,openTransactions:0,revoked:[],trace:[],values:{genesis:{...anchor},restore:{...anchor},audit:{ownerId:anchor.ownerId,sequence:0,mac:opaque()},graph:{profileId:binding.profileId,anchor:{...anchor,bundleId:null,sha256:null,parts:0,generation:1},pending:null}}};
 const files=['master','trust','witness','graph-root'].map(id=>({id,path:path.join(native,id+'.cipher'),maxBytes:8192,optional:false}));for(const f of files)fs.writeFileSync(f.path,'synthetic ciphertext '+f.id,{mode:0o600});
 let client,draining;
 const registry=createMemoryNativeProofRegistry({binding,profileLease:{profileId:binding.profileId,storageId:binding.storageId,isCurrent:()=>state.owned},capsuleDirectory:capsules,cipherFiles:files,excludedRoots:[profile,journal],
  async captureNativeState(){return Object.fromEntries(Object.entries(state.values).map(([field,value])=>{const captured=JSON.parse(JSON.stringify(value));return[field,{value:captured,isCurrent:()=>state.owned&&C.canonical(captured)===C.canonical(state.values[field])}];}));},
  async parkIngress(event){
   assert.equal(event.operationId,state.currentOperation,'actual pending operation, not a message-invented ID');assert.equal(state.openTransactions,0);state.trace.push('prepark');state.parked=true;state.suspended=state.currentOperation;
   // A native hold is distinct from the one-use child coordinator ticket.
   let released=false;return{operationId:state.currentOperation,isCurrent:()=>!released&&state.owned,release(){released=true;state.trace.push('native-hold-released');}};
  },
  async publishInvalidation(event){state.trace.push('invalidate');draining=client.handleInvalidation(event);},
  async drainChild(){return draining;},
  async resumeChild(event){return client.handleResume(event);},
 });
 const bootstrap=await registry.initialize();
 client=createMemoryNativeProofClient({bootstrap,
  async requestFresh(request){state.currentOperation=request.operationId;return registry.handleRequest(request);},
  async parkIngress(event){assert.equal(state.parked,true,'native prepark completed before blocked publication');assert.equal(event.operationId,state.suspended);return{operationId:state.suspended,isCurrent:()=>state.parked&&state.owned,release(){state.parked=false;state.suspended=null;}};},
  async drainOperations(event,ticket){assert.equal(ticket.isCurrent(),true);state.trace.push('drained');return{suspendedOperationId:state.suspended,activeOperations:0,openTransactions:state.openTransactions};},
  async resumeIngress(event,ticket){state.trace.push('child-resumed');await ticket.release();},
  onRevoke(fields){state.revoked.push(...fields);},
 });
 t.after(async()=>{client.close();await registry.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,native,files,state,binding,registry,client,bootstrap,rewrite(id,suffix){fs.writeFileSync(files.find(f=>f.id===id).path,'synthetic ciphertext '+id+suffix,{mode:0o600});}};
}

test('client requires actual transport/park/drain/revoke producers; no default true path',()=>{
 assert.throws(()=>createMemoryNativeProofClient({}),/unsupported/);
});
test('actual normalized values are bound to a native field hash, not a boolean verified claim',async t=>{
 const h=await connected(t);const lease=await h.client.capture(['restore'],'read-one');assert.equal(lease.isCurrent(),true);assert.equal(lease.values.restore.ownerId,'synthetic-owner');
 assert.throws(()=>C.response({v:1,type:'memory-proof-response',requestId:opaque(),descriptor:lease.descriptor,values:{profile:lease.values.profile,restore:{...lease.values.restore,keyId:'forged'}}}),/unavailable/);
 await assert.rejects(()=>h.registry.handleRequest({v:1,type:'memory-proof-request',binding:h.binding,requestId:opaque(),operation:'registerGraphPreflight',operationId:'read-one',handle:lease.descriptor.handle}));
});
test('unchanged restore lease survives audited aggregate-file refresh; prepark precedes invalidation and resume',async t=>{
 const h=await connected(t),lease=await h.client.capture(['restore'],'audit-op');
 const ticket=await h.registry.beginMutation({operationId:'audit-op',changedFields:['audit']});assert.equal(lease.isCurrent(),false,'blocked while initiating operation suspended');
 h.state.values.audit={...h.state.values.audit,sequence:1,mac:opaque()};h.rewrite('trust',' audit-next');h.rewrite('witness',' audit-next');await ticket.complete();
 assert.equal(lease.isCurrent(),true);assert.equal(h.state.revoked.includes('restore'),false);assert.deepEqual(h.state.trace,['prepark','invalidate','drained','child-resumed','native-hold-released']);
 const fresh=await h.client.fresh(lease,'audit-op');assert.equal(fresh.isCurrent(),true);assert.deepEqual(fresh.descriptor.fields.restore,lease.descriptor.fields.restore);
});
test('changed authority invalidates the old lease; cipher tamper is not repaired by a fresh RPC',async t=>{
 const h=await connected(t),lease=await h.client.capture(['restore'],'forget-op');const ticket=await h.registry.beginMutation({operationId:'forget-op',changedFields:['restore']});
 h.state.values.restore={...h.state.values.restore,forgetSequence:1,forgetMac:'1'.repeat(64)};h.rewrite('trust',' forgotten');h.rewrite('witness',' forgotten');await ticket.complete();assert.equal(lease.isCurrent(),false);assert.ok(h.state.revoked.includes('restore'));
 const next=await h.client.capture(['restore'],'next-read');h.rewrite('trust',' outside-tamper');assert.equal(next.isCurrent(),false);await assert.rejects(()=>h.client.fresh(next,'next-read'));
});
test('wrong launch, replayed invalidation, or nonzero transaction ACK fail closed',async t=>{
 const h=await connected(t);await h.client.capture(['restore'],'busy-op');h.state.openTransactions=1;
 await assert.rejects(()=>h.registry.beginMutation({operationId:'busy-op',changedFields:['audit']}));assert.notEqual(h.registry.status().state,'active');
 const forged={v:1,type:'memory-proof-invalidate',binding:{...h.binding,childEpoch:opaque()},mutationId:opaque(),operationId:'busy-op',serial:2,changedFields:['audit'],nonce:opaque()};await assert.rejects(()=>h.client.handleInvalidation(forged));
});
test('expired field lease refuses even when its native capsule bytes have not changed',async t=>{
 const h=await connected(t),lease=await h.client.capture(['restore'],'expiry-op'),now=Date.now;Date.now=()=>lease.descriptor.expiresAt+1;
 try{assert.equal(lease.isCurrent(),false);await assert.rejects(()=>h.client.fresh(lease,'expiry-op'));}finally{Date.now=now;}
});
test('missing graph read permit refuses before any graph persistence effect',async t=>{
 const h=await connected(t);await h.client.capture(['graph','restore'],'graph-no-permit');await assert.rejects(()=>h.registry.beginMutation({operationId:'graph-no-permit',changedFields:['graph']}));assert.notEqual(h.registry.status().state,'active');
});

test('foundation is renewed by a new actual operation and new handle without extending an old ordinary lease',async t=>{
 const h=await connected(t),foundation=await h.client.captureFoundation(['genesis'],'startup-op'),ordinary=await h.client.capture(['genesis'],'startup-op'),oldHandle=foundation.descriptor.handle,now=Date.now;
 Date.now=()=>ordinary.descriptor.expiresAt+1;
 try{assert.equal(foundation.isCurrent(),false);await h.client.refreshFoundations('new-authenticated-operation');assert.equal(foundation.isCurrent(),true);assert.notEqual(foundation.descriptor.handle,oldHandle);assert.equal(foundation.descriptor.operationId,'new-authenticated-operation');assert.equal(ordinary.isCurrent(),false);await assert.rejects(()=>h.client.fresh(ordinary,'new-authenticated-operation'));}
 finally{Date.now=now;}
});
test('auxiliary metadata cannot masquerade as graph and has no implicit key-read approval',()=>{
 const a={v:1,ownerId:'owner',memberId:'member',authorityId:'authority',keyId:'key',epoch:1,forgetSequence:0,forgetMac:'0'.repeat(64),bundleId:null,sha256:null,parts:0,generation:1};
 const auxiliary=C.value('auxiliary',{purpose:'memory-auxiliary',profileId:'profile',anchor:a,pending:null});assert.equal(auxiliary.purpose,'memory-auxiliary');
 assert.throws(()=>C.value('auxiliary',{purpose:'memory-graph',profileId:'profile',anchor:a,pending:null}),/unavailable/);assert.throws(()=>C.value('graph',auxiliary),/unavailable/);
});
