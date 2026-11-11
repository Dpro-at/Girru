import {beforeEncryptedMemoryEffect,memoryEffectDigest} from './memory-effect.js';
import {prepareOwnerNewContent,captureOwnerNewContentAdmission,isTrustedOwnerNewContentAdmission} from './owner-content-admission.js';
import {memoryControlQuery} from './control-runner.js';
/** Owner-created encrypted pinned facts, preserving existing scope limits and redaction policy. */
import {randomUUID} from 'node:crypto';
import {one,run,lockName,type StepRunner,type SqlParam} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {parsePinnedScope,pinnedScopeId,MAX_FACT_CHARS,MAX_FACTS_PER_SCOPE} from '../scopes/pinned.js';
import {departmentStep,projectStep} from '../scopes/store.js';
import {redactImportText} from '../import/redact.js';
import {encryptMemoryRow,decryptMemoryRow,attachOwnerNewContentProducer} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import {MemoryCipherError} from './envelope.js';
export async function addAuthenticatedEncryptedPinnedFact(input:{runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;scope:string;text:string}){
 const {runner,token,session}=input;let key:Buffer|undefined;
 try{
  const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};boundary();
  const scope=parsePinnedScope(input.scope);if(typeof input.text!=='string'||input.text.length>MAX_FACT_CHARS)throw new MemoryCipherError();const prepared=prepareOwnerNewContent('pin',null,'scope:'+pinnedScopeId(scope),input.text),text=prepared.text;if(!text||text.length>MAX_FACT_CHARS)throw new MemoryCipherError();
  const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(owner.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  const admission=captureOwnerNewContentAdmission(owner.ownerId,lease.scope.memberId,prepared.intent);if(!admission)throw new MemoryCipherError();
  const check=async()=>{boundary();if(!isTrustedOwnerNewContentAdmission(admission))throw new MemoryCipherError();const fresh=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();};
  const material=await lease.resolveKey({user_id:owner.ownerId});key=material.key;if(material.id!==admission.anchor.keyId)throw new MemoryCipherError();await check();const operationKey=key,id=randomUUID();
  await runner.tx(function*(){
   if(scope.kind==='department'&&!(yield* memoryControlQuery(()=>departmentStep(owner.ownerId,scope.id))))throw new MemoryCipherError();if(scope.kind==='project'){const project=yield* memoryControlQuery(()=>projectStep(owner.ownerId,scope.id));if(!project||project.archived)throw new MemoryCipherError();}
   const count=yield* one<{n:number|string;max:number|string|null}>('SELECT count(*) n,MAX(position) max FROM memory_pinned_facts WHERE owner_id=? AND scope_kind=? AND scope_id=?',owner.ownerId,scope.kind,scope.id);if(!count||Number(count.n)>=MAX_FACTS_PER_SCOPE||!Number.isSafeInteger(Number(count.max??-1)+1)||Number(count.max??-1)+1<0)throw new MemoryCipherError();
  },{immediate:true});await check();
  await beforeEncryptedMemoryEffect({runner,action:'create-pin',auth:owner,isCurrent:()=>lease.isCurrent()&&isTrustedOwnerNewContentAdmission(admission)&&Date.now()<owner.validUntil,targetDigest:memoryEffectDigest([id,scope,prepared.intent])});await check();
  await runner.tx(function*(){
   const fresh=yield* authenticatedMemoryOwnerStep(token);if(JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();
   if(scope.kind==='department'&&!(yield* memoryControlQuery(()=>departmentStep(owner.ownerId,scope.id))))throw new MemoryCipherError();if(scope.kind==='project'){const project=yield* memoryControlQuery(()=>projectStep(owner.ownerId,scope.id));if(!project||project.archived)throw new MemoryCipherError();}
   yield* lockName('encrypted-pinned:'+JSON.stringify([owner.ownerId,scope.kind,scope.id]));const count=yield* one<{n:number|string;max:number|string|null}>('SELECT count(*) n,MAX(position) max FROM memory_pinned_facts WHERE owner_id=? AND scope_kind=? AND scope_id=?',owner.ownerId,scope.kind,scope.id);if(!count||Number(count.n)>=MAX_FACTS_PER_SCOPE)throw new MemoryCipherError();const position=Number(count.max??-1)+1;if(!Number.isSafeInteger(position)||position<0)throw new MemoryCipherError();
   const now=new Date().toISOString(),plain={id,owner_id:owner.ownerId,scope_kind:scope.kind,scope_id:scope.id,text,position,created_by:owner.ownerId,created_at:now,updated_at:now},cipher=encryptMemoryRow('memory_pinned_facts',attachOwnerNewContentProducer('memory_pinned_facts',plain,lease.scope,admission),lease.scope,operationKey,material.id),fields=Object.keys(cipher);
   yield* run(`INSERT INTO memory_pinned_facts(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,...fields.map(field=>cipher[field] as SqlParam));const row=yield* one<Record<string,unknown>>('SELECT * FROM memory_pinned_facts WHERE id=? AND owner_id=?',id,owner.ownerId);if(!row||canonicalEncryptedRow(decryptMemoryRow('memory_pinned_facts',row,lease.scope,operationKey,material.id))!==canonicalEncryptedRow(plain)||!lease.isCurrent()||!isTrustedOwnerNewContentAdmission(admission)||Date.now()>=owner.validUntil)throw new MemoryCipherError();
  },{immediate:true});await check();return{id};
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
