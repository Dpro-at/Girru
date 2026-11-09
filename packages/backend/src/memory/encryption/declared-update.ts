import {prepareOwnerNewContent,captureOwnerNewContentAdmission,isTrustedOwnerNewContentAdmission} from './owner-content-admission.js';
import {beforeEncryptedMemoryEffect,memoryEffectDigest} from './memory-effect.js';
/** Audited owner updates for auxiliary declared surfaces. Identity/policy/revision fields cannot be patched. */
import {one,run,dialect,type StepRunner,type SqlParam} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {loadEncryptedOwnerRow} from './owner-row-loader.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {memoryRowSurfaceManifest,encryptMemoryRow,decryptMemoryRow,attachOwnerNewContentProducer,type MemoryRowTable} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
import {MAX_FACT_CHARS} from '../scopes/pinned.js';
import {redactImportText} from '../import/redact.js';
// Handoffs are versioned append-only notes; edits must create a new version via their scoped writer.
const writable={memory_weekly_summaries:['text','model_text'],memory_pinned_facts:['text']} as const;
type AuxiliaryTable=keyof typeof writable;
export async function updateAuthenticatedEncryptedAuxiliary(input:{runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;table:AuxiliaryTable;id:string;patch:Record<string,string|null>;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>}){
 const {runner,token,session,table,id,recordRead}=input;let key:Buffer|undefined;
 try{
  const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};boundary();
  if(!Object.hasOwn(writable,table)||!input.patch||typeof input.patch!=='object'||Array.isArray(input.patch)||!Object.keys(input.patch).length||Object.entries(input.patch).some(([field,value])=>!(writable[table] as readonly string[]).includes(field)||value!==null&&(typeof value!=='string'||Buffer.byteLength(value)>1024*1024)))throw new MemoryCipherError();
  const patch={...input.patch};let pinIntent:ReturnType<typeof prepareOwnerNewContent>|undefined;
  if(table==='memory_pinned_facts'){
   if(typeof patch.text!=='string'||patch.text.length>MAX_FACT_CHARS)throw new MemoryCipherError();patch.text=redactImportText(patch.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,' ')).text.trim();if(!patch.text||patch.text.length>MAX_FACT_CHARS)throw new MemoryCipherError();pinIntent=prepareOwnerNewContent('pin',id,'pin:'+id,patch.text,null);patch.text=pinIntent.text;
  }else{
   if(Object.hasOwn(patch,'text')&&typeof patch.text!=='string')throw new MemoryCipherError();
   if(typeof patch.model_text==='string'&&patch.model_text.length>20000)throw new MemoryCipherError();
   for(const field of Object.keys(patch))if(typeof patch[field]==='string')patch[field]=redactImportText(patch[field] as string).text;
  }
  const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(owner.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  const admission=pinIntent?captureOwnerNewContentAdmission(owner.ownerId,lease.scope.memberId,pinIntent.intent):null;if(pinIntent&&!admission)throw new MemoryCipherError();
  const check=async()=>{boundary();if(admission&&!isTrustedOwnerNewContentAdmission(admission))throw new MemoryCipherError();const fresh=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();};
  const source=await loadEncryptedOwnerRow(runner,table,owner.ownerId,id);await check();if(!source)throw new MemoryCipherError();if(await recordRead({readerKind:'user',readerId:owner.ownerId,purpose:'tool',records:[{table,id}]})!==true)throw new MemoryCipherError();await check();
  const material=await lease.resolveKey({user_id:owner.ownerId});key=material.key;if(admission&&material.id!==admission.anchor.keyId)throw new MemoryCipherError();await check();const plain=decryptMemoryRow(table,source,lease.scope,key,material.id),updated={...plain,...patch,...(table==='memory_pinned_facts'?{updated_at:new Date().toISOString()}:{})},replacement=encryptMemoryRow(table,admission?attachOwnerNewContentProducer(table,updated,lease.scope,admission,['text']):updated,lease.scope,key,material.id),surface=memoryRowSurfaceManifest().find(s=>s.table===table)!;
  await beforeEncryptedMemoryEffect({runner,action:'update-owner-auxiliary',auth:owner,isCurrent:()=>lease.isCurrent()&&(!admission||isTrustedOwnerNewContentAdmission(admission))&&Date.now()<owner.validUntil,targetDigest:memoryEffectDigest([table,id,source,replacement])});await check();
  const operationKey=key;await runner.tx(function*(){
   const fresh=yield* authenticatedMemoryOwnerStep(token);if(JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent()||admission&&!isTrustedOwnerNewContentAdmission(admission))throw new MemoryCipherError();
   const driver=yield* dialect();
   const current=yield* one<Record<string,unknown>>(`SELECT * FROM ${table} WHERE ${surface.owner}=? AND ${surface.id}=?${driver==='postgres'?' FOR UPDATE':''}`,owner.ownerId,id);if(!current||canonicalEncryptedRow(current)!==canonicalEncryptedRow(source))throw new MemoryCipherError();
   const fields=Object.keys(replacement).filter(field=>field!==surface.owner&&field!==surface.id);const changed=yield* run(`UPDATE ${table} SET ${fields.map(field=>field+'=?').join(',')} WHERE ${surface.owner}=? AND ${surface.id}=?`,...fields.map(field=>replacement[field] as SqlParam),owner.ownerId,id);if(changed.changes!==1)throw new MemoryCipherError();
   const stored=yield* one<Record<string,unknown>>(`SELECT * FROM ${table} WHERE ${surface.owner}=? AND ${surface.id}=?`,owner.ownerId,id);if(!stored||canonicalEncryptedRow(stored)!==canonicalEncryptedRow(replacement))throw new MemoryCipherError();decryptMemoryRow(table as MemoryRowTable,stored,lease.scope,operationKey,material.id);
   if(!lease.isCurrent()||admission&&!isTrustedOwnerNewContentAdmission(admission)||Date.now()>=owner.validUntil||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();
  },{immediate:true});await check();
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
