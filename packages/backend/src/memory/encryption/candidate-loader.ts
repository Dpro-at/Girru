import {hasMemoryControlBinding} from './control-runner.js';
/** Bounded ciphertext transport only; never grants access or decrypts rows. */
import {all,one,run,dialect,tableColumns,type StepRunner} from '../../repositories/sql-steps.js';
import {memoryRowSurfaceManifest} from './row-codec.js';
import {NOT_ARCHIVED_SQL} from '../scopes/store.js';
import {MemoryCipherError} from './envelope.js';
export async function loadEncryptedMemoryCandidates(runner:StepRunner,ownerId:string,maxRows=5000,maxBytes=64*1024*1024){
 try{
  if(typeof ownerId!=='string'||!ownerId||ownerId.length>256||!Number.isInteger(maxRows)||maxRows<1||maxRows>5000||!Number.isInteger(maxBytes)||maxBytes<1024||maxBytes>64*1024*1024)throw new MemoryCipherError();
  const surface=memoryRowSurfaceManifest().find(s=>s.table==='memories')!;
  const fields=[surface.owner,surface.id,...surface.bound,...surface.clear,...surface.text,...surface.binary];
  return await runner.tx(function*(){
   const driver=yield* dialect();if(driver==='postgres')yield* run('LOCK TABLE memories,memory_project_scopes IN SHARE MODE');
   const columns=driver==='sqlite'?(yield* all<{name:string}>('SELECT name FROM pragma_table_xinfo(?)','memories')).map(c=>c.name):yield* tableColumns('memories');
   if(columns.sort().join('\0')!==[...fields].sort().join('\0'))throw new MemoryCipherError();
   const lengths=fields.map(f=>driver==='sqlite'?`COALESCE(length(CAST(${f} AS BLOB)),0)`:`COALESCE(octet_length(${new Set<string>(surface.binary).has(f)?f:`CAST(${f} AS TEXT)`}),0)`);
   const where="user_id=? AND (status='active' OR status IS NULL) AND COALESCE(drawer_kind,'')<>'agent'"+(hasMemoryControlBinding(runner)?'':' AND '+NOT_ARCHIVED_SQL);
   const size=yield* one<{n:number|string;b:number|string|null}>(`SELECT count(*) AS n,SUM(${lengths.join('+')}) AS b FROM memories WHERE ${where}`,ownerId);
   const count=Number(size?.n),bytes=Number(size?.b);
   if(!Number.isSafeInteger(count)||count>maxRows||!Number.isSafeInteger(bytes)||bytes<0||bytes>maxBytes)throw new MemoryCipherError();
   const rows=yield* all<Record<string,unknown>>(`SELECT * FROM memories WHERE ${where} ORDER BY id LIMIT 5001`,ownerId);
   if(rows.length!==count)throw new MemoryCipherError();return rows;
  },{immediate:true});
 }catch{throw new MemoryCipherError();}
}
