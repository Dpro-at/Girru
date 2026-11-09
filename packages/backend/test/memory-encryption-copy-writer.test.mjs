import {MEMORY_COPY_MAX_ROWS,MEMORY_COPY_MAX_SOURCE_BYTES} from '../src/memory/encryption/copy-limits.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import Database from 'better-sqlite3';
import {sqliteStepsOn} from '../src/repositories/sql-steps.ts';
import {memoryRowSurfaceManifest} from '../src/memory/encryption/row-codec.ts';
import {prepareMemoryCopyBatch,verifyMemoryCopyBatch} from '../src/memory/encryption/copy-batch.ts';
import {writeMemoryBatchToEmptyCopy} from '../src/memory/encryption/copy-writer.ts';
import {MemoryCipherError} from '../src/memory/encryption/envelope.ts';
const scope={ownerId:'copy-owner',memberId:'copy-member'},key=randomBytes(32),receiptKey=randomBytes(32),keyId='copy-key';
function fixture(){
 const db=new Database(':memory:'),s=memoryRowSurfaceManifest().find(s=>s.table==='memories');
 const row=Object.fromEntries([[s.owner,scope.ownerId],[s.id,'record-a'],...s.bound.map(f=>[f,null]),...s.clear.map(f=>[f,0]),...s.text.map(f=>[f,f==='content'?'PRIVATE_COPY_CONTENT':null]),...s.binary.map(f=>[f,null])]);
 const fields=Object.keys(row);db.exec('CREATE TABLE memories('+fields.map(f=>f+' '+(s.clear.includes(f)?'INTEGER':s.binary.includes(f)?'BLOB':'TEXT')).join(',')+')');
 return {db,batch:prepareMemoryCopyBatch('memories',[row],scope,key,keyId,receiptKey)};
}
test('shared-step writer accepts an empty exact-schema target and refuses a second write without modifying it',async()=>{
 const {db,batch}=fixture();try{
  await writeMemoryBatchToEmptyCopy(sqliteStepsOn(db),batch,scope,key,keyId,receiptKey);
  const before=db.prepare('SELECT * FROM memories').all();verifyMemoryCopyBatch(batch,before,scope,key,keyId,receiptKey);
  await assert.rejects(writeMemoryBatchToEmptyCopy(sqliteStepsOn(db),batch,scope,key,keyId,receiptKey),MemoryCipherError);
  assert.deepEqual(db.prepare('SELECT * FROM memories').all(),before);
 }finally{db.close();}
});
test('schema drift and trigger corruption refuse the copy; failed readback rolls back all inserts',async()=>{
 for(const setup of ['ALTER TABLE memories ADD COLUMN future TEXT','ALTER TABLE memories ADD COLUMN computed TEXT GENERATED ALWAYS AS (content) VIRTUAL',"CREATE TRIGGER corrupt AFTER INSERT ON memories BEGIN UPDATE memories SET content='corrupted'; END"]){
  const {db,batch}=fixture();try{
   db.exec(setup);await assert.rejects(writeMemoryBatchToEmptyCopy(sqliteStepsOn(db),batch,scope,key,keyId,receiptKey),MemoryCipherError);
   assert.equal(db.prepare('SELECT count(*) n FROM memories').get().n,0);
  }finally{db.close();}
 }
});
test('async transaction boundary snapshots ciphertext, scope and caller-owned keys',async()=>{
 const {db,batch}=fixture(),sourceKey=Buffer.from(key),sourceReceipt=Buffer.from(receiptKey),sourceScope={...scope};
 const actual=sqliteStepsOn(db),runner={...actual,async tx(body,opts){await Promise.resolve();return actual.tx(body,opts);}};
 try{
  const pending=writeMemoryBatchToEmptyCopy(runner,batch,sourceScope,sourceKey,keyId,sourceReceipt);
  batch.rows[0].content='replacement';sourceScope.ownerId='other';sourceKey.fill(0);sourceReceipt.fill(0);
  await pending;assert.notEqual(db.prepare('SELECT content FROM memories').get().content,'replacement');
 }finally{db.close();}
});

const {writeMemorySurfaceSetToEmptyCopy}=await import('../src/memory/encryption/copy-writer.ts');
function surfaceFixture(){
 const db=new Database(':memory:'),batches=[];
 db.exec(`
CREATE TABLE memory_import_previews(batch_id TEXT,version INTEGER,parent_version INTEGER,content_hash TEXT,files TEXT,items TEXT,summary TEXT,created_by TEXT,created_at TEXT,PRIMARY KEY(batch_id,version));
CREATE TABLE memory_quality_history(id TEXT PRIMARY KEY,memory_id TEXT,old_quality_score REAL,new_quality_score REAL,improvement_type TEXT,changes_made TEXT,created_at TEXT);
CREATE TABLE memory_enrichment_log(id TEXT PRIMARY KEY,memory_id TEXT,enrichment_type TEXT,before_value TEXT,after_value TEXT,confidence REAL,created_at TEXT);
CREATE TABLE memory_trust(memory_id TEXT PRIMARY KEY,user_id TEXT,source TEXT,content_hash TEXT,confidence REAL,verified INTEGER,use_weight REAL,uses INTEGER,last_used_at TEXT,flags TEXT,enrich_state TEXT,created_at TEXT,updated_at TEXT);
CREATE TABLE memory_trust_sources(memory_id TEXT,user_id TEXT,source_key TEXT,kind TEXT,content_hash TEXT,at TEXT,PRIMARY KEY(memory_id,source_key));
CREATE TABLE memory_recall_uses(run_id TEXT,memory_id TEXT,user_id TEXT,agent_id TEXT,created_at TEXT,PRIMARY KEY(run_id,memory_id));
`);
 for(const s of memoryRowSurfaceManifest()){
  const row=Object.fromEntries([[s.owner,scope.ownerId],[s.id,'surface-a'],...s.bound.map(f=>[f,null]),...s.clear.map(f=>[f,0]),...s.text.map(f=>[f,'SYNTHETIC_GROUP_CONTENT']),...s.binary.map(f=>[f,Buffer.from([1,2,3])])]);
  db.exec('CREATE TABLE '+s.table+'('+Object.keys(row).map(f=>f+' '+(s.binary.includes(f)?'BLOB':s.clear.includes(f)?'INTEGER':'TEXT')).join(',')+')');
  batches.push(prepareMemoryCopyBatch(s.table,[row],scope,key,keyId,receiptKey));
 }
 return {db,batches};
}
test('current declared-surface copy is atomic and refuses omitted or duplicate table batches',async()=>{
 const {db,batches}=surfaceFixture();try{
  for(const input of [batches.slice(1),[...batches.slice(1),batches[1]]])await assert.rejects(writeMemorySurfaceSetToEmptyCopy(sqliteStepsOn(db),input,scope,key,keyId,receiptKey),MemoryCipherError);
  await writeMemorySurfaceSetToEmptyCopy(sqliteStepsOn(db),batches,scope,key,keyId,receiptKey);
  for(const b of batches)verifyMemoryCopyBatch(b,db.prepare('SELECT * FROM '+b.table).all(),scope,key,keyId,receiptKey);
 }finally{db.close();}
});
test('late-table failure and cross-table corruption roll back every copied surface',async()=>{
 for(const target of ['memory_weekly_summaries','agent_handoffs']){
  const {db,batches}=surfaceFixture();try{
   const field=target==='agent_handoffs'?'done':'text';
   db.exec(`CREATE TRIGGER corrupt_group AFTER INSERT ON memory_weekly_summaries BEGIN UPDATE ${target} SET ${field}='corrupted'; END`);
   await assert.rejects(writeMemorySurfaceSetToEmptyCopy(sqliteStepsOn(db),batches,scope,key,keyId,receiptKey),MemoryCipherError);
   for(const b of batches)assert.equal(db.prepare('SELECT count(*) n FROM '+b.table).get().n,0);
  }finally{db.close();}
 }
});

const {prepareMemorySurfaceSnapshot}=await import('../src/memory/encryption/copy-source.ts');
test('source snapshot covers every declared owner surface, excludes other owners and preserves the source',async()=>{
 const {db,batches}=surfaceFixture();try{
  const s=memoryRowSurfaceManifest().find(s=>s.table==='memories');
  const row=Object.fromEntries([[s.owner,scope.ownerId],[s.id,'source-a'],...s.bound.map(f=>[f,null]),...s.clear.map(f=>[f,0]),...s.text.map(f=>[f,'SYNTHETIC_SOURCE']),...s.binary.map(f=>[f,null])]);
  const fields=Object.keys(row),insert=db.prepare('INSERT INTO memories('+fields.join(',')+') VALUES('+fields.map(()=>'?').join(',')+')');
  insert.run(...fields.map(f=>row[f]));insert.run(...fields.map(f=>f==='id'?'other-a':f==='user_id'?'other-owner':row[f]));
  const before=db.prepare('SELECT * FROM memories ORDER BY id').all();
  const snapshot=await prepareMemorySurfaceSnapshot(sqliteStepsOn(db),scope,key,keyId,receiptKey);
  assert.equal(snapshot.version,5);assert.equal(snapshot.coverage,'owner-twenty-declared-surfaces-only');assert.equal(snapshot.activationReady,false);assert.equal(snapshot.batches.length,20);
  assert.equal(snapshot.batches.find(b=>b.table==='memories').rows.length,1);
  assert.deepEqual(db.prepare('SELECT * FROM memories ORDER BY id').all(),before);
  assert.ok(!JSON.stringify(snapshot).includes('SYNTHETIC_SOURCE'));
  db.exec('ALTER TABLE memory_versions ADD COLUMN unknown TEXT');
  await assert.rejects(prepareMemorySurfaceSnapshot(sqliteStepsOn(db),scope,key,keyId,receiptKey),MemoryCipherError);
 }finally{db.close();}
});
test('source snapshot refuses oversized sources rather than returning a truncated batch',async()=>{
 const {db}=surfaceFixture();try{
  db.prepare('INSERT INTO memories(id,user_id,content) VALUES(?,?,?)').run('oversized',scope.ownerId,'x'.repeat(MEMORY_COPY_MAX_SOURCE_BYTES+1));
  await assert.rejects(prepareMemorySurfaceSnapshot(sqliteStepsOn(db),scope,key,keyId,receiptKey),MemoryCipherError);
  assert.equal(db.prepare('SELECT count(*) n FROM memories').get().n,1);
  db.exec('DELETE FROM memories');
  const insert=db.prepare('INSERT INTO memories(id,user_id,content) VALUES(?,?,?)');
  db.transaction(()=>{for(let i=0;i<MEMORY_COPY_MAX_ROWS+1;i++)insert.run('row-'+i,scope.ownerId,'small');})();
  await assert.rejects(prepareMemorySurfaceSnapshot(sqliteStepsOn(db),scope,key,keyId,receiptKey),MemoryCipherError);
  assert.equal(db.prepare('SELECT count(*) n FROM memories').get().n,MEMORY_COPY_MAX_ROWS+1);
 }finally{db.close();}
});
test('SQLite NUL-containing text cannot bypass the pre-transfer source byte limit',async()=>{
 const {db}=surfaceFixture();let transferred=false;try{
  db.prepare('INSERT INTO memories(id,user_id,content) VALUES(?,?,?)').run('nul-source',scope.ownerId,'\0'+'x'.repeat(MEMORY_COPY_MAX_SOURCE_BYTES+1));
  const base=sqliteStepsOn(db),runner={...base,tx(body,opts){return base.tx(function*(){
   const step=body();let next=step.next();
   while(!next.done){if(next.value.kind==='all'&&/^SELECT \* FROM memories WHERE/.test(next.value.sql))transferred=true;const value=yield next.value;next=step.next(value);}return next.value;
  },opts);}};
  await assert.rejects(prepareMemorySurfaceSnapshot(runner,scope,key,keyId,receiptKey),MemoryCipherError);
  assert.equal(transferred,false,'oversized source must be rejected before SELECT * transfers plaintext');
 }finally{db.close();}
});
const {sealMemorySurfaceSnapshot,verifyMemorySurfaceSnapshot}=await import('../src/memory/encryption/copy-manifest.ts');
const {writeMemorySnapshotToEmptyCopy}=await import('../src/memory/encryption/copy-writer.ts');
test('snapshot manifest rejects mixing independently valid batches, omissions, forged state and another snapshot ID',async()=>{
 const first=surfaceFixture(),second=surfaceFixture();try{
  const a=sealMemorySurfaceSnapshot(first.batches,scope,key,keyId,receiptKey),b=sealMemorySurfaceSnapshot(second.batches,scope,key,keyId,receiptKey);
  verifyMemorySurfaceSnapshot(a,scope,key,keyId,receiptKey);
  const mixed={...a,batches:[b.batches[0],...a.batches.slice(1)]};
  for(const changed of [mixed,{...a,batches:a.batches.slice(1)},{...a,snapshotId:b.snapshotId},{...a,state:'verified'},{...a,activationReady:true}]){
   assert.throws(()=>verifyMemorySurfaceSnapshot(changed,scope,key,keyId,receiptKey),MemoryCipherError);
   await assert.rejects(writeMemorySnapshotToEmptyCopy(sqliteStepsOn(first.db),changed,scope,key,keyId,receiptKey),MemoryCipherError);
  }
  assert.equal(first.db.prepare('SELECT count(*) n FROM memories').get().n,0);
  await writeMemorySnapshotToEmptyCopy(sqliteStepsOn(first.db),a,scope,key,keyId,receiptKey);
 }finally{first.db.close();second.db.close();}
});
const {verifyStoredMemoryCopyReceipt}=await import('../src/memory/encryption/copy-receipt.ts');
test('verified-copy receipt survives a new connection and detects tampering against the retained snapshot',async()=>{
 const {db,batches}=surfaceFixture();let reopened;try{
  const snapshot=sealMemorySurfaceSnapshot(batches,scope,key,keyId,receiptKey);
  await writeMemorySnapshotToEmptyCopy(sqliteStepsOn(db),snapshot,scope,key,keyId,receiptKey);
  reopened=new Database(db.serialize());await verifyStoredMemoryCopyReceipt(sqliteStepsOn(reopened),snapshot,receiptKey);
  reopened.prepare("UPDATE memory_encryption_copy_receipts SET payload='forged'").run();
  await assert.rejects(verifyStoredMemoryCopyReceipt(sqliteStepsOn(reopened),snapshot,receiptKey),MemoryCipherError);
 }finally{reopened?.close();db.close();}
});
test('receipt-write failure or a receipt trigger corrupting copied data rolls back receipt and every table',async()=>{
 for(const action of ["SELECT RAISE(ABORT,'synthetic failure')","UPDATE agent_handoffs SET done='corrupted'"]){
  const {db,batches}=surfaceFixture();try{
   db.exec('CREATE TABLE memory_encryption_copy_receipts(snapshot_id TEXT PRIMARY KEY,payload TEXT NOT NULL,mac TEXT NOT NULL)');
   db.exec(`CREATE TRIGGER receipt_failure AFTER INSERT ON memory_encryption_copy_receipts BEGIN ${action}; END`);
   const snapshot=sealMemorySurfaceSnapshot(batches,scope,key,keyId,receiptKey);
   await assert.rejects(writeMemorySnapshotToEmptyCopy(sqliteStepsOn(db),snapshot,scope,key,keyId,receiptKey),MemoryCipherError);
   for(const b of batches)assert.equal(db.prepare('SELECT count(*) n FROM '+b.table).get().n,0);
   assert.equal(db.prepare('SELECT count(*) n FROM memory_encryption_copy_receipts').get().n,0);
  }finally{db.close();}
 }
});
const {writeIndexedMemorySnapshotToEmptyCopy}=await import('../src/memory/encryption/copy-writer.ts');
const {decryptMemoryRow}=await import('../src/memory/encryption/row-codec.ts');
const {deriveMemoryLookupKey}=await import('../src/memory/encryption/topic-lookup.ts');
function indexedSnapshot(batches,duplicate=false){
 const memory=batches.find(b=>b.table==='memories'),plain=decryptMemoryRow('memories',memory.rows[0],scope,key,keyId);plain.topic_key='synthetic-topic';plain.status='active';
 const source=duplicate?[plain,{...plain,id:'duplicate-topic-memory'}]:[plain];
 const replacement=prepareMemoryCopyBatch('memories',source,scope,key,keyId,receiptKey);
 return sealMemorySurfaceSnapshot(batches.map(b=>b.table==='memories'?replacement:b),scope,key,keyId,receiptKey);
}
test('indexed copy builds scoped opaque claims with the data and verified receipt',async()=>{
 const {db,batches}=surfaceFixture();try{const snapshot=indexedSnapshot(batches),lookup=deriveMemoryLookupKey(randomBytes(32),scope.ownerId);await writeIndexedMemorySnapshotToEmptyCopy(sqliteStepsOn(db),snapshot,scope,key,keyId,receiptKey,lookup);
 const claim=db.prepare('SELECT * FROM memory_encryption_topics').get();assert.equal(claim.memory_id,'surface-a');assert.match(claim.topic_token,/^enc-topic-v1:/);assert.ok(!db.serialize().includes(Buffer.from('synthetic-topic')));
 await verifyStoredMemoryCopyReceipt(sqliteStepsOn(db),snapshot,receiptKey);
 }finally{db.close();}
});
test('duplicate topics or receipt-trigger index corruption roll back all indexed copy tables',async()=>{
 for(const duplicate of [true,false]){const {db,batches}=surfaceFixture();try{
  db.exec('CREATE TABLE memory_encryption_topics(owner_id TEXT,memory_id TEXT,drawer_kind TEXT,drawer_key TEXT,topic_token TEXT,PRIMARY KEY(owner_id,memory_id),UNIQUE(owner_id,drawer_kind,drawer_key,topic_token));CREATE TABLE memory_encryption_copy_receipts(snapshot_id TEXT PRIMARY KEY,payload TEXT,mac TEXT)');
  if(!duplicate)db.exec("CREATE TRIGGER corrupt_topic AFTER INSERT ON memory_encryption_copy_receipts BEGIN UPDATE memory_encryption_topics SET topic_token='corrupted'; END");
  const snapshot=indexedSnapshot(batches,duplicate);await assert.rejects(writeIndexedMemorySnapshotToEmptyCopy(sqliteStepsOn(db),snapshot,scope,key,keyId,receiptKey,randomBytes(32)));
  for(const b of batches)assert.equal(db.prepare('SELECT count(*) n FROM '+b.table).get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM memory_encryption_topics').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM memory_encryption_copy_receipts').get().n,0);
 }finally{db.close();}}
});

// Deferred with the complete ENC source verification round.
test('declared-surface source and target retain a 933-memory collection with two historical versions each',async()=>{
 const source=surfaceFixture(),target=surfaceFixture();try{
  for(const table of ['memories','memory_versions']){
   const surface=memoryRowSurfaceManifest().find(s=>s.table===table),fields=[surface.owner,surface.id,...surface.bound,...surface.clear,...surface.text,...surface.binary];
   const insert=source.db.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`);
   source.db.transaction(()=>{for(let i=0;i<(table==='memories'?933:1866);i++){
    const row=Object.fromEntries([[surface.owner,scope.ownerId],[surface.id,table+'-'+i],...surface.bound.map(f=>[f,f==='memory_id'?'memories-'+Math.floor(i/2):f==='version'?i%2+1:null]),...surface.clear.map(f=>[f,0]),...surface.text.map(f=>[f,f==='content'?'SYNTHETIC_HISTORY_COPY':null]),...surface.binary.map(f=>[f,null])]);
    insert.run(...fields.map(f=>row[f]));
   }})();
  }
  const snapshot=await prepareMemorySurfaceSnapshot(sqliteStepsOn(source.db),scope,key,keyId,receiptKey);
  await writeMemorySnapshotToEmptyCopy(sqliteStepsOn(target.db),snapshot,scope,key,keyId,receiptKey);
  for(const [table,count] of [['memories',933],['memory_versions',1866]]){
   assert.equal(target.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,count);
   const batch=snapshot.batches.find(b=>b.table===table);verifyMemoryCopyBatch(batch,target.db.prepare(`SELECT * FROM ${table}`).all(),scope,key,keyId,receiptKey);
  }
 }finally{source.db.close();target.db.close();}
});
