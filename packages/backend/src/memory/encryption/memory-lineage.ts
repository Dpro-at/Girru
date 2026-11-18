import {stampEncryptedRunLineage} from './run-admission.js';
/** Exact authenticated producer references, never semantic inference from arbitrary metadata JSON. */
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {encryptedFieldProducer,type MemoryRowScope} from './row-codec.js';
import {captureMemoryRestoreAnchor,sameMemoryRestoreAnchor} from './restore-package.js';
import type {RunSource} from './run-admission.js';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const identity=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value);
/** Null means unknown provenance. In particular, legacy data-key MACs are not guessed across rotation. */
export function verifiedEncryptedMemoryLineageSources(row:Readonly<Record<string,unknown>>,scope:MemoryRowScope,key:Buffer):readonly Readonly<RunSource>[]|null{
 try{
  if(!Buffer.isBuffer(key)||key.length!==32||row.user_id!==scope.ownerId||!identity(row.id)||typeof row.content!=='string')return null;
  const authenticatedOrigin=encryptedFieldProducer('memories',row as Record<string,unknown>,'content',scope);
  // A native NEW CONTENT action is an explicit new admission, not inferred ancestry.
  if(authenticatedOrigin?.kind==='owner-new-content')return Object.freeze([]);
  if(typeof row.metadata!=='string'||Buffer.byteLength(row.metadata)>1024*1024)return null;
  const metadata=JSON.parse(row.metadata),value=metadata?.__girru_run_lineage_v1;if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='agentId,anchor,contentHash,mac,mode,runId,sources,v'||value.v!==1||value.mode!=='captured-run'||!identity(value.runId)||!identity(value.agentId)||typeof value.mac!=='string'||!/^[a-f0-9]{64}$/.test(value.mac)||value.contentHash!==digest(row.content)||!Array.isArray(value.sources)||value.sources.length>5000)return null;
  const anchor=captureMemoryRestoreAnchor(value.anchor);if(anchor.ownerId!==scope.ownerId||anchor.memberId!==scope.memberId)return null;
  const sources:RunSource[]=[],seen=new Set<string>();for(const item of value.sources){if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!=='id,kind'||!['memory','document','handoff','question','auxiliary'].includes(item.kind)||!identity(item.id))return null;const id=item.kind+':'+item.id;if(seen.has(id))return null;seen.add(id);sources.push({kind:item.kind,id:item.id});}
  if(JSON.stringify([...sources].sort((a,b)=>(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id)).map(source=>[source.kind,source.id]))!==JSON.stringify(sources.map(source=>[source.kind,source.id])))return null;
  const producer=authenticatedOrigin;
  if(producer){
   // This source digest was minted only from the opaque admitted run and lives inside
   // the authenticated content envelope. Copy/rotation preserves it byte-for-byte.
   if(producer.runId!==value.runId||producer.agentId!==value.agentId||producer.sourceDigest!==digest(JSON.stringify(value.sources))||!sameMemoryRestoreAnchor(anchor,{v:1,ownerId:producer.ownerId,memberId:producer.memberId,authorityId:producer.authorityId,keyId:producer.keyId,epoch:producer.epoch,forgetSequence:producer.forgetSequence,forgetMac:producer.forgetMac}))return null;
  }else{
   const {mac,...body}=value,expected=createHmac('sha256',key).update(JSON.stringify(['girru-memory-producer-lineage',1,scope.ownerId,scope.memberId,row.id,body])).digest();if(!timingSafeEqual(expected,Buffer.from(mac,'hex')))return null;
  }
  return Object.freeze(sources.map(source=>Object.freeze(source)));
 }catch{return null;}
}

/** Called while the original run admission is live, before queuing its encrypted proposal. */
export function stampEncryptedProposalRunLineage(proposal:Record<string,unknown>,admission:NonNullable<ReturnType<typeof import('./run-admission.js').captureEncryptedRunWriteAdmission>>,key:Buffer):string{
 if(typeof proposal.id!=='string'||typeof proposal.changes!=='string')throw new Error('invalid_proposal_lineage');
 const changes=JSON.parse(proposal.changes);if(!Array.isArray(changes)||changes.length!==1||!changes[0]?.after||typeof changes[0].after.content!=='string')throw new Error('invalid_proposal_lineage');
 return stampEncryptedRunLineage({id:proposal.id,user_id:admission.ownerId,content:changes[0].after.content,metadata:'{}'},admission,key);
}
/** Carry the exact encrypted proposal's authenticated origin and exact-entry lineage into a new ID. */
export function approvedEncryptedProposalMetadata(proposal:Record<string,unknown>,target:Record<string,unknown>,scope:MemoryRowScope):string|null{
 const producer=encryptedFieldProducer('memory_file_proposals',proposal,'changes',scope);if(!producer||producer.kind!=='admitted-run'||typeof proposal.note!=='string'||typeof target.content!=='string')return null;
 try{const note=JSON.parse(proposal.note),lineage=note?.__girru_run_lineage_v1;if(!lineage||lineage.contentHash!==digest(target.content)||lineage.runId!==producer.runId||lineage.agentId!==producer.agentId||!Array.isArray(lineage.sources)||producer.sourceDigest!==digest(JSON.stringify(lineage.sources)))return null;const meta=typeof target.metadata==='string'?JSON.parse(target.metadata):{};return JSON.stringify({...meta,__girru_run_lineage_v1:lineage});}catch{return null;}
}
