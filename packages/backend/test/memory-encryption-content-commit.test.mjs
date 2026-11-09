import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import Database from 'better-sqlite3';
import {sqliteStepsOn} from '../src/repositories/sql-steps.ts';import {memoryRowSurfaceManifest,encryptMemoryRow,decryptMemoryRow} from '../src/memory/encryption/row-codec.ts';import {prepareEncryptedContentUpdate} from '../src/memory/encryption/content-update.ts';import {commitEncryptedContentStep} from '../src/memory/encryption/content-commit.ts';
const scope={ownerId:'commit-owner',memberId:'commit-member'},key=randomBytes(32),keyId='commit-key';
function fixture(topic=null){const db=new Database(':memory:');for(const s of memoryRowSurfaceManifest().filter(s=>['memories','memory_versions'].includes(s.table))){const fields=[s.owner,s.id,...s.bound,...s.clear,...s.text,...s.binary];db.exec('CREATE TABLE '+s.table+'('+fields.map(f=>f+' '+(s.binary.includes(f)?'BLOB':['importance_score','version','drawer_revision','access_count','last_accessed_at'].includes(f)?'REAL':'TEXT')).join(',')+')');}
 const s=memoryRowSurfaceManifest().find(s=>s.table==='memories'),plain=Object.fromEntries([[s.owner,scope.ownerId],[s.id,'commit-a'],...s.bound.map(f=>[f,null]),...s.clear.map(f=>[f,0]),...s.text.map(f=>[f,null]),...s.binary.map(f=>[f,null])]);Object.assign(plain,{type:'fact',content:'old private content',drawer_kind:'owner',drawer_key:'',status:'active',importance_score:0.5,topic_key:topic});
 const expected=encryptMemoryRow('memories',plain,scope,key,keyId),fields=Object.keys(expected);db.prepare('INSERT INTO memories('+fields.join(',')+') VALUES('+fields.map(()=>'?').join(',')+')').run(...fields.map(f=>expected[f]));
 const replacement=prepareEncryptedContentUpdate(expected,{content:'new private content',embedding:null,embedding_vec:null,embedding_model:null,embedding_dims:null},scope,key,keyId,()=>true);return{db,expected,replacement};}
test('content CAS and encrypted baseline/update history commit together; stale edits are refused',async()=>{
 const {db,expected,replacement}=fixture();try{const runner=sqliteStepsOn(db);await runner.tx(()=>commitEncryptedContentStep(expected,replacement,scope,key,keyId,'agent:synthetic'));
 assert.equal(decryptMemoryRow('memories',db.prepare('SELECT * FROM memories').get(),scope,key,keyId).content,'new private content');assert.equal(db.prepare('SELECT count(*) n FROM memory_versions').get().n,2);
 await assert.rejects(runner.tx(()=>commitEncryptedContentStep(expected,replacement,scope,key,keyId,'agent:synthetic')));assert.equal(db.prepare('SELECT count(*) n FROM memory_versions').get().n,2);
 }finally{db.close();}
});
test('history failure restores the original ciphertext and removes the new baseline',async()=>{
 const {db,expected,replacement}=fixture();try{db.exec("CREATE TRIGGER deny_update BEFORE INSERT ON memory_versions WHEN NEW.change='update' BEGIN SELECT RAISE(ABORT,'synthetic'); END");await assert.rejects(sqliteStepsOn(db).tx(()=>commitEncryptedContentStep(expected,replacement,scope,key,keyId,'agent:synthetic')));assert.deepEqual(db.prepare('SELECT * FROM memories').get(),expected);assert.equal(db.prepare('SELECT count(*) n FROM memory_versions').get().n,0);
 }finally{db.close();}
});

const {initializeEncryptedTopicIndexStep,syncEncryptedTopicIndexStep}=await import('../src/memory/encryption/topic-index.ts');
test('indexed content edit preserves its claim and refuses missing or corrupted claims atomically',async()=>{
 for(const mode of ['valid','missing','trigger']){
  const {db,expected,replacement}=fixture('synthetic-topic'),lookup=randomBytes(32),runner=sqliteStepsOn(db);try{
   await runner.tx(initializeEncryptedTopicIndexStep);await runner.tx(()=>syncEncryptedTopicIndexStep(decryptMemoryRow('memories',expected,scope,key,keyId),lookup));
   const claim=db.prepare('SELECT * FROM memory_encryption_topics').get();
   if(mode==='missing')db.exec('DELETE FROM memory_encryption_topics');
   if(mode==='trigger')db.exec("CREATE TRIGGER corrupt_claim AFTER INSERT ON memory_versions WHEN NEW.change='update' BEGIN UPDATE memory_encryption_topics SET topic_token='forged'; END");
   const commit=()=>runner.tx(()=>commitEncryptedContentStep(expected,replacement,scope,key,keyId,'agent:synthetic',lookup));
   if(mode==='valid'){await commit();assert.deepEqual(db.prepare('SELECT * FROM memory_encryption_topics').get(),claim);}
   else{await assert.rejects(commit());assert.deepEqual(db.prepare('SELECT * FROM memories').get(),expected);assert.equal(db.prepare('SELECT count(*) n FROM memory_versions').get().n,0);if(mode==='trigger')assert.deepEqual(db.prepare('SELECT * FROM memory_encryption_topics').get(),claim);}
  }finally{db.close();}
 }
});
const {prepareEncryptedDrawerMove}=await import('../src/memory/encryption/drawer-move.ts');
test('drawer move reseals policy metadata, relocates topic claim and records both source and target history',async()=>{
 const {db,expected}=fixture('move-topic'),lookup=randomBytes(32),runner=sqliteStepsOn(db),target={kind:'project',key:'destination'};try{
  await runner.tx(initializeEncryptedTopicIndexStep);await runner.tx(()=>syncEncryptedTopicIndexStep(decryptMemoryRow('memories',expected,scope,key,keyId),lookup));
  assert.throws(()=>prepareEncryptedDrawerMove(expected,target,scope,key,keyId,()=>true,()=>false));
  assert.throws(()=>prepareEncryptedDrawerMove(expected,target,scope,key,keyId,()=>false,()=>true));
  const moved=prepareEncryptedDrawerMove(expected,target,scope,key,keyId,()=>true,r=>r.drawer_key==='destination');
  assert.throws(()=>decryptMemoryRow('memories',{...expected,drawer_kind:'project',drawer_key:'destination'},scope,key,keyId));
  await runner.tx(()=>commitEncryptedContentStep(expected,moved,scope,key,keyId,'agent:synthetic',lookup,target));
  assert.equal(decryptMemoryRow('memories',db.prepare('SELECT * FROM memories').get(),scope,key,keyId).drawer_key,'destination');assert.equal(db.prepare('SELECT drawer_key FROM memory_encryption_topics').get().drawer_key,'destination');
  assert.deepEqual(db.prepare('SELECT drawer_kind,drawer_key FROM memory_versions ORDER BY version').all(),[{drawer_kind:'owner',drawer_key:''},{drawer_kind:'project',drawer_key:'destination'}]);
 }finally{db.close();}
});
test('conflicting destination topic rolls back move, source claim and history',async()=>{
 const {db,expected}=fixture('move-topic'),lookup=randomBytes(32),runner=sqliteStepsOn(db),target={kind:'project',key:'destination'};try{
  await runner.tx(initializeEncryptedTopicIndexStep);const plain=decryptMemoryRow('memories',expected,scope,key,keyId);await runner.tx(()=>syncEncryptedTopicIndexStep(plain,lookup));await runner.tx(()=>syncEncryptedTopicIndexStep({...plain,id:'existing-destination',drawer_kind:'project',drawer_key:'destination'},lookup));
  const moved=prepareEncryptedDrawerMove(expected,target,scope,key,keyId,()=>true,()=>true);
  await assert.rejects(runner.tx(()=>commitEncryptedContentStep(expected,moved,scope,key,keyId,'agent:synthetic',lookup,target)));
  assert.deepEqual(db.prepare('SELECT * FROM memories').get(),expected);assert.equal(db.prepare('SELECT count(*) n FROM memory_versions').get().n,0);assert.equal(db.prepare("SELECT drawer_kind FROM memory_encryption_topics WHERE memory_id='commit-a'").get().drawer_kind,'owner');
 }finally{db.close();}
});
const {commitEncryptedSupersessionStep}=await import('../src/memory/encryption/supersession-commit.ts');
test('supersession persists new record, old authenticated replacement metadata, topic transfer and history together',async()=>{
 const {db,expected}=fixture('replace-topic'),lookup=randomBytes(32),runner=sqliteStepsOn(db);try{
  const old=decryptMemoryRow('memories',expected,scope,key,keyId),next=encryptMemoryRow('memories',{...old,id:'newer',content:'replacement content'},scope,key,keyId);
  await runner.tx(initializeEncryptedTopicIndexStep);await runner.tx(()=>syncEncryptedTopicIndexStep(old,lookup));
  await runner.tx(()=>commitEncryptedSupersessionStep(expected,next,scope,key,keyId,lookup,'agent:synthetic'));
  const replaced=decryptMemoryRow('memories',db.prepare("SELECT * FROM memories WHERE id='commit-a'").get(),scope,key,keyId);assert.equal(replaced.status,'replaced');assert.equal(replaced.superseded_by,'newer');assert.equal(replaced.content,old.content);
  assert.equal(decryptMemoryRow('memories',db.prepare("SELECT * FROM memories WHERE id='newer'").get(),scope,key,keyId).content,'replacement content');assert.equal(db.prepare('SELECT memory_id FROM memory_encryption_topics').get().memory_id,'newer');assert.equal(db.prepare('SELECT count(*) n FROM memory_versions').get().n,2);
  await assert.rejects(runner.tx(()=>commitEncryptedSupersessionStep(expected,next,scope,key,keyId,lookup,'agent:synthetic')));
 }finally{db.close();}
});
test('new-row or create-history failure restores old ciphertext, old topic claim and all history',async()=>{
 for(const failHistory of [false,true]){const {db,expected}=fixture('replace-topic'),lookup=randomBytes(32),runner=sqliteStepsOn(db);try{
  const old=decryptMemoryRow('memories',expected,scope,key,keyId),next=encryptMemoryRow('memories',{...old,id:'newer',content:'replacement content'},scope,key,keyId);
  await runner.tx(initializeEncryptedTopicIndexStep);await runner.tx(()=>syncEncryptedTopicIndexStep(old,lookup));
  db.exec(failHistory?"CREATE TRIGGER fail_new BEFORE INSERT ON memory_versions WHEN NEW.memory_id='newer' BEGIN SELECT RAISE(ABORT,'synthetic'); END":"CREATE TRIGGER fail_new BEFORE INSERT ON memories WHEN NEW.id='newer' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  await assert.rejects(runner.tx(()=>commitEncryptedSupersessionStep(expected,next,scope,key,keyId,lookup,'agent:synthetic')));
  assert.deepEqual(db.prepare('SELECT * FROM memories').get(),expected);assert.equal(db.prepare('SELECT count(*) n FROM memories').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM memory_versions').get().n,0);assert.equal(db.prepare('SELECT memory_id FROM memory_encryption_topics').get().memory_id,'commit-a');
 }finally{db.close();}}
});

const {deleteEncryptedMemoryToTrashStep}=await import('../src/memory/encryption/trash-delete.ts');
const {prepareEncryptedTrashRestore}=await import('../src/memory/encryption/trash-snapshot.ts');
test('encrypted Trash delete atomically removes live row/claim and stores restorable encrypted snapshot',async()=>{
 const {db,expected}=fixture('trash-topic'),lookup=randomBytes(32),runner=sqliteStepsOn(db);try{
 await runner.tx(initializeEncryptedTopicIndexStep);await runner.tx(()=>syncEncryptedTopicIndexStep(decryptMemoryRow('memories',expected,scope,key,keyId),lookup));
 const id=await runner.tx(()=>deleteEncryptedMemoryToTrashStep(expected,scope,key,keyId,lookup,'owner:synthetic','trash',()=>true));
 assert.equal(db.prepare('SELECT count(*) n FROM memories').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM memory_encryption_topics').get().n,0);
 const history=db.prepare('SELECT * FROM memory_versions WHERE id=?').get(id);assert.ok(!history.snapshot.includes('old private content'));
 const snapshot=decryptMemoryRow('memory_versions',history,scope,key,keyId).snapshot;assert.deepEqual(decryptMemoryRow('memories',prepareEncryptedTrashRestore(snapshot,'commit-a',scope,key,keyId,()=>true),scope,key,keyId),decryptMemoryRow('memories',expected,scope,key,keyId));
 await assert.rejects(runner.tx(()=>deleteEncryptedMemoryToTrashStep(expected,scope,key,keyId,lookup,'owner:synthetic','trash',()=>true)));
 }finally{db.close();}
});
test('late delete-history failure rolls back live ciphertext, topic claim and baseline',async()=>{
 const {db,expected}=fixture('trash-failure'),lookup=randomBytes(32),runner=sqliteStepsOn(db);try{
 await runner.tx(initializeEncryptedTopicIndexStep);await runner.tx(()=>syncEncryptedTopicIndexStep(decryptMemoryRow('memories',expected,scope,key,keyId),lookup));const claim=db.prepare('SELECT * FROM memory_encryption_topics').get();
 db.exec("CREATE TRIGGER fail_trash BEFORE INSERT ON memory_versions WHEN NEW.change='delete' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 await assert.rejects(runner.tx(()=>deleteEncryptedMemoryToTrashStep(expected,scope,key,keyId,lookup,'owner:synthetic','trash',()=>true)));
 assert.deepEqual(db.prepare('SELECT * FROM memories').get(),expected);assert.deepEqual(db.prepare('SELECT * FROM memory_encryption_topics').get(),claim);assert.equal(db.prepare('SELECT count(*) n FROM memory_versions').get().n,0);
 }finally{db.close();}
});
const {restoreEncryptedMemoryFromTrashStep}=await import('../src/memory/encryption/trash-restore.ts');
test('strict Trash restore preserves same identity and rejects replay; topic conflict rolls back',async()=>{
 for(const conflict of [false,true]){const {db,expected}=fixture('restore-topic'),lookup=randomBytes(32),runner=sqliteStepsOn(db);try{
 await runner.tx(initializeEncryptedTopicIndexStep);const plain=decryptMemoryRow('memories',expected,scope,key,keyId);await runner.tx(()=>syncEncryptedTopicIndexStep(plain,lookup));
 const deletedId=await runner.tx(()=>deleteEncryptedMemoryToTrashStep(expected,scope,key,keyId,lookup,'owner:synthetic','trash',()=>true)),history=db.prepare('SELECT * FROM memory_versions WHERE id=?').get(deletedId);
 if(conflict)await runner.tx(()=>syncEncryptedTopicIndexStep({...plain,id:'occupied'},lookup));
 const restore=()=>runner.tx(()=>restoreEncryptedMemoryFromTrashStep(history,scope,key,keyId,lookup,'owner:synthetic',()=>true));
 if(conflict){await assert.rejects(restore());assert.equal(db.prepare('SELECT count(*) n FROM memories').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM memory_versions').get().n,2);}
 else{assert.equal(await restore(),'commit-a');assert.deepEqual(decryptMemoryRow('memories',db.prepare('SELECT * FROM memories').get(),scope,key,keyId),plain);await assert.rejects(restore());assert.equal(db.prepare('SELECT count(*) n FROM memory_versions').get().n,3);}
 }finally{db.close();}}
});
test('restore create-history failure leaves delete history, absent live row and absent topic claim intact',async()=>{
 const {db,expected}=fixture('restore-failure'),lookup=randomBytes(32),runner=sqliteStepsOn(db);try{
 await runner.tx(initializeEncryptedTopicIndexStep);await runner.tx(()=>syncEncryptedTopicIndexStep(decryptMemoryRow('memories',expected,scope,key,keyId),lookup));
 const id=await runner.tx(()=>deleteEncryptedMemoryToTrashStep(expected,scope,key,keyId,lookup,'owner:synthetic','trash',()=>true)),history=db.prepare('SELECT * FROM memory_versions WHERE id=?').get(id);
 db.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON memory_versions WHEN NEW.change='create' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 await assert.rejects(runner.tx(()=>restoreEncryptedMemoryFromTrashStep(history,scope,key,keyId,lookup,'owner:synthetic',()=>true)));
 assert.equal(db.prepare('SELECT count(*) n FROM memories').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM memory_encryption_topics').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM memory_versions').get().n,2);assert.deepEqual(db.prepare('SELECT * FROM memory_versions WHERE id=?').get(id),history);
 }finally{db.close();}
});
