/** Cryptographic precondition for upgrading an already-encrypted isolated copy. */
import {all,one,run,dialect,tableColumns,type Step} from '../../repositories/sql-steps.js';
import {memoryRowSurfaceManifest,decryptMemoryRow,type MemoryRowScope,type MemoryRowTable} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import {MemoryCipherError} from './envelope.js';
type Row=Record<string,unknown>;
export type EncryptedMigrationSurfaces=Array<{table:MemoryRowTable;rows:Row[]}>;
export function* captureEncryptedMigrationSurfacesStep(ownerId:string):Step<EncryptedMigrationSurfaces>{
 const driver=yield* dialect(),result:EncryptedMigrationSurfaces=[];let total=0;
 for(const s of memoryRowSurfaceManifest().filter(surface=>surface.table!=='memory_encryption_legacy_graph')){const fields=[s.owner,s.id,...s.bound,...s.clear,...s.text,...s.binary],binary=new Set<string>(s.binary);if(driver==='postgres')yield* run(`LOCK TABLE ${s.table} IN SHARE MODE`);const columns=driver==='sqlite'?(yield* all<{name:string}>('SELECT name FROM pragma_table_xinfo(?)',s.table)).map(row=>row.name):yield* tableColumns(s.table);if(columns.sort().join(',')!==[...fields].sort().join(','))throw new MemoryCipherError();const lengths=fields.map(field=>driver==='sqlite'?`COALESCE(length(CAST(${field} AS BLOB)),0)`:`COALESCE(octet_length(${binary.has(field)?field:`CAST(${field} AS TEXT)`}),0)`),size=yield* one<{n:number|string;b:number|string|null}>(`SELECT count(*) n,SUM(${lengths.join('+')}) b FROM ${s.table} WHERE ${s.owner}=?`,ownerId);const n=Number(size?.n),b=Number(size?.b??0);total+=b;if(!Number.isSafeInteger(n)||n<0||n>5000||!Number.isSafeInteger(b)||b<0||b>8*1024*1024||total>32*1024*1024)throw new MemoryCipherError();const rows=yield* all<Row>(`SELECT * FROM ${s.table} WHERE ${s.owner}=? ORDER BY ${s.id}`,ownerId);if(rows.length!==n)throw new MemoryCipherError();result.push({table:s.table,rows});}
 return result;
}
/** Caller must persist a read-audit ACK for every captured record before calling. */
export function validateEncryptedMigrationSurfaces(captured:EncryptedMigrationSurfaces,scope:MemoryRowScope,key:Buffer,keyId:string):void{
 for(const {table,rows}of captured)for(const cipher of rows){const plain=decryptMemoryRow(table,cipher,scope,key,keyId);for(const value of Object.values(plain))if(Buffer.isBuffer(value))value.fill(0);}
}
export function sameEncryptedMigrationSurfaces(a:EncryptedMigrationSurfaces,b:EncryptedMigrationSurfaces):boolean{return a.length===b.length&&a.every((part,index)=>part.table===b[index].table&&part.rows.length===b[index].rows.length&&part.rows.every((row,n)=>canonicalEncryptedRow(row)===canonicalEncryptedRow(b[index].rows[n])));}
