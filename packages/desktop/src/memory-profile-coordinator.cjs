'use strict';
/** Explicit main-process profile lease. All writers must be owned by the authorizing host; no stale-lock takeover. */
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const unavailable=()=>Error('memory_profile_unavailable');
function createMemoryProfileCoordinator({profileId,profileRoot,memoryRoot,authorizeExclusive}){
 if(typeof profileId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(profileId)||![profileRoot,memoryRoot].every(value=>typeof value==='string'&&path.isAbsolute(value))||typeof authorizeExclusive!=='function')throw unavailable();
 const root=path.resolve(profileRoot),memory=path.resolve(memoryRoot),relative=path.relative(root,memory);
 if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw unavailable();
 let handle,closed=false,ownership,rootIdentity,memoryIdentity,lockIdentity;const lockPath=path.join(root,'.memory-encryption-host.lock'),nonce=randomBytes(32).toString('hex');
 const identity=stat=>[stat.dev,stat.ino].join(':');
 const directory=value=>{const stat=fs.lstatSync(value);if(stat.isSymbolicLink()||!stat.isDirectory()||fs.realpathSync(value)!==value)throw unavailable();return identity(stat);};
 const physicalOwnership=()=>{
  if(handle===undefined)return false;
  try{
   if(directory(root)!==rootIdentity||directory(memory)!==memoryIdentity)return false;
   const held=fs.fstatSync(handle),named=fs.lstatSync(lockPath);if(!held.isFile()||!named.isFile()||named.isSymbolicLink()||held.nlink!==1||named.nlink!==1||identity(held)!==lockIdentity||identity(named)!==lockIdentity||named.size>1024)return false;
   const data=Buffer.alloc(named.size);fs.readSync(handle,data,0,data.length,0);const record=JSON.parse(data.toString('utf8'));return record.profileId===profileId&&record.nonce===nonce;
  }catch{return false;}
 };
 const current=()=>{try{return !closed&&!!ownership&&ownership.isCurrent()===true&&physicalOwnership();}catch{return false;}};
 return Object.freeze({
  async acquire(){
   if(closed||handle!==undefined)throw unavailable();
   // A filesystem lock cannot prove that an unrelated legacy writer stopped. The main host must prove that first.
   const permitted=await authorizeExclusive(Object.freeze({profileId,profileRoot:root,memoryRoot:memory}));
   if(closed||!permitted||typeof permitted.storageId!=='string'||!permitted.storageId||typeof permitted.isCurrent!=='function'||permitted.isCurrent()!==true)throw unavailable();ownership={storageId:permitted.storageId,isCurrent:permitted.isCurrent.bind(permitted)};
   rootIdentity=directory(root);memoryIdentity=directory(memory);
   try{
    handle=fs.openSync(lockPath,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW??0),0o600);
    const stat=fs.fstatSync(handle);if(!stat.isFile()||stat.nlink!==1)throw unavailable();lockIdentity=identity(stat);
    fs.writeFileSync(handle,JSON.stringify({v:1,profileId,nonce})+'\n');fs.fsyncSync(handle);
    if(!current())throw unavailable();return Object.freeze({profileId,storageId:ownership.storageId,profileRoot:root,memoryRoot:memory,isCurrent:current});
   }catch{if(handle!==undefined){try{fs.closeSync(handle);}catch{}handle=undefined;}closed=true;throw unavailable();}
  },
  close(){
   if(closed&&handle===undefined)return;
   const owned=physicalOwnership();closed=true;
   try{if(owned){const named=fs.lstatSync(lockPath);if(identity(named)===lockIdentity&&!named.isSymbolicLink())fs.unlinkSync(lockPath);}}finally{if(handle!==undefined){fs.closeSync(handle);handle=undefined;}ownership=undefined;}
  },
 });
}
module.exports={createMemoryProfileCoordinator};
