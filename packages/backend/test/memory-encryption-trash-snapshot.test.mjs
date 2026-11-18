import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {memoryRowSurfaceManifest,encryptMemoryRow,decryptMemoryRow} from '../src/memory/encryption/row-codec.ts';import {prepareEncryptedTrashSnapshot,prepareEncryptedTrashRestore} from '../src/memory/encryption/trash-snapshot.ts';import {MemoryCipherError} from '../src/memory/encryption/envelope.ts';
const key=randomBytes(32),scope={ownerId:'update-owner',memberId:'update-member'},keyId='update-key',s=memoryRowSurfaceManifest().find(s=>s.table==='memories');
const plain=Object.fromEntries([[s.owner,scope.ownerId],[s.id,'update-a'],...s.bound.map(f=>[f,null]),...s.clear.map(f=>[f,0]),...s.text.map(f=>[f,f==='content'?'old synthetic content':null]),...s.binary.map(f=>[f,null])]);
plain.status='active';plain.embedding_vec=Buffer.from([0,1,255]);
test('encrypted Trash snapshot preserves identity, metadata, nullable fields and vector bytes through reseal',()=>{
 const cipher=encryptMemoryRow('memories',plain,scope,key,keyId),snapshot=prepareEncryptedTrashSnapshot(cipher,scope,key,keyId,()=>true);
 const restored=prepareEncryptedTrashRestore(snapshot,plain.id,scope,key,keyId,()=>true);assert.deepEqual(decryptMemoryRow('memories',restored,scope,key,keyId),plain);assert.notEqual(restored.content,cipher.content);
});
test('snapshot preparation refuses denied/deleted sources and restore rejects owner/id/schema/format substitution',()=>{
 const cipher=encryptMemoryRow('memories',plain,scope,key,keyId),snapshot=prepareEncryptedTrashSnapshot(cipher,scope,key,keyId,()=>true);
 assert.throws(()=>prepareEncryptedTrashSnapshot(cipher,scope,key,keyId,()=>false),MemoryCipherError);
 assert.throws(()=>prepareEncryptedTrashSnapshot(encryptMemoryRow('memories',{...plain,status:'replaced'},scope,key,keyId),scope,key,keyId,()=>true),MemoryCipherError);
 for(const raw of [snapshot.replace('girru-encrypted-trash-row','legacy'),JSON.stringify({...JSON.parse(snapshot),row:{...JSON.parse(snapshot).row,unknown:'field'}}),snapshot+'x'])assert.throws(()=>prepareEncryptedTrashRestore(raw,plain.id,scope,key,keyId,()=>true),MemoryCipherError);
 assert.throws(()=>prepareEncryptedTrashRestore(snapshot,'wrong-id',scope,key,keyId,()=>true),MemoryCipherError);assert.throws(()=>prepareEncryptedTrashRestore(snapshot,plain.id,scope,key,keyId,()=>false),MemoryCipherError);
 let checks=0;assert.throws(()=>prepareEncryptedTrashRestore(snapshot,plain.id,scope,key,keyId,()=>++checks===1),MemoryCipherError);
});
test('restore refuses oversized snapshots, noncanonical binary data and another owner',()=>{
 const snapshot=prepareEncryptedTrashSnapshot(encryptMemoryRow('memories',plain,scope,key,keyId),scope,key,keyId,()=>true),parsed=JSON.parse(snapshot);
 for(const raw of [' '.repeat(512*1024+1),JSON.stringify({...parsed,row:{...parsed.row,embedding_vec:{bytes:'AA'}}}),JSON.stringify({...parsed,row:{...parsed.row,user_id:'another-owner'}})])assert.throws(()=>prepareEncryptedTrashRestore(raw,plain.id,scope,key,keyId,()=>true),MemoryCipherError);
});
test('restore requires the complete snapshot schema, including mutable access counters',()=>{
 const snapshot=prepareEncryptedTrashSnapshot(encryptMemoryRow('memories',plain,scope,key,keyId),scope,key,keyId,()=>true),parsed=JSON.parse(snapshot);
 for(const field of ['access_count','last_accessed_at','content','embedding_vec']){const row={...parsed.row};delete row[field];assert.throws(()=>prepareEncryptedTrashRestore(JSON.stringify({...parsed,row}),plain.id,scope,key,keyId,()=>true),MemoryCipherError);}
});
