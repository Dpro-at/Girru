import {observeEncryptedRunContextSources} from './run-admission.js';
import {readMemoryControlStep} from './control-runner.js';
import {memoryControlQuery} from './control-runner.js';
import {validateAdmittedDocumentFile} from './document-coverage.js';
import {captureMemoryRestoreAnchor,sameMemoryRestoreAnchor} from './restore-package.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
import {captureDocumentAdmissionPlan,documentAdmissionMatchesAuthority,requireAppliedDocumentAdmission} from './document-lineage.js';
/** Selected encrypted document reads. No filesystem scan, default SQL handle, legacy cache or implicit source creation. */
import {createHash} from 'node:crypto';
import {all,one,run as sqlRun,dialect,tableColumns,type StepRunner,type Step} from '../../repositories/sql-steps.js';
import type {DocHit,DocScopes} from '../docs/recall.js';
import {lexicalTokens} from '../text-normalize.js';
import {bm25FromCounts,hybridScore,termCounts,vectorScore,MIN_RECALL_SCORE} from '../hybrid.js';
import {cosine,type EmbeddingResult} from '../embedding.js';
import {unpackVector} from '../vectors.js';
import {captureAuthenticatedMemoryRun,authenticatedMemoryRunStep} from './auth-capture.js';
import {createMemoryRevisionValidator} from './revision-validator.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {memoryRowSurfaceManifest,decryptMemoryRow,type MemoryRowTable} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
type Row=Record<string,unknown>;
export const DOCUMENT_TABLES=['doc_index_sources','doc_index_files','doc_index_chunks','memory_encryption_document_admissions'] as const;
type DocumentTable=typeof DOCUMENT_TABLES[number];
const MAX_ROWS=5000,MAX_BYTES=32*1024*1024;
export type EncryptedDocumentReadInput={runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;run:Parameters<typeof captureAuthenticatedMemoryRun>[2];recordRead:(intent:MemoryReadIntent)=>Promise<boolean>;captureAuthority:()=>Promise<MemoryRestoreAuthorityLease|null>};
/** Bound transfer before loading ciphertext, including trigger-produced oversized values. */
export function* documentCipherRowsStep(table:DocumentTable,ownerId:string):Step<Row[]>{
 const surface=memoryRowSurfaceManifest().find(surface=>surface.table===table);if(!surface)throw new MemoryCipherError();
 const driver=yield* dialect();if(driver==='postgres')yield* sqlRun(`LOCK TABLE ${table} IN SHARE MODE`);
 const fields=[surface.owner,surface.id,...surface.bound,...surface.clear,...surface.text,...surface.binary],binary=new Set<string>(surface.binary);
 const columns=driver==='sqlite'?(yield* all<{name:string}>('SELECT name FROM pragma_table_xinfo(?)',table)).map(row=>row.name):yield* tableColumns(table);
 if([...columns].sort().join('\0')!==[...fields].sort().join('\0'))throw new MemoryCipherError();
 const lengths=fields.map(field=>driver==='sqlite'?`COALESCE(length(CAST(${field} AS BLOB)),0)`:`COALESCE(octet_length(${binary.has(field)?field:`CAST(${field} AS TEXT)`}),0)`);
 const size=yield* one<{n:number|string;b:number|string|null}>(`SELECT count(*) n,SUM(${lengths.join('+')}) b FROM ${table} WHERE owner_id=?`,ownerId);
 const n=Number(size?.n),bytes=Number(size?.b??0);if(!Number.isSafeInteger(n)||n<0||n>MAX_ROWS||!Number.isSafeInteger(bytes)||bytes<0||bytes>MAX_BYTES)throw new MemoryCipherError();
 const rows=yield* all<Row>(`SELECT * FROM ${table} WHERE owner_id=? ORDER BY id LIMIT ${MAX_ROWS+1}`,ownerId);if(rows.length!==n)throw new MemoryCipherError();return rows;
}
export function permittedEncryptedDocumentScope(source:Readonly<Row>,run:EncryptedDocumentReadInput['run'],access:{authorize:(row:Readonly<Row>)=>boolean},ownerId:string,projects:readonly {id:string;slug:string}[]=[]):boolean{
 if(source.owner_id!==ownerId||Number(source.enabled)!==1||typeof source.ref_id!=='string')return false;
 if(source.kind==='agent')return source.ref_id===run.agentId&&access.authorize({user_id:ownerId,drawer_kind:'owner',drawer_key:'',status:'active'});
 if(source.kind!=='project')return false;const project=projects.find(project=>project.id===source.ref_id);return !!project&&[project.id,project.slug].some(key=>access.authorize({user_id:ownerId,drawer_kind:'project',drawer_key:key,status:'active'}));
}
/** Final transaction verifies complete relevant owner sets, so deletions/new rows cannot hide behind old revisions. */
async function readSelectedDocuments<T>(input:EncryptedDocumentReadInput,project:(value:{sources:Row[];files:Row[];chunks:Row[];scopes:DocScopes;outside:Set<string>;cipherEvidence:Map<string,{table:DocumentTable;id:string;cipher:string}>})=>Promise<T>|T):Promise<T>{
 const {runner,token,session,recordRead}=input;let key:Buffer|undefined;const plaintextBuffers:Buffer[]=[];
 try{
  const run={...input.run,delegatedFrom:[...input.run.delegatedFrom],drawers:input.run.drawers.map(drawer=>({...drawer}))},lease=session.capture(),auth=await captureAuthenticatedMemoryRun(runner,token,run);
  if(run.audience!=='owner'||auth.ownerId!==lease.scope.ownerId)throw new MemoryCipherError();
  const suppliedAuthority=await input.captureAuthority();if(!suppliedAuthority||!suppliedAuthority.isCurrent())throw new MemoryCipherError();const authority={anchor:captureMemoryRestoreAnchor(suppliedAuthority.anchor),isCurrent:suppliedAuthority.isCurrent.bind(suppliedAuthority)};if(authority.anchor.ownerId!==auth.ownerId||authority.anchor.memberId!==lease.scope.memberId)throw new MemoryCipherError();
  const validate=createMemoryRevisionValidator(runner,auth.revision,session.lock),check=async()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1'||!lease.isCurrent()||!authority.isCurrent()||await validate()!==true||!lease.isCurrent())throw new MemoryCipherError();const fresh=await input.captureAuthority();if(!fresh||!fresh.isCurrent()||!sameMemoryRestoreAnchor(authority.anchor,fresh.anchor)||!authority.isCurrent())throw new MemoryCipherError();};await check();
  const sets=await runner.tx(function*(){const result=new Map<DocumentTable,Row[]>();for(const table of DOCUMENT_TABLES)result.set(table,yield* documentCipherRowsStep(table,auth.ownerId));return result;},{immediate:true});await check();
  const expected=new Map(DOCUMENT_TABLES.map(table=>[table,JSON.stringify(sets.get(table)!.map(canonicalEncryptedRow))]));
  const projects=await readMemoryControlStep(runner,all<{id:string;slug:string}>('SELECT id,slug FROM chat_projects WHERE user_id=? ORDER BY id',auth.ownerId));await check();
  const sources=sets.get('doc_index_sources')!.filter(source=>permittedEncryptedDocumentScope(source,run,auth.access,auth.ownerId,projects));
  const ids=new Set(sources.map(source=>String(source.id))),files=sets.get('doc_index_files')!.filter(file=>ids.has(String(file.source_id))),chunks=sets.get('doc_index_chunks')!.filter(chunk=>ids.has(String(chunk.source_id))),fileIds=new Set(files.map(file=>String(file.id))),admissions=sets.get('memory_encryption_document_admissions')!.filter(row=>row.state==='applied'&&fileIds.has(String(row.file_id))&&documentAdmissionMatchesAuthority(row,authority.anchor,lease.scope.memberId));
  for(const [table,rows] of [['doc_index_sources',sources],['doc_index_files',files],['doc_index_chunks',chunks],['memory_encryption_document_admissions',admissions]] as Array<[DocumentTable,Row[]]>){for(let offset=0;offset<rows.length;offset+=500){if(await recordRead({readerKind:'agent',readerId:run.agentId,purpose:'recall',records:rows.slice(offset,offset+500).map(row=>({table,id:String(row.id)}))})!==true)throw new MemoryCipherError();await check();}}
  const material=await lease.resolveKey({user_id:auth.ownerId});key=material.key;if(material.id!==authority.anchor.keyId)throw new MemoryCipherError();await check();const activeKey=key;
  const decode=(table:MemoryRowTable,rows:Row[])=>rows.map(row=>{if(!lease.isCurrent())throw new MemoryCipherError();const plain=decryptMemoryRow(table,row,lease.scope,activeKey,material.id);for(const value of Object.values(plain))if(Buffer.isBuffer(value))plaintextBuffers.push(value);return plain;});
  const plainSources=decode('doc_index_sources',sources),plainFiles=decode('doc_index_files',files),plainChunks=decode('doc_index_chunks',chunks),plainAdmissions=decode('memory_encryption_document_admissions',admissions),sourceById=new Map(plainSources.map(row=>[String(row.id),row])),fileById=new Map(plainFiles.map(row=>[String(row.id),row]));
  for(const source of plainSources)if(!permittedEncryptedDocumentScope(source,run,auth.access,auth.ownerId,projects)||!Number.isSafeInteger(Number(source.revision))||Number(source.revision)<0)throw new MemoryCipherError();
  for(const file of plainFiles){const source=sourceById.get(String(file.source_id));if(!source||file.owner_id!==auth.ownerId||!['ok','unreadable'].includes(String(file.status))||typeof file.display_path!=='string'||Buffer.byteLength(file.display_path)>16384)throw new MemoryCipherError();const admitted=plainAdmissions.filter(row=>row.file_id===file.id&&row.file_hash===file.file_hash&&Number(row.file_revision)===Number(file.revision));if(admitted.length!==1)throw new MemoryCipherError();requireAppliedDocumentAdmission(admitted[0],captureDocumentAdmissionPlan(JSON.parse(String(admitted[0].plan))),file,source,authority.anchor,lease.scope.memberId);validateAdmittedDocumentFile(file,source,plainChunks.filter(chunk=>chunk.file_id===file.id),plainAdmissions,authority.anchor,lease.scope.memberId);}
  for(const chunk of plainChunks){const source=sourceById.get(String(chunk.source_id)),file=fileById.get(String(chunk.file_id));if(!source||!file||file.source_id!==source.id||file.status!=='ok'||chunk.scope_kind!==source.kind||chunk.scope_key!==source.ref_id||chunk.file_hash!==file.file_hash||Number(chunk.revision)!==Number(file.revision)||typeof chunk.content!=='string'||Buffer.byteLength(chunk.content)>16384||typeof chunk.lex!=='string'||Buffer.byteLength(chunk.lex)>65536)throw new MemoryCipherError();}
  const scopes:DocScopes={sources:plainSources.map(source=>({id:String(source.id),kind:source.kind as 'project'|'agent',refId:String(source.ref_id),revision:Number(source.revision),state:String(source.state),scannedAt:source.scanned_at as string|null})),token:createHash('sha256').update(JSON.stringify(sources.map(canonicalEncryptedRow))).digest('hex')};
  const outside=new Set<string>(),trust=await readMemoryControlStep(runner,all<{project_id:string;outside:number|string}>('SELECT project_id,outside FROM project_trust WHERE owner_id=? ORDER BY project_id',auth.ownerId));await check();
  const trustById=new Map(trust.map(row=>[row.project_id,Number(row.outside)]));for(const source of plainSources)if(source.kind==='project'&&trustById.get(String(source.ref_id))!==0)outside.add(String(source.ref_id));
  const cipherEvidence=new Map<string,{table:DocumentTable;id:string;cipher:string}>();for(const [table,rows]of [['doc_index_sources',sources],['doc_index_files',files],['doc_index_chunks',chunks],['memory_encryption_document_admissions',admissions]] as Array<[DocumentTable,Row[]]>)for(const row of rows)cipherEvidence.set(table+':'+row.id,{table,id:String(row.id),cipher:canonicalEncryptedRow(row)});
  const result=await project({sources:plainSources,files:plainFiles,chunks:plainChunks,scopes,outside,cipherEvidence});await check();
  await runner.tx(function*(){const fresh=yield* authenticatedMemoryRunStep(token,run);if(JSON.stringify(fresh.revision)!==JSON.stringify(auth.revision)||!lease.isCurrent()||!authority.isCurrent())throw new MemoryCipherError();for(const table of DOCUMENT_TABLES){const rows=yield* documentCipherRowsStep(table,auth.ownerId);if(JSON.stringify(rows.map(canonicalEncryptedRow))!==expected.get(table))throw new MemoryCipherError();}const currentProjects=yield* memoryControlQuery(()=>all<{id:string;slug:string}>('SELECT id,slug FROM chat_projects WHERE user_id=? ORDER BY id',auth.ownerId));if(JSON.stringify(currentProjects)!==JSON.stringify(projects))throw new MemoryCipherError();const currentTrust=yield* memoryControlQuery(()=>all<{project_id:string;outside:number|string}>('SELECT project_id,outside FROM project_trust WHERE owner_id=? ORDER BY project_id',auth.ownerId));if(JSON.stringify(currentTrust)!==JSON.stringify(trust)||!lease.isCurrent()||Date.now()>=auth.revision.validUntil)throw new MemoryCipherError();},{immediate:true});await check();return result;
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);for(const bytes of plaintextBuffers)bytes.fill(0);}
}
export function encryptedDocumentScopes(input:EncryptedDocumentReadInput):Promise<DocScopes>{return readSelectedDocuments(input,value=>value.scopes);}
export async function recallEncryptedDocuments(input:EncryptedDocumentReadInput&{query:string;limit?:number;scopes?:DocScopes;embedQuery?:(text:string)=>Promise<EmbeddingResult>}):Promise<{items:DocHit[];reliable:boolean;best:number}>{
 const query=input.query,limit=input.limit??4,requested=input.scopes?JSON.parse(JSON.stringify(input.scopes)) as DocScopes:undefined;
 if(typeof query!=='string'||Buffer.byteLength(query)>4096||!Number.isInteger(limit)||limit<1||limit>20)throw new MemoryCipherError();
 return readSelectedDocuments(input,async value=>{
  if(requested&&JSON.stringify(requested)!==JSON.stringify(value.scopes))throw new MemoryCipherError();const trimmed=query.trim();if(!trimmed||!value.chunks.length)return{items:[],reliable:false,best:0};
  const queryVector=input.embedQuery?await input.embedQuery(trimmed):null;
  try{
   const fileById=new Map(value.files.map(row=>[String(row.id),row])),documents=value.chunks.map(row=>({row,counts:termCounts(String(row.lex).split(' ').filter(Boolean)),length:String(row.lex).split(' ').filter(Boolean).length})),lexical=bm25FromCounts(lexicalTokens(trimmed),documents);
   const scored=documents.map((document,index)=>{const vector=unpackVector(document.row.embedding_vec),comparable=queryVector&&vector&&document.row.embedding_model===queryVector.model&&vector.length===queryVector.vector.length;const meaning=comparable&&(queryVector!.semantic||lexical[index]>0)?vectorScore(cosine(queryVector!.vector,vector!),queryVector!.semantic):null;return{row:document.row,score:hybridScore(meaning,lexical[index],queryVector?.semantic??false)*(document.row.scope_kind==='project'&&value.outside.has(String(document.row.scope_key))?0.8:1)};}).filter(item=>item.score>=MIN_RECALL_SCORE).sort((a,b)=>b.score-a.score||String(a.row.id).localeCompare(String(b.row.id)));
   const best=scored[0]?.score??0;if(best<0.16)return{items:[],reliable:false,best};const perFile=new Map<string,number>(),items:DocHit[]=[];
   for(const item of scored){if(items.length>=limit||item.score<best*0.45)break;const file=fileById.get(String(item.row.file_id));if(!file)throw new MemoryCipherError();const id=String(file.id),count=perFile.get(id)??0;if(count>=2)continue;perFile.set(id,count+1);items.push({chunkId:String(item.row.id),file:String(file.display_path),page:item.row.page===null?null:Number(item.row.page),heading:item.row.heading as string|null,text:String(item.row.content),score:Math.round(item.score*1000)/1000,scope:{kind:item.row.scope_kind as 'project'|'agent',key:String(item.row.scope_key)},...(item.row.scope_kind==='project'&&value.outside.has(String(item.row.scope_key))?{outside:true}:{})});}
   observeEncryptedRunContextSources(items.map(item=>({kind:'document' as const,id:item.chunkId})));return{items,reliable:items.length>0,best};
  }finally{queryVector?.vector.fill(0);}
 });
}

/** Trace citations are read/audited under the same run; no supplied path or chunk ID grants access. */
export function encryptedDocumentTraceReferences(input:EncryptedDocumentReadInput&{ids:readonly string[]}){
 const ids=[...input.ids];if(ids.length>64||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id)))throw new MemoryCipherError();
 return readSelectedDocuments(input,value=>ids.map(id=>{
  const chunk=value.chunks.find(chunk=>chunk.id===id),file=chunk?value.files.find(file=>file.id===chunk.file_id):null;
  if(!chunk||!file)throw new MemoryCipherError();const documentAdmissions=[...value.cipherEvidence.values()].filter(item=>item.table==='memory_encryption_document_admissions');const evidence=[value.cipherEvidence.get('doc_index_sources:'+chunk.source_id),value.cipherEvidence.get('doc_index_files:'+file.id),value.cipherEvidence.get('doc_index_chunks:'+id),...documentAdmissions];if(evidence.some(item=>!item))throw new MemoryCipherError();
  return{id,drawer:String(chunk.scope_kind)+':'+String(chunk.scope_key),cite:{file:String(file.display_path),page:chunk.page===null?null:Number(chunk.page),heading:chunk.heading as string|null},evidence:evidence.map(item=>({...item!}))};
 }));
}
