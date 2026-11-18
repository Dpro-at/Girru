import {MEMORY_COPY_MAX_ROWS,MEMORY_COPY_READ_LIMIT} from './copy-limits.js';
/** Scoped historical reads on encrypted versions; history in a closed drawer never opens a key. */
import {all,one,run as sqlRun,dialect,tableColumns,type Step,type StepRunner} from '../../repositories/sql-steps.js';
import {captureAuthenticatedMemoryRun,authenticatedMemoryRunStep} from './auth-capture.js';
import {createMemoryRevisionValidator} from './revision-validator.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {loadEncryptedOwnerRow} from './owner-row-loader.js';
import {memoryRowSurfaceManifest,decryptMemoryRow} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
export async function readAuthenticatedEncryptedHistory(input:{runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;run:Parameters<typeof captureAuthenticatedMemoryRun>[2];memoryId:string;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>}){
 const {runner,token,session,memoryId,recordRead}=input;let key:Buffer|undefined;
 try{
  if(typeof memoryId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(memoryId))throw new MemoryCipherError();
  const run={...input.run,delegatedFrom:[...input.run.delegatedFrom],drawers:input.run.drawers.map(drawer=>({...drawer}))},lease=session.capture(),auth=await captureAuthenticatedMemoryRun(runner,token,run);if(auth.ownerId!==lease.scope.ownerId)throw new MemoryCipherError();
  const validate=createMemoryRevisionValidator(runner,auth.revision,session.lock),check=async()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1'||!lease.isCurrent()||await validate()!==true||!lease.isCurrent())throw new MemoryCipherError();};await check();
  const memory=await loadEncryptedOwnerRow(runner,'memories',auth.ownerId,memoryId);await check();if(!memory||!auth.access.authorize(memory))throw new MemoryCipherError();
  function* captureRows():Step<Record<string,unknown>[]>{
   const driver=yield* dialect();if(driver==='postgres')yield* sqlRun('LOCK TABLE memory_versions IN SHARE MODE');const surface=memoryRowSurfaceManifest().find(surface=>surface.table==='memory_versions')!,fields=[surface.owner,surface.id,...surface.bound,...surface.text];
   const columns=driver==='sqlite'?(yield* all<{name:string}>('SELECT name FROM pragma_table_xinfo(?)','memory_versions')).map(column=>column.name):yield* tableColumns('memory_versions');if(columns.sort().join('\0')!==[...fields].sort().join('\0'))throw new MemoryCipherError();
   const terms=fields.map(field=>driver==='sqlite'?`COALESCE(length(CAST(${field} AS BLOB)),0)`:`COALESCE(octet_length(CAST(${field} AS TEXT)),0)`),size=yield* one<{n:number|string;b:number|string}>('SELECT count(*) n,COALESCE(sum('+terms.join('+')+'),0) b FROM memory_versions WHERE user_id=? AND memory_id=?',auth.ownerId,memoryId);
   if(!size||!Number.isSafeInteger(Number(size.n))||Number(size.n)>MEMORY_COPY_MAX_ROWS||!Number.isSafeInteger(Number(size.b))||Number(size.b)>16*1024*1024)throw new MemoryCipherError();
   const rows=yield* all<Record<string,unknown>>(`SELECT * FROM memory_versions WHERE user_id=? AND memory_id=? ORDER BY version,id LIMIT ${MEMORY_COPY_READ_LIMIT}`,auth.ownerId,memoryId);if(rows.length!==Number(size.n))throw new MemoryCipherError();return rows;
  }
  const source=await runner.tx(captureRows,{immediate:true});await check();const authorized=source.filter(row=>auth.access.authorize(row));if(!authorized.length)return[];
  for(let offset=0;offset<authorized.length;offset+=500){if(await recordRead({readerKind:'agent',readerId:run.agentId,purpose:'view',records:authorized.slice(offset,offset+500).map(row=>({table:'memory_versions',id:String(row.id)}))})!==true)throw new MemoryCipherError();await check();}
  const material=await lease.resolveKey(memory);key=material.key;await check();let bytes=0;const rows=authorized.map(row=>{if(!lease.isCurrent())throw new MemoryCipherError();const plain=decryptMemoryRow('memory_versions',row,lease.scope,key!,material.id);if(!auth.access.authorize(plain))throw new MemoryCipherError();bytes+=Buffer.byteLength(canonicalEncryptedRow(plain));if(bytes>8*1024*1024)throw new MemoryCipherError();return plain;});
  await check();await runner.tx(function*(){const fresh=yield* authenticatedMemoryRunStep(token,run);if(JSON.stringify(fresh.revision)!==JSON.stringify(auth.revision)||!lease.isCurrent())throw new MemoryCipherError();
   const live=yield* one<Record<string,unknown>>('SELECT * FROM memories WHERE id=? AND user_id=?',memoryId,auth.ownerId);if(!live||!fresh.access.authorize(live)||canonicalEncryptedRow(live)!==canonicalEncryptedRow(memory))throw new MemoryCipherError();const current=yield* captureRows();if(current.length!==source.length||current.some((row,index)=>canonicalEncryptedRow(row)!==canonicalEncryptedRow(source[index])))throw new MemoryCipherError();
  },{immediate:true});await check();return rows;
 }catch{throw new MemoryCipherError();}finally{key?.fill(0);}
}
