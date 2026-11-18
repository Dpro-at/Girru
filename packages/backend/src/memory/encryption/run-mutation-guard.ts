import {memoryControlQuery} from './control-runner.js';
/** Recheck authenticated agent/drawer policy inside the SAME transaction as an owner-mediated mutation. */
import {one,type Step,type StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryRunStep,captureAuthenticatedMemoryRun} from './auth-capture.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {loadEncryptedOwnerRow} from './owner-row-loader.js';
import {MemoryCipherError} from './envelope.js';
export type EncryptedMutationGuard=(row:Readonly<Record<string,unknown>>)=>Step<void>;
export async function captureEncryptedMutationGuard(input:{runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;run:Parameters<typeof authenticatedMemoryRunStep>[1];id:string;fromHistory?:boolean}):Promise<EncryptedMutationGuard>{
 const {runner,token,session,id}=input,run={...input.run,delegatedFrom:[...input.run.delegatedFrom],drawers:input.run.drawers.map(d=>({...d}))},lease=session.capture();
 const auth=await captureAuthenticatedMemoryRun(runner,token,run);if(auth.ownerId!==lease.scope.ownerId||run.audience!=='owner'||!lease.isCurrent())throw new MemoryCipherError();
 const row=await loadEncryptedOwnerRow(runner,input.fromHistory?'memory_versions':'memories',auth.ownerId,id,input.fromHistory===true);if(!row||!auth.access.authorizeWrite(row)||!lease.isCurrent())throw new MemoryCipherError();
 return function*(plain){
  if(!lease.isCurrent()||Date.now()>=auth.revision.validUntil||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();
  const current=yield* authenticatedMemoryRunStep(token,run);if(JSON.stringify(current.revision)!==JSON.stringify(auth.revision)||!current.access.authorizeWrite(plain)||!lease.isCurrent())throw new MemoryCipherError();
  if(plain.drawer_kind==='project'&&(yield* memoryControlQuery(()=>one('SELECT 1 AS archived FROM memory_project_scopes WHERE owner_id=? AND slug=? AND archived_at IS NOT NULL',auth.ownerId,String(plain.drawer_key)))))throw new MemoryCipherError();
 };
}
