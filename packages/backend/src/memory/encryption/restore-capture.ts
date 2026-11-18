import type {AuxiliarySourceCapture} from './auxiliary-source.js';
import type {LegacyGraphSourceCapture} from './legacy-graph-migration.js';
/** Audited capture from an ALREADY encrypted selected source; never double-encrypts ciphertext as content. */
import {MEMORY_COPY_MAX_ROWS,MEMORY_COPY_READ_LIMIT} from './copy-limits.js';
import {all,type StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {memoryRowSurfaceManifest,type MemoryRowTable} from './row-codec.js';
import {prepareMemorySurfaceSnapshot} from './copy-source.js';
import {createMemoryRestorePackage,captureMemoryRestoreAnchor,sameMemoryRestoreAnchor} from './restore-package.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
export async function captureAuthenticatedEncryptedRestorePackage(input:{auxiliarySource?:AuxiliarySourceCapture;legacyGraphSource?:LegacyGraphSourceCapture;runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;verificationKey:Buffer;captureAuthority:()=>Promise<MemoryRestoreAuthorityLease|null>;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>}){
 const {runner,token,session,captureAuthority,recordRead}=input;let key:Buffer|undefined,verificationKey:Buffer|undefined;
 try{
  const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};
  boundary();if(!Buffer.isBuffer(input.verificationKey)||input.verificationKey.length!==32||typeof captureAuthority!=='function'||typeof recordRead!=='function')throw new MemoryCipherError();verificationKey=Buffer.from(input.verificationKey);
  const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(!lease.isCurrent()||lease.scope.ownerId!==owner.ownerId)throw new MemoryCipherError();
  const authority=await captureAuthority();boundary();if(!authority||typeof authority.isCurrent!=='function')throw new MemoryCipherError();const anchor=captureMemoryRestoreAnchor(authority.anchor),current=authority.isCurrent.bind(authority);
  if(anchor.ownerId!==lease.scope.ownerId||anchor.memberId!==lease.scope.memberId||!current())throw new MemoryCipherError();
  const check=async()=>{boundary();if(!lease.isCurrent()||!current())throw new MemoryCipherError();const fresh=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent()||!current())throw new MemoryCipherError();const head=await captureAuthority();boundary();if(!head||head.isCurrent()!==true||!sameMemoryRestoreAnchor(anchor,head.anchor)||!lease.isCurrent()||!current())throw new MemoryCipherError();};
  const audited=new Map<MemoryRowTable,string[]>();
  for(const surface of memoryRowSurfaceManifest()){
   await check();const rows=await runner.read(all<{id:string}>(`SELECT CASE WHEN length(${surface.id})<=256 THEN ${surface.id} ELSE NULL END AS id FROM ${surface.table} WHERE ${surface.owner}=? ORDER BY ${surface.id} LIMIT ${MEMORY_COPY_READ_LIMIT}`,owner.ownerId));await check();
   if(rows.length>MEMORY_COPY_MAX_ROWS||rows.some(row=>typeof row.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(row.id))||new Set(rows.map(row=>row.id)).size!==rows.length)throw new MemoryCipherError();
   const table=surface.table as MemoryRowTable,ids=rows.map(row=>row.id).sort();audited.set(table,ids);
   for(let i=0;i<ids.length;i+=500){if(await recordRead({readerKind:'user',readerId:owner.ownerId,purpose:'export',records:ids.slice(i,i+500).map(id=>({table,id}))})!==true)throw new MemoryCipherError();await check();}
  }
  const material=await lease.resolveKey({user_id:owner.ownerId});key=material.key;if(material.id!==anchor.keyId)throw new MemoryCipherError();await check();
  const snapshot=await prepareMemorySurfaceSnapshot(runner,lease.scope,key,material.id,verificationKey,{assertAudited:(table,rows)=>{
   if(!lease.isCurrent()||!current()||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();const surface=memoryRowSurfaceManifest().find(s=>s.table===table);if(!surface)throw new MemoryCipherError();const ids=rows.map(row=>String(row[surface.id])).sort();if(JSON.stringify(ids)!==JSON.stringify(audited.get(table)))throw new MemoryCipherError();
  }},input.legacyGraphSource,input.auxiliarySource);await check();return createMemoryRestorePackage(snapshot,anchor,verificationKey);
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);verificationKey?.fill(0);}
}
