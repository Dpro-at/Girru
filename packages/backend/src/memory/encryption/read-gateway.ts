/** Owner-authenticated audited declared-row reads. Not a fallback for agent permissions or arbitrary SQL. */
import type {StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {loadEncryptedOwnerRow} from './owner-row-loader.js';
import {decryptMemoryRow,type MemoryRowTable} from './row-codec.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
export async function readAuthenticatedEncryptedOwnerRow(input:{runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;table:MemoryRowTable;id:string;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>}){
 const {runner,token,session,table,id,recordRead}=input;let key:Buffer|undefined;
 // Internal transport and physical document provenance require their dedicated scoped APIs.
 if(['memory_encryption_legacy_graph','memory_encryption_auxiliary','memory_encryption_document_admissions','doc_index_files','doc_index_chunks'].includes(table))throw new MemoryCipherError();
 try{
  const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};boundary();
  const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(owner.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  const check=async()=>{boundary();const fresh=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();};
  const row=await loadEncryptedOwnerRow(runner,table,owner.ownerId,id);await check();if(!row||['memories','memory_versions','memory_file_proposals'].includes(table)&&row.drawer_kind==='agent')return null;
  if(await recordRead({readerKind:'user',readerId:owner.ownerId,purpose:'view',records:[{table,id}]})!==true)throw new MemoryCipherError();await check();
  const material=await lease.resolveKey({user_id:owner.ownerId});key=material.key;await check();const plain=decryptMemoryRow(table,row,lease.scope,key,material.id);
  const fresh=await loadEncryptedOwnerRow(runner,table,owner.ownerId,id);await check();
  const canonical=(value:Record<string,unknown>)=>JSON.stringify(Object.keys(value).sort().map(field=>[field,Buffer.isBuffer(value[field])?(value[field] as Buffer).toString('base64'):value[field]]));
  if(!fresh||canonical(fresh)!==canonical(row))throw new MemoryCipherError();return plain;
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}

/** Metadata-only owner pagination; content is opened separately with a durable read intent. */
export async function listAuthenticatedEncryptedOwnerIds(input:{runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;table:MemoryRowTable;after?:string;limit?:number;pendingOnly?:boolean}){
 const {runner,token,session,table}=input,after=input.after??'',limit=input.limit??50,pendingOnly=input.pendingOnly===true;
 try{
  const {memoryRowSurfaceManifest}=await import('./row-codec.js'),{all}=await import('../../repositories/sql-steps.js');
  const surface=memoryRowSurfaceManifest().find(s=>s.table===table);
  if(!surface||!Number.isInteger(limit)||limit<1||limit>200||typeof after!=='string'||Buffer.byteLength(after)>256||pendingOnly&&table!=='memory_file_proposals')throw new MemoryCipherError();
  const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};boundary();
  const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(owner.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  const rows=await runner.read(all<{id:string}>(`SELECT CASE WHEN length(${surface.id})<=256 THEN ${surface.id} ELSE NULL END AS id FROM ${surface.table} WHERE ${surface.owner}=? AND ${surface.id}>?${pendingOnly?" AND status='pending'":''} ORDER BY ${surface.id} LIMIT ?`,owner.ownerId,after,limit+1));boundary();
  const fresh=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent()||rows.some(row=>typeof row.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(row.id)))throw new MemoryCipherError();
  return{ids:rows.slice(0,limit).map(row=>row.id),next:rows.length>limit?rows[limit-1].id:null};
 }catch{session.lock();throw new MemoryCipherError();}
}
