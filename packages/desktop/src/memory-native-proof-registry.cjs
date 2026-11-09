'use strict';
/** Trusted-main proof registry. Never accepts enrollment, path selection or authority from child RPCs. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const C=require('../../identity/src/memory-native-proof.cjs');
const freshId=()=>crypto.randomBytes(32).toString('base64url');
const inside=(root,file)=>{const r=path.relative(root,file);return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
function createMemoryNativeProofRegistry(options){
 if(!options||['captureNativeState','parkIngress','drainChild','publishInvalidation','resumeChild'].some(k=>typeof options[k]!=='function'))C.unsupported();
 const bound=C.binding(options.binding),profileLease=options.profileLease;
 if(!profileLease||typeof profileLease.isCurrent!=='function'||profileLease.profileId!==bound.profileId||profileLease.storageId!==bound.storageId)C.unsupported();
 const root=path.resolve(C.text(options.capsuleDirectory,4096));if(!path.isAbsolute(options.capsuleDirectory))throw C.error();
 const files=C.cipherFiles(options.cipherFiles),excluded=options.excludedRoots;
 if(!Array.isArray(excluded)||excluded.length<2||excluded.some(p=>typeof p!=='string'||!path.isAbsolute(p))||files.some(f=>excluded.some(p=>inside(path.resolve(p),f.path)))||excluded.some(p=>inside(path.resolve(p),root)))throw C.error();
 const capsulePath=path.join(root,'capsule.json'),proofPath=path.join(root,'proof.json'),key=crypto.randomBytes(32),handles=new Map(),graphPermits=new Map(),seenRequests=new Map();
 let current=null,proofRecord=null,currentBytes=null,serial=0,state='new',busy=false,mutation=null,enrollment=null,directoryProofs=[];
 const timeoutMs=options.timeoutMs??15000;if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw C.error();
 async function bounded(promise){let timer;try{return await Promise.race([Promise.resolve(promise),new Promise((_,reject)=>{timer=setTimeout(()=>reject(C.error()),timeoutMs);})]);}finally{clearTimeout(timer);}}
 function directoryOwned(){const st=fs.lstatSync(root);if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(root)!==root||process.platform!=='win32'&&(st.uid!==process.getuid()||(st.mode&0o077)!==0))throw C.error();}
 function owned(){if(state==='closed'||!profileLease.isCurrent())throw C.error();directoryOwned();}
 function atomic(file,bytes){directoryOwned();const tmp=path.join(root,'.proof-'+crypto.randomUUID()+'.tmp');let fd;try{fd=fs.openSync(tmp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW??0),0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(tmp,file);if(process.platform!=='win32'){const parent=fs.openSync(root,fs.constants.O_RDONLY|(fs.constants.O_DIRECTORY??0)|(fs.constants.O_NOFOLLOW??0));try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}}finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch{}}}
 function live(){if(state!=='active'||!current||current.state!=='active'||busy)throw C.error();try{owned();const named=C.openSigned(C.readProtectedFile(capsulePath,C.MAX_WIRE).bytes,key,C.capsule),record=C.openSigned(C.readProtectedFile(proofPath,C.MAX_WIRE).bytes,key,C.proof);if(C.canonical(named)!==C.canonical(current)||C.canonical(record)!==C.canonical(proofRecord)||C.digest(C.readProtectedFile(proofPath,C.MAX_WIRE).bytes)!==named.proofHash||C.canonical(C.fingerprintNativeFiles(files))!==C.canonical(record.fingerprints))throw C.error();}catch{poison();throw C.error();}}
 async function collect(capture=options.captureNativeState,phase='fresh'){
  owned();const supplied=await bounded(capture({phase,mutationId:mutation?.id??null}));owned();if(!supplied||typeof supplied!=='object'||Array.isArray(supplied)||Object.keys(supplied).some(f=>!['genesis','restore','audit','graph','auxiliary','presence'].includes(f)))C.unsupported();
  const values={profile:{profileId:bound.profileId,storageId:bound.storageId,journalStorageId:bound.journalStorageId}},proofs=[];
  for(const f of ['genesis','restore','audit','graph','auxiliary','presence'])if(Object.hasOwn(supplied,f)){const p=supplied[f];if(!p||typeof p.isCurrent!=='function'||p.isCurrent()!==true)C.unsupported();values[f]=C.value(f,p.value);proofs.push(p);}
  if(!values.genesis||!values.restore||!values.audit)C.unsupported();
  if(values.genesis.forgetSequence!==0||values.genesis.epoch>values.restore.epoch||values.genesis.ownerId!==values.restore.ownerId||values.genesis.memberId!==values.restore.memberId||values.genesis.authorityId!==values.restore.authorityId||values.audit.ownerId!==values.restore.ownerId||values.graph&&values.graph.profileId!==bound.profileId||values.auxiliary&&values.auxiliary.profileId!==bound.profileId||values.presence&&values.presence.profileId!==bound.profileId)throw C.error();
  const fingerprints=C.fingerprintNativeFiles(files);if(proofs.some(p=>p.isCurrent()!==true)||!profileLease.isCurrent())throw C.error();return {values,proofs,fingerprints};
 }
 function hashes(values){return Object.fromEntries(Object.entries(values).map(([f,v])=>[f,C.digest(v)]));}
 function publish(snapshot,nextSlots,phase='active',mutationId=null){
  const nextSerial=++serial;proofRecord=C.proof({v:1,binding:bound,serial:nextSerial,fields:nextSlots,fingerprints:snapshot.fingerprints});const bytes=C.signed(proofRecord,key);atomic(proofPath,bytes);
  current=C.capsule({v:1,binding:bound,serial:nextSerial,state:phase,mutationId,fields:nextSlots,proofHash:C.digest(bytes)});currentBytes=C.signed(current,key);atomic(capsulePath,currentBytes);state=phase;
 }
 function block(phase,id){directoryOwned();if(!current||!proofRecord)throw C.error();current=C.capsule({...current,serial:++serial,state:phase,mutationId:id});currentBytes=C.signed(current,key);atomic(capsulePath,currentBytes);state=phase;}
 function poison(){handles.clear();graphPermits.clear();if(state==='closed')return;try{if(current&&state!=='closed')block('poisoned',mutation?.id??null);}catch{}state='poisoned';}
 function sameSnapshot(snapshot){const next=hashes(snapshot.values);return C.canonical(next)===C.canonical(Object.fromEntries(Object.entries(current.fields).map(([f,s])=>[f,s.valueHash])))&&C.canonical(snapshot.fingerprints)===C.canonical(proofRecord.fingerprints);}
 function issue(fields,operationId,snapshot,handle=freshId()){
  const wanted=C.fields(['profile',...fields.filter(f=>f!=='profile')]);if(wanted.some(f=>!current.fields[f]))C.unsupported();const now=Date.now(),ttl=options.leaseMs??15000;if(!Number.isSafeInteger(ttl)||ttl<1||ttl>C.MAX_LEASE_MS)throw C.error();
  const descriptor=C.descriptor({v:1,binding:bound,handle,operationId:C.text(operationId,128),fields:Object.fromEntries(wanted.map(f=>[f,current.fields[f]])),issuedAt:now,expiresAt:now+ttl});
  const values=Object.fromEntries(wanted.map(f=>[f,snapshot.values[f]]));handles.set(handle,{descriptor,values});if(handles.size>256){handles.delete(handle);throw C.error();}return {descriptor,values};
 }
 async function capture(fields,operationId){for(const [id,held]of handles)if(held.descriptor.expiresAt<=Date.now())handles.delete(id);live();let snapshot;try{snapshot=await collect();live();if(!sameSnapshot(snapshot))throw C.error();}catch{poison();throw C.error();}return issue(C.fields(fields),operationId,snapshot);}
 async function fresh(handle,operationId){live();const held=handles.get(C.opaque(handle));if(!held||held.descriptor.expiresAt<=Date.now()||held.descriptor.operationId!==operationId)throw C.error();const snapshot=await collect();live();if(!sameSnapshot(snapshot)){poison();throw C.error();}for(const [f,v]of Object.entries(held.descriptor.fields))if(C.canonical(v)!==C.canonical(current.fields[f]))throw C.error();return issue(Object.keys(held.descriptor.fields),operationId,snapshot,handle);}
 function bootstrap(){if(state==='enrolling')owned();else live();return C.bootstrap({v:1,type:'memory-proof-bootstrap',binding:bound,capsulePath,proofPath,cipherFiles:files,macKey:key.toString('base64url'),directoryProofs});}
 function contentPreflight(field,input){
  live();if(!input||typeof input.isCurrent!=='function'||typeof input.release!=='function'||input.isCurrent()!==true)C.unsupported();const operationId=C.text(input.operationId,128),expiresAt=C.number(input.expiresAt,1);if(expiresAt<=Date.now()||expiresAt>Date.now()+C.MAX_LEASE_MS)throw C.error();const p={operationId,readPermitId:C.opaque(input.readPermitId),challengeId:C.opaque(input.challengeId),authorityValueHash:C.hash(input.authorityValueHash),field,priorValueHash:C.hash(field==='graph'?input.graphValueHash:field==='auxiliary'?input.auxiliaryValueHash:input.presenceValueHash),expiresAt,isCurrent:input.isCurrent.bind(input),release:input.release.bind(input)};const id=freshId();graphPermits.set(id,p);if(graphPermits.size>32){graphPermits.delete(id);throw C.error();}return id;
 }
 async function beginMutation(input,local={}){
  if(!input||Object.keys(input).some(k=>!['operationId','changedFields','graphPermitId','auxiliaryPermitId','presencePermitId'].includes(k))||local.captureState!==undefined&&typeof local.captureState!=='function')throw C.error();
  const operationId=C.text(input.operationId,128),changedFields=C.fields(input.changedFields,{empty:true}),captureState=local.captureState??options.captureNativeState;
  live();busy=true;const id=freshId(),nonce=freshId();mutation={id,operationId};let park,permit,done=false,active=false;
  const stillOwned=()=>{try{return active&&!done&&state==='blocked'&&mutation?.id===id&&profileLease.isCurrent()&&park?.isCurrent()===true&&(!permit||permit.expiresAt>Date.now()&&permit.isCurrent()===true);}catch{return false;}};
  const fail=async()=>{if(done)return;done=true;active=false;poison();try{await bounded(permit?.release());}catch{}mutation=null;busy=false;};
  try{
   const prior=await collect(captureState,'before');if(!sameSnapshot(prior))throw C.error();
   const contentFields=['graph','auxiliary','presence'].filter(field=>changedFields.includes(field)||input[field+'PermitId']!==undefined);if(contentFields.length>1)C.unsupported();const contentField=contentFields[0]??null;
   if(contentField){const permitId=C.opaque(input[contentField+'PermitId']);permit=graphPermits.get(permitId);graphPermits.delete(permitId);if(!permit||permit.field!==contentField||permit.operationId!==operationId||permit.expiresAt<=Date.now()||permit.isCurrent()!==true||permit.authorityValueHash!==current.fields.restore?.valueHash||permit.priorValueHash!==(current.fields[contentField]?.valueHash??C.digest(null)))C.unsupported();}
   const event=C.invalidation({v:1,type:'memory-proof-invalidate',binding:bound,mutationId:id,operationId,serial:serial+1,changedFields,nonce});
   park=await bounded(options.parkIngress(event));if(!park||park.operationId!==operationId||typeof park.isCurrent!=='function'||typeof park.release!=='function'||park.isCurrent()!==true)C.unsupported();
   block('blocked',id);for(const [handle,held]of handles)if(changedFields.some(f=>Object.hasOwn(held.descriptor.fields,f)))handles.delete(handle);
   if(current.serial!==event.serial)throw C.error();
   await bounded(options.publishInvalidation(event));const ack=C.ack(await bounded(options.drainChild(event)));
   if(!C.sameBinding(ack.binding,bound)||ack.mutationId!==id||ack.operationId!==operationId||ack.serial!==event.serial||ack.nonce!==nonce||!profileLease.isCurrent()||park.isCurrent()!==true||prior.proofs.some(p=>p.isCurrent()!==true)||permit&&(permit.expiresAt<=Date.now()||permit.isCurrent()!==true))throw C.error();active=true;
   return Object.freeze({isCurrent:stillOwned,async complete(){
    if(!stillOwned())throw C.error();try{const after=await collect(captureState,'after');if(!stillOwned())throw C.error();const nextHashes=hashes(after.values),actuallyChanged=C.FIELDS.filter(f=>(current.fields[f]?.valueHash??null)!==(nextHashes[f]??null));if(C.canonical(actuallyChanged)!==C.canonical(changedFields))throw C.error();
     const nextSlots=Object.fromEntries(Object.entries(nextHashes).map(([f,valueHash])=>[f,{generation:(current.fields[f]?.generation??0)+(changedFields.includes(f)?1:0)||1,valueHash}]));
     publish(after,nextSlots);const resume=C.resume({v:1,type:'memory-proof-resume',binding:bound,mutationId:id,operationId,serial:current.serial,nonce});const resumed=C.resumed(await bounded(options.resumeChild(resume)));if(!C.sameBinding(resumed.binding,bound)||resumed.mutationId!==id||resumed.operationId!==operationId||resumed.serial!==resume.serial||resumed.nonce!==nonce)throw C.error();if(!profileLease.isCurrent())throw C.error();await bounded(permit?.release());await bounded(park.release());done=true;active=false;mutation=null;busy=false;
    }catch{await fail();throw C.error();}
   },fail});
  }catch{await fail();throw C.error();}
 }
 async function initializeEnrollment(nativeGrant){
  if(state!=='new')throw C.error();owned();
  C.exact(nativeGrant,['purpose','binding','grantId','operationId','expiresAt','isCurrent','release']);
  if(nativeGrant.purpose!=='memory-native-enrollment'||!C.sameBinding(nativeGrant.binding,bound)||typeof nativeGrant.isCurrent!=='function'||typeof nativeGrant.release!=='function'||nativeGrant.isCurrent()!==true)C.unsupported();
  const expiresAt=C.number(nativeGrant.expiresAt,1);if(expiresAt<=Date.now()||expiresAt>Date.now()+C.MAX_LEASE_MS||fs.existsSync(capsulePath)||fs.existsSync(proofPath))throw C.error();
  const captured=C.fingerprintNativeFiles(files);for(const id of ['trust','witness'])if(!files.some(f=>f.id===id&&f.optional)||!captured.some(f=>f.id===id&&f.missing===true))throw C.error();
  directoryProofs=C.captureDirectories(options.enrollmentDirectories);if(!['profile-root','journal-root'].every(id=>directoryProofs.some(d=>d.id===id))||process.platform==='win32')C.unsupported();
  enrollment={grantId:C.opaque(nativeGrant.grantId),operationId:C.text(nativeGrant.operationId,128),expiresAt,isCurrent:nativeGrant.isCurrent.bind(nativeGrant),release:nativeGrant.release.bind(nativeGrant)};
  const profile={profileId:bound.profileId,storageId:bound.storageId,journalStorageId:bound.journalStorageId};
  publish({fingerprints:captured},{profile:{generation:1,valueHash:C.digest(profile)}},'blocked');state='enrolling';return bootstrap();
 }
 async function captureEnrollmentProfile(operationId){
  if(state!=='enrolling'||busy||!enrollment||operationId!==enrollment.operationId||enrollment.expiresAt<=Date.now()||!enrollment.isCurrent()||!current||current.state!=='blocked'||current.mutationId!==null||Object.keys(current.fields).join()!=='profile')C.unsupported();owned();C.verifyDirectories(directoryProofs);
  const named=C.openSigned(C.readProtectedFile(capsulePath,C.MAX_WIRE).bytes,key,C.capsule),proof=C.openSigned(C.readProtectedFile(proofPath,C.MAX_WIRE).bytes,key,C.proof);if(C.canonical(named)!==C.canonical(current)||C.canonical(proof)!==C.canonical(proofRecord)||C.canonical(C.fingerprintNativeFiles(files))!==C.canonical(proof.fingerprints))throw C.error();
  return issue(['profile'],operationId,{values:{profile:{profileId:bound.profileId,storageId:bound.storageId,journalStorageId:bound.journalStorageId}}});
 }
 async function beginEnrollmentPersistence(input,local={}){
  C.exact(input,['operationId','grantId']);if(local.captureState!==undefined&&typeof local.captureState!=='function')throw C.error();
  if(state!=='enrolling'||busy||!enrollment||input.grantId!==enrollment.grantId||input.operationId!==enrollment.operationId||enrollment.expiresAt<=Date.now()||enrollment.isCurrent()!==true)C.unsupported();
  owned();busy=true;const activeGrant=enrollment,id=freshId(),nonce=freshId(),operationId=activeGrant.operationId,changedFields=['genesis','restore','audit'];mutation={id,operationId};let park,active=false,done=false;
  const stillOwned=()=>{try{return active&&!done&&state==='blocked'&&mutation?.id===id&&profileLease.isCurrent()&&activeGrant.expiresAt>Date.now()&&activeGrant.isCurrent()===true&&park?.isCurrent()===true;}catch{return false;}};
  const fail=async()=>{if(done)return;done=true;active=false;poison();try{await bounded(activeGrant.release());}catch{}enrollment=null;mutation=null;busy=false;};
  try{
   const event=C.invalidation({v:1,type:'memory-proof-invalidate',binding:bound,mutationId:id,operationId,serial:serial+1,changedFields,nonce});
   park=await bounded(options.parkIngress(event));if(!park||park.operationId!==operationId||typeof park.isCurrent!=='function'||typeof park.release!=='function'||park.isCurrent()!==true)C.unsupported();
   block('blocked',id);await bounded(options.publishInvalidation(event));const drained=C.ack(await bounded(options.drainChild(event)));
   if(!C.sameBinding(drained.binding,bound)||drained.mutationId!==id||drained.operationId!==operationId||drained.serial!==event.serial||drained.nonce!==nonce||!profileLease.isCurrent()||!activeGrant.isCurrent()||park.isCurrent()!==true)throw C.error();active=true;
   return Object.freeze({isCurrent:stillOwned,async complete(){
    if(!stillOwned())throw C.error();try{
     const snapshot=await collect(local.captureState??options.captureNativeState,'enrolled');if(!stillOwned()||snapshot.values.graph||snapshot.values.auxiliary||snapshot.values.presence)throw C.error();
     const nextSlots=Object.fromEntries(Object.entries(hashes(snapshot.values)).map(([f,valueHash])=>[f,{generation:1,valueHash}]));
     if(nextSlots.profile.valueHash!==current.fields.profile.valueHash)throw C.error();publish(snapshot,nextSlots);
     const message=C.resume({v:1,type:'memory-proof-resume',binding:bound,mutationId:id,operationId,serial:current.serial,nonce}),resumed=C.resumed(await bounded(options.resumeChild(message)));
     if(!C.sameBinding(resumed.binding,bound)||resumed.mutationId!==id||resumed.operationId!==operationId||resumed.serial!==message.serial||resumed.nonce!==nonce||!profileLease.isCurrent())throw C.error();
     await bounded(activeGrant.release());await bounded(park.release());enrollment=null;mutation=null;busy=false;active=false;done=true;
    }catch{await fail();throw C.error();}
   },fail});
  }catch{await fail();throw C.error();}
 }
 return Object.freeze({
  async initialize(){if(state!=='new')throw C.error();owned();if(fs.existsSync(capsulePath)||fs.existsSync(proofPath))throw C.error();try{const snapshot=await collect(),slots=Object.fromEntries(Object.entries(hashes(snapshot.values)).map(([f,valueHash])=>[f,{generation:1,valueHash}]));publish(snapshot,slots);return bootstrap();}catch{poison();throw C.error();}},
  initializeEnrollment,beginEnrollmentPersistence,captureEnrollmentProfile,bootstrap,capture,fresh,registerGraphPreflight:input=>contentPreflight('graph',input),registerAuxiliaryPreflight:input=>contentPreflight('auxiliary',input),registerPresencePreflight:input=>contentPreflight('presence',input),beginMutation,
  async mutate(input,persist,local){if(typeof persist!=='function')C.unsupported();const ticket=await beginMutation(input,local);try{if(!ticket.isCurrent())throw C.error();const result=await persist();if(!ticket.isCurrent())throw C.error();await ticket.complete();return result;}catch{await ticket.fail();throw C.error();}},
  async handleRequest(raw){const req=C.request(raw);for(const [id,until]of seenRequests)if(until<=Date.now())seenRequests.delete(id);if(!C.sameBinding(req.binding,bound)||seenRequests.has(req.requestId)||seenRequests.size>=4096)throw C.error();seenRequests.set(req.requestId,Date.now()+C.MAX_LEASE_MS);const result=req.operation==='capture'?await capture(req.fields,req.operationId):req.operation==='enrollment-profile'?await captureEnrollmentProfile(req.operationId):await fresh(req.handle,req.operationId);return C.response({v:1,type:'memory-proof-response',requestId:req.requestId,...result});},
  async close(){if(state==='closed')return;handles.clear();graphPermits.clear();try{if(current)block('closed',mutation?.id??null);}finally{state='closed';key.fill(0);}},
  status:()=>({state,serial,binding:{...bound}}),
 });
}
module.exports={createMemoryNativeProofRegistry};
