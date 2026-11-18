import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {encryptMemoryRow,decryptMemoryRow,memoryRowSurfaceManifest} from '../src/memory/encryption/row-codec.ts';
import {MemoryCipherError} from '../src/memory/encryption/envelope.ts';
const key=randomBytes(32),scope={ownerId:'row-owner',memberId:'row-member'},keyId='row-key';
function row(table,id='row-a') {
 const s=memoryRowSurfaceManifest().find(x=>x.table===table);
 return Object.fromEntries([[s.owner,scope.ownerId],[s.id,id],...s.bound.map(f=>[f,null]),...s.text.map(f=>[f,f==='content'?'نص ذاكرة تجريبي ENC_ROW_DISK_SENTINEL':null]),...s.binary.map(f=>[f,Buffer.from([0,1,255,128])])]);
}
test('every declared existing row surface round-trips text, bytes and authenticated nulls without mutating input',()=>{
 for(const s of memoryRowSurfaceManifest()){
  const plain=row(s.table), before={...plain},encrypted=encryptMemoryRow(s.table,plain,scope,key,keyId);
  assert.deepEqual(plain,before);assert.deepEqual(decryptMemoryRow(s.table,encrypted,scope,key,keyId),plain);
  for(const f of [...s.text,...s.binary])assert.notEqual(encrypted[f],null,'NULL must not be an unauthenticated drop-field channel');
 }
});
test('row/field/table/member swaps and missing or NULL/plaintext replacements fail closed',()=>{
 const source=row('memory_versions'),cipher=encryptMemoryRow('memory_versions',source,scope,key,keyId);
 for(const changed of [{...cipher,id:'other'},{...cipher,content:cipher.snapshot},{...cipher,content:null},{...cipher,content:'legacy plaintext'}])assert.throws(()=>decryptMemoryRow('memory_versions',changed,scope,key,keyId),MemoryCipherError);
 const missing={...cipher};delete missing.snapshot;assert.throws(()=>decryptMemoryRow('memory_versions',missing,scope,key,keyId),MemoryCipherError);
 assert.throws(()=>decryptMemoryRow('memory_versions',cipher,{...scope,memberId:'other'},key,keyId),MemoryCipherError);
 assert.throws(()=>decryptMemoryRow('memory_versions',cipher,{...scope,ownerId:'other'},key,keyId),MemoryCipherError);
 assert.throws(()=>decryptMemoryRow('memories',cipher,scope,key,keyId),MemoryCipherError);
});
test('existing SQLite TEXT/BLOB columns hold only ciphertext; a newly opened connection restores exact bytes',()=>{
 const root=mkdtempSync(join(tmpdir(),'girru-enc-row-')),file=join(root,'rows.sqlite'),plain=row('memories');let db;
 try{
  db=new Database(file);const s=memoryRowSurfaceManifest().find(x=>x.table==='memories');
  db.exec('CREATE TABLE memories(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,'+s.bound.map(f=>f+' TEXT').concat(s.text.map(f=>f+' TEXT'),s.binary.map(f=>f+' BLOB')).join(',')+')');
  const encrypted=encryptMemoryRow('memories',plain,scope,key,keyId),fields=Object.keys(encrypted);
  db.prepare('INSERT INTO memories('+fields.join(',')+') VALUES('+fields.map(()=>'?').join(',')+')').run(...fields.map(f=>encrypted[f]));db.close();db=null;
  assert.ok(!readFileSync(file).includes(Buffer.from('ENC_ROW_DISK_SENTINEL')));
  db=new Database(file);assert.deepEqual(decryptMemoryRow('memories',db.prepare('SELECT * FROM memories').get(),scope,key,keyId),plain);
 }finally{db?.close();rmSync(root,{recursive:true,force:true});}
});
test('invalid owner, unsupported table and malformed field types cannot be encrypted',()=>{
 assert.throws(()=>encryptMemoryRow('not-a-table',{},scope,key,keyId),MemoryCipherError);
 const source=row('memories');assert.throws(()=>encryptMemoryRow('memories',{...source,user_id:'other'},scope,key,keyId),MemoryCipherError);
 assert.throws(()=>encryptMemoryRow('memories',{...source,metadata:{}},scope,key,keyId),MemoryCipherError);
 const manifest=memoryRowSurfaceManifest();manifest[0].text.length=0;assert.ok(memoryRowSurfaceManifest()[0].text.length>0);
});
test('changing project or access-policy metadata cannot move authenticated ciphertext into another permission scope',()=>{
 const plain={...row('memories'),drawer_kind:'project',drawer_key:'restricted',visibility:'private',team_id:null,is_team_critical:0,source_agent_id:null,status:'active'};
 const encrypted=encryptMemoryRow('memories',plain,scope,key,keyId);
 assert.equal(decryptMemoryRow('memories',{...encrypted,is_team_critical:false},scope,key,keyId).content,plain.content,'equivalent SQL integer/PostgreSQL boolean policy encodings share an authenticated meaning');
 for(const changes of [{drawer_key:'allowed'},{drawer_kind:'owner',drawer_key:null},{visibility:'public'},{team_id:'other-team'},{is_team_critical:1},{status:'active-forged'}])assert.throws(()=>decryptMemoryRow('memories',{...encrypted,...changes},scope,key,keyId),MemoryCipherError);
});
test('an unknown future content column cannot pass through a protected row as plaintext',()=>{
 const plain={...row('memories'),future_memory_text:'PRIVATE_UNCLASSIFIED_COLUMN'};
 assert.throws(()=>encryptMemoryRow('memories',plain,scope,key,keyId),MemoryCipherError);
});

test('every declared metadata field is authenticated while numeric access counters remain mutable',()=>{
 for(const s of memoryRowSurfaceManifest()){
  const plain=row(s.table),cipher=encryptMemoryRow(s.table,plain,scope,key,keyId);
  for(const field of s.bound)assert.throws(()=>decryptMemoryRow(s.table,{...cipher,[field]:'altered-metadata'},scope,key,keyId),MemoryCipherError,`${s.table}.${field}`);
  for(const field of s.clear){
   assert.equal(decryptMemoryRow(s.table,{...cipher,[field]:42},scope,key,keyId)[field],42);
   assert.throws(()=>encryptMemoryRow(s.table,{...plain,[field]:'UNCLASSIFIED_TEXT'},scope,key,keyId),MemoryCipherError);
  }
  assert.throws(()=>decryptMemoryRow(s.table,{...cipher,future_column:'plaintext'},scope,key,keyId),MemoryCipherError);
 }
});
