import {memoryControlQuery} from './control-runner.js';
import {currentMemoryReadOrigin} from './read-origin-context.js';
import {currentStoredRunPrincipal} from './stored-run-principal.js';
import {isOriginalMemoryMaintenanceAudit} from './internal-maintenance-audit.js';
import type {VerifiedDisclosureInventory} from './disclosure-history.js';
import type {AuxiliarySourceCapture} from './auxiliary-source.js';
import type {LegacyGraphSourceCapture} from './legacy-graph-migration.js';
/** Explicit internal restore composition. No default authority enrollment, target selection or activation. */
import type {StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {createMemoryReadAuditStore,type MemoryAuditAnchor,type MemoryReadIntent} from './read-audit.js';
import {createMemoryRestoreIntentStore} from './restore-intent-store.js';
import {restoreAuthenticatedMemoryToEmptyCopy,type MemoryRestoreAuthorityLease,type MemoryRestoreTargetLease} from './restore-guard.js';
import {captureMemoryRestorePackage,type MemoryRestorePackage} from './restore-package.js';
import {MemoryCipherError} from './envelope.js';
import {captureAuthenticatedEncryptedRestorePackage} from './restore-capture.js';
export type MemoryRestoreAuditCustody={
 /** Head must come from trusted custody outside restored data; missing custody refuses, never enrolls. */
 capture:()=>Promise<{head:MemoryAuditAnchor;isCurrent:()=>boolean}|null>;
 /** Atomic compare-and-swap in trusted custody; false/failure requires reconciliation, never automatic retry. */
 advance:(expected:MemoryAuditAnchor,next:MemoryAuditAnchor)=>Promise<boolean>;
};
export function createAuthenticatedMemoryRestoreHost(input:{runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;auditKey:Buffer;verificationKey:Buffer;auditCustody:MemoryRestoreAuditCustody;captureAuthority:()=>Promise<MemoryRestoreAuthorityLease|null>;captureDisclosureInventory?:()=>Promise<VerifiedDisclosureInventory>;authorizeEmptyTarget:(runner:StepRunner)=>Promise<MemoryRestoreTargetLease|null>}){
 const {runner,token,session,auditCustody,captureAuthority,authorizeEmptyTarget}=input;
 if(!Buffer.isBuffer(input.verificationKey)||input.verificationKey.length!==32||!auditCustody||typeof auditCustody.capture!=='function'||typeof auditCustody.advance!=='function')throw new MemoryCipherError();
 const verificationKey=Buffer.from(input.verificationKey),scope=session.capture().scope,ownerId=scope.ownerId;
 const audit=createMemoryReadAuditStore(runner,ownerId,input.auditKey),intents=createMemoryRestoreIntentStore(runner,ownerId);
 let state:'new'|'starting'|'ready'|'failed'|'closed'='new',busy=false,active:Promise<unknown>|undefined;
 const boundary=()=>{if(state==='closed'||state==='failed'||runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};
 const authenticate=async(allowStored=false)=>{boundary();const stored=currentStoredRunPrincipal();if(stored){if(!allowStored||stored.control.ownerId!==ownerId||!stored.isCurrent())throw new MemoryCipherError();const lease=session.capture();await runner.tx(()=>memoryControlQuery(()=>stored.control.assertCurrentStep()),{immediate:true});boundary();if(!lease.isCurrent()||!stored.isCurrent())throw new MemoryCipherError();return lease;}const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(owner.ownerId!==ownerId||lease.scope.ownerId!==ownerId||lease.scope.memberId!==scope.memberId||!lease.isCurrent())throw new MemoryCipherError();return lease;};
 const captureHead=async()=>{
  boundary();const captured=await auditCustody.capture();boundary();if(!captured||typeof captured.isCurrent!=='function'||captured.isCurrent()!==true)throw new MemoryCipherError();
  const head={...captured.head},current=captured.isCurrent.bind(captured);if(head.ownerId!==ownerId)throw new MemoryCipherError();await audit.verify(head);boundary();if(!current())throw new MemoryCipherError();return{head,current};
 };
 const recordAuditedRead=async(lease:ReturnType<typeof session.capture>,intent:MemoryReadIntent)=>{
     const prior=await captureHead();await authenticate(true);if(!lease.isCurrent()||!prior.current())throw new MemoryCipherError();
     const next=await audit.append(prior.head,intent);boundary();if(!lease.isCurrent()||!prior.current())throw new MemoryCipherError();
     if(await auditCustody.advance({...prior.head},{...next})!==true)throw new MemoryCipherError();boundary();await authenticate(true);
     const fresh=await captureHead();if(!lease.isCurrent()||JSON.stringify(fresh.head)!==JSON.stringify(next))throw new MemoryCipherError();return true;
 };
 const failHost=()=>{if(state!=='closed')state='failed';session.lock();};
 async function perform<T>(operation:()=>Promise<T>):Promise<T>{
  if(busy||state==='closed'||state==='failed')throw new MemoryCipherError();busy=true;
  const pending=(async()=>{try{return await operation();}catch{failHost();throw new MemoryCipherError();}finally{busy=false;}})();active=pending;try{return await pending;}finally{if(active===pending)active=undefined;}
 }
 return{
  start:()=>perform(async()=>{if(state!=='new')throw new MemoryCipherError();state='starting';const lease=await authenticate();await audit.initialize();await intents.initialize();await captureHead();await authenticate();if(!lease.isCurrent())throw new MemoryCipherError();state='ready';}),
  recordRead:(intent:MemoryReadIntent)=>perform(async()=>{
   if(state!=='ready')throw new MemoryCipherError();const origin=currentMemoryReadOrigin(),stored=currentStoredRunPrincipal();if(stored&&intent.readerKind!=='agent'&&!isOriginalMemoryMaintenanceAudit(intent))throw new MemoryCipherError();const captured=isOriginalMemoryMaintenanceAudit(intent)?intent:{...intent,...(origin&&intent.readerKind==='user'?origin:{}),records:intent.records.map(record=>({...record}))},lease=await authenticate(true);
   return recordAuditedRead(lease,captured);
  }),
  capturePackage:(legacyGraphSource?:LegacyGraphSourceCapture,auxiliarySource?:AuxiliarySourceCapture)=>perform(async()=>{
   if(state!=='ready')throw new MemoryCipherError();const lease=await authenticate();await captureHead();
   return captureAuthenticatedEncryptedRestorePackage({runner,token,session,verificationKey,captureAuthority,legacyGraphSource,auxiliarySource,recordRead:intent=>recordAuditedRead(lease,intent)});
  }),
  restore:(targetRunner:StepRunner,restorePackage:MemoryRestorePackage)=>perform(async()=>{
   if(state!=='ready')throw new MemoryCipherError();const candidate=captureMemoryRestorePackage(restorePackage,verificationKey),lease=await authenticate();await captureHead();
   return restoreAuthenticatedMemoryToEmptyCopy({runner,targetRunner,token,session,package:candidate,verificationKey,captureAuthority,captureDisclosureInventory:input.captureDisclosureInventory,authorizeEmptyTarget,
    recordRestoreIntent:async intent=>{boundary();if(!lease.isCurrent())throw new MemoryCipherError();const ok=await intents.append(intent);await authenticate();if(!lease.isCurrent())throw new MemoryCipherError();return ok;},
    recordRead:intent=>recordAuditedRead(lease,intent),
   });
  }),
  async close(){state='closed';session.lock();try{await active;}catch{/* Failed audit requires explicit reconciliation before creating a new host. */}audit.close();verificationKey.fill(0);},
  status:()=>state,
 };
}
