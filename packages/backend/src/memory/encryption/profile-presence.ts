/** Bounded whole-profile ciphertext presence. This digest alone grants no read/key/owner authority. */
import {createHash} from 'node:crypto';
import {all,one,run,dialect,tableColumns,type Step} from '../../repositories/sql-steps.js';
import {memoryRowSurfaceManifest} from './row-codec.js';
import {MemoryCipherError} from './envelope.js';
export type ProfileCipherPresence={v:1;ownerId:string;tables:ReadonlyArray<Readonly<{table:string;count:number;sha256:string}>>;sha256:string};
function fail():never{throw new MemoryCipherError();}
const MAX_ROWS=5000,MAX_TABLE_BYTES=8*1024*1024,MAX_TOTAL_BYTES=64*1024*1024;
const ordered=(a:string,b:string)=>a<b?-1:a>b?1:0;
/** Call within one actual isolated transaction; native presence verification and authorization are external. */
export function* captureProfileCipherPresenceStep(ownerId:string):Step<ProfileCipherPresence>{
 if(typeof ownerId!=='string'||!ownerId||Buffer.byteLength(ownerId)>256)fail();
 const surfaces=memoryRowSurfaceManifest().sort((a,b)=>ordered(a.table,b.table));if(surfaces.length!==20||new Set(surfaces.map(surface=>surface.table)).size!==20)fail();
 const driver=yield* dialect(),counts=new Map<string,number>();let totalBytes=0;
 if(driver==='postgres')for(const surface of surfaces)yield* run(`LOCK TABLE ${surface.table} IN SHARE ROW EXCLUSIVE MODE`);
 // Inspect every table's schema, ownership and bounds before reading any ciphertext payload.
 for(const surface of surfaces){
  const fields=[surface.owner,surface.id,...surface.bound,...surface.clear,...surface.text,...surface.binary];
  const columns=driver==='sqlite'?(yield* all<{name:string}>('SELECT name FROM pragma_table_xinfo(?)',surface.table)).map(column=>column.name):yield* tableColumns(surface.table);
  if(columns.sort(ordered).join('\0')!==[...fields].sort(ordered).join('\0'))fail();
  const clear:readonly string[]=surface.clear,included=fields.filter(field=>!clear.includes(field)),binary=new Set<string>(surface.binary);
  const sizes=included.map(field=>driver==='sqlite'?`COALESCE(length(CAST(${field} AS BLOB)),0)`:`COALESCE(octet_length(${binary.has(field)?field:`CAST(${field} AS TEXT)`}),0)`);
  const size=yield* one<{n:number|string;b:number|string|null}>(`SELECT count(*) n,SUM(${sizes.join('+')}) b FROM ${surface.table}`);
  const own=yield* one<{n:number|string}>(`SELECT count(*) n FROM ${surface.table} WHERE ${surface.owner}=?`,ownerId);
  const count=Number(size?.n),bytes=Number(size?.b??0);totalBytes+=bytes;
  if(!size||!own||!Number.isSafeInteger(count)||count<0||count>MAX_ROWS||Number(own.n)!==count||!Number.isSafeInteger(bytes)||bytes<0||bytes>MAX_TABLE_BYTES||totalBytes>MAX_TOTAL_BYTES)fail();counts.set(surface.table,count);
 }
 const tables:Readonly<{table:string;count:number;sha256:string}>[]=[];
 for(const surface of surfaces){
  const fields=[surface.owner,surface.id,...surface.bound,...surface.text,...surface.binary];
  const rows=yield* all<Record<string,unknown>>(`SELECT ${fields.join(',')} FROM ${surface.table} WHERE ${surface.owner}=? ORDER BY ${surface.id} LIMIT ${MAX_ROWS+1}`,ownerId);
  if(rows.length!==counts.get(surface.table))fail();rows.sort((a,b)=>ordered(String(a[surface.id]),String(b[surface.id])));
  const hash=createHash('sha256').update(JSON.stringify(['memory-profile-presence-table-v1',ownerId,surface.table,rows.length]));let last:string|undefined;
  for(const row of rows){const id=row[surface.id];if(typeof id!=='string'||!id||id===last||row[surface.owner]!==ownerId||Object.keys(row).sort(ordered).join('\0')!==[...fields].sort(ordered).join('\0'))fail();last=id;
   for(const value of Object.values(row))if(value!==null&&!Buffer.isBuffer(value)&&typeof value!=='string'&&typeof value!=='boolean'&&!(typeof value==='number'&&Number.isFinite(value)))fail();
   const encoded=JSON.stringify(Object.keys(row).sort(ordered).map(field=>{const value=row[field];return[field,value===null?'null':Buffer.isBuffer(value)?'bytes':typeof value,Buffer.isBuffer(value)?value.toString('base64'):value];}));hash.update(JSON.stringify([Buffer.byteLength(encoded),encoded]));
  }
  tables.push(Object.freeze({table:surface.table,count:rows.length,sha256:hash.digest('hex')}));
 }
 const sha256=createHash('sha256').update(JSON.stringify(['memory-profile-presence-v1',ownerId,tables])).digest('hex');
 return Object.freeze({v:1,ownerId,tables:Object.freeze(tables),sha256});
}
