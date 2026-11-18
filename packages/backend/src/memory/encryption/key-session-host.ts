/** Explicit existing-key unlock. Missing key/authority refuses; never creates keys or discovers profiles. */
import {one,tableExists,type StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {unlockMemoryDataKey,MemoryCipherError,type WrappedMemoryDataKey} from './envelope.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {captureMemoryRestoreAnchor,sameMemoryRestoreAnchor} from './restore-package.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
export function createExistingMemoryKeySessionHost(input:{runner:StepRunner;token:string;ownerId:string;memberId:string;session:ReturnType<typeof createMemoryUnlockSession>;captureAuthority:()=>Promise<MemoryRestoreAuthorityLease|null>;/** Returns a fresh owned buffer, wiped immediately after copying. */readProtectedMaster:()=>Promise<Buffer>}){
 const {runner,token,ownerId,memberId,session,captureAuthority,readProtectedMaster}=input;
 if(![ownerId,memberId].every(id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(id))||typeof captureAuthority!=='function'||typeof readProtectedMaster!=='function')throw new MemoryCipherError();
 let closed=false,busy=false,generation=0;
 const boundary=()=>{if(closed||runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};
 async function authenticate(){boundary();const owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(owner.ownerId!==ownerId)throw new MemoryCipherError();return owner;}
 return{
  async unlock(ttlMs=300000){
   boundary();if(busy)throw new MemoryCipherError();busy=true;session.lock();const operationGeneration=++generation;let master:Buffer|undefined,key:Buffer|undefined;
   try{
    if(!Number.isFinite(ttlMs)||ttlMs<1||ttlMs>3600000)throw new MemoryCipherError();const owner=await authenticate(),authority=await captureAuthority();boundary();
    if(!authority||typeof authority.isCurrent!=='function'||authority.isCurrent()!==true)throw new MemoryCipherError();const anchor=captureMemoryRestoreAnchor(authority.anchor),current=authority.isCurrent.bind(authority);
    if(anchor.ownerId!==ownerId||anchor.memberId!==memberId)throw new MemoryCipherError();
    const record=await runner.tx(function*(){
     if(!(yield* tableExists('memory_encryption_member_keys')))throw new MemoryCipherError();
     return yield* one<WrappedMemoryDataKey>('SELECT key_id AS id,CASE WHEN length(wrapped)<=16384 THEN wrapped ELSE NULL END AS wrapped FROM memory_encryption_member_keys WHERE owner_id=? AND member_id=? AND key_id=?',ownerId,memberId,anchor.keyId);
    },{immediate:true});boundary();if(!record||record.id!==anchor.keyId||typeof record.wrapped!=='string'||Buffer.byteLength(record.wrapped)>16384||!current()||operationGeneration!==generation)throw new MemoryCipherError();
    const fresh=await authenticate();if(JSON.stringify(fresh)!==JSON.stringify(owner)||!current())throw new MemoryCipherError();
    const supplied=await readProtectedMaster();if(!Buffer.isBuffer(supplied))throw new MemoryCipherError();try{if(supplied.length!==32)throw new MemoryCipherError();master=Buffer.from(supplied);}finally{supplied.fill(0);}boundary();
    if(operationGeneration!==generation||!current())throw new MemoryCipherError();key=unlockMemoryDataKey(record,master,ownerId,memberId);
    const head=await captureAuthority();boundary();if(!head||head.isCurrent()!==true||!sameMemoryRestoreAnchor(anchor,head.anchor)||!current()||operationGeneration!==generation||JSON.stringify(await authenticate())!==JSON.stringify(owner))throw new MemoryCipherError();
    const unchanged=await runner.tx(function*(){
     const freshOwner=yield* authenticatedMemoryOwnerStep(token);if(JSON.stringify(freshOwner)!==JSON.stringify(owner))throw new MemoryCipherError();
     const stored=yield* one<WrappedMemoryDataKey>('SELECT key_id AS id,CASE WHEN length(wrapped)<=16384 THEN wrapped ELSE NULL END AS wrapped FROM memory_encryption_member_keys WHERE owner_id=? AND member_id=? AND key_id=?',ownerId,memberId,record.id);
     return stored?.id===record.id&&stored.wrapped===record.wrapped;
    },{immediate:true});
    boundary();if(!unchanged||!current()||operationGeneration!==generation)throw new MemoryCipherError();session.unlock(key,record.id,{ownerId,memberId},Math.min(ttlMs,owner.validUntil-Date.now()));
   }catch{session.lock();throw new MemoryCipherError();}finally{master?.fill(0);key?.fill(0);busy=false;}
  },
  lock(){generation++;session.lock();},
  invalidatePermissions(){generation++;session.invalidatePermissions();},
  close(){closed=true;generation++;session.lock();},
 };
}
