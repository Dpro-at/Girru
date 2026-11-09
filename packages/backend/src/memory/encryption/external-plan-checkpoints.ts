/** Append-only encrypted observation checkpoints. Not proof of historical completeness or rollback custody. */
import {randomUUID} from 'node:crypto';
import {all,one,run,tableExists,dialect,type Step,type StepRunner} from '../../repositories/sql-steps.js';
import {MemoryCipherError} from './envelope.js';
const TABLE='memory_encryption_external_plan_checkpoints';
export function createExternalPlanCheckpointStore(runner:StepRunner,ownerId:string){
 if(typeof ownerId!=='string'||!ownerId||Buffer.byteLength(ownerId)>256)throw new MemoryCipherError();
 const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};
 return{
  async initialize(){boundary();await runner.tx(function*(){yield* run(`CREATE TABLE IF NOT EXISTS ${TABLE}(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,ciphertext TEXT NOT NULL,created_at TEXT NOT NULL)`);},{immediate:true});},
  async append(snapshot:{snapshotId:string;ciphertext:string}):Promise<string>{
   boundary();const {snapshotId,ciphertext}=snapshot;
   if(typeof snapshotId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(snapshotId)||typeof ciphertext!=='string'||Buffer.byteLength(ciphertext)>1400000)throw new MemoryCipherError();
   try{const envelope=JSON.parse(ciphertext);if(!envelope||Object.keys(envelope).sort().join(',')!=='c,k,n,t,v'||envelope.v!==1||typeof envelope.k!=='string'||!envelope.k||Buffer.byteLength(envelope.k)>256||typeof envelope.n!=='string'||!/^[A-Za-z0-9+/]{16}$/.test(envelope.n)||typeof envelope.t!=='string'||!/^[A-Za-z0-9+/]{22}==$/.test(envelope.t)||typeof envelope.c!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(envelope.c))throw new MemoryCipherError();}catch{throw new MemoryCipherError();}
   const id=randomUUID(),at=new Date().toISOString();
   await runner.tx(function*(){yield* run(`INSERT INTO ${TABLE}(id,owner_id,snapshot_id,ciphertext,created_at) VALUES(?,?,?,?,?)`,id,ownerId,snapshotId,ciphertext,at);const row=yield* one<{owner_id:string;snapshot_id:string;ciphertext:string}>(`SELECT owner_id,snapshot_id,ciphertext FROM ${TABLE} WHERE id=?`,id);if(!row||row.owner_id!==ownerId||row.snapshot_id!==snapshotId||row.ciphertext!==ciphertext)throw new MemoryCipherError();},{immediate:true});return id;
  },
 };
}

/** Bounded ciphertext transport only; caller must authenticate owner and audit before opening keys. */
export function* loadExternalPlanCheckpointStep(ownerId:string,id:string):Step<{id:string;snapshotId:string;ciphertext:string}|null>{
 if(typeof ownerId!=='string'||!ownerId||Buffer.byteLength(ownerId)>256||typeof id!=='string'||!/^[A-Za-z0-9-]{1,128}$/.test(id))throw new MemoryCipherError();
 if(!(yield* tableExists(TABLE)))return null;
 const driver=yield* dialect(),size=(column:string)=>driver==='sqlite'?`length(CAST(${column} AS BLOB))`:`octet_length(${column})`;
 const row=yield* one<{snapshot_id:string|null;ciphertext:string|null}>(`SELECT CASE WHEN ${size('snapshot_id')}<=256 THEN snapshot_id ELSE NULL END snapshot_id,CASE WHEN ${size('ciphertext')}<=1400000 THEN ciphertext ELSE NULL END ciphertext FROM ${TABLE} WHERE owner_id=? AND id=?`,ownerId,id);
 if(!row)return null;if(typeof row.snapshot_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(row.snapshot_id)||typeof row.ciphertext!=='string')throw new MemoryCipherError();
 return{id,snapshotId:row.snapshot_id,ciphertext:row.ciphertext};
}
/** Identifier metadata only. Not authenticated chronology, rollback detection or complete write history. */
export function* listExternalPlanCheckpointIdsStep(ownerId:string):Step<Array<{id:string;snapshotId:string}>>{
 if(typeof ownerId!=='string'||!ownerId||Buffer.byteLength(ownerId)>256)throw new MemoryCipherError();
 if(!(yield* tableExists(TABLE)))return[];
 const driver=yield* dialect();if(driver==='postgres')yield* run(`LOCK TABLE ${TABLE} IN SHARE MODE`);
 const size=driver==='sqlite'?'coalesce(length(CAST(id AS BLOB)),0)+coalesce(length(CAST(snapshot_id AS BLOB)),0)':'coalesce(octet_length(id),0)+coalesce(octet_length(snapshot_id),0)';
 const bound=yield* one<{n:number|string;bytes:number|string}>(`SELECT count(*) n,coalesce(sum(${size}),0) bytes FROM ${TABLE} WHERE owner_id=?`,ownerId);
 if(!bound||!Number.isSafeInteger(Number(bound.n))||Number(bound.n)>1000||Number(bound.bytes)>524288)throw new MemoryCipherError();
 const rows=yield* all<{id:string;snapshot_id:string}>(`SELECT id,snapshot_id FROM ${TABLE} WHERE owner_id=? ORDER BY created_at,id`,ownerId);
 if(rows.length!==Number(bound.n))throw new MemoryCipherError();
 return rows.map(row=>{if(typeof row.id!=='string'||!/^[A-Za-z0-9-]{1,128}$/.test(row.id)||typeof row.snapshot_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(row.snapshot_id))throw new MemoryCipherError();return{id:row.id,snapshotId:row.snapshot_id};});
}
