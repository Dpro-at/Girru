'use strict';
/** Deferred synthetic protocol fixtures. They do not establish OS custody or production writer ownership. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const C=require('../../identity/src/memory-native-proof.cjs');
const {createMemoryNativeProofRegistry}=require('../src/memory-native-proof-registry.cjs');
const id=()=>crypto.randomBytes(32).toString('base64url');
function fixture(t,{enrollment=false,auxiliary=false,overrides={}}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'memory-native-proof-'))),dirs=Object.fromEntries(['profile','journal','backup','capsules','native'].map(n=>[n,path.join(root,n)]));for(const d of Object.values(dirs))fs.mkdirSync(d,{mode:0o700});
 const binding={launchId:id(),childEpoch:id(),profileId:'synthetic-profile',storageId:'synthetic-sqlite-connection',journalStorageId:'synthetic-journal-connection'};
 const a={v:1,ownerId:'synthetic-owner',memberId:'synthetic-member',authorityId:'synthetic-authority',keyId:'synthetic-key',epoch:1,forgetSequence:0,forgetMac:'0'.repeat(64)};
 const state={owned:true,parked:false,grant:true,values:{genesis:{...a},restore:{...a},audit:{ownerId:a.ownerId,sequence:0,mac:id()},graph:{profileId:binding.profileId,anchor:{...a,bundleId:null,sha256:null,parts:0,generation:1},pending:null}}};
 if(auxiliary)state.values.auxiliary={purpose:'memory-auxiliary',profileId:binding.profileId,anchor:{...a,bundleId:null,sha256:null,parts:0,generation:1},pending:null};
 const cipherFiles=['master','trust','witness','graph-root',...(auxiliary?['auxiliary-root','auxiliary-witness']:[])].map(name=>({id:name,path:path.join(dirs.native,name+'.cipher'),maxBytes:4096,optional:enrollment}));
 for(const file of cipherFiles)if(!enrollment||file.id==='master')fs.writeFileSync(file.path,'synthetic encrypted '+file.id,{mode:0o600});
 const options={binding,profileLease:{profileId:binding.profileId,storageId:binding.storageId,isCurrent:()=>state.owned},capsuleDirectory:dirs.capsules,cipherFiles,enrollmentDirectories:[{id:'profile-root',path:dirs.profile},{id:'journal-root',path:dirs.journal}],excludedRoots:[dirs.profile,dirs.journal,dirs.backup],
  async captureNativeState(){return Object.fromEntries(Object.entries(state.values).map(([f,v])=>{const value=JSON.parse(JSON.stringify(v));return[f,{value,isCurrent:()=>state.owned&&C.canonical(state.values[f])===C.canonical(value)}];}));},
  async parkIngress(event){state.parked=true;return {operationId:event.operationId,isCurrent:()=>state.owned&&state.parked,release(){state.parked=false;}};},
  async publishInvalidation(event){const cap=C.openSigned(C.readProtectedFile(path.join(dirs.capsules,'capsule.json'),C.MAX_WIRE).bytes,Buffer.from(boot.macKey,'base64url'),C.capsule);assert.equal(cap.state,'blocked');assert.equal(cap.serial,event.serial);assert.equal(state.parked,true);},
  async drainChild(event){const {changedFields,...rest}=event;return C.ack({...rest,type:'memory-proof-drained',suspendedOperationId:event.operationId,activeOperations:0,openTransactions:0});},
  async resumeChild(event){return C.resumed({...event,type:'memory-proof-resumed'});},...overrides};
 const registry=createMemoryNativeProofRegistry(options);let boot;
 t.after(async()=>{await registry.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,dirs,binding,state,options,registry,async start(){boot=await registry.initialize();return boot;},setBoot(v){boot=v;},get boot(){return boot;},rewrite(name,suffix){const file=cipherFiles.find(f=>f.id===name);fs.writeFileSync(file.path,'synthetic encrypted '+name+suffix,{mode:0o600});}};
}
function leaseCurrent(boot,descriptor){try{const key=Buffer.from(boot.macKey,'base64url'),cap=C.openSigned(C.readProtectedFile(boot.capsulePath,C.MAX_WIRE).bytes,key,C.capsule),proofBytes=C.readProtectedFile(boot.proofPath,C.MAX_WIRE).bytes,proof=C.openSigned(proofBytes,key,C.proof);return cap.state==='active'&&C.digest(proofBytes)===cap.proofHash&&C.canonical(proof.fingerprints)===C.canonical(C.fingerprintNativeFiles(boot.cipherFiles))&&Object.entries(descriptor.fields).every(([f,v])=>C.canonical(v)===C.canonical(cap.fields[f]));}catch{return false;}}
test('missing native/ingress/drain producer is unsupported, and SQLite paths cannot be fingerprint inputs',async t=>{
 assert.throws(()=>createMemoryNativeProofRegistry({}),/unsupported/);const f=fixture(t);const bad={...f.options,cipherFiles:[{id:'trust',path:path.join(f.dirs.profile,'source.sqlite'),maxBytes:4096,optional:false}]};assert.throws(()=>createMemoryNativeProofRegistry(bad),/unavailable/);
});
test('audit-only persistence refreshes aggregate fingerprints without invalidating an unchanged authority lease',async t=>{
 const f=fixture(t);await f.start();const prior=await f.registry.capture(['restore'],'audit-read');
 const ticket=await f.registry.beginMutation({operationId:'audit-read',changedFields:['audit']});assert.equal(ticket.isCurrent(),true);assert.equal(leaseCurrent(f.boot,prior.descriptor),false);
 f.state.values.audit={...f.state.values.audit,sequence:1,mac:id()};f.rewrite('trust',' audit-one');f.rewrite('witness',' audit-one');await ticket.complete();
 assert.equal(leaseCurrent(f.boot,prior.descriptor),true);const renewed=await f.registry.fresh(prior.descriptor.handle,'audit-read');assert.deepEqual(renewed.descriptor.fields.restore,prior.descriptor.fields.restore);
});
test('blocked capsule is visible to synchronous checks before JS invalidation delivery or ACK',async t=>{
 let release,published;const f=fixture(t,{overrides:{publishInvalidation:async event=>{published=event;},drainChild:()=>new Promise(resolve=>release=resolve)}});await f.start();const held=await f.registry.capture(['restore'],'busy-sqlite');const pending=f.registry.beginMutation({operationId:'busy-sqlite',changedFields:['restore']});
 while(!published)await new Promise(resolve=>setImmediate(resolve));assert.equal(leaseCurrent(f.boot,held.descriptor),false,'sync transaction boundary sees blocked file even without an event-loop ACK');
 const {changedFields,...event}=published;release(C.ack({...event,type:'memory-proof-drained',suspendedOperationId:event.operationId,activeOperations:0,openTransactions:0}));const ticket=await pending;await ticket.fail();assert.equal(f.registry.status().state,'poisoned');
});
test('ciphertext tampering and loss of actual ownership fail closed',async t=>{
 const f=fixture(t);await f.start();const held=await f.registry.capture(['restore'],'tamper');f.rewrite('trust',' outside-edit');assert.equal(leaseCurrent(f.boot,held.descriptor),false);await assert.rejects(()=>f.registry.fresh(held.descriptor.handle,'tamper'));assert.equal(f.registry.status().state,'poisoned');
});
test('revoked owner lease poisons current capsule before another proof can be issued',async t=>{
 const f=fixture(t);await f.start();const held=await f.registry.capture(['restore'],'revoke');f.state.owned=false;await assert.rejects(()=>f.registry.fresh(held.descriptor.handle,'revoke'));assert.equal(leaseCurrent(f.boot,held.descriptor),false);
});
test('graph pending requires genuine local preaudited preflight and revokes the prior graph lease',async t=>{
 const f=fixture(t);await f.start();const graph=await f.registry.capture(['graph','restore'],'graph-change'),authorityHash=graph.descriptor.fields.restore.valueHash,graphHash=graph.descriptor.fields.graph.valueHash;
 assert.throws(()=>f.registry.registerGraphPreflight({verified:true}),/unsupported/);
 const permit=f.registry.registerGraphPreflight({operationId:'graph-change',readPermitId:id(),challengeId:id(),authorityValueHash:authorityHash,graphValueHash:graphHash,expiresAt:Date.now()+10000,isCurrent:()=>f.state.owned,release(){}});
 const ticket=await f.registry.beginMutation({operationId:'graph-change',changedFields:['graph'],graphPermitId:permit});const prior={...f.state.values.graph.anchor},next={...prior,generation:2};f.state.values.graph={...f.state.values.graph,pending:{id:crypto.randomUUID(),prior,next}};f.rewrite('graph-root',' pending');await ticket.complete();assert.equal(leaseCurrent(f.boot,graph.descriptor),false);await assert.rejects(()=>f.registry.fresh(graph.descriptor.handle,'graph-change'));
});
test('expired proof and invalid drain ACK never become a default-true proof',async t=>{
 const now=Date.now;let clock=100000;Date.now=()=>clock;
 try{const f=fixture(t,{overrides:{leaseMs:10}});await f.start();const held=await f.registry.capture(['restore'],'expires');clock+=11;await assert.rejects(()=>f.registry.fresh(held.descriptor.handle,'expires'));}finally{Date.now=now;}
});
test('non-drained transaction or missing graph permit refuses rather than deadlocking or mutating',async t=>{
 const f=fixture(t,{overrides:{drainChild:async()=>({verified:true})}});await f.start();await assert.rejects(()=>f.registry.beginMutation({operationId:'no-ack',changedFields:['audit']}));assert.equal(f.registry.status().state,'poisoned');
});
test('explicit enrollment starts blocked and activates only after actual native trust/witness publication',{skip:process.platform==='win32'&&'POSIX-only path (directory fsync, uid, links); Girru takes its Windows path there'},async t=>{
 const f=fixture(t,{enrollment:true});delete f.state.values.graph;const grant={purpose:'memory-native-enrollment',binding:f.binding,grantId:id(),operationId:'explicit-enroll',expiresAt:Date.now()+10000,isCurrent:()=>f.state.grant&&f.state.owned,release(){f.state.grant=false;}};
 const boot=await f.registry.initializeEnrollment(grant);f.setBoot(boot);await assert.rejects(()=>f.registry.capture(['restore'],'explicit-enroll'));const only=await f.registry.captureEnrollmentProfile('explicit-enroll');assert.deepEqual(Object.keys(only.descriptor.fields),['profile']);assert.deepEqual(Object.keys(only.values),['profile']);await assert.rejects(()=>f.registry.captureEnrollmentProfile('wrong-frame'));
 const ticket=await f.registry.beginEnrollmentPersistence({operationId:grant.operationId,grantId:grant.grantId});f.rewrite('trust',' enrolled');f.rewrite('witness',' enrolled');await ticket.complete();assert.equal(f.registry.status().state,'active');assert.ok((await f.registry.capture(['restore'],'after-enroll')).values.restore);
});

test('auxiliary root has distinct purpose, files, generation and preaudited permit from graph',async t=>{
 const f=fixture(t,{auxiliary:true});await f.start();const graph=await f.registry.capture(['graph'],'auxiliary-change'),aux=await f.registry.capture(['auxiliary','restore'],'auxiliary-change');
 assert.equal(aux.values.auxiliary.purpose,'memory-auxiliary');assert.notEqual(aux.descriptor.fields.auxiliary.valueHash,graph.descriptor.fields.graph.valueHash);
 const permit=f.registry.registerAuxiliaryPreflight({operationId:'auxiliary-change',readPermitId:id(),challengeId:id(),authorityValueHash:aux.descriptor.fields.restore.valueHash,auxiliaryValueHash:aux.descriptor.fields.auxiliary.valueHash,expiresAt:Date.now()+10000,isCurrent:()=>f.state.owned,release(){}});
 const ticket=await f.registry.beginMutation({operationId:'auxiliary-change',changedFields:['auxiliary'],auxiliaryPermitId:permit});const prior={...f.state.values.auxiliary.anchor};f.state.values.auxiliary={...f.state.values.auxiliary,pending:{id:crypto.randomUUID(),prior,next:{...prior,generation:2}}};f.rewrite('auxiliary-root',' pending');f.rewrite('auxiliary-witness',' pending');await ticket.complete();
 assert.equal(leaseCurrent(f.boot,aux.descriptor),false);assert.equal(leaseCurrent(f.boot,graph.descriptor),true);
});
test('a graph permit cannot authorize an auxiliary mutation and a missing verifier cannot be a true proof',async t=>{
 const f=fixture(t,{auxiliary:true});await f.start();const held=await f.registry.capture(['graph','restore'],'cross-purpose');
 const graphPermit=f.registry.registerGraphPreflight({operationId:'cross-purpose',readPermitId:id(),challengeId:id(),authorityValueHash:held.descriptor.fields.restore.valueHash,graphValueHash:held.descriptor.fields.graph.valueHash,expiresAt:Date.now()+10000,isCurrent:()=>f.state.owned,release(){}});
 await assert.rejects(()=>f.registry.beginMutation({operationId:'cross-purpose',changedFields:['auxiliary'],auxiliaryPermitId:graphPermit}));assert.equal(f.registry.status().state,'poisoned');
});
test('blocked native capsule is observed by a worker busy in synchronous JavaScript without an invalidation handler',{skip:process.platform==='win32'&&'POSIX-only path (directory fsync, uid, links); Girru takes its Windows path there'},async t=>{
 const {Worker}=require('node:worker_threads');const f=fixture(t);await f.start();const held=await f.registry.capture(['restore'],'worker-busy');
 const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');const C=require(workerData.codec),key=Buffer.from(workerData.boot.macKey,'base64url');parentPort.postMessage('ready');const until=Date.now()+5000;while(Date.now()<until){let blocked=false;try{const c=C.openSigned(C.readProtectedFile(workerData.boot.capsulePath,C.MAX_WIRE).bytes,key,C.capsule);blocked=c.state!=='active';}catch{blocked=true;}if(blocked){parentPort.postMessage('blocked');break;}}`,{eval:true,workerData:{codec:require.resolve('../../identity/src/memory-native-proof.cjs'),boot:f.boot}});
 t.after(()=>worker.terminate());await new Promise((resolve,reject)=>{worker.once('message',message=>message==='ready'?resolve():reject(Error('unexpected worker state')));worker.once('error',reject);});
 const observed=new Promise((resolve,reject)=>{worker.once('message',message=>message==='blocked'?resolve():reject(Error('worker missed blocked capsule')));worker.once('error',reject);worker.once('exit',()=>reject(Error('worker ended before observing the blocked boundary')));});
 const ticket=await f.registry.beginMutation({operationId:'worker-busy',changedFields:['restore']});await observed;assert.equal(leaseCurrent(f.boot,held.descriptor),false);await ticket.fail();
});

test('a verifier/drain request that never returns has a bounded fail-closed timeout, not a reentrant wait forever',async t=>{
 const f=fixture(t,{overrides:{timeoutMs:10,drainChild:()=>new Promise(()=>{})}});await f.start();await assert.rejects(()=>f.registry.beginMutation({operationId:'never-ack',changedFields:['audit']}));assert.equal(f.registry.status().state,'poisoned');
});

test('enrollment profile checks real directory identities and cannot issue authority or key proof',{skip:process.platform==='win32'&&'POSIX-only path (directory fsync, uid, links); Girru takes its Windows path there'},async t=>{const f=fixture(t,{enrollment:true});delete f.state.values.graph;const grant={purpose:'memory-native-enrollment',binding:f.binding,grantId:id(),operationId:'directory-enroll',expiresAt:Date.now()+10000,isCurrent:()=>f.state.grant&&f.state.owned,release(){}};const boot=await f.registry.initializeEnrollment(grant);f.setBoot(boot);const only=await f.registry.captureEnrollmentProfile(grant.operationId);assert.deepEqual(Object.keys(only.values),['profile']);fs.renameSync(f.dirs.profile,f.dirs.profile+'-old');fs.mkdirSync(f.dirs.profile,{mode:0o700});await assert.rejects(()=>f.registry.captureEnrollmentProfile(grant.operationId));assert.throws(()=>C.request({v:1,type:'memory-proof-request',binding:f.binding,requestId:id(),operation:'enrollment-profile',operationId:grant.operationId,fields:['restore']}));});
