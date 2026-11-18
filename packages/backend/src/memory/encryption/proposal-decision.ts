import {assertEncryptedDocumentRuntimeCoverageStep,type DocumentRuntimeCoverage} from './document-runtime-coverage.js';
import {assertNoUncoveredExternalProjectCopiesStep} from './forget-coverage.js';
import type {StepRunner} from '../../repositories/sql-steps.js';
import {assertNoUncoveredProjectCopiesStep} from './forget-coverage.js';
/** Internal owner decision transaction step; caller audits proposal/old-row decrypts and owns transaction. */
import {one,run,dialect,type Step,type SqlParam} from '../../repositories/sql-steps.js';
import {lockDrawer} from '../memory-files.js';
import {drawerRevisionStep} from '../versions.js';
import {normalizeDrawer} from '../drawers.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {snapshotEncryptedRow,canonicalEncryptedRow} from './content-commit.js';
import {decryptMemoryRow,encryptMemoryRow,type MemoryRowScope} from './row-codec.js';
import {buildEncryptedReviewedReplacement} from './reviewed-replacement.js';
import {commitEncryptedSupersessionStep} from './supersession-commit.js';
import {MemoryCipherError} from './envelope.js';
type Row=Record<string,unknown>;
export function* approveEncryptedSupersessionStep(token:string,proposalInput:Row,olderInput:Row,reviewHash:string,suppliedScope:MemoryRowScope,suppliedKey:Buffer,keyId:string,suppliedLookup:Buffer,isCurrent:()=>boolean,documentCoverage?:{runner:StepRunner;proof:DocumentRuntimeCoverage}):Step<{id:string;revision:number}>{
 if(!Buffer.isBuffer(suppliedKey)||suppliedKey.length!==32||!Buffer.isBuffer(suppliedLookup)||suppliedLookup.length!==32)throw new MemoryCipherError();
 const proposalCipher=snapshotEncryptedRow(proposalInput),older=snapshotEncryptedRow(olderInput),scope={...suppliedScope},key=Buffer.from(suppliedKey),lookup=Buffer.from(suppliedLookup);
 try{
  const owner=yield* authenticatedMemoryOwnerStep(token);
  const check=()=>{if(owner.ownerId!==scope.ownerId||typeof isCurrent!=='function'||isCurrent()!==true||Date.now()>=owner.validUntil)throw new MemoryCipherError();};check();
  const driver=yield* dialect();
  if(driver==='postgres')yield* run('LOCK TABLE memories,memory_versions IN SHARE ROW EXCLUSIVE MODE');
  if(documentCoverage){yield* assertNoUncoveredExternalProjectCopiesStep(scope.ownerId);yield* assertEncryptedDocumentRuntimeCoverageStep(documentCoverage.proof,documentCoverage.runner,scope.ownerId);}else yield* assertNoUncoveredProjectCopiesStep(scope.ownerId);
  const current=yield* one<Row>(`SELECT * FROM memory_file_proposals WHERE id=? AND user_id=?${driver==='postgres'?' FOR UPDATE':''}`,proposalCipher.id as string,scope.ownerId);
  if(!current||canonicalEncryptedRow(current)!==canonicalEncryptedRow(proposalCipher))throw new MemoryCipherError();
  const proposal=decryptMemoryRow('memory_file_proposals',current,scope,key,keyId),drawer=normalizeDrawer({kind:proposal.drawer_kind,key:proposal.drawer_key??''});
  const replacement=buildEncryptedReviewedReplacement(current,older,scope,key,keyId,reviewHash);
  yield* lockDrawer(scope.ownerId,drawer);check();
  const previousRevision=yield* drawerRevisionStep(scope.ownerId,drawer),revision=previousRevision+1;
  if(!Number.isSafeInteger(revision)||revision<1)throw new MemoryCipherError();
  const decided=encryptMemoryRow('memory_file_proposals',{...proposal,status:'approved',decided_by:owner.ownerId,decided_at:new Date().toISOString(),applied_revision:revision,decision:'keep_new'},scope,key,keyId),fields=Object.keys(decided).filter(f=>f!=='id'&&f!=='user_id');
  const claimed=yield* run(`UPDATE memory_file_proposals SET ${fields.map(f=>f+'=?').join(',')} WHERE id=? AND user_id=? AND status='pending' AND changes=?`,...fields.map(f=>decided[f] as SqlParam),proposalCipher.id as string,scope.ownerId,proposalCipher.changes as string);
  if(claimed.changes!==1)throw new MemoryCipherError();check();
  yield* commitEncryptedSupersessionStep(older,replacement,scope,key,keyId,lookup,owner.ownerId,{proposalId:proposal.id as string,previousRevision,revision,reason:'proposal:'+String(proposal.source)});
  const stored=yield* one<Row>('SELECT * FROM memory_file_proposals WHERE id=? AND user_id=?',proposal.id as string,scope.ownerId);
  if(!stored||canonicalEncryptedRow(stored)!==canonicalEncryptedRow(decided))throw new MemoryCipherError();check();
  if(documentCoverage)yield* assertEncryptedDocumentRuntimeCoverageStep(documentCoverage.proof,documentCoverage.runner,scope.ownerId);
  return {id:replacement.id as string,revision};
 }finally{key.fill(0);lookup.fill(0);}
}
