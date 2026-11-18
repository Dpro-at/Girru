import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';import {randomBytes} from 'node:crypto';
import {sqliteStepsOn} from '../src/repositories/sql-steps.ts';import {sealMemoryText} from '../src/memory/encryption/envelope.ts';import {createExternalPlanCheckpointStore,loadExternalPlanCheckpointStep,listExternalPlanCheckpointIdsStep} from '../src/memory/encryption/external-plan-checkpoints.ts';
test('historical ciphertext loader/list isolate owner and reject oversized transport without decrypting',async()=>{
 const db=new Database(':memory:');try{
 const runner=sqliteStepsOn(db),store=createExternalPlanCheckpointStore(runner,'owner');await store.initialize();
 const snapshot={snapshotId:'synthetic-snapshot',ciphertext:sealMemoryText('SYNTHETIC_PRIVATE_METADATA',randomBytes(32),'synthetic-key',{ownerId:'owner',memberId:'member',recordId:'synthetic-snapshot',field:'external-reference-plan'})};
 const id=await store.append(snapshot),loaded=await runner.tx(()=>loadExternalPlanCheckpointStep('owner',id));assert.equal(loaded.ciphertext,snapshot.ciphertext);assert.deepEqual(await runner.tx(()=>listExternalPlanCheckpointIdsStep('owner')),[{id,snapshotId:snapshot.snapshotId}]);
 assert.equal(await runner.tx(()=>loadExternalPlanCheckpointStep('other-owner',id)),null);assert.deepEqual(await runner.tx(()=>listExternalPlanCheckpointIdsStep('other-owner')),[]);
 db.prepare('UPDATE memory_encryption_external_plan_checkpoints SET ciphertext=? WHERE id=?').run('x'.repeat(1400001),id);await assert.rejects(runner.tx(()=>loadExternalPlanCheckpointStep('owner',id)));
 db.prepare('UPDATE memory_encryption_external_plan_checkpoints SET snapshot_id=? WHERE id=?').run('s'.repeat(524289),id);await assert.rejects(runner.tx(()=>listExternalPlanCheckpointIdsStep('owner')));
 }finally{db.close();}
});
