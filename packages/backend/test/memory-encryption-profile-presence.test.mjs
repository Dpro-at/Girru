// Deferred actual disposable databases: digest tests do not establish native witness acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createEncryptionDriverFixture} from './fixtures/memory-encryption-drivers.mjs';
import {ownedMemorySchemaDefinitions} from '../src/memory/encryption/owned-profile-schema.ts';
import {captureProfileCipherPresenceStep} from '../src/memory/encryption/profile-presence.ts';
import {run} from '../src/repositories/sql-steps.ts';
async function fixture(t,driver){
 const db=await createEncryptionDriverFixture({driver,name:'profile-presence'});t.after(()=>db.close());
 for(const surface of ownedMemorySchemaDefinitions())await db.exec(`CREATE TABLE ${surface.table}(${surface.columns.map(column=>column.name+' '+(column.type==='BLOB'&&driver==='postgres'?'BYTEA':column.type)+(column.primary?' PRIMARY KEY':'')).join(',')})`);
 const surface=ownedMemorySchemaDefinitions().find(surface=>surface.table==='memories'),row=Object.fromEntries(surface.fields.map(field=>[field,null]));Object.assign(row,{id:'synthetic-memory',user_id:'synthetic-owner',content:'synthetic-ciphertext-placeholder',last_accessed_at:0,access_count:0});
 await db.runner.tx(function*(){yield* run(`INSERT INTO memories(${surface.fields.join(',')}) VALUES(${surface.fields.map(()=>'?').join(',')})`,...surface.fields.map(field=>row[field]));});
 return{db,capture:()=>db.runner.tx(()=>captureProfileCipherPresenceStep('synthetic-owner'),{immediate:true})};
}
for(const driver of ['sqlite','postgres']){
 test(driver+': whole twenty-table digest detects deletion and ciphertext changes',async t=>{const f=await fixture(t,driver),before=await f.capture();assert.equal(before.tables.length,20);await f.db.exec("UPDATE memories SET content='different synthetic ciphertext'");const changed=await f.capture();assert.notEqual(changed.sha256,before.sha256);await f.db.exec('DELETE FROM memories');const removed=await f.capture();assert.notEqual(removed.sha256,changed.sha256);assert.equal(removed.tables.find(table=>table.table==='memories').count,0);});
 test(driver+': permitted clear counters do not change authenticated presence',async t=>{const f=await fixture(t,driver),before=await f.capture();await f.db.exec('UPDATE memories SET last_accessed_at=99,access_count=12');assert.equal((await f.capture()).sha256,before.sha256);});
 test(driver+': unexpected schema and foreign owner rows refuse presence claims',async t=>{const f=await fixture(t,driver);await f.db.exec("UPDATE memories SET user_id='another-owner'");await assert.rejects(()=>f.capture());await f.db.exec("UPDATE memories SET user_id='synthetic-owner'");await f.db.exec('ALTER TABLE memories ADD COLUMN unknown_payload TEXT');await assert.rejects(()=>f.capture());});
 test(driver+': oversized ciphertext refuses the bounded capture',async t=>{const f=await fixture(t,driver);await f.db.runner.tx(function*(){yield* run('UPDATE memories SET content=?','x'.repeat(8*1024*1024+1));});await assert.rejects(()=>f.capture());});
}
