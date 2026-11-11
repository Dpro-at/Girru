import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import Database from 'better-sqlite3';
import {sqliteStepsOn} from '../src/repositories/sql-steps.ts';import {memoryRowSurfaceManifest,decryptMemoryRow} from '../src/memory/encryption/row-codec.ts';import {recordEncryptedVersionStep} from '../src/memory/encryption/version-writer.ts';
const key=randomBytes(32),scope={ownerId:'history-owner',memberId:'history-member'},keyId='history-key';
function fixture(){const db=new Database(':memory:'),s=memoryRowSurfaceManifest().find(s=>s.table==='memory_versions');const fields=[s.owner,s.id,...s.bound,...s.clear,...s.text,...s.binary];db.exec('CREATE TABLE memory_versions('+fields.map(f=>f+' '+(['version','drawer_revision','importance_score'].includes(f)?'REAL':'TEXT')).join(',')+',UNIQUE(memory_id,version))');return db;}
const input={memoryId:'memory-a',userId:scope.ownerId,drawer:{kind:'owner'},change:'baseline',entry:{type:'fact',importance:5,content:'PRIVATE_HISTORY_SENTINEL'},actor:'agent:synthetic',revision:0,reason:'PRIVATE_HISTORY_REASON',snapshot:'PRIVATE_HISTORY_SNAPSHOT'};
test('baseline and update history encrypt content/reason/snapshot while preserving versions and one baseline',async()=>{
 const db=fixture();try{const runner=sqliteStepsOn(db);await runner.tx(function*(){yield* recordEncryptedVersionStep(input,scope,key,keyId,true);yield* recordEncryptedVersionStep(input,scope,key,keyId,true);yield* recordEncryptedVersionStep({...input,change:'update'},scope,key,keyId);});
 const rows=db.prepare('SELECT * FROM memory_versions ORDER BY version').all();assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.version),[1,2]);assert.ok(!db.serialize().includes(Buffer.from('PRIVATE_HISTORY_')));
 assert.equal(decryptMemoryRow('memory_versions',rows[0],scope,key,keyId).content,input.entry.content);
 }finally{db.close();}
});
test('a failed later history insert rolls back baseline and enclosing row changes',async()=>{
 const db=fixture();try{db.exec("CREATE TABLE synthetic_state(value INTEGER);INSERT INTO synthetic_state VALUES(0);CREATE TRIGGER deny_update BEFORE INSERT ON memory_versions WHEN NEW.change='update' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 const {run}=await import('../src/repositories/sql-steps.ts');await assert.rejects(sqliteStepsOn(db).tx(function*(){yield* run('UPDATE synthetic_state SET value=1');yield* recordEncryptedVersionStep(input,scope,key,keyId,true);yield* recordEncryptedVersionStep({...input,change:'update'},scope,key,keyId);}));
 assert.equal(db.prepare('SELECT count(*) n FROM memory_versions').get().n,0);assert.equal(db.prepare('SELECT value FROM synthetic_state').get().value,0);
 }finally{db.close();}
});
