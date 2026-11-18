/** Pure encrypted-review validation. NOT authorization, approval consumption or a replacement row builder. */
import {proposalReviewHash,type MemoryChange} from '../memory-files.js';
import {drawerId,normalizeDrawer,defaultDrawerForType,sameDrawer} from '../drawers.js';
import {decryptMemoryRow,encryptedFieldProducer,type MemoryRowScope} from './row-codec.js';
import {MemoryCipherError} from './envelope.js';
type Row=Record<string,unknown>;
/** Caller must authenticate the owner and audit all three decrypt intents before invoking. */
export function validateEncryptedSupersessionReview(proposalCipher:Row,olderCipher:Row,newerCipher:Row,scope:MemoryRowScope,key:Buffer,keyId:string,expectedReviewHash:string):void{
 try{
  if(typeof expectedReviewHash!=='string'||!/^[a-f0-9]{64}$/.test(expectedReviewHash))throw new MemoryCipherError();
  const proposal=decryptMemoryRow('memory_file_proposals',proposalCipher,scope,key,keyId),older=decryptMemoryRow('memories',olderCipher,scope,key,keyId),newer=decryptMemoryRow('memories',newerCipher,scope,key,keyId);
  if(proposal.status!=='pending'||proposal.decision!==null||proposal.conflict_with!==older.id||older.id===newer.id||!['agent','learning','import','owner'].includes(String(proposal.source))||(older.status??'active')!=='active'||(newer.status??'active')!=='active'||typeof proposal.changes!=='string')throw new MemoryCipherError();
  if(proposal.source==='owner'){const producer=encryptedFieldProducer('memory_file_proposals',proposal,'changes',scope);if(proposal.created_by!==scope.ownerId||proposal.agent_id!==null||!producer||producer.kind!=='owner-new-content'||producer.action!=='correct-memory')throw new MemoryCipherError();}
  const changes=JSON.parse(proposal.changes);
  if(!Array.isArray(changes)||changes.length!==1)throw new MemoryCipherError();
  const change=changes[0];
  if(!change||Object.keys(change).sort().join(',')!=='after,before,id,op'||change.op!=='update'||change.id!==older.id)throw new MemoryCipherError();
  const matches=(entry:unknown,row:Row)=>{
   if(!entry||typeof entry!=='object'||Array.isArray(entry)||Object.keys(entry).sort().join(',')!=='content,importance,type')return false;
   const e=entry as Record<string,unknown>,importance=Math.min(10,Math.max(1,Math.round((typeof row.importance_score==='number'?row.importance_score:0.5)*10)));
   return typeof e.content==='string'&&e.content===row.content&&e.type===row.type&&Number.isInteger(e.importance)&&e.importance===importance;
  };
  if(!matches(change.before,older)||!matches(change.after,newer)||newer.topic_key!==older.topic_key)throw new MemoryCipherError();
  const drawer=(row:Row)=>row.drawer_kind==null?defaultDrawerForType(typeof row.type==='string'?row.type:undefined):normalizeDrawer({kind:row.drawer_kind,key:row.drawer_key??''});
  const proposed=normalizeDrawer({kind:proposal.drawer_kind,key:proposal.drawer_key??''});
  if(!sameDrawer(drawer(older),proposed)||!sameDrawer(drawer(newer),proposed)||typeof proposal.id!=='string'||typeof proposal.base_hash!=='string'||!Number.isSafeInteger(proposal.base_revision))throw new MemoryCipherError();
  const actual=proposalReviewHash({id:proposal.id,drawerId:drawerId(proposed),baseRevision:proposal.base_revision as number,baseHash:proposal.base_hash,source:proposal.source as 'agent'|'learning'|'import'|'owner',changes:changes as MemoryChange[]});
  if(actual!==expectedReviewHash)throw new MemoryCipherError();
 }catch{throw new MemoryCipherError();}
}
