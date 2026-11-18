import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {memoryRowSurfaceManifest,encryptMemoryRow,decryptMemoryRow} from '../src/memory/encryption/row-codec.ts';import {prepareEncryptedContentUpdate} from '../src/memory/encryption/content-update.ts';import {MemoryCipherError} from '../src/memory/encryption/envelope.ts';
const key=randomBytes(32),scope={ownerId:'update-owner',memberId:'update-member'},keyId='update-key',s=memoryRowSurfaceManifest().find(s=>s.table==='memories');
const plain=Object.fromEntries([[s.owner,scope.ownerId],[s.id,'update-a'],...s.bound.map(f=>[f,null]),...s.clear.map(f=>[f,0]),...s.text.map(f=>[f,f==='content'?'old synthetic content':null]),...s.binary.map(f=>[f,null])]);
const patch={content:'new synthetic content',embedding:null,embedding_vec:null,embedding_model:null,embedding_dims:null};
test('authorized content preparation reseals every field without mutating source and invalidates stale vectors',()=>{
 const cipher=encryptMemoryRow('memories',plain,scope,key,keyId),before=Object.fromEntries(Object.entries(cipher).map(([f,v])=>[f,Buffer.isBuffer(v)?Buffer.from(v):v])),updated=prepareEncryptedContentUpdate(cipher,patch,scope,key,keyId,()=>true);
 assert.deepEqual(cipher,before);assert.equal(decryptMemoryRow('memories',updated,scope,key,keyId).content,patch.content);assert.ok(!JSON.stringify(updated).includes(patch.content));
});
test('denied writes, identity/policy/topic edits and content edits retaining stale vectors fail closed',()=>{
 const cipher=encryptMemoryRow('memories',plain,scope,key,keyId);
 for(const change of [{content:'new'}, {...patch,user_id:'other'},{...patch,drawer_key:'other'},{...patch,topic_key:'topic'},{...patch,status:'replaced'}])assert.throws(()=>prepareEncryptedContentUpdate(cipher,change,scope,key,keyId,()=>true),MemoryCipherError);
 assert.throws(()=>prepareEncryptedContentUpdate(cipher,patch,scope,key,keyId,()=>false),MemoryCipherError);
});
