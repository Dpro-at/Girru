// Deferred until final whole-task verification; synthetic runner identities only.
import test from 'node:test';import assert from 'node:assert/strict';
import {createMemoryRestoreTargetRegistry} from '../src/memory/encryption/restore-target-registry.ts';
const runner=()=>({inTransaction:()=>false});
test('quarantine registry rejects physical source aliases and preserves target revocation',async()=>{
 const source=runner(),journal=runner(),target=runner();let storage='source-storage',live=true;
 const registry=createMemoryRestoreTargetRegistry({sourceRunner:source,journalRunner:journal,sourceStorageId:'source-storage',journalStorageId:'journal-storage',targets:[{runner:target,targetId:'synthetic-target',captureQuarantine:async()=>({storageId:storage,quarantined:true,isCurrent:()=>live})}]});
 assert.equal(await registry.authorize(source),null);assert.equal(await registry.authorize(target),null);storage='target-storage';const lease=await registry.authorize(target);assert.equal(lease.isCurrent(),true);registry.revokeStorage(storage);assert.equal(lease.isCurrent(),false);assert.equal(await registry.authorize(target),null);live=false;registry.close();
});
test('quarantine identity cannot change behind a registered target',async()=>{
 const source=runner(),journal=runner(),target=runner();let storage='target-storage-a';
 const registry=createMemoryRestoreTargetRegistry({sourceRunner:source,journalRunner:journal,sourceStorageId:'source-storage',journalStorageId:'journal-storage',targets:[{runner:target,targetId:'synthetic-target',captureQuarantine:async()=>({storageId:storage,quarantined:true,isCurrent:()=>true})}]});
 assert.ok(await registry.authorize(target));storage='target-storage-b';assert.equal(await registry.authorize(target),null);registry.close();
});
