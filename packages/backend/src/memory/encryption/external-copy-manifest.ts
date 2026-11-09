import {memoryControlQuery} from './control-runner.js';
/** Metadata-only inventory groundwork; caller must use one transaction. Not root authorization or complete coverage. */
import {all,one,run,tableExists,dialect,type Step} from '../../repositories/sql-steps.js';
import {MemoryCipherError,sealMemoryText,openMemoryText,MAX_MEMORY_PLAINTEXT_BYTES,type MemoryCipherContext} from './envelope.js';
export type ExternalCopyReference={kind:'project-root'|'design-root'|'previous-design-root'|'projection-file';scope:string;path:string};
function* captureControlCopyReferencesStep(ownerId:string):Step<ExternalCopyReference[]>{
 if(typeof ownerId!=='string'||!ownerId||ownerId.length>256)throw new MemoryCipherError();
 const driver=yield* dialect(),references:ExternalCopyReference[]=[];
 const collect=function*(table:string,query:string,params:string[],kind:ExternalCopyReference['kind']):Step<void>{
  if(!(yield* tableExists(table)))return;
  if(driver==='postgres')yield* run(`LOCK TABLE ${table} IN SHARE MODE`);
  const count=yield* one<{n:number|string;bytes:number|string}>(`SELECT count(*) n,coalesce(sum(${driver==='sqlite'?'length(CAST(path AS BLOB))+length(CAST(scope AS BLOB))':'octet_length(path)+octet_length(scope)'}),0) bytes FROM (${query}) refs`,...params);
  if(!count||!Number.isSafeInteger(Number(count.n))||Number(count.n)>1000||Number(count.bytes)>1048576)throw new MemoryCipherError();
  const rows=yield* all<{scope:string;path:string}>(query,...params);
  if(rows.length!==Number(count.n))throw new MemoryCipherError();
  for(const row of rows){
   if(typeof row.path!=='string'||!row.path||row.path.includes('\0')||Buffer.byteLength(row.path)>16384||typeof row.scope!=='string'||Buffer.byteLength(row.scope)>512)throw new MemoryCipherError();
   references.push({kind,scope:row.scope,path:row.path});
  }
 };
 yield* collect('chat_projects',"SELECT id AS scope,folder AS path FROM chat_projects WHERE user_id=? AND folder IS NOT NULL AND trim(folder)<>''",[ownerId],'project-root');
 if(yield* tableExists('memory_project_design')){
  if(driver==='postgres')yield* run('LOCK TABLE memory_project_design IN SHARE MODE');
  for(const [column,kind] of [['found','design-root'],['previous','previous-design-root']] as const){
   const root=driver==='sqlite'?`CASE WHEN json_valid(${column}) THEN json_extract(${column},'$.root') ELSE NULL END`:`(${column}::jsonb)->>'root'`;
   const invalid=yield* one<{n:number|string}>(driver==='sqlite'?`SELECT count(*) n FROM memory_project_design WHERE owner_id=? AND ${column} IS NOT NULL AND (NOT json_valid(${column}) OR json_type(${column},'$.root') NOT IN ('text','null'))`:`SELECT count(*) n FROM memory_project_design WHERE owner_id=? AND ${column} IS NOT NULL AND jsonb_typeof((${column}::jsonb)->'root') NOT IN ('string','null')`,ownerId);
   if(!invalid||Number(invalid.n)!==0)throw new MemoryCipherError();
   yield* collect('memory_project_design',`SELECT slug AS scope,${root} AS path FROM memory_project_design WHERE owner_id=? AND ${column} IS NOT NULL AND ${root} IS NOT NULL`,[ownerId],kind);
  }
 }
 if(yield* tableExists('projection_state')){
  if(!(yield* tableExists('change_scopes')))throw new MemoryCipherError();
  if(driver==='postgres')yield* run('LOCK TABLE change_scopes IN SHARE MODE');
  yield* collect('projection_state','SELECT p.scope,p.target AS path FROM projection_state p JOIN change_scopes s ON s.scope=p.scope WHERE s.owner_id=? AND p.target IS NOT NULL',[ownerId],'projection-file');
 }
 if(references.length>3000)throw new MemoryCipherError();
 return references.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function* captureExternalCopyReferencesStep(ownerId:string):Step<ExternalCopyReference[]>{return yield* memoryControlQuery(()=>captureControlCopyReferencesStep(ownerId));}

/** Confidential reference snapshot only. It cannot authorize a root or certify full copy coverage. */
export function sealExternalReferenceSnapshot(references:readonly ExternalCopyReference[],context:MemoryCipherContext,key:Buffer,keyId:string):string{
 const records=validateReferences(references);
 return sealMemoryText(JSON.stringify({v:1,references:records}),key,keyId,{...context,field:'external-copy-references'});
}
export function openExternalReferenceSnapshot(ciphertext:string,context:MemoryCipherContext,key:Buffer,keyId:string):ExternalCopyReference[]{
 try{
  const parsed=JSON.parse(openMemoryText(ciphertext,key,keyId,{...context,field:'external-copy-references'}));
  if(!parsed||Object.keys(parsed).sort().join(',')!=='references,v'||parsed.v!==1)throw new MemoryCipherError();
  return validateReferences(parsed.references);
 }catch{throw new MemoryCipherError();}
}
export function validateReferences(input:unknown):ExternalCopyReference[]{
 if(!Array.isArray(input)||input.length>3000)throw new MemoryCipherError();
 const records=input.map((row:ExternalCopyReference)=>{
  if(!row||Object.keys(row).sort().join(',')!=='kind,path,scope'||!['project-root','design-root','previous-design-root','projection-file'].includes(row.kind)||typeof row.scope!=='string'||!row.scope||Buffer.byteLength(row.scope)>512||typeof row.path!=='string'||!row.path||row.path.includes('\0')||Buffer.byteLength(row.path)>16384)throw new MemoryCipherError();
  return {kind:row.kind,scope:row.scope,path:row.path};
 });
 if(Buffer.byteLength(JSON.stringify({v:1,references:records}))>MAX_MEMORY_PLAINTEXT_BYTES)throw new MemoryCipherError();
 return records;
}

/** Recheck metadata in the caller's transaction before planning effects; grants no filesystem permission. */
export function* assertExternalCopyReferencesCurrentStep(ownerId:string,expected:readonly ExternalCopyReference[]):Step<void>{
 const canonical=(records:ExternalCopyReference[])=>JSON.stringify(records.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
 const before=canonical(validateReferences(expected));
 const current=canonical(yield* captureExternalCopyReferencesStep(ownerId));
 if(before!==current)throw new MemoryCipherError();
}

export type ExternalProjectionHold={scope:string;id:string;generation:number};
/** Validate explicitly supplied hold receipts; does not assert every external reference is covered. */
export function* assertExternalProjectionHoldsCurrentStep(ownerId:string,holds:readonly ExternalProjectionHold[]):Step<void>{
 if(typeof ownerId!=='string'||!ownerId||ownerId.length>256||!Array.isArray(holds)||holds.length===0||holds.length>1000)throw new MemoryCipherError();
 if(!(yield* tableExists('memory_encryption_projection_holds')))throw new MemoryCipherError();
 if((yield* dialect())==='postgres')yield* run('LOCK TABLE memory_encryption_projection_holds IN SHARE MODE');
 const seen=new Set<string>();
 for(const hold of holds){
  if(!hold||Object.keys(hold).sort().join(',')!=='generation,id,scope'||typeof hold.scope!=='string'||!hold.scope||Buffer.byteLength(hold.scope)>512||typeof hold.id!=='string'||!hold.id||Buffer.byteLength(hold.id)>256||!Number.isSafeInteger(hold.generation)||hold.generation<1||seen.has(hold.scope))throw new MemoryCipherError();
  seen.add(hold.scope);
  const row=yield* one<{owner_id:string;hold_id:string;generation:number|string;state:string}>('SELECT owner_id,hold_id,generation,state FROM memory_encryption_projection_holds WHERE scope=?',hold.scope);
  if(!row||row.owner_id!==ownerId||row.hold_id!==hold.id||Number(row.generation)!==hold.generation||row.state!=='held')throw new MemoryCipherError();
 }
}
