/** Bounded ciphertext transport after owner authentication; does not grant access or decrypt. */
import {all,one,run,dialect,tableColumns,type StepRunner} from '../../repositories/sql-steps.js';
import {memoryRowSurfaceManifest,type MemoryRowTable} from './row-codec.js';
import {MemoryCipherError} from './envelope.js';
export async function loadEncryptedOwnerRow(runner:StepRunner,table:MemoryRowTable,ownerId:string,id:string,latestForMemory=false){
 try{
  if(!memoryRowSurfaceManifest().some(surface=>surface.table===table)||[ownerId,id].some(v=>typeof v!=='string'||!v||Buffer.byteLength(v)>256))throw new MemoryCipherError();
  if(latestForMemory&&table!=='memory_versions')throw new MemoryCipherError();
  const s=memoryRowSurfaceManifest().find(s=>s.table===table)!;
  const fields=[s.owner,s.id,...s.bound,...s.clear,...s.text,...s.binary],binary=new Set<string>(s.binary);
  return await runner.tx(function*(){
   const driver=yield* dialect();if(driver==='postgres')yield* run(`LOCK TABLE ${table} IN SHARE MODE`);
   const columns=driver==='sqlite'?(yield* all<{name:string}>('SELECT name FROM pragma_table_xinfo(?)',table)).map(c=>c.name):yield* tableColumns(table);
   if(columns.sort().join('\0')!==[...fields].sort().join('\0'))throw new MemoryCipherError();
   const predicate=latestForMemory?'user_id=? AND memory_id=? AND version=(SELECT MAX(v.version) FROM memory_versions v WHERE v.user_id=? AND v.memory_id=?)':`${s.owner}=? AND ${s.id}=?`;
   const params=latestForMemory?[ownerId,id,ownerId,id]:[ownerId,id];
   const lengths=fields.map(f=>driver==='sqlite'?`COALESCE(length(CAST(${f} AS BLOB)),0)`:`COALESCE(octet_length(${binary.has(f)?f:`CAST(${f} AS TEXT)`}),0)`);
   const size=yield* one<{n:number|string;b:number|string|null}>(`SELECT count(*) AS n,SUM(${lengths.join('+')}) AS b FROM ${table} WHERE ${predicate}`,...params);
   const count=Number(size?.n),bytes=Number(size?.b);if(!Number.isSafeInteger(count)||count<0||count>1||!Number.isSafeInteger(bytes)||bytes<0||bytes>16*1024*1024)throw new MemoryCipherError();
   if(count===0)return null;
   const row=yield* one<Record<string,unknown>>(`SELECT * FROM ${table} WHERE ${predicate}`,...params);if(!row)throw new MemoryCipherError();return row;
  },{immediate:true});
 }catch{throw new MemoryCipherError();}
}
