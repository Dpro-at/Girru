/** Explicit identifier-only plan intent store. Not a tamper-evident chain or proof of completed effects. */
import {randomUUID} from 'node:crypto';
import {one,run,type StepRunner} from '../../repositories/sql-steps.js';
import type {ExternalPlanIntent} from './external-reference-gateway.js';
import {MemoryCipherError} from './envelope.js';
const TABLE='memory_encryption_external_plan_intents';
export function createExternalPlanIntentStore(runner:StepRunner,ownerId:string){
 if(typeof ownerId!=='string'||!ownerId||Buffer.byteLength(ownerId)>256)throw new MemoryCipherError();
 const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};
 return{
  async initialize(){boundary();await runner.tx(function*(){yield* run(`CREATE TABLE IF NOT EXISTS ${TABLE}(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,purpose TEXT NOT NULL,reference_count INTEGER NOT NULL,hold_count INTEGER NOT NULL,created_at TEXT NOT NULL)`);},{immediate:true});},
  async append(input:ExternalPlanIntent):Promise<boolean>{
   boundary();
   if(!input||Object.keys(input).sort().join(',')!=='holdCount,ownerId,purpose,referenceCount,snapshotId'||input.ownerId!==ownerId||!['external-forget-plan','external-forget-plan-history'].includes(input.purpose)||typeof input.snapshotId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(input.snapshotId)||!Number.isSafeInteger(input.referenceCount)||input.referenceCount<0||input.referenceCount>3000||!Number.isSafeInteger(input.holdCount)||input.holdCount<0||input.holdCount>1000)throw new MemoryCipherError();
   const event={...input},id=randomUUID(),at=new Date().toISOString();
   await runner.tx(function*(){
    yield* run(`INSERT INTO ${TABLE}(id,owner_id,snapshot_id,purpose,reference_count,hold_count,created_at) VALUES(?,?,?,?,?,?,?)`,id,ownerId,event.snapshotId,event.purpose,event.referenceCount,event.holdCount,at);
    const row=yield* one<{owner_id:string;snapshot_id:string;purpose:string;reference_count:number|string;hold_count:number|string;created_at:string}>(`SELECT owner_id,snapshot_id,purpose,reference_count,hold_count,created_at FROM ${TABLE} WHERE id=?`,id);
    if(!row||row.owner_id!==ownerId||row.snapshot_id!==event.snapshotId||row.purpose!==event.purpose||Number(row.reference_count)!==event.referenceCount||Number(row.hold_count)!==event.holdCount||row.created_at!==at)throw new MemoryCipherError();
   },{immediate:true});
   // Resolves only after the standalone transaction committed successfully.
   return true;
  },
 };
}
