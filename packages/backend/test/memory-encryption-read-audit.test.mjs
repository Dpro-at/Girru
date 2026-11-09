import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import Database from 'better-sqlite3';
import {sqliteStepsOn} from '../src/repositories/sql-steps.ts';
import {deriveMemoryAuditKey,memoryAuditGenesis,appendMemoryReadEntry,verifyMemoryReadChain,createMemoryReadAuditStore} from '../src/memory/encryption/read-audit.ts';
import {MemoryCipherError} from '../src/memory/encryption/envelope.ts';
const owner='audit-owner',key=deriveMemoryAuditKey(randomBytes(32),owner),input={readerKind:'agent',readerId:'agent-a',purpose:'recall',records:[{table:'memories',id:'record-a'}]};
const head=e=>({ownerId:e.ownerId,sequence:e.sequence,mac:e.mac});
test('authenticated read chain verifies against its trusted head and rejects modification, reorder, deletion and valid-prefix truncation',()=>{
 const genesis=memoryAuditGenesis(owner,key),a=appendMemoryReadEntry(genesis,input,key),b=appendMemoryReadEntry(head(a),{...input,records:[{table:'memories',id:'record-b'}]},key);
 assert.doesNotThrow(()=>verifyMemoryReadChain([a,b],head(b),key));
 for(const records of [[a],[b],[b,a],[a,a],[{...a,readerId:'other'},b],[a,{...b,records:[{table:'memories',id:'forged'}]}]])assert.throws(()=>verifyMemoryReadChain(records,head(b),key),MemoryCipherError);
 assert.throws(()=>verifyMemoryReadChain([a,b],{...head(b),ownerId:'other-owner'},key),MemoryCipherError);
 assert.throws(()=>verifyMemoryReadChain([a,b],head(b),randomBytes(32)),MemoryCipherError);
});
test('audit accepts bounded technical ids only, never a query or free-text reason',()=>{
 const start=memoryAuditGenesis(owner,key);
 for(const value of [{...input,query:'PRIVATE_QUERY_MUST_NOT_BE_LOGGED'},{...input,purpose:'private query text'},{...input,records:[]},{...input,records:[...input.records,...input.records]},{...input,records:[{table:'memories',id:'line\nbreak'}]}])assert.throws(()=>appendMemoryReadEntry(start,value,key),MemoryCipherError);
 const e=appendMemoryReadEntry(start,input,key);assert.ok(!JSON.stringify(e).includes('PRIVATE_QUERY'));
});
test('shared SQL-step store persists scoped reads, detects a stale checkpoint and refuses a truncated log',async()=>{
 const db=new Database(':memory:'),store=createMemoryReadAuditStore(sqliteStepsOn(db),owner,key);
 try{
  await store.initialize();const a=await store.append(store.genesis(),input);const b=await store.append(a,{...input,purpose:'view'});await store.verify(b);
  await assert.rejects(store.append(a,input),MemoryCipherError);
  db.prepare('DELETE FROM memory_encryption_read_audit WHERE owner_id=? AND sequence=?').run(owner,b.sequence);
  await assert.rejects(store.verify(b),MemoryCipherError);await assert.rejects(store.append(b,input),MemoryCipherError);
 }finally{store.close();db.close();}
});
test('concurrent stale-head append attempts cannot fork a chain; failed appends roll back',async()=>{
 const db=new Database(':memory:'),store=createMemoryReadAuditStore(sqliteStepsOn(db),owner,key);
 try{
  await store.initialize();const genesis=store.genesis(),results=await Promise.allSettled([store.append(genesis,input),store.append(genesis,input)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(db.prepare('SELECT count(*) n FROM memory_encryption_read_audit').get().n,1);
  const next=results.find(x=>x.status==='fulfilled').value;await store.verify(next);
 }finally{store.close();db.close();}
});
test('another owner, damaged last payload, oversized payload and closed store all fail closed',async()=>{
 const db=new Database(':memory:'),store=createMemoryReadAuditStore(sqliteStepsOn(db),owner,key);
 try{
  await store.initialize();const a=await store.append(store.genesis(),input);
  await assert.rejects(store.verify({...a,ownerId:'other'}),MemoryCipherError);
  db.prepare('UPDATE memory_encryption_read_audit SET payload=?').run('x'.repeat(524289));
  await assert.rejects(store.verify(a),MemoryCipherError);await assert.rejects(store.append(a,input),MemoryCipherError);
  store.close();await assert.rejects(store.append(a,input),MemoryCipherError);
 }finally{store.close();db.close();}
});
test('authenticated SQL log survives reopening a scratch file when its expected head is retained separately',async()=>{
 const {mkdtempSync,rmSync,readFileSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'girru-read-audit-')),file=join(root,'audit.sqlite');let db,store;
 try{
  db=new Database(file);store=createMemoryReadAuditStore(sqliteStepsOn(db),owner,key);await store.initialize();const retained=await store.append(store.genesis(),input);store.close();db.close();db=null;
  db=new Database(file);store=createMemoryReadAuditStore(sqliteStepsOn(db),owner,key);await store.verify(retained);
  assert.ok(!readFileSync(file).includes(key));await assert.rejects(store.verify(store.genesis()),MemoryCipherError);
 }finally{store?.close();db?.close();rmSync(root,{recursive:true,force:true});}
});

test('internal maintenance cannot be fabricated with system JSON or by changing the v1 grammar',()=>{
 const forged={readerKind:'system',readerId:'trace-auxiliary-maintenance',purpose:'internal-maintenance',records:[{table:'memory_encryption_auxiliary',id:'auxiliary-part-a'}]};
 assert.throws(()=>appendMemoryReadEntry(memoryAuditGenesis(owner,key),forged,key),MemoryCipherError);
 const original=appendMemoryReadEntry(memoryAuditGenesis(owner,key),input,key);
 assert.throws(()=>verifyMemoryReadChain([{...original,version:2}],head(original),key),MemoryCipherError);
 assert.throws(()=>verifyMemoryReadChain([{...original,purpose:'internal-maintenance'}],head(original),key),MemoryCipherError);
});
