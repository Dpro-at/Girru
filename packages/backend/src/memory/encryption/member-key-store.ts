/** Explicit wrapped-key registration for provisioned isolated copies. Never generates or replaces a key. */
import {one,run,type StepRunner} from '../../repositories/sql-steps.js';
import type {WrappedMemoryDataKey} from './envelope.js';
import {MemoryCipherError} from './envelope.js';
export function createProvisionedMemoryMemberKeyStore(runner:StepRunner){
 const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};
 return{
  async initialize(){boundary();await runner.tx(function*(){yield* run('CREATE TABLE IF NOT EXISTS memory_encryption_member_keys(owner_id TEXT NOT NULL,member_id TEXT NOT NULL,key_id TEXT NOT NULL,wrapped TEXT NOT NULL,PRIMARY KEY(owner_id,member_id,key_id))');},{immediate:true});boundary();},
  async registerExisting(ownerId:string,memberId:string,record:WrappedMemoryDataKey,authorizeProvisioned:()=>Promise<boolean>){
   boundary();if(![ownerId,memberId,record?.id].every(id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(id))||typeof record.wrapped!=='string'||Buffer.byteLength(record.wrapped)>16384||typeof authorizeProvisioned!=='function')throw new MemoryCipherError();
   const captured={id:record.id,wrapped:record.wrapped};if(await authorizeProvisioned()!==true)throw new MemoryCipherError();boundary();
   await runner.tx(function*(){yield* run('INSERT INTO memory_encryption_member_keys(owner_id,member_id,key_id,wrapped) VALUES(?,?,?,?)',ownerId,memberId,captured.id,captured.wrapped);const stored=yield* one<WrappedMemoryDataKey>('SELECT key_id AS id,wrapped FROM memory_encryption_member_keys WHERE owner_id=? AND member_id=? AND key_id=?',ownerId,memberId,captured.id);if(!stored||stored.id!==captured.id||stored.wrapped!==captured.wrapped)throw new MemoryCipherError();},{immediate:true});boundary();
  },
 };
}
