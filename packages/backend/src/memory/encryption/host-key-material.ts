/** Deterministic domain-separated host service keys; none are stored beside memory ciphertext. */
import {createHmac} from 'node:crypto';
import {deriveMemoryAuditKey} from './read-audit.js';
import {deriveMemoryLookupKey} from './topic-lookup.js';
import {MemoryCipherError} from './envelope.js';
export function deriveMemoryHostKeyMaterial(master:Buffer,scope:{ownerId:string;memberId:string;authorityId:string}){
 if(!Buffer.isBuffer(master)||master.length!==32||!scope||![scope.ownerId,scope.memberId,scope.authorityId].every(id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(id)))throw new MemoryCipherError();
 const captured={...scope},derive=(purpose:string)=>createHmac('sha256',master).update(JSON.stringify(['girru-memory-host',1,purpose,captured.ownerId,captured.memberId,captured.authorityId])).digest();
 const lookupKey=deriveMemoryLookupKey(master,captured.ownerId),auditKey=deriveMemoryAuditKey(master,captured.ownerId),verificationKey=derive('snapshot-verification'),authorityKey=derive('forget-authority');
 return{lookupKey,auditKey,verificationKey,authorityKey,close(){for(const key of [lookupKey,auditKey,verificationKey,authorityKey])key.fill(0);}};
}
