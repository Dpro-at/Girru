import {captureUnverifiedMemoryRestoreTransport} from './restore-transport.js';
/** Authenticated recovery verified on a declared-surface copy before explicit protected-master enrollment. */
import type {StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {recoverMemoryMasterKey,unlockMemoryDataKey,MemoryCipherError,type MemoryRecoveryRecord,type WrappedMemoryDataKey} from './envelope.js';
import {deriveMemoryHostKeyMaterial} from './host-key-material.js';
import {captureMemoryRestoreAnchor,captureMemoryRestorePackage,sameMemoryRestoreAnchor,type MemoryRestorePackage} from './restore-package.js';
import {verifyMemorySurfaceSnapshot} from './copy-manifest.js';
import {memoryRowSurfaceManifest} from './row-codec.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
import {createMemoryReadAuditStore,type MemoryReadIntent} from './read-audit.js';
import type {MemoryRestoreAuditCustody} from './restore-host.js';
import {createMemoryRecoveryIntentStore} from './recovery-intent-store.js';
export async function recoverAuthenticatedMemoryMasterOnCopy(input:{runner:StepRunner;token:string;ownerId:string;memberId:string;recoveryRecord:MemoryRecoveryRecord;recoveryCode:string;memberKey:WrappedMemoryDataKey;package:MemoryRestorePackage;captureAuthority:()=>Promise<MemoryRestoreAuthorityLease|null>;authorizeRecovery:()=>Promise<boolean>;auditCustody:MemoryRestoreAuditCustody;authorizeRecoveryCopy:(runner:StepRunner)=>Promise<{copyId:string;isCurrent:()=>boolean}|null>;enrollProtectedMaster:(master:Buffer)=>Promise<boolean>}){
 const {runner,token,ownerId,memberId,captureAuthority,authorizeRecovery,auditCustody,authorizeRecoveryCopy,enrollProtectedMaster}=input;
 let master:Buffer|undefined,key:Buffer|undefined,serviceKeys:ReturnType<typeof deriveMemoryHostKeyMaterial>|undefined,audit:ReturnType<typeof createMemoryReadAuditStore>|undefined;
 try{
  const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};boundary();
  if([captureAuthority,authorizeRecovery,authorizeRecoveryCopy,auditCustody?.capture,auditCustody?.advance,enrollProtectedMaster].some(fn=>typeof fn!=='function')||typeof input.recoveryCode!=='string'||input.recoveryCode.length>256||!input.recoveryRecord||typeof input.recoveryRecord.id!=='string'||typeof input.recoveryRecord.wrapped!=='string'||Buffer.byteLength(input.recoveryRecord.wrapped)>16384||!input.memberKey||typeof input.memberKey.id!=='string'||typeof input.memberKey.wrapped!=='string'||Buffer.byteLength(input.memberKey.wrapped)>16384)throw new MemoryCipherError();
  const transport=captureUnverifiedMemoryRestoreTransport(input.package);
  // The host proves physical isolation before even reading authentication rows or writing attempt/audit evidence.
  const copy=await authorizeRecoveryCopy(runner);boundary();if(!copy||typeof copy.copyId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(copy.copyId)||typeof copy.isCurrent!=='function'||!copy.isCurrent())throw new MemoryCipherError();const copyCurrent=copy.isCurrent.bind(copy);
  if(!copyCurrent())throw new MemoryCipherError();
  const recovery={...input.recoveryRecord},memberKey={...input.memberKey},recoveryCode=input.recoveryCode,owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(owner.ownerId!==ownerId)throw new MemoryCipherError();
  const authority=await captureAuthority();boundary();if(!authority||typeof authority.isCurrent!=='function'||!authority.isCurrent())throw new MemoryCipherError();const anchor=captureMemoryRestoreAnchor(authority.anchor),current=authority.isCurrent.bind(authority);if(anchor.ownerId!==ownerId||anchor.memberId!==memberId||anchor.keyId!==memberKey.id)throw new MemoryCipherError();
  const check=async()=>{boundary();if(!copyCurrent()||!current())throw new MemoryCipherError();const fresh=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(fresh)!==JSON.stringify(owner)||!copyCurrent()||!current())throw new MemoryCipherError();const trusted=await captureAuthority();boundary();if(!copyCurrent()||!trusted||!trusted.isCurrent()||!sameMemoryRestoreAnchor(anchor,trusted.anchor)||!current())throw new MemoryCipherError();};
  if(await authorizeRecovery()!==true)throw new MemoryCipherError();await check();if(await createMemoryRecoveryIntentStore(runner,ownerId).append({purpose:'memory-key-recovery',ownerId,memberId,authorityId:anchor.authorityId,epoch:anchor.epoch})!==true)throw new MemoryCipherError();await check();
  master=recoverMemoryMasterKey(recovery,recoveryCode,ownerId);serviceKeys=deriveMemoryHostKeyMaterial(master,{ownerId,memberId,authorityId:anchor.authorityId});
  const candidate=captureMemoryRestorePackage(transport,serviceKeys.verificationKey);if(!sameMemoryRestoreAnchor(candidate.anchor,anchor))throw new MemoryCipherError();
  const records:MemoryReadIntent['records']=[];for(const batch of candidate.snapshot.batches){const surface=memoryRowSurfaceManifest().find(s=>s.table===batch.table);if(!surface)throw new MemoryCipherError();for(const row of batch.rows){const id=row[surface.id];if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(id))throw new MemoryCipherError();records.push({table:batch.table,id});}}
  audit=createMemoryReadAuditStore(runner,ownerId,serviceKeys.auditKey);await audit.initialize();await check();
  const captureAudit=auditCustody.capture.bind(auditCustody),advanceAudit=auditCustody.advance.bind(auditCustody);
  const initialAudit=await captureAudit();await check();if(!initialAudit||initialAudit.head.ownerId!==ownerId||typeof initialAudit.isCurrent!=='function'||!initialAudit.isCurrent())throw new MemoryCipherError();
  await audit.verify({...initialAudit.head});await check();if(!initialAudit.isCurrent())throw new MemoryCipherError();
  const recordRead=async(intent:MemoryReadIntent)=>{
   await check();const prior=await captureAudit();await check();if(!prior||prior.head.ownerId!==ownerId||typeof prior.isCurrent!=='function'||!prior.isCurrent())throw new MemoryCipherError();const expected={...prior.head},priorCurrent=prior.isCurrent.bind(prior);
   await audit!.verify(expected);await check();if(!priorCurrent())throw new MemoryCipherError();const next=await audit!.append(expected,intent);await check();if(!priorCurrent()||await advanceAudit({...expected},{...next})!==true)throw new MemoryCipherError();await check();const fresh=await captureAudit();await check();if(!fresh||!fresh.isCurrent()||JSON.stringify(fresh.head)!==JSON.stringify(next))throw new MemoryCipherError();await audit!.verify(next);return true;
  };
  for(let i=0;i<records.length;i+=500){await check();if(await recordRead({readerKind:'user',readerId:ownerId,purpose:'migration-verify',records:records.slice(i,i+500)})!==true)throw new MemoryCipherError();await check();}
  key=unlockMemoryDataKey(memberKey,master,ownerId,memberId);verifyMemorySurfaceSnapshot(candidate.snapshot,{ownerId,memberId},key,memberKey.id,serviceKeys.verificationKey);await check();
  const enrollment=Buffer.from(master);try{if(await enrollProtectedMaster(enrollment)!==true)throw new MemoryCipherError();}finally{enrollment.fill(0);}await check();
  const finalOwner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(finalOwner)!==JSON.stringify(owner)||!current())throw new MemoryCipherError();
  return{verifiedDeclaredSurfaces:true as const,copyId:copy.copyId,activationReady:false as const};
 }catch{throw new MemoryCipherError();}finally{master?.fill(0);key?.fill(0);serviceKeys?.close();audit?.close();}
}
