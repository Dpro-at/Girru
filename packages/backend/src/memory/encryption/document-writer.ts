import {beforeEncryptedMemoryEffect,memoryEffectDigest} from './memory-effect.js';
import {memoryControlQuery} from './control-runner.js';
/** Explicit owner/host document producer. No discovery, default path, plaintext staging or global embedding provider. */
import {createHash} from 'node:crypto';
import path from 'node:path';
import {all,one,run,dialect,type StepRunner,type Step,type SqlParam} from '../../repositories/sql-steps.js';
import {chunkMarkdown,chunkText,chunkPages,type DocChunk} from '../docs/chunk.js';
import {extractPdfText} from '../docs/pdf-text.js';
import {redactImportText} from '../import/redact.js';
import {lexicalTokens} from '../text-normalize.js';
import {packVector} from '../vectors.js';
import type {EmbeddingResult} from '../embedding.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {loadEncryptedOwnerRow} from './owner-row-loader.js';
import {encryptMemoryRow,decryptMemoryRow,type MemoryRowTable} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import type {MemoryReadIntent} from './read-audit.js';
import {consumeAuthorizedMemoryFile,type MemoryImportFileLease} from './import-file.js';
import {MemoryCipherError} from './envelope.js';
type Row=Record<string,unknown>;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value);
const sourceId=(owner:string,kind:string,ref:string)=>hash(owner+'\n'+kind+'\n'+ref).slice(0,32);
export type MemoryDocumentFileLease=MemoryImportFileLease&{sourceId:string;root:string;relativePath:string;format:'markdown'|'text'|'pdf';expectedFileRevision:number;expectedSourceRevision:number};
export type DocumentWriteAdmission={isCurrent:()=>boolean;assertCurrentStep:()=>Step<void>;consumeStep:()=>Step<void>;assertExtraction:(value:ReturnType<typeof extractProtectedDocumentBytes>)=>void};
type OwnerInput={runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>};
function* insertRow(table:MemoryRowTable,row:Row):Step<void>{const fields=Object.keys(row);yield* run(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,...fields.map(field=>row[field] as SqlParam));}
/** Selected source setup is an explicit owner action. It never queues the legacy background indexer. */
export async function configureEncryptedDocumentSource(input:OwnerInput&{kind:'project'|'agent';refId:string;enabled:boolean;expectedRevision:number|null}){
 const {runner,token,session,recordRead}=input;let key:Buffer|undefined;
 try{
  const kind=input.kind,refId=input.refId,enabled=input.enabled,revision=input.expectedRevision;
  if(!['project','agent'].includes(kind)||!validId(refId)||typeof enabled!=='boolean'||revision!==null&&(!Number.isSafeInteger(revision)||revision<0))throw new MemoryCipherError();
  const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true}),id=sourceId(owner.ownerId,kind,refId);
  const check=async()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1'||!lease.isCurrent()||owner.ownerId!==lease.scope.ownerId||JSON.stringify(await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true}))!==JSON.stringify(owner))throw new MemoryCipherError();};await check();
  const before=await loadEncryptedOwnerRow(runner,'doc_index_sources',owner.ownerId,id);await check();
  if(before?Number(before.revision)!==revision:revision!==null)throw new MemoryCipherError();
  if(before&&await recordRead({readerKind:'user',readerId:owner.ownerId,purpose:'tool',records:[{table:'doc_index_sources',id}]})!==true)throw new MemoryCipherError();await check();
  const material=await lease.resolveKey({user_id:owner.ownerId});key=material.key;await check();const previous=before?decryptMemoryRow('doc_index_sources',before,lease.scope,key,material.id):null;
  if(previous&&(previous.kind!==kind||previous.ref_id!==refId))throw new MemoryCipherError();
  const now=new Date().toISOString(),plain:Row={id,owner_id:owner.ownerId,kind,ref_id:refId,enabled:enabled?1:0,state:'ready',revision:revision===null?0:revision+1,files:enabled?Number(previous?.files??0):0,chunks:enabled?Number(previous?.chunks??0):0,unreadable:enabled?Number(previous?.unreadable??0):0,limited:0,note:previous?.note??null,scanned_at:previous?.scanned_at??null,updated_at:now},cipher=encryptMemoryRow('doc_index_sources',plain,lease.scope,key,material.id);
  await runner.tx(function*(){const exists=kind==='project'?yield* memoryControlQuery(()=>one('SELECT id FROM chat_projects WHERE id=? AND user_id=?',refId,owner.ownerId)):yield* memoryControlQuery(()=>one('SELECT id FROM agents_config WHERE id=?',refId));if(!exists)throw new MemoryCipherError();},{immediate:true});await check();
  await beforeEncryptedMemoryEffect({runner,action:'configure-documents',auth:owner,isCurrent:()=>lease.isCurrent()&&Date.now()<owner.validUntil,targetDigest:memoryEffectDigest([before,cipher])});
  await runner.tx(function*(){const fresh=yield* authenticatedMemoryOwnerStep(token);if(JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();
   const exists=kind==='project'?yield* memoryControlQuery(()=>one('SELECT id FROM chat_projects WHERE id=? AND user_id=?',refId,owner.ownerId)):yield* memoryControlQuery(()=>one('SELECT id FROM agents_config WHERE id=?',refId));if(!exists)throw new MemoryCipherError();
   if((yield* dialect())==='postgres')yield* run('LOCK TABLE doc_index_sources,doc_index_files,doc_index_chunks IN SHARE ROW EXCLUSIVE MODE');
   const current=yield* one<Row>('SELECT * FROM doc_index_sources WHERE id=? AND owner_id=?',id,owner.ownerId);if(before?(!current||canonicalEncryptedRow(current)!==canonicalEncryptedRow(before)):!!current)throw new MemoryCipherError();
   if(!enabled){yield* run('DELETE FROM doc_index_chunks WHERE source_id=? AND owner_id=?',id,owner.ownerId);yield* run('DELETE FROM doc_index_files WHERE source_id=? AND owner_id=?',id,owner.ownerId);}
   if(current)yield* run('DELETE FROM doc_index_sources WHERE id=? AND owner_id=?',id,owner.ownerId);yield* insertRow('doc_index_sources',cipher);
   const stored=yield* one<Row>('SELECT * FROM doc_index_sources WHERE id=? AND owner_id=?',id,owner.ownerId);if(!stored||canonicalEncryptedRow(stored)!==canonicalEncryptedRow(cipher)||!lease.isCurrent()||Date.now()>=owner.validUntil)throw new MemoryCipherError();
  },{immediate:true});await check();return{sourceId:id,revision:Number(plain.revision),enabled};
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
/** Host resolves opaque file IDs to current exclusive leases. Renderer paths never grant read authority. */
export async function indexAuthenticatedEncryptedDocumentFile(input:OwnerInput&{fileId:string;authorize:(fileId:string)=>Promise<MemoryDocumentFileLease|null>;admission:DocumentWriteAdmission;embedDocument?:(text:string)=>Promise<EmbeddingResult>}){
 const {runner,token,session,recordRead}=input;let key:Buffer|undefined;const vectors:Buffer[]=[];
 try{
  const fileId=input.fileId;if(!/^[a-f0-9]{32}$/.test(fileId)||typeof input.authorize!=='function'||!input.admission||typeof input.admission.isCurrent!=='function'||typeof input.admission.assertCurrentStep!=='function'||typeof input.admission.consumeStep!=='function'||typeof input.admission.assertExtraction!=='function'||!input.admission.isCurrent())throw new MemoryCipherError();
  const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});
  const check=async()=>{if(!input.admission.isCurrent())throw new MemoryCipherError();if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1'||!lease.isCurrent()||owner.ownerId!==lease.scope.ownerId||JSON.stringify(await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true}))!==JSON.stringify(owner))throw new MemoryCipherError();};await check();
  const supplied=await input.authorize(fileId);await check();if(!supplied)throw new MemoryCipherError();const fileLease={...supplied,isCurrent:supplied.isCurrent.bind(supplied)};
  if(fileLease.fileId!==fileId||!validId(fileLease.sourceId)||fileLease.root!==path.resolve(fileLease.root)||typeof fileLease.relativePath!=='string'||!fileLease.relativePath||path.isAbsolute(fileLease.relativePath)||fileLease.relativePath.split(/[\\/]/).some(part=>!part||part==='.'||part==='..')||path.resolve(fileLease.root,fileLease.relativePath)!==fileLease.path||fileId!==hash(fileLease.sourceId+'\n'+fileLease.root+'\n'+fileLease.relativePath).slice(0,32)||!['markdown','text','pdf'].includes(fileLease.format)||![fileLease.expectedFileRevision,fileLease.expectedSourceRevision].every(value=>Number.isSafeInteger(value)&&value>=0))throw new MemoryCipherError();
  const current=()=>lease.isCurrent()&&fileLease.isCurrent()&&input.admission.isCurrent();
  const beforeSource=await loadEncryptedOwnerRow(runner,'doc_index_sources',owner.ownerId,fileLease.sourceId),beforeFile=await loadEncryptedOwnerRow(runner,'doc_index_files',owner.ownerId,fileId);await check();
  if(!beforeSource||Number(beforeSource.enabled)!==1||Number(beforeSource.revision)!==fileLease.expectedSourceRevision||(beforeFile?Number(beforeFile.revision)!==fileLease.expectedFileRevision:fileLease.expectedFileRevision!==0))throw new MemoryCipherError();
  const records:MemoryReadIntent['records']=[{table:'doc_index_sources',id:fileLease.sourceId},...(beforeFile?[{table:'doc_index_files' as const,id:fileId}]:[])];if(await recordRead({readerKind:'user',readerId:owner.ownerId,purpose:'tool',records})!==true)throw new MemoryCipherError();await check();
  const material=await lease.resolveKey({user_id:owner.ownerId});key=material.key;await check();const activeKey=key,source=decryptMemoryRow('doc_index_sources',beforeSource,lease.scope,key,material.id),oldFile=beforeFile?decryptMemoryRow('doc_index_files',beforeFile,lease.scope,key,material.id):null;
  if(source.id!==sourceId(owner.ownerId,String(source.kind),String(source.ref_id))||oldFile&&(oldFile.source_id!==source.id||oldFile.root!==fileLease.root||oldFile.rel_path!==fileLease.relativePath))throw new MemoryCipherError();
  return await consumeAuthorizedMemoryFile({fileId,authorize:async()=>fileLease,isCurrent:current,consume:async request=>{
   await check();const extraction=extractProtectedDocumentBytes(fileLease.format,request.bytes),extracted=extraction.chunks,pages=extraction.pages,reason=extraction.reason;input.admission.assertExtraction(extraction);
   if(extracted.length>1500||extracted.reduce((bytes,chunk)=>bytes+Buffer.byteLength(chunk.text)+Buffer.byteLength(chunk.heading??''),0)>2*1024*1024)throw new MemoryCipherError();
   const now=new Date().toISOString(),nextRevision=fileLease.expectedFileRevision+1,plainFile:Row={id:fileId,source_id:source.id,owner_id:owner.ownerId,root:fileLease.root,rel_path:fileLease.relativePath,display_path:source.kind==='agent'?'knowledge/'+fileLease.relativePath:fileLease.relativePath,file_hash:request.sourceDigest,revision:nextRevision,bytes:fileLease.size,mtime_ms:0,status:reason?'unreadable':'ok',reason,pages,chunks:extracted.length,indexed_at:now},fileCipher=encryptMemoryRow('doc_index_files',plainFile,lease.scope,activeKey,material.id),chunkCiphers:Row[]=[];
   for(const [ordinal,chunk]of extracted.entries()){await check();if(!request.sourceLease())throw new MemoryCipherError();let model:string|null=null,vector:Buffer|null=null;if(input.embedDocument){const embedded=await input.embedDocument((chunk.heading?chunk.heading+'\n':'')+chunk.text);try{if(!Number.isSafeInteger(embedded.dims)||embedded.dims<1||embedded.dims>8192||embedded.vector.length!==embedded.dims||embedded.vector.some(value=>!Number.isFinite(value)||Math.abs(value)>3.4028234663852886e38))throw new MemoryCipherError();model=embedded.model;vector=packVector(embedded.vector);vectors.push(vector);}finally{embedded.vector.fill(0);}}await check();const plain:Row={id:hash(fileId+'\n'+nextRevision+'\n'+ordinal).slice(0,32),file_id:fileId,source_id:source.id,owner_id:owner.ownerId,scope_kind:source.kind,scope_key:source.ref_id,ordinal,page:chunk.page,heading:chunk.heading,content:chunk.text,lex:lexicalTokens((chunk.heading?chunk.heading+'\n':'')+chunk.text).join(' '),file_hash:request.sourceDigest,revision:nextRevision,embedding_model:model,embedding_vec:vector,created_at:now};chunkCiphers.push(encryptMemoryRow('doc_index_chunks',plain,lease.scope,activeKey,material.id));}
   await check();await runner.tx(function*(){yield* input.admission.assertCurrentStep();const counts=yield* one<{files:number|string;chunks:number|string;owner_files:number|string;owner_chunks:number|string}>('SELECT (SELECT count(*) FROM doc_index_files WHERE source_id=? AND owner_id=? AND id<>?) files,(SELECT count(*) FROM doc_index_chunks WHERE source_id=? AND owner_id=? AND file_id<>?) chunks,(SELECT count(*) FROM doc_index_files WHERE owner_id=? AND id<>?) owner_files,(SELECT count(*) FROM doc_index_chunks WHERE owner_id=? AND file_id<>?) owner_chunks',source.id as string,owner.ownerId,fileId,source.id as string,owner.ownerId,fileId,owner.ownerId,fileId,owner.ownerId,fileId);if(!counts||Number(counts.files)+1>500||Number(counts.chunks)+chunkCiphers.length>5000||Number(counts.owner_files)+1>5000||Number(counts.owner_chunks)+chunkCiphers.length>5000)throw new MemoryCipherError();},{immediate:true});await check();await beforeEncryptedMemoryEffect({runner,action:'index-document-file',auth:owner,isCurrent:()=>current()&&request.sourceLease()&&Date.now()<owner.validUntil,targetDigest:memoryEffectDigest([beforeSource,beforeFile,fileCipher,chunkCiphers])});await runner.tx(function*(){const fresh=yield* authenticatedMemoryOwnerStep(token);if(JSON.stringify(fresh)!==JSON.stringify(owner)||!request.sourceLease())throw new MemoryCipherError();yield* input.admission.assertCurrentStep();if((yield* dialect())==='postgres')yield* run('LOCK TABLE doc_index_sources,doc_index_files,doc_index_chunks IN SHARE ROW EXCLUSIVE MODE');
    const currentSource=yield* one<Row>('SELECT * FROM doc_index_sources WHERE id=? AND owner_id=?',source.id as string,owner.ownerId),currentFile=yield* one<Row>('SELECT * FROM doc_index_files WHERE id=? AND owner_id=?',fileId,owner.ownerId);if(!currentSource||canonicalEncryptedRow(currentSource)!==canonicalEncryptedRow(beforeSource)||(beforeFile?(!currentFile||canonicalEncryptedRow(currentFile)!==canonicalEncryptedRow(beforeFile)):!!currentFile))throw new MemoryCipherError();
    yield* run('DELETE FROM doc_index_chunks WHERE file_id=? AND owner_id=?',fileId,owner.ownerId);if(currentFile)yield* run('DELETE FROM doc_index_files WHERE id=? AND owner_id=?',fileId,owner.ownerId);yield* insertRow('doc_index_files',fileCipher);for(const chunk of chunkCiphers)yield* insertRow('doc_index_chunks',chunk);
    const counts=yield* one<{files:number|string;chunks:number|string;unreadable:number|string}>('SELECT (SELECT count(*) FROM doc_index_files WHERE source_id=? AND owner_id=?) files,(SELECT count(*) FROM doc_index_chunks WHERE source_id=? AND owner_id=?) chunks,(SELECT count(*) FROM doc_index_files WHERE source_id=? AND owner_id=? AND status=?) unreadable',source.id as string,owner.ownerId,source.id as string,owner.ownerId,source.id as string,owner.ownerId,'unreadable');if(!counts||Number(counts.files)>500||Number(counts.chunks)>5000)throw new MemoryCipherError();
    const nextSource={...source,revision:Number(source.revision)+1,files:Number(counts.files),chunks:Number(counts.chunks),unreadable:Number(counts.unreadable),state:'ready',note:source.note,scanned_at:now,updated_at:now},sourceCipher=encryptMemoryRow('doc_index_sources',nextSource,lease.scope,activeKey,material.id);yield* run('DELETE FROM doc_index_sources WHERE id=? AND owner_id=?',source.id as string,owner.ownerId);yield* insertRow('doc_index_sources',sourceCipher);
    const storedFile=yield* one<Row>('SELECT * FROM doc_index_files WHERE id=? AND owner_id=?',fileId,owner.ownerId),storedChunks=yield* all<Row>('SELECT * FROM doc_index_chunks WHERE file_id=? AND owner_id=? ORDER BY ordinal',fileId,owner.ownerId),storedSource=yield* one<Row>('SELECT * FROM doc_index_sources WHERE id=? AND owner_id=?',source.id as string,owner.ownerId);yield* input.admission.consumeStep();if(!storedFile||canonicalEncryptedRow(storedFile)!==canonicalEncryptedRow(fileCipher)||storedChunks.length!==chunkCiphers.length||storedChunks.some((row,index)=>canonicalEncryptedRow(row)!==canonicalEncryptedRow(chunkCiphers[index]))||!storedSource||canonicalEncryptedRow(storedSource)!==canonicalEncryptedRow(sourceCipher)||!request.sourceLease()||Date.now()>=owner.validUntil)throw new MemoryCipherError();
   },{immediate:true});await check();return{fileId,revision:nextRevision,chunks:chunkCiphers.length,unreadable:reason!==null};
  }});
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);for(const vector of vectors)vector.fill(0);}
}

/** Same pure extraction/redaction for native preview and its exact approved write. */
export function extractProtectedDocumentBytes(format:'markdown'|'text'|'pdf',bytes:Buffer):{chunks:DocChunk[];pages:number|null;reason:string|null}{
 if(!Buffer.isBuffer(bytes)||bytes.length>512*1024||!['markdown','text','pdf'].includes(format))throw new MemoryCipherError();
 if(format==='pdf'){const value=extractPdfText(bytes);return value.ok?{chunks:chunkPages(value.pages.map(page=>({page:page.page,text:redactImportText(page.text).text}))),pages:value.pageCount,reason:null}:{chunks:[],pages:null,reason:value.reason};}
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\0'))throw new MemoryCipherError();const redacted=redactImportText(text.replace(/^\uFEFF/,'')).text;return{chunks:format==='markdown'?chunkMarkdown(redacted):chunkText(redacted),pages:null,reason:null};
}
