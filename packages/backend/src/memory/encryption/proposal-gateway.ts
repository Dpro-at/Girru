import {captureCurrentEncryptedProposalOrigin} from './proposal-origin.js';
import {validateEncryptedDocumentRuntimeCoverage,assertEncryptedDocumentRuntimeCoverageStep} from './document-runtime-coverage.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
import {buildEncryptedReviewedReplacement} from './reviewed-replacement.js';
import {verifyEncryptedTopicClaimStep} from './topic-index.js';
import {drawerRevisionStep} from '../versions.js';
import {normalizeDrawer} from '../drawers.js';
import {memoryControlQuery} from './control-runner.js';
import {beforeEncryptedMemoryEffect,memoryEffectDigest} from './memory-effect.js';
import {assertNoUncoveredProjectCopiesStep,assertNoUncoveredExternalProjectCopiesStep} from './forget-coverage.js';
/** Internal owner preview/decision composition; higher route gates and explicit UI review remain required. */
import {one,run,dialect,type StepRunner,type SqlParam} from '../../repositories/sql-steps.js';
import {encryptMemoryRow} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import {memoryProposalFromRow} from '../memory-files.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {loadEncryptedOwnerRow} from './owner-row-loader.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {decryptMemoryRow} from './row-codec.js';
import {approveEncryptedSupersessionStep} from './proposal-decision.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
type Input={captureAuthority?:()=>Promise<MemoryRestoreAuthorityLease|null>;runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;proposalId:string;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>};
async function capture(input:Input){
 const runner=input.runner,token=input.token,session=input.session,lease=session.capture(),proposalId=input.proposalId,recordRead=input.recordRead;
 const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};boundary();
 const owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();
 if(owner.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
 const check=async()=>{try{boundary();if(!lease.isCurrent())throw new MemoryCipherError();const fresh=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();}catch{session.lock();throw new MemoryCipherError();}};
 const audit=async(table:'memories'|'memory_file_proposals',id:string,purpose:'view'|'tool')=>{if(await recordRead({readerKind:'user',readerId:owner.ownerId,purpose,records:[{table,id}]})!==true)throw new MemoryCipherError();await check();};
 return {runner,token,lease,owner,check,audit,proposalId};
}
export async function readAuthenticatedEncryptedProposal(input:Input){
 let key:Buffer|undefined;
 try{
  const c=await capture(input);await c.check();const row=await loadEncryptedOwnerRow(c.runner,'memory_file_proposals',c.owner.ownerId,c.proposalId);await c.check();if(!row)return null;
  await c.audit('memory_file_proposals',c.proposalId,'view');const material=await c.lease.resolveKey(row);key=material.key;await c.check();
  const plain=decryptMemoryRow('memory_file_proposals',row,c.lease.scope,key,material.id);
  if(plain.user_id!==c.owner.ownerId||plain.id!==c.proposalId||typeof plain.changes!=='string')throw new MemoryCipherError();
  const changes=JSON.parse(plain.changes);if(!Array.isArray(changes)||changes.length>500)throw new MemoryCipherError();
  const proposal=memoryProposalFromRow(plain);await c.check();return proposal;
 }catch{throw new MemoryCipherError();}finally{key?.fill(0);}
}
export async function approveAuthenticatedEncryptedSupersession(input:Input&{reviewHash:string;lookupKey:Buffer}){
 let key:Buffer|undefined,lookup:Buffer|undefined;
 try{
  if(!Buffer.isBuffer(input.lookupKey)||input.lookupKey.length!==32||typeof input.reviewHash!=='string'||!/^[a-f0-9]{64}$/.test(input.reviewHash))throw new MemoryCipherError();lookup=Buffer.from(input.lookupKey);const reviewHash=input.reviewHash;
  const c=await capture(input);await c.check();const documentCoverage=input.captureAuthority?await validateEncryptedDocumentRuntimeCoverage({runner:c.runner,token:c.token,session:input.session,captureAuthority:input.captureAuthority,recordRead:input.recordRead}):null;await c.check();await c.runner.tx(()=>documentCoverage?assertNoUncoveredExternalProjectCopiesStep(c.owner.ownerId):assertNoUncoveredProjectCopiesStep(c.owner.ownerId),{immediate:true});await c.check();const proposalCipher=await loadEncryptedOwnerRow(c.runner,'memory_file_proposals',c.owner.ownerId,c.proposalId);await c.check();if(!proposalCipher)throw new MemoryCipherError();
  await c.audit('memory_file_proposals',c.proposalId,'tool');const material=await c.lease.resolveKey(proposalCipher);key=material.key;await c.check();
  const proposal=decryptMemoryRow('memory_file_proposals',proposalCipher,c.lease.scope,key,material.id);
  if(proposal.id!==c.proposalId||proposal.user_id!==c.owner.ownerId||proposal.status!=='pending'||typeof proposal.conflict_with!=='string')throw new MemoryCipherError();
  const older=await loadEncryptedOwnerRow(c.runner,'memories',c.owner.ownerId,proposal.conflict_with);await c.check();if(!older)throw new MemoryCipherError();
  await c.audit('memories',proposal.conflict_with,'tool');await c.check();
  const operationKey=key,lookupKey=lookup,origin=await captureCurrentEncryptedProposalOrigin({runner:c.runner,proposal,scope:c.lease.scope,captureAuthority:input.captureAuthority});await c.check();buildEncryptedReviewedReplacement(proposalCipher,older,c.lease.scope,operationKey,material.id,reviewHash);
  const drawer=normalizeDrawer({kind:proposal.drawer_kind,key:proposal.drawer_key??''}),olderPlain=decryptMemoryRow('memories',older,c.lease.scope,operationKey,material.id);
  await c.runner.tx(function*(){if(JSON.stringify(yield* authenticatedMemoryOwnerStep(c.token))!==JSON.stringify(c.owner)||!c.lease.isCurrent()||origin&&!origin.isCurrent())throw new MemoryCipherError();const current=yield* one<Record<string,unknown>>('SELECT * FROM memory_file_proposals WHERE id=? AND user_id=?',c.proposalId,c.owner.ownerId),memory=yield* one<Record<string,unknown>>('SELECT * FROM memories WHERE id=? AND user_id=?',String(older.id),c.owner.ownerId);if(!current||!memory||canonicalEncryptedRow(current)!==canonicalEncryptedRow(proposalCipher)||canonicalEncryptedRow(memory)!==canonicalEncryptedRow(older))throw new MemoryCipherError();if(documentCoverage){yield* assertNoUncoveredExternalProjectCopiesStep(c.owner.ownerId);yield* assertEncryptedDocumentRuntimeCoverageStep(documentCoverage,c.runner,c.owner.ownerId);}else yield* assertNoUncoveredProjectCopiesStep(c.owner.ownerId);if(drawer.kind==='project'&&(yield* memoryControlQuery(()=>one('SELECT 1 AS archived FROM memory_project_scopes WHERE owner_id=? AND slug=? AND archived_at IS NOT NULL',c.owner.ownerId,drawer.key!))))throw new MemoryCipherError();const revision=(yield* drawerRevisionStep(c.owner.ownerId,drawer))+1;if(!Number.isSafeInteger(revision)||revision<1)throw new MemoryCipherError();yield* verifyEncryptedTopicClaimStep(olderPlain,lookupKey);},{immediate:true});await c.check();
  await beforeEncryptedMemoryEffect({runner:c.runner,action:'decide-supersession',auth:c.owner,isCurrent:()=>c.lease.isCurrent()&&(!origin||origin.isCurrent())&&Date.now()<c.owner.validUntil,targetDigest:memoryEffectDigest([c.proposalId,reviewHash,proposalCipher,older])});await c.check();if(documentCoverage)await documentCoverage.refresh();await c.check();
  return await c.runner.tx(function*(){if(origin&&!origin.isCurrent())throw new MemoryCipherError();if(drawer.kind==='project'&&(yield* memoryControlQuery(()=>one('SELECT 1 AS archived FROM memory_project_scopes WHERE owner_id=? AND slug=? AND archived_at IS NOT NULL',c.owner.ownerId,drawer.key!))))throw new MemoryCipherError();return yield* approveEncryptedSupersessionStep(c.token,proposalCipher,older,reviewHash,c.lease.scope,operationKey,material.id,lookupKey,c.lease.isCurrent,documentCoverage?{runner:c.runner,proof:documentCoverage}:undefined);},{immediate:true});
 }catch{throw new MemoryCipherError();}finally{key?.fill(0);lookup?.fill(0);}
}

/** A rejection never replaces/deletes the conflicting source; hash binds the exact preview. */
export async function rejectAuthenticatedEncryptedProposal(input:Input&{reviewHash:string}){
 let key:Buffer|undefined;
 try{
  const reviewHash=input.reviewHash;if(typeof reviewHash!=='string'||!/^[a-f0-9]{64}$/.test(reviewHash))throw new MemoryCipherError();const c=await capture(input);await c.check();const cipher=await loadEncryptedOwnerRow(c.runner,'memory_file_proposals',c.owner.ownerId,c.proposalId);await c.check();if(!cipher)throw new MemoryCipherError();await c.audit('memory_file_proposals',c.proposalId,'tool');const material=await c.lease.resolveKey(cipher);key=material.key;await c.check();const proposal=decryptMemoryRow('memory_file_proposals',cipher,c.lease.scope,key,material.id);
  if(proposal.status!=='pending'||proposal.decision!==null||memoryProposalFromRow(proposal).reviewHash!==reviewHash)throw new MemoryCipherError();
  const replacement=encryptMemoryRow('memory_file_proposals',{...proposal,status:'rejected',decided_by:c.owner.ownerId,decided_at:new Date().toISOString(),decision:'keep_old'},c.lease.scope,key,material.id);
  await c.runner.tx(function*(){if(JSON.stringify(yield* authenticatedMemoryOwnerStep(c.token))!==JSON.stringify(c.owner)||!c.lease.isCurrent())throw new MemoryCipherError();const current=yield* one<Record<string,unknown>>('SELECT * FROM memory_file_proposals WHERE id=? AND user_id=?',c.proposalId,c.owner.ownerId);if(!current||canonicalEncryptedRow(current)!==canonicalEncryptedRow(cipher))throw new MemoryCipherError();},{immediate:true});await c.check();
  await beforeEncryptedMemoryEffect({runner:c.runner,action:'reject-proposal',auth:c.owner,isCurrent:()=>c.lease.isCurrent()&&Date.now()<c.owner.validUntil,targetDigest:memoryEffectDigest([c.proposalId,reviewHash,cipher,replacement])});await c.check();
  await c.runner.tx(function*(){
   const owner=yield* authenticatedMemoryOwnerStep(c.token);if(JSON.stringify(owner)!==JSON.stringify(c.owner)||!c.lease.isCurrent())throw new MemoryCipherError();const driver=yield* dialect(),current=yield* one<Record<string,unknown>>(`SELECT * FROM memory_file_proposals WHERE id=? AND user_id=?${driver==='postgres'?' FOR UPDATE':''}`,c.proposalId,c.owner.ownerId);if(!current||canonicalEncryptedRow(current)!==canonicalEncryptedRow(cipher))throw new MemoryCipherError();
   const fields=Object.keys(replacement).filter(field=>!['id','user_id'].includes(field));const changed=yield* run(`UPDATE memory_file_proposals SET ${fields.map(field=>field+'=?').join(',')} WHERE id=? AND user_id=? AND status='pending' AND changes=?`,...fields.map(field=>replacement[field] as SqlParam),c.proposalId,c.owner.ownerId,cipher.changes as string);if(changed.changes!==1)throw new MemoryCipherError();const stored=yield* one<Record<string,unknown>>('SELECT * FROM memory_file_proposals WHERE id=? AND user_id=?',c.proposalId,c.owner.ownerId);if(!stored||canonicalEncryptedRow(stored)!==canonicalEncryptedRow(replacement)||!c.lease.isCurrent()||Date.now()>=owner.validUntil||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();
  },{immediate:true});await c.check();return{proposalId:c.proposalId,memoryId:null,decision:'reject' as const};
 }catch{input.session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
