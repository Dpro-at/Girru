'use strict';
/** Explicit main-process trust storage, outside selected profile/backup roots. No default paths or enrollment. */
const fs=require('node:fs');const path=require('node:path');const {randomUUID,createHash}=require('node:crypto');
class MemoryTrustStoreError extends Error{constructor(){super('memory_trust_unavailable');this.name='MemoryTrustStoreError';}}
const fail=()=>{throw new MemoryTrustStoreError();};
const inside=(root,child)=>{const relative=path.relative(root,child);return !relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
function createMemoryTrustStore({directory,excludedRoots,protector,platform=process.platform,witness,beginPersistence}){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||!Array.isArray(excludedRoots)||!excludedRoots.length||!protector||!witness||typeof witness.capture!=='function'||typeof witness.compareAndSwap!=='function')fail();
 const selected=path.resolve(directory),excluded=excludedRoots.map(root=>{if(typeof root!=='string'||!path.isAbsolute(root))fail();return path.resolve(root);});
 if(excluded.some(root=>inside(root,selected)||inside(selected,root)))fail();
 const file=path.join(selected,'memory-trust.json'),lock=path.join(selected,'.memory-trust.lock');let closed=false,busy=false,poisoned=false,latest;
 function available(){if(closed||poisoned||!protector.isEncryptionAvailable())fail();if(platform==='linux'&&(!protector.getSelectedStorageBackend||!['gnome_libsecret','kwallet','kwallet5','kwallet6'].includes(protector.getSelectedStorageBackend())))fail();}
 function base(){available();const st=fs.lstatSync(selected);if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(selected)!==selected)fail();}
 function parse(value){
  if(!value||Object.keys(value).sort().join(',')!=='audit,genesis,ownerId,restore,revision,v'||value.v!==2||typeof value.ownerId!=='string'||!value.ownerId||value.ownerId.length>256||!Number.isSafeInteger(value.revision)||value.revision<1)fail();
  const a=value.restore,r=value.audit;if(!a||!r||a.ownerId!==value.ownerId||r.ownerId!==value.ownerId||!Number.isSafeInteger(a.epoch)||a.epoch<1||!Number.isSafeInteger(a.forgetSequence)||a.forgetSequence<0||!Number.isSafeInteger(r.sequence)||r.sequence<0||typeof a.forgetMac!=='string'||!/^[a-f0-9]{64}$/.test(a.forgetMac)||typeof r.mac!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(r.mac))fail();
  if(Object.keys(a).sort().join(',')!=='authorityId,epoch,forgetMac,forgetSequence,keyId,memberId,ownerId,v'||a.v!==1||![a.ownerId,a.memberId,a.authorityId,a.keyId].every(id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(id))||Object.keys(r).sort().join(',')!=='mac,ownerId,sequence')fail();
  const g=value.genesis;if(!g||Object.keys(g).sort().join(',')!=='authorityId,epoch,forgetMac,forgetSequence,keyId,memberId,ownerId,v'||g.v!==1||g.ownerId!==value.ownerId||g.memberId!==a.memberId||g.authorityId!==a.authorityId||![g.ownerId,g.memberId,g.authorityId,g.keyId].every(id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(id))||!Number.isSafeInteger(g.epoch)||g.epoch<1||g.epoch>a.epoch||g.forgetSequence!==0||typeof g.forgetMac!=='string'||!/^[a-f0-9]{64}$/.test(g.forgetMac))fail();
  return JSON.parse(JSON.stringify(value));
 }
 function read(){base();let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size<1||stat.size>65536)fail();const buffer=Buffer.alloc(stat.size+1);let used=0;while(used<buffer.length){const n=fs.readSync(fd,buffer,used,buffer.length-used,used);if(!n)break;used+=n;}const after=fs.fstatSync(fd),entry=fs.lstatSync(file);if(used!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||entry.dev!==stat.dev||entry.ino!==stat.ino)fail();const outer=JSON.parse(buffer.subarray(0,used).toString());if(!outer||Object.keys(outer).sort().join(',')!=='cipher,v'||outer.v!==1||typeof outer.cipher!=='string')fail();const cipher=Buffer.from(outer.cipher,'base64');if(cipher.toString('base64')!==outer.cipher)fail();const record=parse(JSON.parse(protector.decryptString(cipher)));return{record,digest:createHash('sha256').update(buffer.subarray(0,used)).digest('hex')};}finally{if(fd!==undefined)fs.closeSync(fd);}}
 function persist(record,create){base();let tmp;try{const cipher=protector.encryptString(JSON.stringify(parse(record)));if(!Buffer.isBuffer(cipher)||cipher.length>40000)fail();tmp=path.join(selected,'.memory-trust-'+randomUUID()+'.tmp');const fd=fs.openSync(tmp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,JSON.stringify({v:1,cipher:cipher.toString('base64')}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(create)fs.linkSync(tmp,file);else{fs.renameSync(tmp,file);tmp=undefined;}const parent=fs.openSync(selected,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}finally{if(tmp)try{fs.unlinkSync(tmp);}catch{}}}
 async function exclusive(fn){base();if(busy)fail();busy=true;let fd;try{fd=fs.openSync(lock,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.writeFileSync(fd,randomUUID());fs.fsyncSync(fd);return await fn();}catch{throw new MemoryTrustStoreError();}finally{if(fd!==undefined){const stat=fs.fstatSync(fd);fs.closeSync(fd);try{const entry=fs.lstatSync(lock);if(entry.dev===stat.dev&&entry.ino===stat.ino)fs.unlinkSync(lock);}catch{}}busy=false;}}
 async function verified(){const observed=read(),proof=await witness.capture();available();if(!proof||typeof proof.isCurrent!=='function'||proof.isCurrent()!==true||proof.revision!==observed.record.revision||proof.digest!==observed.digest||read().digest!==observed.digest)fail();const result={...observed,current:()=>{try{return !closed&&proof.isCurrent()===true&&read().digest===observed.digest;}catch{return false;}}};latest=result;return result;}
 async function save(prior,candidate){
  if(typeof beginPersistence!=='function')fail();let ticket,after;
  const capturedPrior=prior?JSON.parse(JSON.stringify(prior.record)):null;
  const captureTrustState=()=>{const actual=after??prior;if(actual){if(!actual.current())fail();return{value:JSON.parse(JSON.stringify(actual.record)),isCurrent:actual.current};}if(fs.existsSync(file))fail();return{value:null,isCurrent:()=>{try{available();return !fs.existsSync(file);}catch{return false;}}};};
  try{
   ticket=await beginPersistence(Object.freeze({kind:prior?'trust-store-cas':'trust-store-enroll',operationId:randomUUID(),ownerId:candidate.ownerId,prior:capturedPrior,next:JSON.parse(JSON.stringify(candidate)),captureTrustState}));
   if(!ticket||typeof ticket.isCurrent!=='function'||typeof ticket.complete!=='function'||typeof ticket.fail!=='function'||!ticket.isCurrent()||prior&&!prior.current())fail();
   persist(candidate,!prior);const stored=read();
   if(!ticket.isCurrent()||await witness.compareAndSwap(prior?{revision:prior.record.revision,digest:prior.digest}:null,{revision:candidate.revision,digest:stored.digest})!==true)fail();
   if(!ticket.isCurrent())fail();after=await verified();if(JSON.stringify(after.record)!==JSON.stringify(candidate)||!ticket.isCurrent())fail();
   await ticket.complete();if(!after.current())fail();return candidate;
  }catch{poisoned=true;latest=undefined;try{await ticket?.fail();}catch{}fail();}
 }
 return{
  /** Enrollment is an explicit trusted-main action; never called by capture, unlock or missing-file recovery. */
  async enroll(record,authorize){const candidate=parse(record);if(typeof authorize!=='function')fail();return exclusive(async()=>{if(candidate.revision!==1||await authorize()!==true)fail();available();const prior=await witness.capture();if(prior!==null)fail();return save(null,candidate);});},
  async capture(){return exclusive(async()=>{const v=await verified();return{record:v.record,isCurrent:v.current};});},
  async captureSlot(field){if(!['restore','audit','genesis'].includes(field))fail();return exclusive(async()=>{const v=await verified(),value=JSON.parse(JSON.stringify(v.record[field]));return{value,isCurrent:()=>Boolean(latest&&latest.current()&&JSON.stringify(latest.record[field])===JSON.stringify(value))};});},
  async compareAndSwap(expected,next){const prior=parse(expected),candidate=parse(next);return exclusive(async()=>{const v=await verified();if(JSON.stringify(v.record)!==JSON.stringify(prior)||candidate.ownerId!==prior.ownerId||JSON.stringify(candidate.genesis)!==JSON.stringify(prior.genesis)||candidate.revision!==prior.revision+1||candidate.restore.authorityId!==prior.restore.authorityId||candidate.restore.memberId!==prior.restore.memberId||candidate.restore.epoch<prior.restore.epoch||candidate.restore.forgetSequence<prior.restore.forgetSequence||candidate.audit.sequence<prior.audit.sequence||!v.current())fail();const restoreChanged=JSON.stringify(candidate.restore)!==JSON.stringify(prior.restore),auditChanged=JSON.stringify(candidate.audit)!==JSON.stringify(prior.audit);
   if(restoreChanged===auditChanged)fail();
   if(restoreChanged&&(candidate.restore.forgetSequence!==prior.restore.forgetSequence+1||candidate.restore.epoch>prior.restore.epoch+1||candidate.restore.epoch===prior.restore.epoch&&candidate.restore.keyId!==prior.restore.keyId||candidate.restore.epoch>prior.restore.epoch&&candidate.restore.keyId===prior.restore.keyId))fail();
   if(auditChanged&&candidate.audit.sequence!==prior.audit.sequence+1)fail();
   await save(v,candidate);return true;});},
  close(){closed=true;},
 };
}
module.exports={createMemoryTrustStore,MemoryTrustStoreError};
