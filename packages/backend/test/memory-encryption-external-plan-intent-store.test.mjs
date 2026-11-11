import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';
import {sqliteStepsOn} from '../src/repositories/sql-steps.ts';import {createExternalPlanIntentStore} from '../src/memory/encryption/external-plan-intent-store.ts';
const intent={ownerId:'synthetic-owner',snapshotId:'synthetic-plan',purpose:'external-forget-plan',referenceCount:3,holdCount:1};
test('intent acknowledgement follows committed identifier-only row; schema refuses paths and other owners',async()=>{
 const db=new Database(':memory:');try{
 const runner=sqliteStepsOn(db),store=createExternalPlanIntentStore(runner,intent.ownerId);await store.initialize();assert.equal(await store.append(intent),true);
 const row=db.prepare('SELECT * FROM memory_encryption_external_plan_intents').get();assert.equal(row.snapshot_id,intent.snapshotId);assert.equal(row.reference_count,3);assert.deepEqual(Object.keys(row).sort(),['created_at','hold_count','id','owner_id','purpose','reference_count','snapshot_id']);
 await assert.rejects(store.append({...intent,path:'/private/not-for-audit'}));await assert.rejects(store.append({...intent,ownerId:'other'}));
 db.exec("CREATE TRIGGER refuse_intent AFTER INSERT ON memory_encryption_external_plan_intents BEGIN SELECT RAISE(ABORT,'synthetic commit refusal'); END");await assert.rejects(store.append(intent));assert.equal(db.prepare('SELECT count(*) n FROM memory_encryption_external_plan_intents').get().n,1);
 }finally{db.close();}
});
test('intent store rejects enclosing transactions rather than acknowledging uncommitted audit',async()=>{
 const db=new Database(':memory:');try{const store=createExternalPlanIntentStore(sqliteStepsOn(db),intent.ownerId);await store.initialize();db.exec('BEGIN');await assert.rejects(store.append(intent));db.exec('ROLLBACK');assert.equal(db.prepare('SELECT count(*) n FROM memory_encryption_external_plan_intents').get().n,0);}finally{db.close();}
});
