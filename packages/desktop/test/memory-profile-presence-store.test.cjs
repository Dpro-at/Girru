'use strict';
// Deferred state-machine fixtures: OS protection and independent witness are explicit synthetic providers.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createMemoryProfilePresenceRootStore}=require('../src/memory-profile-presence-store.cjs');
const clone=value=>JSON.parse(JSON.stringify(value)),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'memory-profile-presence-root-'))),directory=path.join(root,'profile-presence'),excludedRoots=['data','backups','trust'].map(name=>path.join(root,name));
 for(const p of [directory,...excludedRoots])fs.mkdirSync(p,{mode:0o700});
 const key=crypto.randomBytes(32),protector={isEncryptionAvailable:()=>true,encryptString(value){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(value),cipher.final(),cipher.getAuthTag()]);},decryptString(value){const cipher=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));cipher.setAuthTag(value.subarray(-16));return Buffer.concat([cipher.update(value.subarray(12,-16)),cipher.final()]).toString();}};
 let witnessHead=null,failWitness=false,live=true,legacyCovered=true,copyReceipt=false;
 let authority={v:1,ownerId:'owner',memberId:'member',authorityId:'authority',keyId:'key',epoch:1,forgetSequence:0,forgetMac:'a'.repeat(64)};
 const history=[],db=new Map(),stores=[];
 const witness={async capture(){if(!witnessHead)return null;const value=clone(witnessHead);return {...value,isCurrent:()=>same(value,witnessHead)};},async compareAndSwap(prior,next){if(failWitness||!same(prior,witnessHead)||next.revision!==(prior?prior.revision+1:1))return false;witnessHead=clone(next);return true;}};
 const options={directory,excludedRoots,ownerId:'owner',protector,witness,async beginPersistence({capturePresenceState}){const prior=capturePresenceState();if(!prior.isCurrent())throw Error('stale persistence proof');let current=true;return {isCurrent:()=>current,async complete(){if(!capturePresenceState().isCurrent())throw Error('stale post-CAS proof');current=false;},async fail(){current=false;}};},platform:process.platform==='win32'?'win32':'darwin',async captureAuthority(){const captured=clone(authority);return {anchor:captured,isCurrent:()=>live&&same(captured,authority)};},async verifyPresenceState(profileId,expected,{phase,currentAuthority}){if(!legacyCovered||!same(db.get(profileId),expected)||!same(authority,currentAuthority))return null;const captured=clone(expected);return {purpose:'memory-profile-presence',profileId,operationId:'actual-operation',anchor:captured,...(phase==='enroll-verified-copy'&&copyReceipt?{copyReceiptId:'verified-copy-receipt'}:{}),isCurrent:()=>live&&legacyCovered&&same(db.get(profileId),captured)&&same(authority,currentAuthority)};},async verifyAuthorityTransition(profileId,from,to){if(!history.some(row=>same(row.from,from)&&same(row.to,to)))return null;return {from:clone(from),to:clone(to),isCurrent:()=>live&&same(authority,to)};}};
 const open=()=>{const store=createMemoryProfilePresenceRootStore(options);stores.push(store);return store;};
 const empty=()=>({...clone(authority),sha256:'b'.repeat(64),tables:20,generation:1});
 const moveAuthority=next=>{history.push({from:clone(authority),to:clone(next)});authority=clone(next);};
 t.after(async()=>{for(const store of stores)await store.close().catch(()=>{});key.fill(0);fs.rmSync(root,{recursive:true,force:true});});
 return {root,directory,options,db,open,empty,moveAuthority,authority:()=>clone(authority),setLive:value=>{live=value;},setLegacy:value=>{legacyCovered=value;},setCopy:value=>{copyReceipt=value;},failWitness:()=>{failWitness=true;}};
}
async function enroll(f){const store=f.open(),initial=f.empty();f.db.set('profile',initial);await store.enrollOwner('profile',async()=>true);await store.enrollProfilePresenceRoot('profile',initial,async()=>true);return {store,initial};}
const admission=()=>({purpose:'memory-profile-presence-mutation',operationId:'actual-operation',isCurrent:()=>true});
test('unknown-next pending survives restart and blocks ordinary reads even if database unchanged',async t=>{
 const f=fixture(t),{store,initial}=await enroll(f),pending=await store.prepareProfilePresence('profile',initial,admission());
 assert.equal(pending.purpose,'memory-profile-presence');await assert.rejects(()=>store.captureProfilePresence('profile'));
 await store.close();const reopened=f.open();await assert.rejects(()=>reopened.captureProfilePresence('profile'));
 const held=await reopened.capturePendingProfilePresence('profile');assert.equal(held.id,pending.id);assert.equal(held.operationId,'actual-operation');assert.equal('next' in held,false);
});
test('commit binds actual twenty-table digest and advances native generation once',async t=>{
 const f=fixture(t),{store,initial}=await enroll(f),pending=await store.prepareProfilePresence('profile',initial,admission()),next={...initial,sha256:'c'.repeat(64),generation:2};
 await assert.rejects(()=>pending.commit(next));f.db.set('profile',next);await pending.commit(next);
 assert.deepEqual((await store.captureProfilePresence('profile')).anchor,next);await assert.rejects(()=>pending.commit(next));
});
test('missing typed admission refuses before pending and preserves readable root',async t=>{
 const f=fixture(t),{store,initial}=await enroll(f);await assert.rejects(()=>store.prepareProfilePresence('profile',initial,null));assert.deepEqual((await store.captureProfilePresence('profile')).anchor,initial);
});
test('revoked initiating operation cannot commit or clear its persisted pending',async t=>{
 const f=fixture(t),{store,initial}=await enroll(f);let current=true;const pending=await store.prepareProfilePresence('profile',initial,{...admission(),isCurrent:()=>current}),next={...initial,sha256:'d'.repeat(64),generation:2};f.db.set('profile',next);current=false;
 assert.equal(pending.isCurrent(),false);await assert.rejects(()=>pending.commit(next));assert.equal((await store.capturePendingProfilePresence('profile')).id,pending.id);
});
test('restoring an older protected presence file cannot roll back its independent witness',async t=>{
 const f=fixture(t),{store,initial}=await enroll(f),file=path.join(f.directory,'memory-profile-presence-roots.json'),old=fs.readFileSync(file),pending=await store.prepareProfilePresence('profile',initial,admission()),next={...initial,sha256:'e'.repeat(64),generation:2};
 f.db.set('profile',next);await pending.commit(next);await store.close();fs.writeFileSync(file,old,{mode:0o600});await assert.rejects(()=>f.open().captureProfilePresence('profile'));
});
test('a failed witness CAS leaves no automatically recoverable profile',async t=>{
 const f=fixture(t),{store,initial}=await enroll(f);f.failWitness();await assert.rejects(()=>store.prepareProfilePresence('profile',initial,admission()));await assert.rejects(()=>store.captureProfilePresence('profile'));await assert.rejects(()=>f.open().captureProfilePresence('profile'));
});
test('an admitted pending write can commit its own exact authenticated forget descendant',async t=>{
 const f=fixture(t),{store,initial}=await enroll(f),pending=await store.prepareProfilePresence('profile',initial,admission()),authority={...f.authority(),forgetSequence:1,forgetMac:'f'.repeat(64)},next={...initial,...authority,sha256:'9'.repeat(64),generation:2};
 f.moveAuthority(authority);f.db.set('profile',next);assert.equal(pending.isCurrent(),true);await pending.commit(next);assert.deepEqual((await store.captureProfilePresence('profile')).anchor,next);
});
