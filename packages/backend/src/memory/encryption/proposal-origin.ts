/** Approval preserves an existing origin; it never admits an unknown or old-head proposal as new content. */
import type {StepRunner} from '../../repositories/sql-steps.js';
import {encryptedFieldProducer,type MemoryRowScope} from './row-codec.js';
import {isProtectedMemoryRunner} from './memory-effect.js';
import {captureMemoryRestoreAnchor} from './restore-package.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
import {MemoryCipherError} from './envelope.js';
export async function captureCurrentEncryptedProposalOrigin(input:{runner:StepRunner;proposal:Record<string,unknown>;scope:MemoryRowScope;captureAuthority?:()=>Promise<MemoryRestoreAuthorityLease|null>}){
 const origin=encryptedFieldProducer('memory_file_proposals',input.proposal,'changes',input.scope);if(input.proposal.source==='owner'&&(input.proposal.created_by!==input.scope.ownerId||origin?.kind!=='owner-new-content'))throw new MemoryCipherError();
 if(!input.captureAuthority){if(isProtectedMemoryRunner(input.runner))throw new MemoryCipherError();return undefined;}
 const authority=await input.captureAuthority();if(!origin||!authority?.isCurrent())throw new MemoryCipherError();const anchor=captureMemoryRestoreAnchor(authority.anchor);
 if(anchor.ownerId!==input.scope.ownerId||anchor.memberId!==input.scope.memberId||origin.ownerId!==anchor.ownerId||origin.memberId!==anchor.memberId||origin.authorityId!==anchor.authorityId||origin.keyId!==anchor.keyId||origin.epoch!==anchor.epoch||origin.forgetSequence!==anchor.forgetSequence||origin.forgetMac!==anchor.forgetMac)throw new MemoryCipherError();
 return Object.freeze({isCurrent:()=>authority.isCurrent()===true});
}
