import {observeEncryptedRunFieldProducer} from './run-admission.js';
/** Agent-scoped single-row read. Owner identity alone never substitutes for live run drawer permissions. */
import type {StepRunner} from '../../repositories/sql-steps.js';
import {captureAuthenticatedMemoryRun} from './auth-capture.js';
import {createMemoryRevisionValidator} from './revision-validator.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {loadEncryptedOwnerRow} from './owner-row-loader.js';
import {decryptMemoryRow,encryptedFieldProducer} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
export async function readAuthenticatedEncryptedRunMemory(input:{runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;run:Parameters<typeof captureAuthenticatedMemoryRun>[2];id:string;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>}){
 const {runner,token,session,id,recordRead}=input;let key:Buffer|undefined;
 try{
  const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};boundary();
  if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(id))throw new MemoryCipherError();
  const run={...input.run,delegatedFrom:[...input.run.delegatedFrom],drawers:input.run.drawers.map(drawer=>({...drawer}))},lease=session.capture(),auth=await captureAuthenticatedMemoryRun(runner,token,run);boundary();
  if(auth.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  const validate=createMemoryRevisionValidator(runner,auth.revision,session.lock);
  const check=async()=>{boundary();if(!lease.isCurrent()||await validate()!==true)throw new MemoryCipherError();boundary();if(!lease.isCurrent())throw new MemoryCipherError();};
  const row=await loadEncryptedOwnerRow(runner,'memories',auth.ownerId,id);await check();
  if(!row)return null;if(!auth.access.authorize(row))throw new MemoryCipherError();
  if(await recordRead({readerKind:'agent',readerId:run.agentId,purpose:'tool',records:[{table:'memories',id}]})!==true)throw new MemoryCipherError();await check();
  const material=await lease.resolveKey(row);key=material.key;await check();const plain=decryptMemoryRow('memories',row,lease.scope,key,material.id);await check();
  const fresh=await loadEncryptedOwnerRow(runner,'memories',auth.ownerId,id);await check();
  if(!fresh||!auth.access.authorize(fresh)||canonicalEncryptedRow(row)!==canonicalEncryptedRow(fresh))throw new MemoryCipherError();observeEncryptedRunFieldProducer(encryptedFieldProducer('memories',plain,'content',lease.scope),{kind:'memory',id});return plain;
 }catch{throw new MemoryCipherError();}finally{key?.fill(0);}
}
