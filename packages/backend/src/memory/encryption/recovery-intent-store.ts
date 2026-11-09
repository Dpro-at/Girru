/** Committed id-only recovery attempts, before recovering or opening a master key. */
import {randomUUID} from 'node:crypto';
import {one,run,type StepRunner} from '../../repositories/sql-steps.js';
import {MemoryCipherError} from './envelope.js';
export type MemoryRecoveryIntent={purpose:'memory-key-recovery';ownerId:string;memberId:string;authorityId:string;epoch:number};
export function createMemoryRecoveryIntentStore(runner:StepRunner,ownerId:string){
 if(typeof ownerId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(ownerId))throw new MemoryCipherError();
 const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};
 return{async append(input:MemoryRecoveryIntent){
  boundary();if(!input||Object.keys(input).sort().join(',')!=='authorityId,epoch,memberId,ownerId,purpose'||input.purpose!=='memory-key-recovery'||input.ownerId!==ownerId||![input.ownerId,input.memberId,input.authorityId].every(id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(id))||!Number.isSafeInteger(input.epoch)||input.epoch<1)throw new MemoryCipherError();const id=randomUUID(),payload=JSON.stringify({...input});
  await runner.tx(function*(){yield* run('CREATE TABLE IF NOT EXISTS memory_encryption_recovery_intents(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,payload TEXT NOT NULL)');yield* run('INSERT INTO memory_encryption_recovery_intents(id,owner_id,payload) VALUES(?,?,?)',id,ownerId,payload);const row=yield* one<{payload:string}>('SELECT CASE WHEN length(payload)<=4096 THEN payload ELSE NULL END AS payload FROM memory_encryption_recovery_intents WHERE id=? AND owner_id=?',id,ownerId);if(!row||row.payload!==payload)throw new MemoryCipherError();},{immediate:true});boundary();return true;
 }};
}
