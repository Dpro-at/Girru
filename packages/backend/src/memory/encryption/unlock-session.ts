/** Process-local key lease. Host custody and permission mutation hooks must be wired before use. */
import {MemoryCipherError} from './envelope.js';
import type {MemoryRowScope} from './row-codec.js';
export function createMemoryUnlockSession(now:()=>number=()=>performance.now(),hostCurrent:()=>boolean=()=>true,hostCheck:()=>Promise<boolean>=async()=>true) {
 const lockListeners=new Set<()=>void>();let expiryTimer:ReturnType<typeof setTimeout>|undefined;
 let material:Buffer|undefined,scope:Readonly<MemoryRowScope>|undefined,keyId='',epoch=0,expires=0;
 function lock(){if(expiryTimer){clearTimeout(expiryTimer);expiryTimer=undefined;}material?.fill(0);material=undefined;scope=undefined;keyId='';expires=0;epoch++;for(const listener of [...lockListeners])try{listener();}catch{}}
 function current(){
  let hostAllowed=false;try{hostAllowed=hostCurrent()===true;}catch{}
  const at=now();
  if(!hostAllowed||!Number.isFinite(at)||!material||at>=expires){if(material)lock();return false;}
  return true;
 }
 function armExpiry(){if(!material)return;const remaining=expires-now();if(!Number.isFinite(remaining)||remaining<=0){lock();return;}expiryTimer=setTimeout(()=>{expiryTimer=undefined;if(current())armExpiry();},Math.max(1,Math.ceil(remaining)));expiryTimer.unref?.();}
 return {
  /** Trusted host supplies an already-unwrapped member key; no fallback or automatic recovery. */
  unlock(input:Buffer,id:string,principal:MemoryRowScope,ttlMs=300000){
   lock();
   if(!Buffer.isBuffer(input)||input.length!==32||typeof id!=='string'||!id||id.length>256||!principal||typeof principal.ownerId!=='string'||!principal.ownerId||typeof principal.memberId!=='string'||!principal.memberId||!Number.isFinite(ttlMs)||ttlMs<1||ttlMs>3600000)throw new MemoryCipherError();
   const at=now();if(hostCurrent()!==true||!Number.isFinite(at))throw new MemoryCipherError();
   material=Buffer.from(input);scope=Object.freeze({...principal});keyId=id;expires=at+ttlMs;armExpiry();
  },
  lock,
  subscribeLock(listener:()=>void){if(typeof listener!=='function')throw new MemoryCipherError();lockListeners.add(listener);return()=>{lockListeners.delete(listener);};},
  /** Any authoritative permission/session change revokes every outstanding capture. */
  invalidatePermissions(){lock();},
  isUnlocked(){return current();},
  capture(){
   if(!current()||!scope)throw new MemoryCipherError();
   const capturedEpoch=epoch,capturedScope=scope;
   const isCurrent=()=>current()&&epoch===capturedEpoch;
   return Object.freeze({scope:capturedScope,isCurrent,async resolveKey(metadata:Readonly<Record<string,unknown>>){
    if(!isCurrent()||!material||metadata.user_id!==capturedScope.ownerId)throw new MemoryCipherError();
    let allowed=false;try{allowed=await hostCheck()===true;}catch{}if(!allowed||!isCurrent()||!material){lock();throw new MemoryCipherError();}
    return {id:keyId,key:Buffer.from(material),scope:{...capturedScope}};
   }});
  },
 };
}
