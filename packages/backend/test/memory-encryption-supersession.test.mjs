import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {memoryRowSurfaceManifest,encryptMemoryRow,decryptMemoryRow} from '../src/memory/encryption/row-codec.ts';import {prepareEncryptedSupersession} from '../src/memory/encryption/supersession.ts';import {MemoryCipherError} from '../src/memory/encryption/envelope.ts';
const scope={ownerId:'replace-owner',memberId:'replace-member'},key=randomBytes(32),keyId='replace-key',s=memoryRowSurfaceManifest().find(s=>s.table==='memories');
function cipher(id,extra={}){const row=Object.fromEntries([[s.owner,scope.ownerId],[s.id,id],...s.bound.map(f=>[f,null]),...s.clear.map(f=>[f,0]),...s.text.map(f=>[f,null]),...s.binary.map(f=>[f,null])]);Object.assign(row,{content:'SYNTHETIC_REPLACE_CONTENT',type:'fact',status:'active',drawer_kind:'project',drawer_key:'same-project'},extra);return encryptMemoryRow('memories',row,scope,key,keyId);}
test('supersession reseals lifecycle metadata, preserving old text and binding the distinct new record',()=>{
 const older=cipher('older'),newer=cipher('newer'),at='2026-11-06T00:00:00.000Z',result=prepareEncryptedSupersession(older,newer,scope,key,keyId,()=>true,()=>true,at),plain=decryptMemoryRow('memories',result,scope,key,keyId);
 assert.equal(plain.status,'replaced');assert.equal(plain.superseded_by,'newer');assert.equal(plain.valid_to,at);assert.equal(plain.content,'SYNTHETIC_REPLACE_CONTENT');assert.equal(decryptMemoryRow('memories',older,scope,key,keyId).status,'active');assert.throws(()=>decryptMemoryRow('memories',{...older,status:'replaced',superseded_by:'newer',valid_to:at},scope,key,keyId),MemoryCipherError);
});
test('both records require authorization; same id, cross-drawer and already-replaced inputs fail closed',()=>{
 const older=cipher('older'),newer=cipher('newer');
 for(const next of [older,cipher('newer',{drawer_key:'foreign-project'}),cipher('newer',{status:'replaced'})])assert.throws(()=>prepareEncryptedSupersession(older,next,scope,key,keyId,()=>true,()=>true),MemoryCipherError);
 assert.throws(()=>prepareEncryptedSupersession(older,newer,scope,key,keyId,()=>false,()=>true),MemoryCipherError);assert.throws(()=>prepareEncryptedSupersession(older,newer,scope,key,keyId,()=>true,()=>false),MemoryCipherError);
 assert.throws(()=>prepareEncryptedSupersession(older,newer,scope,key,keyId,()=>true,()=>true,'invalid'),MemoryCipherError);
});
