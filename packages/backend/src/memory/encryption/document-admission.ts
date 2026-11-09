import {beforeEncryptedMemoryEffect,memoryEffectDigest} from './memory-effect.js';
/** Owner-reviewed NEW document content. A stable file/hash is never treated as provenance or as a previous approval. */
import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import path from 'node:path';
import {one,all,run,dialect,type StepRunner,type Step,type SqlParam} from '../../repositories/sql-steps.js';
import {skippedName,docKindOf} from '../docs/scan.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {loadEncryptedOwnerRow} from './owner-row-loader.js';
import {encryptMemoryRow,decryptMemoryRow} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import {consumeAuthorizedMemoryFile} from './import-file.js';
import {indexAuthenticatedEncryptedDocumentFile,extractProtectedDocumentBytes,type MemoryDocumentFileLease,type DocumentWriteAdmission} from './document-writer.js';
import {DOCUMENT_REIMPORT_CONFIRMATION,captureDocumentAdmissionPlan,documentAdmissionMatchesAuthority,type DocumentAdmissionPlan} from './document-lineage.js';
import {ensureDocumentAdmissionSchemaStep,DOCUMENT_ADMISSION_TABLE} from './document-admission-schema.js';
import {captureMemoryRestoreAnchor,sameMemoryRestoreAnchor} from './restore-package.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
import type {MemoryReadIntent} from './read-audit.js';
import type {EmbeddingResult} from '../embedding.js';
import {MemoryCipherError} from './envelope.js';
type Row=Record<string,unknown>;
export type DocumentAdmissionServices={runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>;captureAuthority:()=>Promise<MemoryRestoreAuthorityLease|null>;authorizeFile:(fileId:string)=>Promise<MemoryDocumentFileLease|null>;embedDocument?:(text:string)=>Promise<EmbeddingResult>};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function reviewHash(id:string,plan:DocumentAdmissionPlan,anchor:ReturnType<typeof captureMemoryRestoreAnchor>,key:Buffer){return createHmac('sha256',key).update(JSON.stringify(['girru-document-new-content-review',1,id,anchor,plan])).digest('hex');}
function validateLease(lease:MemoryDocumentFileLease,fileId:string){
 if(lease.fileId!==fileId||!/^[a-f0-9]{32}$/.test(fileId)||!/^[a-f0-9]{32}$/.test(lease.sourceId)||typeof lease.root!=='string'||lease.root!==path.resolve(lease.root)||typeof lease.relativePath!=='string'||!lease.relativePath||path.isAbsolute(lease.relativePath)||lease.relativePath.split(/[\\/]/).some(part=>!part||part==='.'||part==='..'||skippedName(part))||path.resolve(lease.root,lease.relativePath)!==lease.path||!['markdown','text','pdf'].includes(lease.format)||docKindOf(lease.relativePath)!==({markdown:'md',text:'txt',pdf:'pdf'} as const)[lease.format]||fileId!==hash(lease.sourceId+'\n'+lease.root+'\n'+lease.relativePath).slice(0,32)||![lease.expectedSourceRevision,lease.expectedFileRevision].every(value=>Number.isSafeInteger(value)&&value>=0))throw new MemoryCipherError();
}
async function authenticatedContext(input:DocumentAdmissionServices){
 const {runner,token,session}=input,lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true}),supplied=await input.captureAuthority();
 if(!supplied||!supplied.isCurrent()||owner.ownerId!==lease.scope.ownerId)throw new MemoryCipherError();const authority={anchor:captureMemoryRestoreAnchor(supplied.anchor),isCurrent:supplied.isCurrent.bind(supplied)};
 if(authority.anchor.ownerId!==owner.ownerId||authority.anchor.memberId!==lease.scope.memberId)throw new MemoryCipherError();
 const current=()=>lease.isCurrent()&&authority.isCurrent();
 const check=async()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1'||!current()||JSON.stringify(await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true}))!==JSON.stringify(owner))throw new MemoryCipherError();const fresh=await input.captureAuthority();if(!fresh||!fresh.isCurrent()||!sameMemoryRestoreAnchor(authority.anchor,fresh.anchor)||!current())throw new MemoryCipherError();};await check();return{lease,owner,authority,current,check};
}
function ownerPreview(row:Row,plan:DocumentAdmissionPlan){return{admissionId:String(row.id),reviewHash:String(row.review_hash),state:String(row.state),file:plan.file.relativePath,source:{kind:plan.source.kind,refId:plan.source.refId},bytes:plan.file.size,pages:plan.pages,unreadable:plan.reason,contents:plan.chunks.map(chunk=>({...chunk})),newContent:true as const,confirmation:DOCUMENT_REIMPORT_CONFIRMATION};}
export async function previewAuthenticatedDocumentImport(input:DocumentAdmissionServices&{fileId:string}){
 let key:Buffer|undefined;
 try{
  const {runner,token,session,recordRead}=input,fileId=input.fileId,context=await authenticatedContext(input),{lease,owner,authority,current,check}=context;
  const granted=await input.authorizeFile(fileId);await check();if(!granted)throw new MemoryCipherError();const fileLease={...granted,isCurrent:granted.isCurrent.bind(granted)};validateLease(fileLease,fileId);
  // The complete protected schema is provisioned before this operation; never repair a missing table.
  await check();
  const capacity=await runner.read(one<{n:number|string}>(`SELECT count(*) n FROM ${DOCUMENT_ADMISSION_TABLE} WHERE owner_id=?`,owner.ownerId));if(!capacity||Number(capacity.n)>=1000)throw new MemoryCipherError();
  const source=await loadEncryptedOwnerRow(runner,'doc_index_sources',owner.ownerId,fileLease.sourceId),file=await loadEncryptedOwnerRow(runner,'doc_index_files',owner.ownerId,fileId);await check();
  if(!source||Number(source.enabled)!==1||Number(source.revision)!==fileLease.expectedSourceRevision||(file?Number(file.revision)!==fileLease.expectedFileRevision:fileLease.expectedFileRevision!==0))throw new MemoryCipherError();
  if(await recordRead({readerKind:'user',readerId:owner.ownerId,purpose:'view',records:[{table:'doc_index_sources',id:fileLease.sourceId},...(file?[{table:'doc_index_files' as const,id:fileId}]:[])]})!==true)throw new MemoryCipherError();await check();
  const material=await lease.resolveKey({user_id:owner.ownerId});key=material.key;if(material.id!==authority.anchor.keyId)throw new MemoryCipherError();await check();
  const plainSource=decryptMemoryRow('doc_index_sources',source,lease.scope,key,material.id);if(file){const plainFile=decryptMemoryRow('doc_index_files',file,lease.scope,key,material.id);if(plainFile.source_id!==source.id||plainFile.root!==fileLease.root||plainFile.rel_path!==fileLease.relativePath)throw new MemoryCipherError();}
  const activeKey=key;
  return await consumeAuthorizedMemoryFile({fileId,authorize:async()=>fileLease,isCurrent:current,consume:async request=>{
   const extraction=extractProtectedDocumentBytes(fileLease.format,request.bytes),plan=captureDocumentAdmissionPlan({v:1,purpose:'new-owner-document-content',source:{id:fileLease.sourceId,kind:plainSource.kind,refId:plainSource.ref_id,cipherHash:hash(canonicalEncryptedRow(source)),revision:fileLease.expectedSourceRevision},file:{id:fileId,root:fileLease.root,relativePath:fileLease.relativePath,format:fileLease.format,sha256:request.sourceDigest,size:fileLease.size,revision:fileLease.expectedFileRevision,cipherHash:file?hash(canonicalEncryptedRow(file)):null},...extraction});
   const id=randomUUID(),at=new Date().toISOString(),plain:Row={id,owner_id:owner.ownerId,source_id:fileLease.sourceId,file_id:fileId,file_hash:request.sourceDigest,key_id:material.id,authority_id:authority.anchor.authorityId,epoch:authority.anchor.epoch,forget_sequence:authority.anchor.forgetSequence,forget_mac:authority.anchor.forgetMac,source_revision:fileLease.expectedSourceRevision,file_revision:fileLease.expectedFileRevision,review_hash:reviewHash(id,plan,authority.anchor,activeKey),state:'pending',created_by:owner.ownerId,created_at:at,decided_by:null,decided_at:null,plan:JSON.stringify(plan)},cipher=encryptMemoryRow('memory_encryption_document_admissions',plain,lease.scope,activeKey,material.id);
   await check();await beforeEncryptedMemoryEffect({runner,action:'preview-document-import',auth:owner,isCurrent:()=>current()&&request.sourceLease()&&Date.now()<owner.validUntil,targetDigest:memoryEffectDigest([source,file,cipher])});await runner.tx(function*(){const fresh=yield* authenticatedMemoryOwnerStep(token);if(JSON.stringify(fresh)!==JSON.stringify(owner)||!request.sourceLease())throw new MemoryCipherError();if((yield* dialect())==='postgres')yield* run(`LOCK TABLE doc_index_sources,doc_index_files,${DOCUMENT_ADMISSION_TABLE} IN SHARE ROW EXCLUSIVE MODE`);
    const currentSource=yield* one<Row>('SELECT * FROM doc_index_sources WHERE id=? AND owner_id=?',fileLease.sourceId,owner.ownerId),currentFile=yield* one<Row>('SELECT * FROM doc_index_files WHERE id=? AND owner_id=?',fileId,owner.ownerId),count=yield* one<{n:number|string;b:number|string|null}>(`SELECT count(*) n,SUM(${(yield* dialect())==='sqlite'?'length(CAST(plan AS BLOB))':'octet_length(plan)'}) b FROM ${DOCUMENT_ADMISSION_TABLE} WHERE owner_id=?`,owner.ownerId);
    if(!count||!Number.isSafeInteger(Number(count.n))||Number(count.n)<0||Number(count.n)>=1000||!Number.isSafeInteger(Number(count.b??0))||Number(count.b??0)<0||Number(count.b??0)+Buffer.byteLength(String(cipher.plan))>4*1024*1024||!currentSource||canonicalEncryptedRow(currentSource)!==canonicalEncryptedRow(source)||(file?(!currentFile||canonicalEncryptedRow(currentFile)!==canonicalEncryptedRow(file)):!!currentFile))throw new MemoryCipherError();
    const fields=Object.keys(cipher);yield* run(`INSERT INTO ${DOCUMENT_ADMISSION_TABLE}(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,...fields.map(field=>cipher[field] as SqlParam));const stored=yield* one<Row>(`SELECT * FROM ${DOCUMENT_ADMISSION_TABLE} WHERE id=? AND owner_id=?`,id,owner.ownerId);if(!stored||canonicalEncryptedRow(stored)!==canonicalEncryptedRow(cipher)||!request.sourceLease()||Date.now()>=owner.validUntil)throw new MemoryCipherError();
   },{immediate:true});await check();return ownerPreview(plain,plan);
  }});
 }catch{input.session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
export async function readAuthenticatedDocumentImport(input:DocumentAdmissionServices&{admissionId:string}){
 let key:Buffer|undefined;try{const context=await authenticatedContext(input),{runner,session,recordRead}=input,row=await loadEncryptedOwnerRow(runner,'memory_encryption_document_admissions',context.owner.ownerId,input.admissionId);await context.check();if(!row||!documentAdmissionMatchesAuthority(row,context.authority.anchor,context.lease.scope.memberId)||!['pending','applied','rejected'].includes(String(row.state)))throw new MemoryCipherError();
 if(await recordRead({readerKind:'user',readerId:context.owner.ownerId,purpose:'view',records:[{table:'memory_encryption_document_admissions',id:input.admissionId}]})!==true)throw new MemoryCipherError();await context.check();const material=await context.lease.resolveKey({user_id:context.owner.ownerId});key=material.key;if(material.id!==context.authority.anchor.keyId)throw new MemoryCipherError();const plain=decryptMemoryRow('memory_encryption_document_admissions',row,context.lease.scope,key,material.id),plan=captureDocumentAdmissionPlan(JSON.parse(String(plain.plan)));await context.check();return ownerPreview(plain,plan);
 }catch{input.session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
export async function decideAuthenticatedDocumentImport(input:DocumentAdmissionServices&{admissionId:string;reviewHash:string;decision:'approve'|'reject';confirmation?:string}){
 let key:Buffer|undefined;
 try{
  const {runner,token,session,recordRead}=input,admissionId=input.admissionId,expectedHash=input.reviewHash,decision=input.decision,confirmation=input.confirmation;
  if(typeof admissionId!=='string'||!/^[a-f0-9-]{36}$/.test(admissionId)||typeof expectedHash!=='string'||!/^[a-f0-9]{64}$/.test(expectedHash)||!['approve','reject'].includes(decision)||decision==='approve'&&confirmation!==DOCUMENT_REIMPORT_CONFIRMATION)throw new MemoryCipherError();
  const context=await authenticatedContext(input),{owner,lease,authority,current,check}=context,row=await loadEncryptedOwnerRow(runner,'memory_encryption_document_admissions',owner.ownerId,admissionId);await check();
  if(!row||!documentAdmissionMatchesAuthority(row,authority.anchor,lease.scope.memberId)||row.review_hash!==expectedHash||!['pending','applied','rejected'].includes(String(row.state)))throw new MemoryCipherError();
  if(await recordRead({readerKind:'user',readerId:owner.ownerId,purpose:'tool',records:[{table:'memory_encryption_document_admissions',id:admissionId}]})!==true)throw new MemoryCipherError();await check();
  const material=await lease.resolveKey({user_id:owner.ownerId});key=material.key;if(material.id!==authority.anchor.keyId)throw new MemoryCipherError();const activeKey=key,plain=decryptMemoryRow('memory_encryption_document_admissions',row,lease.scope,key,material.id),plan=captureDocumentAdmissionPlan(JSON.parse(String(plain.plan))),expectedReview=reviewHash(admissionId,plan,authority.anchor,key);
  if(!timingSafeEqual(Buffer.from(expectedReview,'hex'),Buffer.from(expectedHash,'hex')))throw new MemoryCipherError();
  if(plain.state!=='pending'){if(plain.state!==(decision==='approve'?'applied':'rejected'))throw new MemoryCipherError();return{admissionId,state:String(plain.state),replayed:true,newContent:true};}
  const nextPlain={...plain,state:decision==='approve'?'applied':'rejected',source_revision:Number(plain.source_revision)+(decision==='approve'?1:0),file_revision:Number(plain.file_revision)+(decision==='approve'?1:0),decided_by:owner.ownerId,decided_at:new Date().toISOString()},next=encryptMemoryRow('memory_encryption_document_admissions',nextPlain,lease.scope,key,material.id);
  const assertCurrentStep=function*():Step<void>{const fresh=yield* authenticatedMemoryOwnerStep(token);if(JSON.stringify(fresh)!==JSON.stringify(owner)||!current())throw new MemoryCipherError();const stored=yield* one<Row>(`SELECT * FROM ${DOCUMENT_ADMISSION_TABLE} WHERE id=? AND owner_id=?`,admissionId,owner.ownerId);if(!stored||canonicalEncryptedRow(stored)!==canonicalEncryptedRow(row))throw new MemoryCipherError();};
  const consumeStep=function*():Step<void>{yield* assertCurrentStep();const fields=Object.keys(next).filter(field=>!['id','owner_id'].includes(field));const changed=yield* run(`UPDATE ${DOCUMENT_ADMISSION_TABLE} SET ${fields.map(field=>field+'=?').join(',')} WHERE id=? AND owner_id=? AND state='pending'`,...fields.map(field=>next[field] as SqlParam),admissionId,owner.ownerId);const stored=yield* one<Row>(`SELECT * FROM ${DOCUMENT_ADMISSION_TABLE} WHERE id=? AND owner_id=?`,admissionId,owner.ownerId);if(changed.changes!==1||!stored||canonicalEncryptedRow(stored)!==canonicalEncryptedRow(next)||!current())throw new MemoryCipherError();};
  if(decision==='reject'){await runner.tx(assertCurrentStep,{immediate:true});await check();await beforeEncryptedMemoryEffect({runner,action:'decide-document-import',auth:owner,isCurrent:()=>current()&&Date.now()<owner.validUntil,targetDigest:memoryEffectDigest([row,next,decision])});await runner.tx(consumeStep,{immediate:true});await check();return{admissionId,state:'rejected',newContent:true};}
  const supplied=await input.authorizeFile(plan.file.id);await check();if(!supplied)throw new MemoryCipherError();const fileLease={...supplied,isCurrent:supplied.isCurrent.bind(supplied)};validateLease(fileLease,plan.file.id);
  if(fileLease.sourceId!==plan.source.id||fileLease.root!==plan.file.root||fileLease.relativePath!==plan.file.relativePath||fileLease.format!==plan.file.format||fileLease.sha256!==plan.file.sha256||fileLease.size!==plan.file.size||fileLease.expectedSourceRevision!==plan.source.revision||fileLease.expectedFileRevision!==plan.file.revision)throw new MemoryCipherError();
  const source=await loadEncryptedOwnerRow(runner,'doc_index_sources',owner.ownerId,plan.source.id),file=await loadEncryptedOwnerRow(runner,'doc_index_files',owner.ownerId,plan.file.id);await check();if(!source||hash(canonicalEncryptedRow(source))!==plan.source.cipherHash||(file?hash(canonicalEncryptedRow(file)):null)!==plan.file.cipherHash)throw new MemoryCipherError();
  const admission:DocumentWriteAdmission={isCurrent:()=>current()&&fileLease.isCurrent(),assertCurrentStep,consumeStep,assertExtraction:extraction=>{if(JSON.stringify(extraction)!==JSON.stringify({chunks:plan.chunks,pages:plan.pages,reason:plan.reason}))throw new MemoryCipherError();}};
  const receipt=await indexAuthenticatedEncryptedDocumentFile({runner,token,session,recordRead,fileId:plan.file.id,authorize:async()=>fileLease,admission,embedDocument:input.embedDocument});await check();return{admissionId,state:'applied',newContent:true,...receipt};
 }catch{input.session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
