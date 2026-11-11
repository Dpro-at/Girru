/** Committed identifier-only restore intent. Records attempts, never proves completed restoration. */
import {randomUUID} from 'node:crypto';
import {one,run,type StepRunner} from '../../repositories/sql-steps.js';
import type {MemoryRestoreIntent} from './restore-guard.js';
import {MemoryCipherError} from './envelope.js';
const TABLE='memory_encryption_restore_intents';
const id=(s:unknown)=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(s);
export function createMemoryRestoreIntentStore(runner:StepRunner,ownerId:string){
 if(!id(ownerId))throw new MemoryCipherError();
 const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};
 return{
  async initialize(){boundary();await runner.tx(function*(){yield* run(`CREATE TABLE IF NOT EXISTS ${TABLE}(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,payload TEXT NOT NULL)`);},{immediate:true});boundary();},
  async append(input:MemoryRestoreIntent):Promise<boolean>{
   boundary();if(!input||Object.keys(input).sort().join(',')!=='authorityId,epoch,forgetSequence,memberId,ownerId,purpose,snapshotId,targetId'||input.purpose!=='memory-restore-copy'||input.ownerId!==ownerId||![input.ownerId,input.memberId,input.authorityId,input.snapshotId,input.targetId].every(id)||!Number.isSafeInteger(input.epoch)||input.epoch<1||!Number.isSafeInteger(input.forgetSequence)||input.forgetSequence<0)throw new MemoryCipherError();
   const eventId=randomUUID(),payload=JSON.stringify({...input});
   await runner.tx(function*(){
    yield* run(`INSERT INTO ${TABLE}(id,owner_id,payload) VALUES(?,?,?)`,eventId,ownerId,payload);
    const row=yield* one<{owner_id:string;payload:string}>(`SELECT owner_id,CASE WHEN length(payload)<=4096 THEN payload ELSE NULL END AS payload FROM ${TABLE} WHERE id=?`,eventId);
    if(!row||row.owner_id!==ownerId||row.payload!==payload)throw new MemoryCipherError();
   },{immediate:true});boundary();return true;
  },
 };
}
