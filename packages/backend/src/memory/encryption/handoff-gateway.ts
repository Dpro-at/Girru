import {beforeEncryptedMemoryEffect,memoryEffectDigest} from './memory-effect.js';
import {captureEncryptedRunWriteAdmission,observeEncryptedRunFieldProducer} from './run-admission.js';
import {memoryControlQuery} from './control-runner.js';
/** Encrypted self-only handoffs. Scope comes from trusted run context and is rechecked in the selected DB. */
import {randomUUID} from 'node:crypto';
import {one,run,lockName,type StepRunner,type SqlParam} from '../../repositories/sql-steps.js';
import {captureAuthenticatedMemoryRun,authenticatedMemoryRunStep} from './auth-capture.js';
import {createMemoryRevisionValidator} from './revision-validator.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {cleanHandoff,toHandoff,MAX_VERSIONS} from '../handoff/store.js';
import {memoryRowSurfaceManifest,encryptMemoryRow,decryptMemoryRow,attachEncryptedRunProducer,encryptedFieldProducer} from './row-codec.js';
import {loadEncryptedOwnerRow} from './owner-row-loader.js';
import {canonicalEncryptedRow} from './content-commit.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
type Scope={kind:'conversation'|'task';id:string;runId?:string|null};
type Input={runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;run:Parameters<typeof authenticatedMemoryRunStep>[1];scope:Scope;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>};
async function capture(input:Input){
 const {runner,token,session,recordRead}=input,scope={...input.scope},runScope={...input.run,delegatedFrom:[...input.run.delegatedFrom],drawers:input.run.drawers.map(d=>({...d}))},lease=session.capture();
 const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};boundary();
 if(!['conversation','task'].includes(scope.kind)||typeof scope.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(scope.id)||runScope.audience!=='owner'||runScope.agentId==='small-local-agent')throw new MemoryCipherError();
 const auth=await captureAuthenticatedMemoryRun(runner,token,runScope);boundary();if(auth.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();const validate=createMemoryRevisionValidator(runner,auth.revision,session.lock);
 const check=async()=>{boundary();if(!lease.isCurrent()||await validate()!==true)throw new MemoryCipherError();boundary();if(!lease.isCurrent())throw new MemoryCipherError();};
 function* scopeStep(){
  const current=yield* authenticatedMemoryRunStep(token,runScope);if(JSON.stringify(current.revision)!==JSON.stringify(auth.revision)||!lease.isCurrent())throw new MemoryCipherError();
  if(scope.kind==='conversation'){const row=yield* memoryControlQuery(()=>one<{project_id:string|null}>('SELECT project_id FROM chat_sessions WHERE id=? AND user_id=?',scope.id,auth.ownerId));if(!row)throw new MemoryCipherError();return row.project_id;}
  const runId=scope.runId;if(typeof runId!=='string'||!runId)throw new MemoryCipherError();const row=yield* memoryControlQuery(()=>one<{task_id:string;agent_id:string;user_id:string|null}>('SELECT task_id,agent_id,user_id FROM task_runs WHERE id=?',runId));if(!row||row.task_id!==scope.id||row.agent_id!==runScope.agentId||row.user_id!==auth.ownerId)throw new MemoryCipherError();return null;
 }
 await check();await runner.tx(scopeStep,{immediate:true});await check();return{runner,token,session,scope,runScope,lease,auth,check,scopeStep,recordRead};
}
export async function saveAuthenticatedEncryptedHandoff(input:Input&{body:unknown}){
 let key:Buffer|undefined;const body=cleanHandoff(input.body,true);
 try{const c=await capture(input),producer=captureEncryptedRunWriteAdmission(c.auth.ownerId,c.runScope.agentId);if(!producer)throw new MemoryCipherError();const material=await c.lease.resolveKey({user_id:c.auth.ownerId});key=material.key;await c.check();const operationKey=key,id=randomUUID();
  const top=await c.runner.read(one<{v:number|string|null}>('SELECT MAX(version) v FROM agent_handoffs WHERE owner_id=? AND agent_id=? AND scope_kind=? AND scope_id=?',c.auth.ownerId,c.runScope.agentId,c.scope.kind,c.scope.id));await c.check();if(!Number.isSafeInteger(Number(top?.v??0)+1)||Number(top?.v??0)+1<1)throw new MemoryCipherError();
  await beforeEncryptedMemoryEffect({runner:c.runner,action:'create-handoff',auth:c.auth,isCurrent:()=>c.lease.isCurrent()&&producer.isCurrent()&&Date.now()<c.auth.revision.validUntil,targetDigest:memoryEffectDigest([id,[c.scope.kind,c.scope.id,c.scope.runId??null],c.runScope.agentId,[body.done,body.left,body.next,body.questions,body.blockers??[],body.files??[]],top?.v??0])});await c.check();
  const result=await c.runner.tx(function*(){const projectId=yield* c.scopeStep();yield* lockName('encrypted-handoff:'+JSON.stringify([c.auth.ownerId,c.runScope.agentId,c.scope.kind,c.scope.id]));
   const top=yield* one<{v:number|string|null}>('SELECT MAX(version) v FROM agent_handoffs WHERE owner_id=? AND agent_id=? AND scope_kind=? AND scope_id=?',c.auth.ownerId,c.runScope.agentId,c.scope.kind,c.scope.id);const version=Number(top?.v??0)+1;if(!Number.isSafeInteger(version)||version<1)throw new MemoryCipherError();
   const surface=memoryRowSurfaceManifest().find(s=>s.table==='agent_handoffs')!,row:Record<string,unknown>=Object.fromEntries([surface.owner,surface.id,...surface.bound,...surface.clear,...surface.text,...surface.binary].map(field=>[field,null]));
   Object.assign(row,{id,owner_id:c.auth.ownerId,agent_id:c.runScope.agentId,scope_kind:c.scope.kind,scope_id:c.scope.id,project_id:projectId,version,done:JSON.stringify(body.done),remaining:JSON.stringify(body.left),next_steps:JSON.stringify(body.next),open_questions:JSON.stringify(body.questions),blockers:JSON.stringify(body.blockers??[]),files_touched:JSON.stringify(body.files??[]),source:'agent',run_id:c.scope.runId??null,created_at:new Date().toISOString()});
   const encrypted=encryptMemoryRow('agent_handoffs',attachEncryptedRunProducer('agent_handoffs',row,c.lease.scope,producer),c.lease.scope,operationKey,material.id),fields=Object.keys(encrypted);yield* run(`INSERT INTO agent_handoffs(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,...fields.map(field=>encrypted[field] as SqlParam));
   const stored=yield* one<Record<string,unknown>>('SELECT * FROM agent_handoffs WHERE id=? AND owner_id=?',id,c.auth.ownerId);if(!stored||canonicalEncryptedRow(stored)!==canonicalEncryptedRow(encrypted))throw new MemoryCipherError();
   yield* run('DELETE FROM agent_handoffs WHERE owner_id=? AND agent_id=? AND scope_kind=? AND scope_id=? AND version<=?',c.auth.ownerId,c.runScope.agentId,c.scope.kind,c.scope.id,version-MAX_VERSIONS);yield* c.scopeStep();if(Date.now()>=c.auth.revision.validUntil||!c.lease.isCurrent()||!producer.isCurrent())throw new MemoryCipherError();return{id,version};
  },{immediate:true});await c.check();return result;
 }catch{input.session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
export async function readAuthenticatedEncryptedHandoff(input:Input){let key:Buffer|undefined;
 try{const c=await capture(input),top=await c.runner.read(one<{id:string}>('SELECT id FROM agent_handoffs WHERE owner_id=? AND agent_id=? AND scope_kind=? AND scope_id=? ORDER BY version DESC LIMIT 1',c.auth.ownerId,c.runScope.agentId,c.scope.kind,c.scope.id));await c.check();if(!top)return null;
  const row=await loadEncryptedOwnerRow(c.runner,'agent_handoffs',c.auth.ownerId,top.id);await c.check();if(!row)throw new MemoryCipherError();if(await c.recordRead({readerKind:'agent',readerId:c.runScope.agentId,purpose:'tool',records:[{table:'agent_handoffs',id:top.id}]})!==true)throw new MemoryCipherError();await c.check();const material=await c.lease.resolveKey({user_id:c.auth.ownerId});key=material.key;await c.check();const plain=decryptMemoryRow('agent_handoffs',row,c.lease.scope,key,material.id);
  if(plain.agent_id!==c.runScope.agentId||plain.scope_kind!==c.scope.kind||plain.scope_id!==c.scope.id)throw new MemoryCipherError();const current=await loadEncryptedOwnerRow(c.runner,'agent_handoffs',c.auth.ownerId,top.id);await c.check();await c.runner.tx(c.scopeStep,{immediate:true});await c.check();if(!current||canonicalEncryptedRow(current)!==canonicalEncryptedRow(row))throw new MemoryCipherError();for(const field of ['done','remaining','next_steps','open_questions','blockers','files_touched'])observeEncryptedRunFieldProducer(encryptedFieldProducer('agent_handoffs',plain,field,c.lease.scope),{kind:'handoff',id:top.id});return toHandoff(plain as never);
 }catch{input.session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
