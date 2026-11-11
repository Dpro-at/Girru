/** Internal empty-copy writer. Never selects a database or opens a profile itself. */
import {MEMORY_COPY_READ_LIMIT,MEMORY_COPY_MAX_ENCODED_BYTES} from './copy-limits.js';
import { all, one, run, dialect, tableColumns, type StepRunner, type Step, type SqlParam } from '../../repositories/sql-steps.js';
import { memoryRowSurfaceManifest, type MemoryRowScope } from './row-codec.js';
import { verifyMemoryCopyBatch, type MemoryCopyBatch } from './copy-batch.js';
import {prepareEncryptedTopicRebuild} from './topic-rebuild.js';
import {memoryCopyReceiptStep} from './copy-receipt.js';
import {verifyMemorySurfaceSnapshot,type MemorySurfaceSnapshot} from './copy-manifest.js';
import { MemoryCipherError } from './envelope.js';
/** Bound trigger-produced values in SQL before materializing target readback. */
function* boundedCopyReadback(table:MemoryCopyBatch['table'],expectedCount:number):Step<Record<string,unknown>[]>{
 const surface=memoryRowSurfaceManifest().find(s=>s.table===table);if(!surface)throw new MemoryCipherError();
 const driver=yield* dialect(),fields=[surface.owner,surface.id,...surface.bound,...surface.clear,...surface.text,...surface.binary],binary=new Set<string>(surface.binary);
 const lengths=fields.map(field=>driver==='sqlite'?`COALESCE(length(CAST(${field} AS BLOB)),0)`:`COALESCE(octet_length(${binary.has(field)?field:`CAST(${field} AS TEXT)`}),0)`);
 const size=yield* one<{n:number|string;b:number|string|null}>(`SELECT count(*) AS n,SUM(${lengths.join('+')}) AS b FROM ${table}`);
 const bytes=Number(size?.b??0);
 if(!size||Number(size.n)!==expectedCount||!Number.isSafeInteger(bytes)||bytes<0||bytes>MEMORY_COPY_MAX_ENCODED_BYTES)throw new MemoryCipherError();
 const rows=yield* all<Record<string,unknown>>(`SELECT ${fields.join(',')} FROM ${table} LIMIT ${MEMORY_COPY_READ_LIMIT}`);
 if(rows.length!==expectedCount)throw new MemoryCipherError();return rows;
}
/** One bounded table subset only. Caller supplies a dedicated disposable target runner. */
async function writeBatches(runner: StepRunner, suppliedBatches: MemoryCopyBatch[], suppliedScope: MemoryRowScope, suppliedKey: Buffer, keyId: string, suppliedVerificationKey: Buffer, receiptStep?: ()=>Step<void>, finalCheck?: ()=>Step<void>): Promise<void> {
  let key: Buffer | undefined, verificationKey: Buffer | undefined;
  try {
    for(const batch of suppliedBatches)verifyMemoryCopyBatch(batch,batch.rows,suppliedScope,suppliedKey,keyId,suppliedVerificationKey);
    const scope = {...suppliedScope};
    const batches: MemoryCopyBatch[] = suppliedBatches.map(batch=>({...batch,rows:batch.rows.map(row=>Object.fromEntries(Object.entries(row).map(([field,value])=>[field,Buffer.isBuffer(value)?Buffer.from(value):value])))})).sort((a,b)=>a.table.localeCompare(b.table));
    key=Buffer.from(suppliedKey); verificationKey=Buffer.from(suppliedVerificationKey);
    const operationKey = key;
    const receiptKey = verificationKey;
    await runner.tx(function*(){
      for(const batch of batches){
    const surface=memoryRowSurfaceManifest().find(s=>s.table===batch.table);
    if(!surface)throw new MemoryCipherError();
    const table=surface.table,fields=[surface.owner,surface.id,...surface.bound,...surface.clear,...surface.text,...surface.binary];

      // PostgreSQL table lock excludes non-cooperating writers as well as copy workers.
      const driver=yield* dialect();
      if(driver==='postgres')yield* run(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
      const columns=driver==='sqlite'
        ? (yield* all<{name:string}>('SELECT name FROM pragma_table_xinfo(?)',table)).map(column=>column.name)
        : yield* tableColumns(table);
      if([...columns].sort().join('\0')!==[...fields].sort().join('\0'))throw new MemoryCipherError();
      if(yield* one(`SELECT 1 AS occupied FROM ${table} LIMIT 1`))throw new MemoryCipherError();
      for(const row of batch.rows){
        const values=fields.map(field=>typeof row[field]==='boolean'?Number(row[field]):row[field]) as SqlParam[];
        yield* run(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,...values);
      }
      const readback=yield* boundedCopyReadback(table,batch.rows.length);
      verifyMemoryCopyBatch(batch,readback,scope,operationKey,keyId,receiptKey);
      }
      if(receiptStep)yield* receiptStep();
      // Later-table triggers must not silently corrupt an already verified table.
      for(const batch of batches){
        const rows=yield* boundedCopyReadback(batch.table,batch.rows.length);
        verifyMemoryCopyBatch(batch,rows,scope,operationKey,keyId,receiptKey);
      }
      if(finalCheck)yield* finalCheck();
    },{immediate:true});
  } catch { throw new MemoryCipherError(); }
  finally {key?.fill(0);verificationKey?.fill(0);}
}

/** One subset; does not imply full source coverage. */
export function writeMemoryBatchToEmptyCopy(runner: StepRunner, batch: MemoryCopyBatch, scope: MemoryRowScope, key: Buffer, keyId: string, verificationKey: Buffer): Promise<void> {
  return writeBatches(runner,[batch],scope,key,keyId,verificationKey);
}
/** Requires all current declared surfaces, including explicit empty batches. Not whole-profile coverage. */
export async function writeMemorySurfaceSetToEmptyCopy(runner: StepRunner, batches: MemoryCopyBatch[], scope: MemoryRowScope, key: Buffer, keyId: string, verificationKey: Buffer): Promise<void> {
  const expected=memoryRowSurfaceManifest().map(s=>s.table).sort().join(',');
  if(!Array.isArray(batches)||batches.length!==memoryRowSurfaceManifest().length||batches.map(b=>b?.table).sort().join(',')!==expected)throw new MemoryCipherError();
  await writeBatches(runner,batches,scope,key,keyId,verificationKey);
}

/** Authenticated snapshot entry point; subset writer does not establish snapshot provenance. */
export async function writeMemorySnapshotToEmptyCopy(runner: StepRunner, snapshot: MemorySurfaceSnapshot, scope: MemoryRowScope, key: Buffer, keyId: string, verificationKey: Buffer): Promise<void> {
  verifyMemorySurfaceSnapshot(snapshot,scope,key,keyId,verificationKey);
  const receiptStep=memoryCopyReceiptStep(snapshot,verificationKey);
  await writeBatches(runner,snapshot.batches,scope,key,keyId,verificationKey,receiptStep);
}

/** Explicit derived-index variant; any duplicate/corruption rolls back all data, index and receipt. */
export async function writeIndexedMemorySnapshotToEmptyCopy(runner:StepRunner,snapshot:MemorySurfaceSnapshot,scope:MemoryRowScope,key:Buffer,keyId:string,verificationKey:Buffer,lookupKey:Buffer):Promise<void>{
 verifyMemorySurfaceSnapshot(snapshot,scope,key,keyId,verificationKey);
 const memories=snapshot.batches.find(b=>b.table==='memories');if(!memories)throw new MemoryCipherError();
 const index=prepareEncryptedTopicRebuild(memories.rows,scope,key,keyId,lookupKey),receipt=memoryCopyReceiptStep(snapshot,verificationKey);
 await writeBatches(runner,snapshot.batches,scope,key,keyId,verificationKey,function*(){yield* index.build();yield* receipt();},index.verify);
}

/** Guarded empty-copy restore only. Target must remain quarantined until a separate activation decision. */
export async function writeGuardedMemoryRestoreCopy(runner:StepRunner,snapshot:MemorySurfaceSnapshot,scope:MemoryRowScope,key:Buffer,keyId:string,verificationKey:Buffer,restoreReceipt:()=>Step<void>,isCurrent:()=>boolean):Promise<void>{
 if(typeof isCurrent!=='function'||typeof restoreReceipt!=='function'||isCurrent()!==true)throw new MemoryCipherError();
 verifyMemorySurfaceSnapshot(snapshot,scope,key,keyId,verificationKey);const receipt=memoryCopyReceiptStep(snapshot,verificationKey);
 await writeBatches(runner,snapshot.batches,scope,key,keyId,verificationKey,function*(){if(isCurrent()!==true)throw new MemoryCipherError();yield* receipt();yield* restoreReceipt();},function*(){if(isCurrent()!==true)throw new MemoryCipherError();});
}
