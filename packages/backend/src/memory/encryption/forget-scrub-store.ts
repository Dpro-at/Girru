import {MEMORY_COPY_MAX_ROWS,MEMORY_COPY_READ_LIMIT,MEMORY_COPY_MAX_SOURCE_BYTES,MEMORY_COPY_MAX_SET_SOURCE_BYTES} from './copy-limits.js';
/** Internal bounded ciphertext snapshot/CAS for scrub only; does not perform complete forget. */
import {all,one,run,dialect,tableColumns,type Step,type StepRunner,type SqlParam} from '../../repositories/sql-steps.js';
import {memoryRowSurfaceManifest,type MemoryRowTable} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import type {ScrubTable} from './forget-scrub.js';
import {MemoryCipherError} from './envelope.js';
const TABLES=memoryRowSurfaceManifest().map(surface=>surface.table as MemoryRowTable);
export type ForgetRows=Record<MemoryRowTable,Record<string,unknown>[]>;
export function* encryptedForgetRowsStep(ownerId:string):Step<ForgetRows>{
 const driver=yield* dialect();if(driver==='postgres')for(const table of TABLES)yield* run(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
 const result={} as ForgetRows;let totalBytes=0;
 for(const table of TABLES){
  const s=memoryRowSurfaceManifest().find(s=>s.table===table)!,fields=[s.owner,s.id,...s.bound,...s.clear,...s.text,...s.binary],binary=new Set<string>(s.binary);
  const columns=driver==='sqlite'?(yield* all<{name:string}>('SELECT name FROM pragma_table_xinfo(?)',table)).map(c=>c.name):yield* tableColumns(table);
  if(columns.sort().join('\0')!==[...fields].sort().join('\0'))throw new MemoryCipherError();
  const sizes=fields.map(f=>driver==='sqlite'?`COALESCE(length(CAST(${f} AS BLOB)),0)`:`COALESCE(octet_length(${binary.has(f)?f:`CAST(${f} AS TEXT)`}),0)`);
  const size=yield* one<{n:number|string;b:number|string|null}>(`SELECT count(*) n,SUM(${sizes.join('+')}) b FROM ${table} WHERE ${s.owner}=?`,ownerId);
  const bytes=Number(size?.b??0);totalBytes+=bytes;
  if(!size||!Number.isSafeInteger(Number(size.n))||Number(size.n)<0||Number(size.n)>MEMORY_COPY_MAX_ROWS||!Number.isSafeInteger(bytes)||bytes<0||bytes>MEMORY_COPY_MAX_SOURCE_BYTES||totalBytes>MEMORY_COPY_MAX_SET_SOURCE_BYTES)throw new MemoryCipherError();
  result[table]=yield* all<Record<string,unknown>>(`SELECT * FROM ${table} WHERE ${s.owner}=? ORDER BY ${s.id} LIMIT ${MEMORY_COPY_READ_LIMIT}`,ownerId);
  result[table].sort((a,b)=>String(a[s.id])<String(b[s.id])?-1:String(a[s.id])>String(b[s.id])?1:0);
  if(result[table].length!==Number(size.n))throw new MemoryCipherError();
 }
 return result;
}
export const loadEncryptedForgetRows=(runner:StepRunner,ownerId:string)=>runner.tx(()=>encryptedForgetRowsStep(ownerId),{immediate:true});
export function sameForgetRows(a:ForgetRows,b:ForgetRows){return TABLES.every(t=>a[t].length===b[t].length&&a[t].every((r,i)=>canonicalEncryptedRow(r)===canonicalEncryptedRow(b[t][i])));}
export function* writeEncryptedScrubRowsStep(ownerId:string,updates:{table:ScrubTable;row:Record<string,unknown>}[]):Step<void>{
 for(const {table,row} of updates){const fields=Object.keys(row).filter(f=>f!=='id'&&f!=='user_id');const result=yield* run(`UPDATE ${table} SET ${fields.map(f=>f+'=?').join(',')} WHERE id=? AND user_id=?`,...fields.map(f=>row[f] as SqlParam),String(row.id),ownerId);if(result.changes!==1)throw new MemoryCipherError();const stored=yield* one<Record<string,unknown>>(`SELECT * FROM ${table} WHERE id=? AND user_id=?`,String(row.id),ownerId);if(!stored||canonicalEncryptedRow(stored)!==canonicalEncryptedRow(row))throw new MemoryCipherError();}
}
