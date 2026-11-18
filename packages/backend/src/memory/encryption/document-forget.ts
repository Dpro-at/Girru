/** Forget invalidates every derived document, never the owner's source files. */
import {createHash} from 'node:crypto';
import {run,one,type Step,type SqlParam} from '../../repositories/sql-steps.js';
import {decryptMemoryRow,encryptMemoryRow,type MemoryRowScope} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import {MemoryCipherError} from './envelope.js';
type Row=Record<string,unknown>;
export const DOCUMENT_FORGET_TABLES=['doc_index_sources','doc_index_files','doc_index_chunks','memory_encryption_document_admissions'] as const;
export type DocumentForgetRows=Record<typeof DOCUMENT_FORGET_TABLES[number],Row[]>;
export function prepareDocumentForget(input:{rows:DocumentForgetRows;scope:MemoryRowScope;key:Buffer;keyId:string;actorId:string;at:string;isCurrent:()=>boolean}){
 const {rows,scope,key,keyId,actorId,at,isCurrent}=input;if(!isCurrent())throw new MemoryCipherError();
 const plain={} as DocumentForgetRows;for(const table of DOCUMENT_FORGET_TABLES)plain[table]=rows[table].map(row=>decryptMemoryRow(table,row,scope,key,keyId));
 const sources=new Map(plain.doc_index_sources.map(row=>[String(row.id),row])),files=new Map(plain.doc_index_files.map(row=>[String(row.id),row]));
 for(const file of files.values())if(!sources.has(String(file.source_id)))throw new MemoryCipherError();
 for(const chunk of plain.doc_index_chunks){const file=files.get(String(chunk.file_id));if(!file||file.source_id!==chunk.source_id||!sources.has(String(chunk.source_id)))throw new MemoryCipherError();}
 const next={} as DocumentForgetRows;next.doc_index_files=[];next.doc_index_chunks=[];
 next.doc_index_sources=plain.doc_index_sources.map(source=>{const revision=Number(source.revision);if(!Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER)throw new MemoryCipherError();const fileCount=plain.doc_index_files.filter(row=>row.source_id===source.id).length,chunkCount=plain.doc_index_chunks.filter(row=>row.source_id===source.id).length;
  let previous:{invalidatedFileCount?:number;invalidatedChunkCount?:number;invalidationCount?:number}={};if(typeof source.note==='string'){try{const note=JSON.parse(source.note);if(note?.v===1&&note.documentsNeedOwnerReimport===true&&note.reason==='memory-forget')previous=note;}catch{/* Non-invalidation notes are not reinterpreted as trusted provenance. */}}const totals={invalidatedFileCount:Number(previous.invalidatedFileCount??0)+fileCount,invalidatedChunkCount:Number(previous.invalidatedChunkCount??0)+chunkCount,invalidationCount:Number(previous.invalidationCount??0)+1};if(Object.values(totals).some(value=>!Number.isSafeInteger(value)||value<0))throw new MemoryCipherError();
  return encryptMemoryRow('doc_index_sources',{...source,revision:revision+1,state:'pending',files:0,chunks:0,unreadable:0,limited:0,scanned_at:null,updated_at:at,note:JSON.stringify({v:1,documentsNeedOwnerReimport:true,reason:'memory-forget',previousFileCount:fileCount,previousChunkCount:chunkCount,...totals,invalidatedAt:at})},scope,key,keyId);});
 next.memory_encryption_document_admissions=plain.memory_encryption_document_admissions.map(row=>encryptMemoryRow('memory_encryption_document_admissions',{...row,state:'revoked',decided_by:actorId,decided_at:at,plan:JSON.stringify({v:1,revoked:true,reason:'memory-forget',priorPlanHash:createHash('sha256').update(String(row.plan)).digest('hex')})},scope,key,keyId));
 if(!isCurrent())throw new MemoryCipherError();return{rows:next,documentsNeedOwnerReimport:plain.doc_index_sources.length>0||plain.memory_encryption_document_admissions.length>0};
}
/** Caller holds the complete owner ciphertext CAS and commits this with the tombstone. */
export function* writeDocumentForgetStep(ownerId:string,rows:DocumentForgetRows):Step<void>{
 for(const table of ['doc_index_chunks','doc_index_files'] as const)yield* run(`DELETE FROM ${table} WHERE owner_id=?`,ownerId);
 for(const table of ['doc_index_sources','memory_encryption_document_admissions'] as const)for(const row of rows[table]){const fields=Object.keys(row).filter(field=>field!=='id'&&field!=='owner_id');const result=yield* run(`UPDATE ${table} SET ${fields.map(field=>field+'=?').join(',')} WHERE id=? AND owner_id=?`,...fields.map(field=>row[field] as SqlParam),String(row.id),ownerId);if(result.changes!==1)throw new MemoryCipherError();const stored=yield* one<Row>(`SELECT * FROM ${table} WHERE id=? AND owner_id=?`,String(row.id),ownerId);if(!stored||canonicalEncryptedRow(stored)!==canonicalEncryptedRow(row))throw new MemoryCipherError();}
}
