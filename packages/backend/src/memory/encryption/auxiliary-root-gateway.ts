import {captureLogicalMemoryParentsMetadataStep,logicalMemoryParentReadRecords,loadLogicalMemoryParentPayloadStep,openLogicalMemoryParents} from './logical-memory-parents.js';
/** Owner-only audited auxiliary history. A graph read lease never authorizes this distinct root. */
import {all,one,run,dialect,tableExists,type Step,type StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {hasMemoryControlBinding} from './control-runner.js';
import type {createMemoryUnlockSession} from './unlock-session.js';
import {captureMemoryRestoreAnchor,sameMemoryRestoreAnchor} from './restore-package.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
import type {MemoryReadIntent} from './read-audit.js';
import {loadAuxiliaryRecordsStep,openAuxiliaryRecords} from './auxiliary-records.js';
import {AUXILIARY_V2_TABLES,type AuxiliaryParents,type OwnerAuxiliaryBundle} from './auxiliary-bundle.js';
import {canonicalEncryptedRow} from './content-commit.js';
import {MemoryCipherError} from './envelope.js';
export type AuxiliaryRootAnchor={v:1;ownerId:string;memberId:string;authorityId:string;keyId:string;epoch:number;forgetSequence:number;forgetMac:string;bundleId:string|null;sha256:string|null;parts:number;generation:number};
export type AuxiliaryRootLease={purpose:'memory-auxiliary';profileId:string;anchor:AuxiliaryRootAnchor;isCurrent:()=>boolean};
type Input={runner:StepRunner;authRunner?:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;captureAuthority:()=>Promise<MemoryRestoreAuthorityLease|null>;captureAuxiliaryRoot:()=>Promise<AuxiliaryRootLease|null>;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>};
type Row=Record<string,unknown>;
function fail():never{throw new MemoryCipherError();}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function captureAuxiliaryRootAnchor(value:AuxiliaryRootAnchor):AuxiliaryRootAnchor{
 if(!value||Object.keys(value).sort().join(',')!=='authorityId,bundleId,epoch,forgetMac,forgetSequence,generation,keyId,memberId,ownerId,parts,sha256,v'||value.v!==1||!Number.isSafeInteger(value.generation)||value.generation<1||!Number.isSafeInteger(value.parts)||value.parts<0||value.parts>11)fail();
 const head=captureMemoryRestoreAnchor({v:1,ownerId:value.ownerId,memberId:value.memberId,authorityId:value.authorityId,keyId:value.keyId,epoch:value.epoch,forgetSequence:value.forgetSequence,forgetMac:value.forgetMac});
 if(value.parts===0?(value.bundleId!==null||value.sha256!==null):(typeof value.bundleId!=='string'||!/^[a-f0-9]{64}$/.test(value.bundleId)||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)))fail();
 return{...head,bundleId:value.bundleId,sha256:value.sha256,parts:value.parts,generation:value.generation};
}
function rootAuthority(value:AuxiliaryRootAnchor){return captureMemoryRestoreAnchor({v:1,ownerId:value.ownerId,memberId:value.memberId,authorityId:value.authorityId,keyId:value.keyId,epoch:value.epoch,forgetSequence:value.forgetSequence,forgetMac:value.forgetMac});}
function* stateStep(ownerId:string):Step<{parents:AuxiliaryParents;parts:Row[]}>{
 const driver=yield* dialect();if(driver==='postgres')yield* run('LOCK TABLE memories,memory_import_batches IN SHARE MODE');const parents:AuxiliaryParents={memories:[],imports:[]};
 for(const [kind,table]of [['memories','memories'],['imports','memory_import_batches']] as const){const measure=driver==='sqlite'?'length(CAST(id AS BLOB))+length(CAST(user_id AS BLOB))':'octet_length(CAST(id AS TEXT))+octet_length(CAST(user_id AS TEXT))';const size=yield* one<{n:number|string;b:number|string|null}>(`SELECT count(*) n,SUM(${measure}) b FROM ${table} WHERE user_id=?`,ownerId);if(!size||!Number.isSafeInteger(Number(size.n))||Number(size.n)<0||Number(size.n)>5000||!Number.isSafeInteger(Number(size.b??0))||Number(size.b??0)<0||Number(size.b??0)>4*1024*1024)fail();parents[kind]=yield* all<{id:string;user_id:string}>(`SELECT id,user_id FROM ${table} WHERE user_id=? ORDER BY id`,ownerId);if(parents[kind].length!==Number(size.n))fail();}
 for(const table of AUXILIARY_V2_TABLES)if(yield* tableExists(table)){
  if(driver==='postgres')yield* run(`LOCK TABLE ${table} IN SHARE MODE`);const parent=table==='memory_import_previews'?'memory_import_batches':'memories',field=table==='memory_import_previews'?'batch_id':'memory_id',explicitOwner=['memory_trust','memory_trust_sources','memory_recall_uses'].includes(table)?' OR c.user_id IS NULL OR c.user_id<>p.user_id':'';
  const orphan=yield* one<{n:number|string}>(`SELECT count(*) n FROM ${table} c LEFT JOIN ${parent} p ON p.id=c.${field} WHERE p.id IS NULL OR p.user_id IS NULL${explicitOwner}`),raw=yield* one<{n:number|string}>(`SELECT count(*) n FROM ${table} c JOIN ${parent} p ON p.id=c.${field} WHERE p.user_id=?`,ownerId);if(!orphan||Number(orphan.n)!==0||!raw||Number(raw.n)!==0)fail();
 }
 return{parents,parts:yield* loadAuxiliaryRecordsStep(ownerId)};
}
/** Projector is trusted synchronous owner presentation, never model-provided code or an agent-wide export. */
export async function auditedOwnerAuxiliary<T>(input:Input,projector:(bundle:OwnerAuxiliaryBundle)=>T):Promise<T>{
 let key:Buffer|undefined,logical:ReturnType<typeof openLogicalMemoryParents>|undefined;
 try{
  const auth=input.authRunner??input.runner;if(auth!==input.runner&&!hasMemoryControlBinding(input.runner))fail();if(typeof projector!=='function'||input.runner.inTransaction?.()!==false||auth.inTransaction?.()!==false)fail();
  const session=input.session.capture(),owner=await auth.tx(()=>authenticatedMemoryOwnerStep(input.token),{immediate:true}),given=await input.captureAuthority(),supplied=await input.captureAuxiliaryRoot();
  if(!given||!given.isCurrent()||!supplied||supplied.purpose!=='memory-auxiliary'||typeof supplied.profileId!=='string'||!supplied.profileId||typeof supplied.isCurrent!=='function'||!supplied.isCurrent())fail();
  const authority={anchor:captureMemoryRestoreAnchor(given.anchor),isCurrent:given.isCurrent.bind(given)},root={anchor:captureAuxiliaryRootAnchor(supplied.anchor),isCurrent:supplied.isCurrent.bind(supplied)};
  if(owner.ownerId!==session.scope.ownerId||root.anchor.ownerId!==owner.ownerId||root.anchor.memberId!==session.scope.memberId||!sameMemoryRestoreAnchor(rootAuthority(root.anchor),authority.anchor))fail();
  const current=()=>session.isCurrent()&&root.isCurrent()&&authority.isCurrent()&&Date.now()<owner.validUntil;
  const check=async()=>{if(input.runner.inTransaction?.()!==false||auth.inTransaction?.()!==false||!current()||!same(await auth.tx(()=>authenticatedMemoryOwnerStep(input.token),{immediate:true}),owner))fail();const fresh=await input.captureAuthority();if(!fresh||!fresh.isCurrent()||!sameMemoryRestoreAnchor(fresh.anchor,authority.anchor)||!current())fail();};await check();
  const logicalMetadata=await input.runner.tx(()=>captureLogicalMemoryParentsMetadataStep(owner.ownerId),{immediate:true});await check();
  const captured=await input.runner.tx(()=>stateStep(owner.ownerId),{immediate:true});await check();
  if(captured.parts.length!==root.anchor.parts||captured.parts.some((row,index)=>row.owner_id!==owner.ownerId||row.bundle_id!==root.anchor.bundleId||row.sha256!==root.anchor.sha256||Number(row.parts)!==root.anchor.parts||Number(row.ordinal)!==index))fail();
  let bundle:OwnerAuxiliaryBundle;
  if(captured.parts.length){
   const records:MemoryReadIntent['records']=[...captured.parts.map(row=>({table:'memory_encryption_auxiliary' as const,id:String(row.id)})),...logicalMemoryParentReadRecords(logicalMetadata)];for(let offset=0;offset<records.length;offset+=500){if(await input.recordRead({readerKind:'user',readerId:owner.ownerId,purpose:'view',records:records.slice(offset,offset+500)})!==true)fail();await check();}const history=await input.runner.tx(()=>loadLogicalMemoryParentPayloadStep(logicalMetadata),{immediate:true});await check();const material=await session.resolveKey({user_id:owner.ownerId});key=material.key;if(material.id!==root.anchor.keyId)fail();await check();logical=openLogicalMemoryParents(logicalMetadata,history,session.scope,key,material.id,current);const parents:AuxiliaryParents={memories:logical.memories.map(row=>({id:row.id,user_id:row.user_id})),imports:captured.parents.imports};const opened=openAuxiliaryRecords(captured.parts,parents,session.scope,key,material.id);if(!opened)fail();bundle=opened;
  }else bundle={v:1,ownerId:owner.ownerId,invalidatedPreviewCount:0,rows:{memory_import_previews:[],memory_quality_history:[],memory_enrichment_log:[]}};
  const result=projector(bundle);if(result&&typeof (result as {then?:unknown}).then==='function')fail();await check();
  await input.runner.tx(function*(){if(!current()||!same(yield* authenticatedMemoryOwnerStep(input.token),owner))fail();if(logical)yield* logical.assertCurrentStep();const fresh=yield* stateStep(owner.ownerId);if(!same(fresh.parents,captured.parents)||!same(fresh.parts.map(canonicalEncryptedRow),captured.parts.map(canonicalEncryptedRow))||!current()||!same(yield* authenticatedMemoryOwnerStep(input.token),owner))fail();},{immediate:true});await check();return result;
 }catch{input.session.lock();throw new MemoryCipherError();}finally{key?.fill(0);if(logical)for(const row of logical.trashRows)for(const value of Object.values(row))if(Buffer.isBuffer(value))value.fill(0);}
}
