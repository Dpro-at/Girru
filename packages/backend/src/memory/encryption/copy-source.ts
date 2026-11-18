import {authenticatedAuxiliarySourceBatchStep,assertNoUncapturedAuxiliarySourceStep,type AuxiliarySourceCapture} from './auxiliary-source.js';
import {authenticatedLegacyGraphSourceBatchStep,type LegacyGraphSourceCapture} from './legacy-graph-migration.js';
import {LEGACY_GRAPH_TABLES} from './legacy-graph-bundle.js';
/** Inactive bounded source snapshot. Caller supplies an explicitly selected disposable/copy database. */
import {MEMORY_COPY_MAX_ROWS,MEMORY_COPY_READ_LIMIT,MEMORY_COPY_MAX_SOURCE_BYTES,MEMORY_COPY_MAX_SET_SOURCE_BYTES} from './copy-limits.js';
import { all, one, run, dialect, tableColumns, tableExists, type StepRunner } from '../../repositories/sql-steps.js';
import { memoryRowSurfaceManifest, decryptMemoryRow, type MemoryRowScope, type MemoryRowTable } from './row-codec.js';
import { prepareMemoryCopyBatch, type MemoryCopyBatch } from './copy-batch.js';
import { MemoryCipherError } from './envelope.js';
import {sealMemorySurfaceSnapshot,type MemorySurfaceSnapshot} from './copy-manifest.js';
export type {MemorySurfaceSnapshot} from './copy-manifest.js';
/** Oversized sources fail closed; no truncation/paging or whole-profile completeness claim. */
export async function prepareMemorySurfaceSnapshot(runner: StepRunner, suppliedScope: MemoryRowScope, suppliedKey: Buffer, keyId: string, suppliedVerificationKey: Buffer, encryptedSource?:{assertAudited:(table:MemoryRowTable,rows:Record<string,unknown>[])=>void},legacyGraphSource?:LegacyGraphSourceCapture,auxiliarySource?:AuxiliarySourceCapture): Promise<MemorySurfaceSnapshot> {
  const assertAudited=encryptedSource?.assertAudited;
  let key: Buffer | undefined, verificationKey: Buffer | undefined;
  try {
    if(!Buffer.isBuffer(suppliedKey)||suppliedKey.length!==32||!Buffer.isBuffer(suppliedVerificationKey)||suppliedVerificationKey.length!==32)throw new MemoryCipherError();
    const scope={...suppliedScope};key=Buffer.from(suppliedKey);verificationKey=Buffer.from(suppliedVerificationKey);
    const operationKey=key;
    const receiptKey=verificationKey;
    const surfaces=memoryRowSurfaceManifest().sort((a,b)=>a.table.localeCompare(b.table));
    return await runner.tx(function*(){
      const driver=yield* dialect();
      // Acquire every lock before reading any table; excludes source writes for the snapshot.
      if(driver==='postgres')for(const s of surfaces)yield* run(`LOCK TABLE ${s.table} IN SHARE MODE`);
      const graphBatch=legacyGraphSource?yield* authenticatedLegacyGraphSourceBatchStep(legacyGraphSource,runner,scope,keyId,receiptKey):undefined;
      const auxiliaryBatch=auxiliarySource?yield* authenticatedAuxiliarySourceBatchStep(auxiliarySource,runner,scope,keyId,receiptKey):undefined;if(!auxiliaryBatch)yield* assertNoUncapturedAuxiliarySourceStep(scope.ownerId);
      // A declared graph-part table cannot silently stand in for uncaptured legacy graph rows.
      // Explicit lossless migration must quarantine/remove the old owner rows atomically first.
      for(const table of graphBatch?[]:LEGACY_GRAPH_TABLES)if(yield* tableExists(table)){
        if(driver==='postgres')yield* run(`LOCK TABLE ${table} IN SHARE MODE`);
        const legacy=yield* one<{n:number|string}>(`SELECT count(*) n FROM ${table} WHERE user_id=?`,scope.ownerId);
        if(!legacy||!Number.isSafeInteger(Number(legacy.n))||Number(legacy.n)!==0)throw new MemoryCipherError();
      }
      const batches: MemoryCopyBatch[]=[];let sourceBytes=0;
      for(const s of surfaces){
        const columns=driver==='sqlite'?(yield* all<{name:string}>('SELECT name FROM pragma_table_xinfo(?)',s.table)).map(c=>c.name):yield* tableColumns(s.table);
        const expected=[s.owner,s.id,...s.bound,...s.clear,...s.text,...s.binary].sort();
        if(columns.sort().join('\0')!==expected.join('\0'))throw new MemoryCipherError();
        const count=yield* one<{n:number|string}>(`SELECT count(*) AS n FROM ${s.table} WHERE ${s.owner}=?`,scope.ownerId);
        const n=Number(count?.n);
        if(!Number.isSafeInteger(n)||n<0||n>MEMORY_COPY_MAX_ROWS)throw new MemoryCipherError();
        const fields=[s.owner,s.id,...s.text,...s.binary,...s.bound,...s.clear];
        // Check variable-width values in SQL before transferring their full bytes into JS.
        const binaryFields=new Set<string>(s.binary);
        const lengths=fields.map(f=>driver==='sqlite'
          ? `COALESCE(length(CAST(${f} AS BLOB)),0)`
          : `COALESCE(octet_length(${binaryFields.has(f)?f:`CAST(${f} AS TEXT)`}),0)`);
        const size=yield* one<{n:number|string|null}>(`SELECT SUM(${lengths.join('+')}) AS n FROM ${s.table} WHERE ${s.owner}=?`,scope.ownerId);
        const tableBytes=Number(size?.n);sourceBytes+=tableBytes;
        if(!Number.isSafeInteger(tableBytes)||tableBytes<0||tableBytes>MEMORY_COPY_MAX_SOURCE_BYTES||sourceBytes>MEMORY_COPY_MAX_SET_SOURCE_BYTES)throw new MemoryCipherError();
        const rows=yield* all<Record<string,unknown>>(`SELECT * FROM ${s.table} WHERE ${s.owner}=? ORDER BY ${s.id} LIMIT ${MEMORY_COPY_READ_LIMIT}`,scope.ownerId);
        if(rows.length!==n)throw new MemoryCipherError();
        if(s.table==='memory_encryption_legacy_graph'&&graphBatch){if(rows.length)throw new MemoryCipherError();batches.push(graphBatch);continue;}
        if(s.table==='memory_encryption_auxiliary'&&auxiliaryBatch){if(rows.length)throw new MemoryCipherError();batches.push(auxiliaryBatch);continue;}
        if(assertAudited){
          assertAudited(s.table as MemoryRowTable,rows);
          const plain=rows.map(row=>decryptMemoryRow(s.table as MemoryRowTable,row,scope,operationKey,keyId));
          batches.push(prepareMemoryCopyBatch(s.table as MemoryRowTable,plain,scope,operationKey,keyId,receiptKey));
        }else batches.push(prepareMemoryCopyBatch(s.table as MemoryRowTable,rows,scope,operationKey,keyId,receiptKey));
      }
      if(legacyGraphSource)yield* authenticatedLegacyGraphSourceBatchStep(legacyGraphSource,runner,scope,keyId,receiptKey);
      if(auxiliarySource)yield* authenticatedAuxiliarySourceBatchStep(auxiliarySource,runner,scope,keyId,receiptKey);
      return sealMemorySurfaceSnapshot(batches,scope,operationKey,keyId,receiptKey);
    },{immediate:true});
  }catch{throw new MemoryCipherError();}
  finally{key?.fill(0);verificationKey?.fill(0);}
}
