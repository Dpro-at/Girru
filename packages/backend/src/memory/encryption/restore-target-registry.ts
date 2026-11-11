/** Exact runner-to-quarantine authority supplied by trusted host; never derives a target from request paths. */
import type {StepRunner} from '../../repositories/sql-steps.js';
import type {MemoryRestoreTargetLease} from './restore-guard.js';
import {MemoryCipherError} from './envelope.js';
export function createMemoryRestoreTargetRegistry(input:{reservedRunners?:readonly StepRunner[];reservedStorageIds?:readonly string[];sourceRunner:StepRunner;journalRunner:StepRunner;sourceStorageId:string;journalStorageId:string;targets:readonly {runner:StepRunner;targetId:string;captureQuarantine:()=>Promise<{storageId:string;quarantined:true;isCurrent:()=>boolean}|null>}[]}){
 const {sourceStorageId,journalStorageId}=input;
 const entries=input.targets.map(entry=>({...entry})),reservedRunners=new Set(input.reservedRunners??[]),reservedStorageIds=new Set(input.reservedStorageIds??[]);
 if(!sourceStorageId||!journalStorageId||sourceStorageId===journalStorageId||entries.length>16||new Set(entries.map(entry=>entry.runner)).size!==entries.length||new Set(entries.map(entry=>entry.targetId)).size!==entries.length||entries.some(entry=>reservedRunners.has(entry.runner)||entry.runner===input.sourceRunner||entry.runner===input.journalRunner||typeof entry.targetId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(entry.targetId)||typeof entry.captureQuarantine!=='function'))throw new MemoryCipherError();
 let closed=false;const captures=new Set<string>(),revoked=new Set<string>(),storageOwners=new Map<string,string>(),targetStorage=new Map<string,string>();
 return Object.freeze({
  async authorize(runner:StepRunner):Promise<MemoryRestoreTargetLease|null>{
   if(closed||runner.inTransaction?.()!==false)return null;const selected=entries.find(entry=>entry.runner===runner);if(!selected)return null;
   const captured=await selected.captureQuarantine();if(closed||!captured||captured.quarantined!==true||typeof captured.storageId!=='string'||!captured.storageId||reservedStorageIds.has(captured.storageId)||captured.storageId===sourceStorageId||captured.storageId===journalStorageId||revoked.has(captured.storageId)||typeof captured.isCurrent!=='function'||!captured.isCurrent())return null;
   // storageId comes from a host physical-identity proof, not a second connection object's identity.
   const current=captured.isCurrent.bind(captured),storageId=captured.storageId;if(targetStorage.has(selected.targetId)&&targetStorage.get(selected.targetId)!==storageId)return null;targetStorage.set(selected.targetId,storageId);if(storageOwners.has(storageId)&&storageOwners.get(storageId)!==selected.targetId)return null;storageOwners.set(storageId,selected.targetId);captures.add(storageId);
   return Object.freeze({targetId:selected.targetId,storageId,isCurrent:()=>!closed&&captures.has(storageId)&&current()});
  },
  revokeStorage(storageId:string){revoked.add(storageId);captures.delete(storageId);},
  close(){closed=true;captures.clear();storageOwners.clear();targetStorage.clear();},
 });
}
