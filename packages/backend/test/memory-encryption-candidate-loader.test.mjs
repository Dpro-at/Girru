import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';
import {sqliteStepsOn} from '../src/repositories/sql-steps.ts';import {memoryRowSurfaceManifest} from '../src/memory/encryption/row-codec.ts';import {loadEncryptedMemoryCandidates} from '../src/memory/encryption/candidate-loader.ts';import {MemoryCipherError} from '../src/memory/encryption/envelope.ts';
function fixture(){const db=new Database(':memory:'),s=memoryRowSurfaceManifest().find(s=>s.table==='memories'),fields=[s.owner,s.id,...s.bound,...s.clear,...s.text,...s.binary];db.exec('CREATE TABLE memories('+fields.map(f=>f+' '+(s.binary.includes(f)?'BLOB':'TEXT')).join(',')+')');db.exec('CREATE TABLE memory_project_scopes(owner_id TEXT,slug TEXT,archived_at TEXT)');return db;}
test('owner and active-state transport excludes foreign/replaced rows and refuses schema drift',async()=>{
 const db=fixture();try{const add=db.prepare('INSERT INTO memories(id,user_id,status) VALUES(?,?,?)');add.run('a','owner','active');add.run('b','owner',null);add.run('c','other','active');add.run('d','owner','replaced');
 assert.deepEqual((await loadEncryptedMemoryCandidates(sqliteStepsOn(db),'owner')).map(r=>r.id),['a','b']);
 await assert.rejects(loadEncryptedMemoryCandidates(sqliteStepsOn(db),'owner',1),MemoryCipherError);
 db.exec('ALTER TABLE memories ADD COLUMN future TEXT');await assert.rejects(loadEncryptedMemoryCandidates(sqliteStepsOn(db),'owner'),MemoryCipherError);
 }finally{db.close();}
});
test('byte bound counts SQLite NUL and multibyte data without transferring oversized rows',async()=>{
 const db=fixture();try{db.prepare('INSERT INTO memories(id,user_id,content) VALUES(?,?,?)').run('a','owner','\0'+'ض'.repeat(600));await assert.rejects(loadEncryptedMemoryCandidates(sqliteStepsOn(db),'owner',5000,1024),MemoryCipherError);}finally{db.close();}
});

test('existing recall exclusions keep archived project memories and agent-only notes out of candidate transport',async()=>{
 const db=fixture();try{
  const add=db.prepare('INSERT INTO memories(id,user_id,status,drawer_kind,drawer_key) VALUES(?,?,?,?,?)');
  add.run('active','owner','active','project','allowed');add.run('archived','owner','active','project','archived');add.run('note','owner','active','agent','private');
  db.prepare('INSERT INTO memory_project_scopes VALUES(?,?,?)').run('owner','archived','2026-01-01');
  assert.deepEqual((await loadEncryptedMemoryCandidates(sqliteStepsOn(db),'owner')).map(r=>r.id),['active']);
 }finally{db.close();}
});
