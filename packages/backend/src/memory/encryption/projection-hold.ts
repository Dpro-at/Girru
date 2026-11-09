/** Explicit durable P6 hold metadata. No startup migration or automatic encryption activation. */
import {randomUUID} from 'node:crypto';
import {one,run,tableExists,lockName,type Step} from '../../repositories/sql-steps.js';
import {MemoryCipherError} from './envelope.js';
const TABLE='memory_encryption_projection_holds';
export function* encryptedProjectionHeldStep(scope:string):Step<boolean>{
 if(!(yield* tableExists(TABLE)))return false;
 const row=yield* one<{state:string;generation:number|string}>(`SELECT state,generation FROM ${TABLE} WHERE scope=?`,scope);
 if(!row)return false;if(!Number.isSafeInteger(Number(row.generation))||Number(row.generation)<1||!['held','released'].includes(row.state))throw new MemoryCipherError();return row.state==='held';
}
export function* claimEncryptedProjectionHoldStep(ownerId:string,scope:string):Step<{id:string;generation:number}>{
 if(typeof scope!=='string'||!scope||Buffer.byteLength(scope)>512||!ownerId)throw new MemoryCipherError();
 yield* lockName('encrypted-projection-owner:'+ownerId);
 yield* run(`CREATE TABLE IF NOT EXISTS ${TABLE}(scope TEXT PRIMARY KEY,owner_id TEXT NOT NULL,hold_id TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL)`);
 yield* lockName('encrypted-projection:'+scope);
 const source=yield* one<{owner_id:string}>('SELECT owner_id FROM change_scopes WHERE scope=?',scope);if(!source||source.owner_id!==ownerId)throw new MemoryCipherError();
 const previous=yield* one<{owner_id:string;generation:number|string;state:string}>(`SELECT owner_id,generation,state FROM ${TABLE} WHERE scope=?`,scope);
 if(previous&&(previous.owner_id!==ownerId||previous.state!=='released'||!Number.isSafeInteger(Number(previous.generation))||Number(previous.generation)<1))throw new MemoryCipherError();
 const generation=previous?Number(previous.generation)+1:1,id=randomUUID();if(!Number.isSafeInteger(generation))throw new MemoryCipherError();
 yield* run(`INSERT INTO ${TABLE}(scope,owner_id,hold_id,generation,state) VALUES(?,?,?,?,'held') ON CONFLICT(scope) DO UPDATE SET hold_id=excluded.hold_id,generation=excluded.generation,state='held'`,scope,ownerId,id,generation);return{id,generation};
}
export function* releaseEncryptedProjectionHoldStep(ownerId:string,scope:string,id:string,generation:number):Step<void>{
 yield* lockName('encrypted-projection:'+scope);const result=yield* run(`UPDATE ${TABLE} SET state='released',hold_id='' WHERE scope=? AND owner_id=? AND hold_id=? AND generation=? AND state='held'`,scope,ownerId,id,generation);if(result.changes!==1)throw new MemoryCipherError();
}
