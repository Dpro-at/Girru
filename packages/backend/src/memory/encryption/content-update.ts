/** Inactive content-update preparation; no SQL/file/graph side effects. */
import {unpackVector} from '../vectors.js';
import {encryptMemoryRow,decryptMemoryRow,type MemoryRowScope} from './row-codec.js';
import {MemoryCipherError} from './envelope.js';
export const MEMORY_CONTENT_UPDATE_FIELDS=Object.freeze(['content','metadata','tags','context','outcomes','emotions','embedding','embedding_vec','embedding_model','embedding_dims']);
const editable=new Set<string>(MEMORY_CONTENT_UPDATE_FIELDS);
/** Caller supplies current authenticated write scope and logs the decrypt intent BEFORE this call. */
export function prepareEncryptedContentUpdate(current:Record<string,unknown>,patch:Record<string,unknown>,scope:MemoryRowScope,key:Buffer,keyId:string,authorizeWrite:(row:Readonly<Record<string,unknown>>)=>boolean,allowReviewedGraph=false){
 try{
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length||Object.keys(patch).some(f=>!editable.has(f))||authorizeWrite(current)!==true)throw new MemoryCipherError();
  const plain=decryptMemoryRow('memories',current,scope,key,keyId);
  // Content edits must supply fresh embedding metadata (or explicitly invalidate it), never retain stale vectors.
  if(Object.hasOwn(patch,'content')&&['embedding','embedding_vec','embedding_model','embedding_dims'].some(f=>!Object.hasOwn(patch,f)))throw new MemoryCipherError();
  if(Object.hasOwn(patch,'metadata')){
   const reserved=(value:unknown,field:string)=>{if(value===null)return undefined;if(typeof value!=='string')throw new MemoryCipherError();const parsed=JSON.parse(value);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new MemoryCipherError();return parsed[field];};
   // The graph review lane does not grant authority to verify facts or clear owner review flags.
   for(const field of ['__girru_owner_quality_v1',...(!allowReviewedGraph?['__girru_reviewed_graph_v1']:[])])if(JSON.stringify(reserved(plain.metadata,field))!==JSON.stringify(reserved(patch.metadata,field)))throw new MemoryCipherError();
  }
  const updated={...plain,...patch};
  if(typeof updated.content!=='string'||!updated.content.trim()||updated.content.length>50000||authorizeWrite(updated)!==true)throw new MemoryCipherError();
  for(const field of ['metadata','tags','context','outcomes','emotions'])if(updated[field]!==null&&(typeof updated[field]!=='string'||Buffer.byteLength(updated[field] as string)>1024*1024))throw new MemoryCipherError();
  if(updated.embedding_vec!==null||updated.embedding!==null){
   let vector=unpackVector(updated.embedding_vec);if(!vector&&typeof updated.embedding==='string'){const parsed=JSON.parse(updated.embedding);if(Array.isArray(parsed))vector=parsed;}
   if(!vector||vector.length<1||vector.length>8192||vector.some(value=>typeof value!=='number'||!Number.isFinite(value))||Number(updated.embedding_dims)!==vector.length||typeof updated.embedding_model!=='string'||!updated.embedding_model||updated.embedding_model.length>256)throw new MemoryCipherError();
  }else if(updated.embedding_dims!==null||updated.embedding_model!==null)throw new MemoryCipherError();
  const ciphertext=encryptMemoryRow('memories',updated,scope,key,keyId);
  // Policy/identity/topic/lifecycle changes require a separate reviewed move/reseal operation.
  return ciphertext;
 }catch{throw new MemoryCipherError();}
}
