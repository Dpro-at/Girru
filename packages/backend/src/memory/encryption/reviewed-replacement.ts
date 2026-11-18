import {approvedEncryptedProposalMetadata} from './memory-lineage.js';
/** Server-only builder for a reviewed single-conflict replacement. Caller must authenticate the owner. */
import {newMemory} from '../learning.js';
import {proposalSourceAgent} from '../memory-files.js';
import {provenanceOf} from '../validity.js';
import {normalizeDrawer} from '../drawers.js';
import {decryptMemoryRow,encryptMemoryRow,carryEncryptedProposalContentProducer,memoryRowSurfaceManifest,type MemoryRowScope} from './row-codec.js';
import {validateEncryptedSupersessionReview} from './proposal-review.js';
import {MemoryCipherError} from './envelope.js';
/** No caller-selected id, metadata, provenance, sharing policy, timestamps or vectors are accepted. */
export function buildEncryptedReviewedReplacement(proposalCipher:Record<string,unknown>,olderCipher:Record<string,unknown>,scope:MemoryRowScope,key:Buffer,keyId:string,reviewHash:string){
 try{
  const proposal=decryptMemoryRow('memory_file_proposals',proposalCipher,scope,key,keyId),older=decryptMemoryRow('memories',olderCipher,scope,key,keyId);
  if(typeof proposal.changes!=='string'||typeof older.topic_key!=='string'&&older.topic_key!==null)throw new MemoryCipherError();
  const changes=JSON.parse(proposal.changes),entry=Array.isArray(changes)&&changes.length===1?changes[0]?.after:null;
  if(!entry||typeof entry.content!=='string'||!entry.content.trim()||entry.content.length>50000||typeof entry.type!=='string'||!/^[a-z][a-z_-]{0,31}$/.test(entry.type)||!Number.isInteger(entry.importance)||entry.importance<1||entry.importance>10)throw new MemoryCipherError();
  const drawer=normalizeDrawer({kind:proposal.drawer_kind,key:proposal.drawer_key??''});
  const memory=newMemory(scope.ownerId,drawer,entry,{source:proposal.source,proposalId:proposal.id,supersedes:older.id},older.topic_key);
  const sourceAgent=proposalSourceAgent(typeof proposal.created_by==='string'?proposal.created_by:null),provenance=provenanceOf({metadataSource:proposal.source,sourceAgentId:sourceAgent,ownerWrote:true});
  const surface=memoryRowSurfaceManifest().find(s=>s.table==='memories')!;
  const row:Record<string,unknown>=Object.fromEntries([surface.owner,surface.id,...surface.bound,...surface.clear,...surface.text,...surface.binary].map(field=>[field,null]));
  Object.assign(row,{id:memory.id,user_id:scope.ownerId,type:memory.type,content:memory.content,memory_layer:memory.memoryLayer,status:'active',metadata:JSON.stringify(memory.metadata),importance_score:memory.importanceScore,created_at:memory.createdAt.toISOString(),last_accessed_at:memory.lastAccessedAt,access_count:0,expiry_timestamp:memory.expiryTimestamp,consolidation_status:'pending',drawer_kind:drawer.kind,drawer_key:drawer.key??'',topic_key:older.topic_key,source_agent_id:sourceAgent,source:provenance.source,source_ref:provenance.sourceRef,trust:provenance.trust,valid_from:memory.createdAt.toISOString(),visibility:'private',is_team_critical:0,quality_score:50,completeness_score:0.5,clarity_score:0.5,usefulness_score:0.5,auto_enriched:0,needs_improvement:0});
  // Existing factory defines retention/layer; stale embeddings and old rich metadata are deliberately absent.
  const lineage=approvedEncryptedProposalMetadata(proposal,row,scope);if(lineage!==null)row.metadata=lineage;
  const tagged=carryEncryptedProposalContentProducer(proposal,row,scope),replacement=encryptMemoryRow('memories',tagged,scope,key,keyId);
  validateEncryptedSupersessionReview(proposalCipher,olderCipher,replacement,scope,key,keyId,reviewHash);
  return replacement;
 }catch{throw new MemoryCipherError();}
}
