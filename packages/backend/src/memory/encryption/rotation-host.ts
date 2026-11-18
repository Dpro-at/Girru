import {beforeEncryptedMemoryEffect,memoryEffectDigest} from './memory-effect.js';
/** Whole declared-surface rotation into an explicitly empty target. No source rewrite or activation. */
import {one,run,type StepRunner,type Step} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {createMemoryForgetAuthorityStore} from './forget-authority-store.js';
import {createAuthenticatedMemoryRestoreHost} from './restore-host.js';
import {prepareEncryptedMemoryRotationCopy} from './rotation-copy.js';
import {captureMemoryRestoreAnchor,sameMemoryRestoreAnchor} from './restore-package.js';
import {writeGuardedMemoryRestoreCopy} from './copy-writer.js';
import {createProvisionedMemoryMemberKeyStore} from './member-key-store.js';
import type {MemoryRestoreTargetLease} from './restore-guard.js';
import {MemoryCipherError,type WrappedMemoryDataKey} from './envelope.js';
export async function rotateAuthenticatedMemoryToQuarantine(input:{runner:StepRunner;targetRunner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;authority:ReturnType<typeof createMemoryForgetAuthorityStore>;restoreHost:ReturnType<typeof createAuthenticatedMemoryRestoreHost>;verificationKey:Buffer;authorizeEmptyTarget:(runner:StepRunner)=>Promise<MemoryRestoreTargetLease|null>;provisionReplacement:()=>Promise<WrappedMemoryDataKey&{key:Buffer}>}){
 const {runner,targetRunner,token,session,authority,restoreHost,authorizeEmptyTarget,provisionReplacement}=input;
 let oldKey:Buffer|undefined,newKey:Buffer|undefined,verificationKey:Buffer|undefined;
 try{
  const boundary=()=>{if(runner.inTransaction?.()!==false||targetRunner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};boundary();
  if(runner===targetRunner||!Buffer.isBuffer(input.verificationKey)||input.verificationKey.length!==32||typeof authorizeEmptyTarget!=='function'||typeof provisionReplacement!=='function')throw new MemoryCipherError();verificationKey=Buffer.from(input.verificationKey);
  const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(owner.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  const oldAuthority=await authority.capture(),previous=captureMemoryRestoreAnchor(oldAuthority.anchor),authorityCurrent=oldAuthority.isCurrent.bind(oldAuthority);boundary();if(previous.ownerId!==owner.ownerId||previous.memberId!==lease.scope.memberId||!authorityCurrent())throw new MemoryCipherError();
  const target=await authorizeEmptyTarget(targetRunner);boundary();if(!target||typeof target.isCurrent!=='function'||typeof target.targetId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(target.targetId))throw new MemoryCipherError();const targetId=target.targetId,targetCurrent=target.isCurrent.bind(target);
  const current=()=>lease.isCurrent()&&authorityCurrent()&&targetCurrent()&&Date.now()<owner.validUntil&&process.env.AGENT_PLAYER_READONLY!=='1';
  const check=async()=>{boundary();if(!current())throw new MemoryCipherError();const fresh=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(fresh)!==JSON.stringify(owner)||!current())throw new MemoryCipherError();};
  await check();const captured=await restoreHost.capturePackage();await check();if(!sameMemoryRestoreAnchor(captured.anchor,previous))throw new MemoryCipherError();
  const material=await lease.resolveKey({user_id:owner.ownerId});oldKey=material.key;await check();if(material.id!==previous.keyId)throw new MemoryCipherError();
  // The native write admission survives this operation's own key/head transition,
  // but remains bound to the actual owner control frame and target lease.
  await beforeEncryptedMemoryEffect({runner,action:'rotate-profile',auth:owner,isCurrent:()=>targetCurrent()&&Date.now()<owner.validUntil&&process.env.AGENT_PLAYER_READONLY!=='1',targetDigest:memoryEffectDigest([previous,targetId,captured.snapshot.snapshotId])});
  const supplied=await provisionReplacement();try{if(!supplied||typeof supplied.id!=='string'||!supplied.id||supplied.id.length>256||typeof supplied.wrapped!=='string'||Buffer.byteLength(supplied.wrapped)>16384||!Buffer.isBuffer(supplied.key)||supplied.key.length!==32||supplied.id===previous.keyId)throw new MemoryCipherError();newKey=Buffer.from(supplied.key);}finally{if(Buffer.isBuffer(supplied?.key))supplied.key.fill(0);}const wrapped={id:supplied.id,wrapped:supplied.wrapped};await check();
  const next=await authority.previewKeyEpoch(wrapped.id);await check();
  const prepared=prepareEncryptedMemoryRotationCopy({snapshot:captured.snapshot,scope:lease.scope,previous,next,oldKey,newKey,verificationKey,isCurrent:current});
  const receipt=function*():Step<void>{
   if(!current())throw new MemoryCipherError();yield* run('CREATE TABLE IF NOT EXISTS memory_encryption_rotation_receipts(owner_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,target_id TEXT NOT NULL,expected_head TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(owner_id,snapshot_id))');
   yield* run("INSERT INTO memory_encryption_rotation_receipts(owner_id,snapshot_id,target_id,expected_head,state) VALUES(?,?,?,?,'copied-unactivated')",owner.ownerId,prepared.snapshot.snapshotId,targetId,JSON.stringify(next));
  };
  await writeGuardedMemoryRestoreCopy(targetRunner,prepared.snapshot,lease.scope,newKey,wrapped.id,verificationKey,receipt,current);await check();
  const keys=createProvisionedMemoryMemberKeyStore(targetRunner);await keys.initialize();await check();await keys.registerExisting(owner.ownerId,lease.scope.memberId,wrapped,async()=>{await check();return true;});await check();
  // Only a fully copied, still-quarantined target may advance the current key epoch.
  const committed=await authority.append({kind:'key-epoch',keyId:wrapped.id});boundary();if(!sameMemoryRestoreAnchor(committed,next)||!lease.isCurrent()||!targetCurrent())throw new MemoryCipherError();
  const fresh=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent()||!targetCurrent())throw new MemoryCipherError();
  await targetRunner.tx(function*(){
   const changed=yield* run("UPDATE memory_encryption_rotation_receipts SET state='epoch-committed-unactivated' WHERE owner_id=? AND snapshot_id=? AND state='copied-unactivated' AND expected_head=?",owner.ownerId,prepared.snapshot.snapshotId,JSON.stringify(next));if(changed.changes!==1)throw new MemoryCipherError();
   const row=yield* one<{state:string}>('SELECT state FROM memory_encryption_rotation_receipts WHERE owner_id=? AND snapshot_id=?',owner.ownerId,prepared.snapshot.snapshotId);if(row?.state!=='epoch-committed-unactivated'||!lease.isCurrent()||!targetCurrent())throw new MemoryCipherError();
  },{immediate:true});boundary();const actual=await authority.capture();if(!actual.isCurrent()||!sameMemoryRestoreAnchor(actual.anchor,next)||!targetCurrent()||!lease.isCurrent())throw new MemoryCipherError();
  const finalOwner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(finalOwner)!==JSON.stringify(owner)||!actual.isCurrent()||!targetCurrent()||!lease.isCurrent())throw new MemoryCipherError();
  return{snapshotId:prepared.snapshot.snapshotId,targetId,keyId:wrapped.id,epoch:next.epoch,activationReady:false as const};
 }catch{throw new MemoryCipherError();}finally{session.lock();oldKey?.fill(0);newKey?.fill(0);verificationKey?.fill(0);}
}
