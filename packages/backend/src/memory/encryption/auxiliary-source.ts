import {captureLogicalMemoryParentsMetadataStep,assertLogicalMemoryParentMetadataStep,logicalMemoryParentReadRecords,loadLogicalMemoryParentPayloadStep,openLogicalMemoryParents,isTrustedLogicalMemoryParents,type LogicalMemoryParentMetadata} from './logical-memory-parents.js';
/** Audited lossless capture from an explicitly authorized isolated source. Never mutates the source. */
import {createHash} from 'node:crypto';
import {all,one,run,dialect,tableColumns,type Step,type StepRunner} from '../../repositories/sql-steps.js';
import {AUXILIARY_TABLES,AUXILIARY_V2_TABLES,AUXILIARY_SHAPES,captureOwnerAuxiliaryBundle,type AuxiliaryTable,type AuxiliaryRow,type AuxiliaryParents} from './auxiliary-bundle.js';
import {AUXILIARY_RECORD_TABLE,prepareAuxiliaryPlainRecords} from './auxiliary-records.js';
import {prepareMemoryCopyBatch,verifyMemoryCopyCiphertext,type MemoryCopyBatch} from './copy-batch.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import type {createMemoryUnlockSession} from './unlock-session.js';
import {captureMemoryRestoreAnchor,sameMemoryRestoreAnchor} from './restore-package.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
import type {MemoryRowScope} from './row-codec.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
const MAX_ROWS=5000,MAX_BYTES=4*1024*1024;
type Raw={parents:AuxiliaryParents;rows:Record<AuxiliaryTable,AuxiliaryRow[]>;ids:Record<AuxiliaryTable,string[]>;parentIds:Record<AuxiliaryTable,string[]>};
function fail():never{throw new MemoryCipherError();}
const count=(value:unknown,max:number)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0||n>max)fail();return n;};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const keyFields=(table:AuxiliaryTable)=>table==='memory_import_previews'?['batch_id','version']:table==='memory_trust'?['memory_id']:table==='memory_trust_sources'?['memory_id','source_key']:table==='memory_recall_uses'?['run_id','memory_id']:['id'];
/** SQL performs ownership and byte checks before any payload text crosses into the process. */
export function* captureAuxiliaryRawSourceStep(ownerId:string,contents:boolean,version:1|2=2,logicalMetadata?:LogicalMemoryParentMetadata,authorizedLogical?:ReturnType<typeof openLogicalMemoryParents>):Step<Raw>{
 if(typeof ownerId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(ownerId))fail();
 if(logicalMetadata){if(logicalMetadata.ownerId!==ownerId)fail();yield* assertLogicalMemoryParentMetadataStep(logicalMetadata);if(contents&&(!authorizedLogical||!isTrustedLogicalMemoryParents(authorizedLogical)))fail();}
 if(version!==1&&version!==2)fail();const tables=version===1?AUXILIARY_TABLES:AUXILIARY_V2_TABLES,driver=yield* dialect();
 if(driver==='postgres')yield* run('LOCK TABLE memories,memory_import_batches,'+tables.join(',')+' IN SHARE MODE');
 const memoryParents=logicalMetadata?`(SELECT id,user_id FROM memories UNION ALL SELECT v.memory_id AS id,v.user_id FROM memory_versions v WHERE v.change='delete' AND NOT EXISTS(SELECT 1 FROM memories m WHERE m.id=v.memory_id) AND NOT EXISTS(SELECT 1 FROM memory_versions later WHERE later.memory_id=v.memory_id AND later.version>v.version))`:'memories';
 if(logicalMetadata){const ambiguous=yield* one<{n:number|string}>(`SELECT count(*) n FROM (SELECT id FROM ${memoryParents} lp GROUP BY id HAVING count(DISTINCT user_id)>1) duplicate_parent`);if(!ambiguous||Number(ambiguous.n)!==0)fail();}
 // Orphans have no authenticated owner. Do not silently assign or discard their content.
 const orphanChecks=tables.map(table=>{const parent=table==='memory_import_previews'?'memory_import_batches':memoryParents,foreign=table==='memory_import_previews'?'batch_id':'memory_id',explicitOwner=['memory_trust','memory_trust_sources','memory_recall_uses'].includes(table)?' OR c.user_id IS NULL OR c.user_id<>p.user_id':'';return `(SELECT count(*) FROM ${table} c LEFT JOIN ${parent} p ON p.id=c.${foreign} WHERE p.id IS NULL OR p.user_id IS NULL${explicitOwner})`;});
 const orphan=yield* one<{n:number|string}>(`SELECT ${orphanChecks.join('+')} n`);
 if(!orphan||count(orphan.n,Number.MAX_SAFE_INTEGER)!==0)fail();
 const parents:AuxiliaryParents={memories:[],imports:[]};
 for(const [kind,table] of [['memories','memories'],['imports','memory_import_batches']] as const){
  const source=kind==='memories'?memoryParents+' logical_parent':table;
  const measure=driver==='sqlite'?'length(CAST(id AS BLOB))+length(CAST(user_id AS BLOB))':'octet_length(CAST(id AS TEXT))+octet_length(CAST(user_id AS TEXT))';
  const size=yield* one<{n:number|string;b:number|string|null}>(`SELECT count(*) n,SUM(${measure}) b FROM ${source} WHERE user_id=?`,ownerId);if(!size)fail();const n=count(size.n,MAX_ROWS);count(size.b??0,MAX_BYTES);
  const ids=yield* all<{id:string;user_id:string}>(`SELECT id,user_id FROM ${source} WHERE user_id=? ORDER BY id`,ownerId);if(ids.length!==n)fail();parents[kind]=ids;
 }
 const rows={} as Raw['rows'],ids={} as Raw['ids'],parentIds={} as Raw['parentIds'];let bytes=0;
 for(const table of tables){
  const fields=AUXILIARY_SHAPES[table],columns=driver==='sqlite'?(yield* all<{name:string}>('SELECT name FROM pragma_table_xinfo(?)',table)).map(row=>row.name):yield* tableColumns(table);
  if([...columns].sort().join(',')!==[...fields].sort().join(','))fail();
  const parent=table==='memory_import_previews'?'memory_import_batches':memoryParents,foreign=table==='memory_import_previews'?'batch_id':'memory_id';
  const allowed=contents&&authorizedLogical?(table==='memory_import_previews'?parents.imports:authorizedLogical.memories).map(row=>row.id):null,args=[ownerId,...(allowed??[])],from=`${table} c JOIN ${parent} p ON p.id=c.${foreign} WHERE p.user_id=?${allowed?(allowed.length?` AND c.${foreign} IN (${allowed.map(()=>'?').join(',')})`:' AND 1=0'):''}`,lengths=fields.map(field=>driver==='sqlite'?`COALESCE(length(CAST(c.${field} AS BLOB)),0)`:`COALESCE(octet_length(CAST(c.${field} AS TEXT)),0)`);
  const size=yield* one<{n:number|string;b:number|string|null}>(`SELECT count(*) n,SUM(${lengths.join('+')}) b FROM ${from}`,...args);if(!size)fail();const n=count(size.n,MAX_ROWS);bytes+=count(size.b??0,MAX_BYTES);if(bytes>MAX_BYTES)fail();
  const keys=keyFields(table),identityFields=[...new Set([...keys,foreign])],order=keys.map(field=>'c.'+field).join(','),identity=yield* all<Record<string,string|number>>(`SELECT ${identityFields.map(field=>'c.'+field).join(',')} FROM ${from} ORDER BY ${order}`,...args);if(identity.length!==n)fail();
  ids[table]=identity.map(row=>keys.length===1?String(row[keys[0]]):createHash('sha256').update(JSON.stringify(keys.map(field=>row[field]))).digest('hex'));
  parentIds[table]=identity.map(row=>String(row[foreign]));if(new Set(ids[table]).size!==n)fail();
  rows[table]=contents?yield* all<AuxiliaryRow>(`SELECT ${fields.map(field=>'c.'+field).join(',')} FROM ${from} ORDER BY ${order}`,...args):[];if(contents&&rows[table].length!==n)fail();
 }
 return{parents,rows,ids,parentIds};
}
export interface AuxiliarySourceCapture {close():void}
const captures=new WeakMap<AuxiliarySourceCapture,{runner:StepRunner;scope:MemoryRowScope;keyId:string;batch:MemoryCopyBatch;assertStep:()=>Step<void>}>();
export async function captureAuthenticatedAuxiliarySource(input:{runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;verificationKey:Buffer;captureAuthority:()=>Promise<MemoryRestoreAuthorityLease|null>;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>;authorizeCopy:()=>Promise<{kind:'isolated-migration-copy';storageId:string;isCurrent:()=>boolean}|null>}):Promise<AuxiliarySourceCapture>{
 let key:Buffer|undefined;
 try{
  if(!Buffer.isBuffer(input.verificationKey)||input.verificationKey.length!==32||input.runner.inTransaction?.()!==false)fail();
  const supplied=await input.authorizeCopy();if(!supplied||supplied.kind!=='isolated-migration-copy'||typeof supplied.storageId!=='string'||!supplied.storageId||supplied.storageId.length>256||typeof supplied.isCurrent!=='function'||!supplied.isCurrent())fail();
  const sourceCurrent=supplied.isCurrent.bind(supplied),lease=input.session.capture(),owner=await input.runner.tx(()=>authenticatedMemoryOwnerStep(input.token),{immediate:true}),given=await input.captureAuthority();if(!given||!given.isCurrent())fail();
  const authority={anchor:captureMemoryRestoreAnchor(given.anchor),isCurrent:given.isCurrent.bind(given)};
  if(owner.ownerId!==lease.scope.ownerId||authority.anchor.ownerId!==owner.ownerId||authority.anchor.memberId!==lease.scope.memberId)fail();let closed=false;
  const current=()=>!closed&&sourceCurrent()&&lease.isCurrent()&&authority.isCurrent()&&Date.now()<owner.validUntil;
  const check=async()=>{if(input.runner.inTransaction?.()!==false||!current()||!same(await input.runner.tx(()=>authenticatedMemoryOwnerStep(input.token),{immediate:true}),owner))fail();const fresh=await input.captureAuthority();if(!fresh||!fresh.isCurrent()||!sameMemoryRestoreAnchor(authority.anchor,fresh.anchor)||!current())fail();};await check();
  const logicalMetadata=await input.runner.tx(()=>captureLogicalMemoryParentsMetadataStep(owner.ownerId),{immediate:true});await check();
  const metadata=await input.runner.tx(()=>captureAuxiliaryRawSourceStep(owner.ownerId,false,2,logicalMetadata),{immediate:true});await check();
  const records:MemoryReadIntent['records']=[...logicalMemoryParentReadRecords(logicalMetadata),...AUXILIARY_V2_TABLES.flatMap(table=>metadata.ids[table].map(id=>({table,id})))];
  for(let offset=0;offset<records.length;offset+=500){if(await input.recordRead({readerKind:'user',readerId:owner.ownerId,purpose:'migration-verify',records:records.slice(offset,offset+500)})!==true)fail();await check();}
  const logicalCipher=await input.runner.tx(()=>loadLogicalMemoryParentPayloadStep(logicalMetadata),{immediate:true});await check();
  const material=await lease.resolveKey({user_id:owner.ownerId});key=material.key;await check();if(material.id!==authority.anchor.keyId)fail();const logical=openLogicalMemoryParents(logicalMetadata,logicalCipher,lease.scope,key,material.id,current),parents:AuxiliaryParents={memories:logical.memories.map(row=>({id:row.id,user_id:row.user_id})),imports:metadata.parents.imports};
  for(const table of AUXILIARY_V2_TABLES){const allowed=new Set((table==='memory_import_previews'?parents.imports:parents.memories).map(row=>row.id));if(metadata.parentIds[table].some(id=>!allowed.has(id)))fail();}
  const captured=await input.runner.tx(()=>captureAuxiliaryRawSourceStep(owner.ownerId,true,2,logicalMetadata,logical),{immediate:true});await check();
  if(!same(metadata.ids,captured.ids)||!same(metadata.parentIds,captured.parentIds)||!same(metadata.parents,captured.parents))fail();
  const bundle=captureOwnerAuxiliaryBundle({v:2,ownerId:owner.ownerId,invalidatedPreviewCount:0,rows:captured.rows},parents);
  const batch=prepareMemoryCopyBatch(AUXILIARY_RECORD_TABLE,prepareAuxiliaryPlainRecords(bundle,parents,lease.scope,new Date().toISOString()),lease.scope,key,material.id,input.verificationKey);
  const assertStep=function*():Step<void>{if(!current()||!same(yield* authenticatedMemoryOwnerStep(input.token),owner))fail();yield* logical.assertCurrentStep();const fresh=yield* captureAuxiliaryRawSourceStep(owner.ownerId,true,2,logicalMetadata,logical);if(!same(fresh,captured)||!current())fail();};
  const capability=Object.freeze({close(){closed=true;for(const table of AUXILIARY_V2_TABLES)captured.rows[table].length=0;captured.parents.memories=[];captured.parents.imports=[];}});
  captures.set(capability,{runner:input.runner,scope:{...lease.scope},keyId:material.id,batch,assertStep});await check();return capability;
 }catch{input.session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
/** Called before AND after all other snapshot reads in the very same source transaction. */
export function* authenticatedAuxiliarySourceBatchStep(capability:AuxiliarySourceCapture,runner:StepRunner,scope:MemoryRowScope,keyId:string,verificationKey:Buffer):Step<MemoryCopyBatch>{
 const captured=captures.get(capability);if(!captured||captured.runner!==runner||captured.keyId!==keyId||captured.scope.ownerId!==scope.ownerId||captured.scope.memberId!==scope.memberId)fail();yield* captured.assertStep();verifyMemoryCopyCiphertext(captured.batch,scope,keyId,verificationKey);return{...captured.batch,rows:captured.batch.rows.map(row=>({...row}))};
}
/** A part-table declaration cannot conceal uncaptured raw content. Missing schemas and orphans refuse. */
export function* assertNoUncapturedAuxiliarySourceStep(ownerId:string):Step<void>{const captured=yield* captureAuxiliaryRawSourceStep(ownerId,false);if(AUXILIARY_V2_TABLES.some(table=>captured.ids[table].length))fail();}
