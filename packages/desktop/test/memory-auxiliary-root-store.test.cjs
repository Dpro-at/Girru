'use strict';
// Deferred state-machine fixtures: OS protection and independent witness are explicit synthetic providers.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createMemoryAuxiliaryRootStore}=require('../src/memory-auxiliary-root-store.cjs');
const clone=value=>JSON.parse(JSON.stringify(value)),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'memory-auxiliary-root-'))),directory=path.join(root,'auxiliary'),excludedRoots=['data','backups','trust'].map(name=>path.join(root,name));
 for(const p of [directory,...excludedRoots])fs.mkdirSync(p,{mode:0o700});
 const key=crypto.randomBytes(32),protector={isEncryptionAvailable:()=>true,encryptString(value){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(value),cipher.final(),cipher.getAuthTag()]);},decryptString(value){const cipher=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));cipher.setAuthTag(value.subarray(-16));return Buffer.concat([cipher.update(value.subarray(12,-16)),cipher.final()]).toString();}};
 let witnessHead=null,failWitness=false,live=true,legacyCovered=true,copyReceipt=false;
 let authority={v:1,ownerId:'owner',memberId:'member',authorityId:'authority',keyId:'key',epoch:1,forgetSequence:0,forgetMac:'a'.repeat(64)};
 const history=[],db=new Map(),stores=[];
 const witness={async capture(){if(!witnessHead)return null;const value=clone(witnessHead);return {...value,isCurrent:()=>same(value,witnessHead)};},async compareAndSwap(prior,next){if(failWitness||!same(prior,witnessHead)||next.revision!==(prior?prior.revision+1:1))return false;witnessHead=clone(next);return true;}};
 const options={directory,excludedRoots,ownerId:'owner',protector,witness,async beginPersistence({captureAuxiliaryState}){const prior=captureAuxiliaryState();if(!prior.isCurrent())throw Error('stale persistence proof');let current=true;return {isCurrent:()=>current,async complete(){if(!captureAuxiliaryState().isCurrent())throw Error('stale post-CAS proof');current=false;},async fail(){current=false;}};},platform:process.platform==='win32'?'win32':'darwin',async captureAuthority(){const captured=clone(authority);return {anchor:captured,isCurrent:()=>live&&same(captured,authority)};},async verifyAuxiliaryState(profileId,expected,{phase,currentAuthority}){if(!legacyCovered||!same(db.get(profileId),expected)||!same(authority,currentAuthority))return null;const captured=clone(expected);return {purpose:'memory-auxiliary',profileId,anchor:captured,...(phase==='enroll-verified-copy'&&copyReceipt?{copyReceiptId:'verified-copy-receipt'}:{}),isCurrent:()=>live&&legacyCovered&&same(db.get(profileId),captured)&&same(authority,currentAuthority)};},async verifyAuthorityTransition(profileId,from,to){if(!history.some(row=>same(row.from,from)&&same(row.to,to)))return null;return {from:clone(from),to:clone(to),isCurrent:()=>live&&same(authority,to)};}};
 const open=()=>{const store=createMemoryAuxiliaryRootStore(options);stores.push(store);return store;};
 const empty=()=>({...clone(authority),bundleId:null,sha256:null,parts:0,generation:1});
 const moveAuthority=next=>{history.push({from:clone(authority),to:clone(next)});authority=clone(next);};
 t.after(async()=>{for(const store of stores)await store.close().catch(()=>{});key.fill(0);fs.rmSync(root,{recursive:true,force:true});});
 return {root,directory,options,db,open,empty,moveAuthority,authority:()=>clone(authority),setLive:value=>{live=value;},setLegacy:value=>{legacyCovered=value;},setCopy:value=>{copyReceipt=value;},failWitness:()=>{failWitness=true;}};
}
async function enroll(f){const store=f.open(),initial=f.empty();f.db.set('profile',initial);await store.enrollOwner('profile',async()=>true);await store.enrollAuxiliaryRoot('profile',initial,async()=>true);return {store,initial};}
test('missing state is not empty genesis; explicit owner enrollment and exact empty-source proof required',async t=>{
 const f=fixture(t),store=f.open(),initial=f.empty();f.db.set('profile',initial);
 await assert.rejects(()=>store.captureAuxiliaryRoot('profile'));
 await assert.rejects(()=>store.enrollOwner('profile',async()=>false));await store.enrollOwner('profile',async()=>true);
 f.setLegacy(false);await assert.rejects(()=>store.enrollAuxiliaryRoot('profile',initial,async()=>true));f.setLegacy(true);
 await store.enrollAuxiliaryRoot('profile',initial,async()=>true);assert.deepEqual((await store.captureAuxiliaryRoot('profile')).anchor,initial);
 assert.equal(fs.readFileSync(path.join(f.directory,'memory-auxiliary-roots.json')).includes(Buffer.from('ownerId')),false);
});
test('durable pending blocks reads; legitimate SQL change does not expire pending; exact proof commit is one-use',async t=>{
 const f=fixture(t),{store,initial}=await enroll(f),next={...initial,bundleId:crypto.randomUUID(),sha256:'b'.repeat(64),parts:2,generation:2};
 const mutation=await store.prepareAuxiliaryMutation('profile',initial,next);assert.equal(mutation.isCurrent(),true);
 await assert.rejects(()=>store.captureAuxiliaryRoot('profile'));f.db.set('profile',next);assert.equal(mutation.isCurrent(),true);
 assert.equal(await mutation.commit(),true);assert.equal(mutation.isCurrent(),false);assert.deepEqual((await store.captureAuxiliaryRoot('profile')).anchor,next);await assert.rejects(()=>mutation.commit());
});
test('restart retains pending; only explicit verified reconciliation can keep the unchanged prior state',async t=>{
 const f=fixture(t),{store,initial}=await enroll(f),next={...initial,bundleId:crypto.randomUUID(),sha256:'b'.repeat(64),parts:1,generation:2};
 const mutation=await store.prepareAuxiliaryMutation('profile',initial,next);await store.close();const reopened=f.open();await assert.rejects(()=>reopened.captureAuxiliaryRoot('profile'));
 assert.equal((await reopened.capturePendingAuxiliaryMutation('profile')).id,mutation.id);
 await assert.rejects(()=>reopened.reconcileAuxiliaryMutation('profile',mutation.id,'keep-prior',async()=>false));
 await reopened.reconcileAuxiliaryMutation('profile',mutation.id,'keep-prior',async()=>true);assert.deepEqual((await reopened.captureAuxiliaryRoot('profile')).anchor,initial);
});
test('batch forget head requires exact trusted descendant proof and cannot reconcile backwards after ACK',async t=>{
 const f=fixture(t),{store,initial}=await enroll(f),nextAuthority={...f.authority(),forgetSequence:2,forgetMac:'c'.repeat(64)};
 f.moveAuthority(nextAuthority);const next={...initial,...nextAuthority,generation:2};
 await assert.rejects(()=>store.captureAuxiliaryRoot('profile'));
 const mutation=await store.prepareAuxiliaryMutation('profile',initial,next);
 await assert.rejects(()=>store.reconcileAuxiliaryMutation('profile',mutation.id,'keep-prior',async()=>true));
 f.db.set('profile',next);await mutation.commit();assert.deepEqual((await store.captureAuxiliaryRoot('profile')).anchor,next);
});
test('restoring only protected auxiliary data is refused against the independent monotonic witness',async t=>{
 const f=fixture(t),{store,initial}=await enroll(f),file=path.join(f.directory,'memory-auxiliary-roots.json'),old=fs.readFileSync(file),next={...initial,bundleId:crypto.randomUUID(),sha256:'d'.repeat(64),parts:1,generation:2};
 const mutation=await store.prepareAuxiliaryMutation('profile',initial,next);f.db.set('profile',next);await mutation.commit();await store.close();
 fs.writeFileSync(file,old,{mode:0o600});await assert.rejects(()=>f.open().captureAuxiliaryRoot('profile'));
});
test('copy enrollment requires a native-verified copy receipt, never a signed old snapshot alone',async t=>{
 const f=fixture(t),store=f.open(),imported={...f.empty(),bundleId:crypto.randomUUID(),sha256:'e'.repeat(64),parts:1};f.db.set('profile',imported);await store.enrollOwner('profile',async()=>true);
 await assert.rejects(()=>store.enrollAuxiliaryRoot('profile',imported,async()=>true));await assert.rejects(()=>store.enrollCopiedAuxiliaryRoot('profile',imported,async()=>true));
 f.setCopy(true);await store.enrollCopiedAuxiliaryRoot('profile',imported,async()=>true);assert.deepEqual((await store.captureAuxiliaryRoot('profile')).anchor,imported);
});
test('revocation during a pending mutation leaves it locked rather than clearing or committing stale authority',async t=>{
 const f=fixture(t),{store,initial}=await enroll(f),next={...initial,bundleId:crypto.randomUUID(),sha256:'f'.repeat(64),parts:1,generation:2};const mutation=await store.prepareAuxiliaryMutation('profile',initial,next);
 f.db.set('profile',next);f.setLive(false);assert.equal(mutation.isCurrent(),false);await assert.rejects(()=>mutation.commit());assert.equal((await store.capturePendingAuxiliaryMutation('profile')).id,mutation.id);
});
test('witness CAS failure after persistence poisons access; no automatic empty-state healing',async t=>{
 const f=fixture(t),{store,initial}=await enroll(f),next={...initial,bundleId:crypto.randomUUID(),sha256:'f'.repeat(64),parts:1,generation:2};f.failWitness();await assert.rejects(()=>store.prepareAuxiliaryMutation('profile',initial,next));await assert.rejects(()=>store.captureAuxiliaryRoot('profile'));await assert.rejects(()=>f.open().captureAuxiliaryRoot('profile'));
});

test('missing native persistence barrier refuses enrollment before protected persistence',async t=>{
 const f=fixture(t);delete f.options.beginPersistence;const store=f.open();f.db.set('profile',f.empty());
 await assert.rejects(()=>store.enrollOwner('profile',async()=>true));assert.equal(fs.existsSync(path.join(f.directory,'memory-auxiliary-roots.json')),false);
});
test('late barrier drains after auxiliary proof and before persistence, completes only after witness CAS',async t=>{
 const f=fixture(t),events=[],originalVerify=f.options.verifyAuxiliaryState,originalCAS=f.options.witness.compareAndSwap;
 f.options.verifyAuxiliaryState=async(...args)=>{const proof=await originalVerify(...args);events.push('auxiliary-proof');return proof;};
 f.options.witness.compareAndSwap=async(...args)=>{events.push('witness-cas');return originalCAS(...args);};
 f.options.beginPersistence=async({captureAuxiliaryState})=>{events.push('blocked');const before=captureAuxiliaryState();assert.equal(before.isCurrent(),true);await Promise.resolve();events.push('drained');let current=true;return{isCurrent:()=>current,async complete(){assert.equal(events.at(-1),'witness-cas');assert.equal(captureAuxiliaryState().isCurrent(),true);events.push('resumed');current=false;},async fail(){current=false;events.push('poisoned');}};};
 const {store,initial}=await enroll(f);events.length=0;const next={...initial,bundleId:crypto.randomUUID(),sha256:'1'.repeat(64),parts:1,generation:2};
 await store.prepareAuxiliaryMutation('profile',initial,next);
 assert.deepEqual(events,['auxiliary-proof','blocked','drained','witness-cas','resumed']);
});
test('drain failure cannot persist; witness failure never resumes the child',async t=>{
 for(const failure of ['drain','witness']){const f=fixture(t),{store,initial}=await enroll(f),file=path.join(f.directory,'memory-auxiliary-roots.json'),before=fs.readFileSync(file);let resumes=0,failed=0;
  f.options.beginPersistence=async()=>{throw Error('constructor options are captured; use fresh instance');};await store.close();
  f.options.beginPersistence=async()=>{if(failure==='drain')throw Error('synthetic child drain failure');return{isCurrent:()=>true,async complete(){resumes++;},async fail(){failed++;}};};
  const reopened=f.open();if(failure==='witness')f.failWitness();const next={...initial,bundleId:crypto.randomUUID(),sha256:'2'.repeat(64),parts:1,generation:2};
  await assert.rejects(()=>reopened.prepareAuxiliaryMutation('profile',initial,next));assert.equal(resumes,0);
  if(failure==='drain')assert.deepEqual(fs.readFileSync(file),before);else assert.equal(failed,1);
 }
});

test('trusted slot metadata proves absence and durable pending without granting ordinary auxiliary read',async t=>{
 const f=fixture(t),store=f.open(),initial=f.empty();f.db.set('profile',initial);await assert.rejects(()=>store.captureSlotState('profile'));await store.enrollOwner('profile',async()=>true);
 const absent=await store.captureSlotState('profile');assert.equal(absent.value,null);assert.equal(absent.isCurrent(),true);
 await store.enrollAuxiliaryRoot('profile',initial,async()=>true);assert.equal(absent.isCurrent(),false);
 const next={...initial,bundleId:crypto.randomUUID(),sha256:'3'.repeat(64),parts:1,generation:2},mutation=await store.prepareAuxiliaryMutation('profile',initial,next),pending=await store.captureSlotState('profile');
 assert.deepEqual(pending.value,{purpose:'memory-auxiliary',profileId:'profile',anchor:initial,pending:{id:mutation.id,prior:initial,next}});assert.equal(pending.isCurrent(),true);await assert.rejects(()=>store.captureAuxiliaryRoot('profile'));
 f.db.set('profile',next);await mutation.commit();assert.equal(pending.isCurrent(),false);assert.equal((await store.captureSlotState('profile')).value.pending,null);
});
test('auxiliary presence journal never accepts a graph-purpose protected record',async t=>{const f=fixture(t),{store}=await enroll(f),file=path.join(f.directory,'memory-auxiliary-roots.json');const outer=JSON.parse(fs.readFileSync(file)),record=JSON.parse(f.options.protector.decryptString(Buffer.from(outer.cipher,'base64')));record.purpose='memory-graph';const prior=await f.options.witness.capture();record.revision=prior.revision+1;const bytes=Buffer.from(JSON.stringify({v:1,cipher:f.options.protector.encryptString(JSON.stringify(record)).toString('base64')}));fs.writeFileSync(file,bytes);await f.options.witness.compareAndSwap({revision:prior.revision,digest:prior.digest},{revision:record.revision,digest:crypto.createHash('sha256').update(bytes).digest('hex')});await assert.rejects(()=>store.captureSlotState('profile'));});
