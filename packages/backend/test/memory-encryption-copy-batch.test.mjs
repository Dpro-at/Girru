import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import Database from 'better-sqlite3';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareMemoryCopyBatch,verifyMemoryCopyBatch} from '../src/memory/encryption/copy-batch.ts';
import {memoryRowSurfaceManifest} from '../src/memory/encryption/row-codec.ts';
import {MemoryCipherError} from '../src/memory/encryption/envelope.ts';
const scope={ownerId:'synthetic-owner',memberId:'synthetic-member'},key=randomBytes(32),verificationKey=randomBytes(32),keyId='copy-key';
const s=memoryRowSurfaceManifest().find(x=>x.table==='memories');
function row(id){return Object.fromEntries([[s.owner,scope.ownerId],[s.id,id],...s.bound.map(f=>[f,null]),...s.clear.map(f=>[f,0]),...s.text.map(f=>[f,f==='content'?'SYNTHETIC_COPY_PRIVATE_SENTINEL '+id:null]),...s.binary.map(f=>[f,Buffer.from([0,255,10])])]);}
test('933 synthetic IDs survive ciphertext persistence and reopen with a verified keyed subset receipt',()=>{
 const source=Array.from({length:933},(_,i)=>row('synthetic-'+i)),batch=prepareMemoryCopyBatch('memories',source,scope,key,keyId,verificationKey);
 assert.equal(batch.activationReady,false);assert.equal(batch.rows.length,933);
 const root=mkdtempSync(join(tmpdir(),'girru-enc-copy-')),file=join(root,'copy.sqlite');let db;
 try{
  db=new Database(file);const fields=Object.keys(batch.rows[0]);
  db.exec('CREATE TABLE memories ('+fields.map(f=>f+' '+(s.binary.includes(f)?'BLOB':s.clear.includes(f)?'INTEGER':'TEXT')).join(',')+')');
  const insert=db.prepare('INSERT INTO memories('+fields.join(',')+') VALUES('+fields.map(()=>'?').join(',')+')');
  db.transaction(()=>{for(const r of batch.rows)insert.run(...fields.map(f=>r[f]));})();db.close();db=null;
  assert.ok(!readFileSync(file).includes(Buffer.from('SYNTHETIC_COPY_PRIVATE_SENTINEL')));
  db=new Database(file);const readback=db.prepare('SELECT * FROM memories').all();
  verifyMemoryCopyBatch(batch,readback.reverse(),scope,key,keyId,verificationKey);
  assert.deepEqual(new Set(readback.map(r=>r.id)),new Set(source.map(r=>r.id)));
 }finally{db?.close();rmSync(root,{recursive:true,force:true});}
});
test('copy receipt rejects partial, duplicated, altered, wrong-key and wrong-scope readback',()=>{
 const batch=prepareMemoryCopyBatch('memories',[row('a'),row('b')],scope,key,keyId,verificationKey);
 for(const rows of [batch.rows.slice(1),[batch.rows[0],batch.rows[0]],batch.rows.map((r,i)=>i? r:{...r,trust:'forged'})])assert.throws(()=>verifyMemoryCopyBatch(batch,rows,scope,key,keyId,verificationKey),MemoryCipherError);
 for(const change of [{sourceMac:'0'.repeat(64)},{activationReady:true},{table:'memory_versions'},{receiptMac:'bad'}])assert.throws(()=>verifyMemoryCopyBatch({...batch,...change},batch.rows,scope,key,keyId,verificationKey),MemoryCipherError);
 assert.throws(()=>verifyMemoryCopyBatch(batch,batch.rows,scope,key,keyId,randomBytes(32)),MemoryCipherError);
 assert.throws(()=>verifyMemoryCopyBatch(batch,batch.rows,{...scope,memberId:'other'},key,keyId,verificationKey),MemoryCipherError);
});
test('copy preparation refuses incomplete schema, future columns, duplicate IDs and oversized batches',()=>{
 const missing=row('a');delete missing.access_count;
 for(const rows of [[missing],[{...row('a'),future:'private'}],[row('a'),row('a')],Array(1001).fill(row('a'))])assert.throws(()=>prepareMemoryCopyBatch('memories',rows,scope,key,keyId,verificationKey),MemoryCipherError);
 const source=row('a'),before={...source};prepareMemoryCopyBatch('memories',[source],scope,key,keyId,verificationKey);assert.deepEqual(source,before);
});
test('equivalent driver boolean and integer flag encodings retain the same receipt meaning',()=>{
 const source={...row('flags'),is_team_critical:false,auto_enriched:true,needs_improvement:false};
 const batch=prepareMemoryCopyBatch('memories',[source],scope,key,keyId,verificationKey);
 verifyMemoryCopyBatch(batch,batch.rows.map(r=>({...r,is_team_critical:0,auto_enriched:1,needs_improvement:0})),scope,key,keyId,verificationKey);
});

// Deferred: historical rows may exceed the old single-table 1000-row ceiling.
test('declared history copy retains more than one version per synthetic memory',()=>{
 const history=memoryRowSurfaceManifest().find(x=>x.table==='memory_versions');
 const source=Array.from({length:1866},(_,i)=>Object.fromEntries([[history.owner,scope.ownerId],[history.id,'history-'+i],...history.bound.map(f=>[f,f==='memory_id'?'synthetic-'+Math.floor(i/2):f==='version'?i%2+1:null]),...history.clear.map(f=>[f,0]),...history.text.map(f=>[f,f==='content'?'SYNTHETIC_HISTORY '+i:null]),...history.binary.map(f=>[f,null])]));
 const batch=prepareMemoryCopyBatch('memory_versions',source,scope,key,keyId,verificationKey);
 assert.equal(batch.rows.length,1866);verifyMemoryCopyBatch(batch,[...batch.rows].reverse(),scope,key,keyId,verificationKey);
 assert.throws(()=>verifyMemoryCopyBatch(batch,batch.rows.slice(1),scope,key,keyId,verificationKey),MemoryCipherError);
});
