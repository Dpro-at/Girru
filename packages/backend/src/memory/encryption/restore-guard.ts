import {assertNoUnresolvedDisclosureHolds,type VerifiedDisclosureInventory} from './disclosure-history.js';
import {beforeEncryptedMemoryEffect,isProtectedMemoryRunner,memoryEffectDigest} from './memory-effect.js';
/** Authenticated declared-surface restore into a host-authorized EMPTY quarantined target only. */
import {one,run,type StepRunner,type Step} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {captureMemoryRestoreAnchor,captureMemoryRestorePackage,sameMemoryRestoreAnchor,type MemoryRestoreAnchor,type MemoryRestorePackage} from './restore-package.js';
import {writeGuardedMemoryRestoreCopy} from './copy-writer.js';
import {memoryRowSurfaceManifest} from './row-codec.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
export type MemoryRestoreAuthorityLease={anchor:MemoryRestoreAnchor;isCurrent:()=>boolean};
export type MemoryRestoreTargetLease={targetId:string;storageId?:string;isCurrent:()=>boolean};
export type MemoryRestoreIntent={purpose:'memory-restore-copy';ownerId:string;memberId:string;snapshotId:string;authorityId:string;epoch:number;forgetSequence:number;targetId:string};
export async function restoreAuthenticatedMemoryToEmptyCopy(input:{
 runner:StepRunner;targetRunner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;
 package:MemoryRestorePackage;verificationKey:Buffer;
 /** Trusted host custody OUTSIDE restored data. Null/missing/stale authority never enrolls a replacement. */
 captureAuthority:()=>Promise<MemoryRestoreAuthorityLease|null>;
 captureDisclosureInventory?:()=>Promise<VerifiedDisclosureInventory>;
 /** Trusted host must explicitly identify and quarantine THIS runner; never authorize the original profile. */
 authorizeEmptyTarget:(runner:StepRunner)=>Promise<MemoryRestoreTargetLease|null>;
 recordRestoreIntent:(intent:MemoryRestoreIntent)=>Promise<boolean>;
 recordRead:(intent:MemoryReadIntent)=>Promise<boolean>;
}):Promise<{snapshotId:string;targetId:string;restoredDeclaredSurfaces:true;activationReady:false}>{
 const {runner,targetRunner,token,session,captureAuthority,authorizeEmptyTarget,recordRestoreIntent,recordRead}=input;
 let key:Buffer|undefined,verificationKey:Buffer|undefined;
 try{
  const boundary=()=>{if(process.env.AGENT_PLAYER_READONLY==='1'||runner.inTransaction?.()!==false||targetRunner.inTransaction?.()!==false)throw new MemoryCipherError();};
  boundary();if(runner===targetRunner||!Buffer.isBuffer(input.verificationKey)||input.verificationKey.length!==32||[captureAuthority,authorizeEmptyTarget,recordRestoreIntent,recordRead].some(callback=>typeof callback!=='function'))throw new MemoryCipherError();
  verificationKey=Buffer.from(input.verificationKey);const candidate=captureMemoryRestorePackage(input.package,verificationKey),anchor=candidate.anchor;
  const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();
  if(owner.ownerId!==lease.scope.ownerId||anchor.ownerId!==owner.ownerId||anchor.memberId!==lease.scope.memberId||!lease.isCurrent())throw new MemoryCipherError();
  const authority=await captureAuthority();boundary();if(!authority||typeof authority.isCurrent!=='function')throw new MemoryCipherError();
  const trusted=captureMemoryRestoreAnchor(authority.anchor),authorityCurrent=authority.isCurrent.bind(authority);
  if(!sameMemoryRestoreAnchor(anchor,trusted)||authorityCurrent()!==true)throw new MemoryCipherError();
  const target=await authorizeEmptyTarget(targetRunner);boundary();if(!target||typeof target.targetId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(target.targetId)||typeof target.isCurrent!=='function')throw new MemoryCipherError();
  const targetId=target.targetId,targetCurrent=target.isCurrent.bind(target);
  const current=()=>process.env.AGENT_PLAYER_READONLY!=='1'&&lease.isCurrent()&&authorityCurrent()===true&&targetCurrent()===true&&Date.now()<owner.validUntil;
  const check=async()=>{
   boundary();if(!current())throw new MemoryCipherError();
   const fresh=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(fresh)!==JSON.stringify(owner)||!current())throw new MemoryCipherError();
   const authorityNow=await captureAuthority();boundary();if(!authorityNow||typeof authorityNow.isCurrent!=='function'||authorityNow.isCurrent()!==true||!sameMemoryRestoreAnchor(trusted,captureMemoryRestoreAnchor(authorityNow.anchor))||!current())throw new MemoryCipherError();
  };
  await check();if(input.captureDisclosureInventory){const inventory=await input.captureDisclosureInventory();await check();if(inventory.ownerId!==owner.ownerId||inventory.memberId!==lease.scope.memberId||!sameMemoryRestoreAnchor(inventory.authority,trusted))throw new MemoryCipherError();assertNoUnresolvedDisclosureHolds(inventory);}else if(isProtectedMemoryRunner(runner))throw new MemoryCipherError();
  await beforeEncryptedMemoryEffect({runner,action:'restore-profile',auth:owner,isCurrent:current,targetDigest:memoryEffectDigest([candidate.snapshot.snapshotId,candidate.packageMac,targetId,trusted])});
  await check();if(await recordRestoreIntent({purpose:'memory-restore-copy',ownerId:owner.ownerId,memberId:lease.scope.memberId,snapshotId:candidate.snapshot.snapshotId,authorityId:trusted.authorityId,epoch:trusted.epoch,forgetSequence:trusted.forgetSequence,targetId})!==true)throw new MemoryCipherError();await check();
  const records:MemoryReadIntent['records']=[];
  for(const batch of candidate.snapshot.batches){const surface=memoryRowSurfaceManifest().find(item=>item.table===batch.table);if(!surface)throw new MemoryCipherError();for(const row of batch.rows){const id=row[surface.id];if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(id))throw new MemoryCipherError();records.push({table:batch.table,id});}}
  for(let offset=0;offset<records.length;offset+=500){await check();if(await recordRead({readerKind:'user',readerId:owner.ownerId,purpose:'migration-verify',records:records.slice(offset,offset+500)})!==true)throw new MemoryCipherError();await check();}
  const material=await lease.resolveKey({user_id:owner.ownerId});key=material.key;if(material.id!==trusted.keyId)throw new MemoryCipherError();await check();
  const receipt=function*():Step<void>{
   if(!current())throw new MemoryCipherError();
   yield* run('CREATE TABLE IF NOT EXISTS memory_encryption_restore_receipts(owner_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,authority_id TEXT NOT NULL,epoch BIGINT NOT NULL,forget_sequence BIGINT NOT NULL,forget_mac TEXT NOT NULL,package_mac TEXT NOT NULL,target_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(owner_id,snapshot_id))');
   yield* run("INSERT INTO memory_encryption_restore_receipts(owner_id,snapshot_id,authority_id,epoch,forget_sequence,forget_mac,package_mac,target_id,state) VALUES(?,?,?,?,?,?,?,?,'copied-unactivated')",owner.ownerId,candidate.snapshot.snapshotId,trusted.authorityId,trusted.epoch,trusted.forgetSequence,trusted.forgetMac,candidate.packageMac,targetId);
   const stored=yield* one<{authority_id:string;epoch:number|string;forget_sequence:number|string;forget_mac:string;package_mac:string;target_id:string;state:string}>('SELECT authority_id,epoch,forget_sequence,forget_mac,package_mac,target_id,state FROM memory_encryption_restore_receipts WHERE owner_id=? AND snapshot_id=?',owner.ownerId,candidate.snapshot.snapshotId);
   if(!stored||stored.authority_id!==trusted.authorityId||Number(stored.epoch)!==trusted.epoch||Number(stored.forget_sequence)!==trusted.forgetSequence||stored.forget_mac!==trusted.forgetMac||stored.package_mac!==candidate.packageMac||stored.target_id!==targetId||stored.state!=='copied-unactivated'||!current())throw new MemoryCipherError();
  };
  await writeGuardedMemoryRestoreCopy(targetRunner,candidate.snapshot,lease.scope,key,material.id,verificationKey,receipt,current);
  // A changed authority after target commit refuses success; target remains copied-unactivated, never selected.
  await check();return{snapshotId:candidate.snapshot.snapshotId,targetId,restoredDeclaredSurfaces:true,activationReady:false};
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);verificationKey?.fill(0);}
}
