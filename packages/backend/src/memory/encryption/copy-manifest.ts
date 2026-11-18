/** Internal snapshot provenance. Does not attest full-profile coverage or enable encryption. */
import {MEMORY_COPY_MAX_ROWS,MEMORY_COPY_MAX_SET_ENCODED_BYTES} from './copy-limits.js';
import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {memoryRowSurfaceManifest,type MemoryRowScope} from './row-codec.js';
import {verifyMemoryCopyBatch,verifyMemoryCopyCiphertext,memoryCopyEncodedBytes,type MemoryCopyBatch} from './copy-batch.js';
import {MemoryCipherError} from './envelope.js';
export interface MemorySurfaceSnapshot {
 version:1|2|3|4|5; activationReady:false; coverage:MemorySnapshotCoverage;
 state:'prepared'; snapshotId:string; manifestMac:string; batches:MemoryCopyBatch[];
}
export type MemorySnapshotCoverage='owner-eight-declared-surfaces-only'|'owner-eleven-declared-surfaces-only'|'owner-twelve-declared-surfaces-only'|'owner-thirteen-declared-surfaces-only'|'owner-twenty-declared-surfaces-only';
const legacyTables=new Set(['memories','memory_versions','memory_file_proposals','memory_weekly_summaries','agent_handoffs','memory_bridge_handoffs','memory_pinned_facts','memory_recall_traces']);
const documentTables=new Set([...legacyTables,'doc_index_sources','doc_index_files','doc_index_chunks']);
const admissionTables=new Set([...documentTables,'memory_encryption_document_admissions']);
const graphTables=new Set([...admissionTables,'memory_encryption_legacy_graph']);
const completeTables=new Set([...graphTables,'memory_open_questions','memory_import_batches','memory_health_events','memory_retention_runs','memory_bridge_audit','memory_bridge_registrations','memory_encryption_auxiliary']);
const pickSurfaces=(tables:ReadonlySet<string>)=>{const result=memoryRowSurfaceManifest().filter(surface=>tables.has(surface.table));if(result.length!==tables.size)throw new MemoryCipherError();return result;};
/** Historical versions retain exact immutable table sets, even when newer descriptors are introduced. */
export function memorySnapshotSurfaceManifest(snapshot:Pick<MemorySurfaceSnapshot,'version'|'coverage'>){
 if(snapshot.version===1&&snapshot.coverage==='owner-eight-declared-surfaces-only')return pickSurfaces(legacyTables);
 if(snapshot.version===2&&snapshot.coverage==='owner-eleven-declared-surfaces-only')return pickSurfaces(documentTables);
 if(snapshot.version===3&&snapshot.coverage==='owner-twelve-declared-surfaces-only')return pickSurfaces(admissionTables);
 if(snapshot.version===4&&snapshot.coverage==='owner-thirteen-declared-surfaces-only')return pickSurfaces(graphTables);
 if(snapshot.version===5&&snapshot.coverage==='owner-twenty-declared-surfaces-only')return pickSurfaces(completeTables);
 throw new MemoryCipherError();
}
function body(snapshot:MemorySurfaceSnapshot):string {
 if(!snapshot||Object.keys(snapshot).sort().join(',')!=='activationReady,batches,coverage,manifestMac,snapshotId,state,version'||![1,2,3,4,5].includes(snapshot.version)||snapshot.activationReady!==false||snapshot.state!=='prepared'||!/^[-a-f0-9]{36}$/.test(snapshot.snapshotId))throw new MemoryCipherError();
 const surfaces=memorySnapshotSurfaceManifest(snapshot),expected=surfaces.map(s=>s.table).sort().join(',');
 if(!Array.isArray(snapshot.batches)||snapshot.batches.length!==surfaces.length||snapshot.batches.map(b=>b?.table).sort().join(',')!==expected)throw new MemoryCipherError();
 let encodedBytes=0;
 const entries=snapshot.batches.map(b=>{
  if(!Array.isArray(b.rows)||b.rows.length>MEMORY_COPY_MAX_ROWS||typeof b.receiptMac!=='string'||!/^[a-f0-9]{64}$/.test(b.receiptMac))throw new MemoryCipherError();
  encodedBytes+=memoryCopyEncodedBytes(b.rows);if(encodedBytes>MEMORY_COPY_MAX_SET_ENCODED_BYTES)throw new MemoryCipherError();
  for(const value of [b.ownerId,b.memberId,b.keyId])if(typeof value!=='string'||Buffer.byteLength(value)>256)throw new MemoryCipherError();
  return [b.table,b.ownerId,b.memberId,b.keyId,b.rows.length,b.receiptMac];
 }).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
 return JSON.stringify(['girru-memory-copy-set',snapshot.version,snapshot.snapshotId,snapshot.state,snapshot.activationReady,snapshot.coverage,entries]);
}
function mac(snapshot:MemorySurfaceSnapshot,key:Buffer):string {
 if(!Buffer.isBuffer(key)||key.length!==32)throw new MemoryCipherError();
 return createHmac('sha256',key).update(body(snapshot)).digest('hex');
}
/** Called within the source transaction, after preparing every declared table. */
export function sealMemorySurfaceSnapshot(batches:MemoryCopyBatch[],scope:MemoryRowScope,key:Buffer,keyId:string,verificationKey:Buffer):MemorySurfaceSnapshot {
 const snapshot:MemorySurfaceSnapshot={version:5,activationReady:false,coverage:'owner-twenty-declared-surfaces-only',state:'prepared',snapshotId:randomUUID(),manifestMac:'',batches};
 for(const batch of batches)verifyMemoryCopyBatch(batch,batch.rows,scope,key,keyId,verificationKey);
 snapshot.manifestMac=mac(snapshot,verificationKey);
 return snapshot;
}
/** Verify set/receipt provenance before data-key access; does not verify decrypted source MACs. */
export function verifyMemorySnapshotCiphertext(snapshot:MemorySurfaceSnapshot,scope:MemoryRowScope,keyId:string,verificationKey:Buffer):void{
 try{
  const expected=mac(snapshot,verificationKey);
  if(typeof snapshot.manifestMac!=='string'||!/^[a-f0-9]{64}$/.test(snapshot.manifestMac)||!timingSafeEqual(Buffer.from(snapshot.manifestMac,'hex'),Buffer.from(expected,'hex')))throw new MemoryCipherError();
  for(const batch of snapshot.batches)verifyMemoryCopyCiphertext(batch,scope,keyId,verificationKey);
 }catch{throw new MemoryCipherError();}
}

export function verifyMemorySurfaceSnapshot(snapshot:MemorySurfaceSnapshot,scope:MemoryRowScope,key:Buffer,keyId:string,verificationKey:Buffer):void {
 try{
  const expected=mac(snapshot,verificationKey);
  if(typeof snapshot.manifestMac!=='string'||!/^[a-f0-9]{64}$/.test(snapshot.manifestMac)||!timingSafeEqual(Buffer.from(snapshot.manifestMac,'hex'),Buffer.from(expected,'hex')))throw new MemoryCipherError();
  for(const batch of snapshot.batches)verifyMemoryCopyBatch(batch,batch.rows,scope,key,keyId,verificationKey);
 }catch{throw new MemoryCipherError();}
}
