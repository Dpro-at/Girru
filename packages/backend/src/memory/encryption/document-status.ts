/** Owner-visible invalidation notice with audited source metadata; never returns physical source paths. */
import {type StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {documentCipherRowsStep} from './document-reader.js';
import {decryptMemoryRow} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
export async function readEncryptedDocumentStatus(input:{runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>}){
 let key:Buffer|undefined;const {runner,token,session,recordRead}=input;
 try{const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});if(owner.ownerId!==lease.scope.ownerId)throw new MemoryCipherError();const check=async()=>{if(runner.inTransaction?.()!==false||!lease.isCurrent()||JSON.stringify(await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true}))!==JSON.stringify(owner))throw new MemoryCipherError();};await check();
 const tables=['doc_index_sources','memory_encryption_document_admissions'] as const,rows=await runner.tx(function*(){return{doc_index_sources:yield* documentCipherRowsStep('doc_index_sources',owner.ownerId),memory_encryption_document_admissions:yield* documentCipherRowsStep('memory_encryption_document_admissions',owner.ownerId)};},{immediate:true});await check();
 const records=tables.flatMap(table=>rows[table].map(row=>({table,id:String(row.id)})));for(let offset=0;offset<records.length;offset+=500){if(await recordRead({readerKind:'user',readerId:owner.ownerId,purpose:'view',records:records.slice(offset,offset+500)})!==true)throw new MemoryCipherError();await check();}
 const material=await lease.resolveKey({user_id:owner.ownerId});key=material.key;await check();const sources=rows.doc_index_sources.map(cipher=>{const row=decryptMemoryRow('doc_index_sources',cipher,lease.scope,key!,material.id);let note:Record<string,unknown>={};try{const value=JSON.parse(String(row.note));if(value&&value.v===1&&value.documentsNeedOwnerReimport===true&&value.reason==='memory-forget')note=value;}catch{/* Ordinary source notes do not grant admission. */}return{id:String(row.id),kind:String(row.kind),refId:String(row.ref_id),revision:Number(row.revision),files:Number(row.files),chunks:Number(row.chunks),documentsNeedOwnerReimport:note.documentsNeedOwnerReimport===true,invalidatedFileCount:Number(note.invalidatedFileCount??0),invalidatedChunkCount:Number(note.invalidatedChunkCount??0)};});
 if(sources.some(source=>!['project','agent'].includes(source.kind)||[source.revision,source.files,source.chunks,source.invalidatedFileCount,source.invalidatedChunkCount].some(value=>!Number.isSafeInteger(value)||value<0)))throw new MemoryCipherError();
 const result={documentsNeedOwnerReimport:sources.some(source=>source.documentsNeedOwnerReimport),sources,pendingImports:rows.memory_encryption_document_admissions.filter(row=>row.state==='pending').length};
 await runner.tx(function*(){if(JSON.stringify(yield* authenticatedMemoryOwnerStep(token))!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();for(const table of tables){const fresh=yield* documentCipherRowsStep(table,owner.ownerId);if(JSON.stringify(fresh.map(canonicalEncryptedRow))!==JSON.stringify(rows[table].map(canonicalEncryptedRow)))throw new MemoryCipherError();}if(!lease.isCurrent()||Date.now()>=owner.validUntil)throw new MemoryCipherError();},{immediate:true});await check();return result;
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
