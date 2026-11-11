/** Owner-authenticated replacement material from an EXISTING protected master. Never enrolls a new master. */
import type {StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createMemoryDataKey,unlockMemoryDataKey,MemoryCipherError} from './envelope.js';
import {captureMemoryRestoreAnchor,sameMemoryRestoreAnchor} from './restore-package.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
export function createAuthenticatedMemoryReplacementProvisioner(input:{runner:StepRunner;token:string;ownerId:string;memberId:string;captureAuthority:()=>Promise<MemoryRestoreAuthorityLease|null>;readProtectedMaster:()=>Promise<Buffer>;authorizeRotation:()=>Promise<boolean>}){
 const {runner,token,ownerId,memberId,captureAuthority,readProtectedMaster,authorizeRotation}=input;let busy=false,closed=false;
 if(typeof authorizeRotation!=='function'||typeof captureAuthority!=='function'||typeof readProtectedMaster!=='function')throw new MemoryCipherError();
 const boundary=()=>{if(closed||runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};
 return{
  async provision(){boundary();if(busy)throw new MemoryCipherError();busy=true;let master:Buffer|undefined,key:Buffer|undefined;
   try{
    const owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(owner.ownerId!==ownerId)throw new MemoryCipherError();
    const authority=await captureAuthority();boundary();if(!authority||typeof authority.isCurrent!=='function'||!authority.isCurrent())throw new MemoryCipherError();const previous=captureMemoryRestoreAnchor(authority.anchor),current=authority.isCurrent.bind(authority);if(previous.ownerId!==ownerId||previous.memberId!==memberId)throw new MemoryCipherError();
    if(await authorizeRotation()!==true)throw new MemoryCipherError();boundary();if(!current())throw new MemoryCipherError();const supplied=await readProtectedMaster();if(!Buffer.isBuffer(supplied))throw new MemoryCipherError();try{if(supplied.length!==32)throw new MemoryCipherError();master=Buffer.from(supplied);}finally{supplied.fill(0);}boundary();
    const record=createMemoryDataKey(master,ownerId,memberId);key=unlockMemoryDataKey(record,master,ownerId,memberId);const fresh=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();const head=await captureAuthority();boundary();if(JSON.stringify(fresh)!==JSON.stringify(owner)||!head||!head.isCurrent()||!sameMemoryRestoreAnchor(previous,head.anchor)||!current())throw new MemoryCipherError();
    const finalOwner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(finalOwner)!==JSON.stringify(owner)||!head.isCurrent()||!current())throw new MemoryCipherError();
    const result={...record,key};key=undefined;return result;
   }catch{throw new MemoryCipherError();}finally{master?.fill(0);key?.fill(0);busy=false;}
  },
  close(){closed=true;},
 };
}
