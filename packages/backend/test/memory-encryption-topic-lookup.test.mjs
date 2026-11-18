import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import Database from 'better-sqlite3';
import {deriveMemoryLookupKey,memoryTopicLookupToken,verifyMemoryTopicLookup} from '../src/memory/encryption/topic-lookup.ts';
import {sealMemoryText} from '../src/memory/encryption/envelope.ts';
const master=randomBytes(32),owner='topic-owner',key=deriveMemoryLookupKey(master,owner),drawer={kind:'project',key:'trial-project'};
test('topic equality is stable but scoped by owner, drawer, key and exact canonical topic',()=>{
 const token=memoryTopicLookupToken('trial-topic',key,owner,drawer);assert.equal(token,memoryTopicLookupToken('trial-topic',key,owner,drawer));
 assert.match(token,/^enc-topic-v1:[A-Za-z0-9_-]{43}$/);assert.ok(!token.includes('trial-topic'));
 for(const other of [memoryTopicLookupToken('other-topic',key,owner,drawer),memoryTopicLookupToken('trial-topic',key,'other-owner',drawer),memoryTopicLookupToken('trial-topic',key,owner,{kind:'project',key:'other'}),memoryTopicLookupToken('trial-topic',deriveMemoryLookupKey(randomBytes(32),owner),owner,drawer)])assert.notEqual(token,other);
 assert.notDeepEqual(deriveMemoryLookupKey(master,'other-owner'),key);
});
test('nulls preserve optional-topic semantics; noncanonical topics and invalid context fail closed',()=>{
 assert.equal(memoryTopicLookupToken(null,key,owner,drawer),null);
 for(const topic of ['',undefined,12,'UPPER CASE','x'.repeat(81)])assert.throws(()=>memoryTopicLookupToken(topic,key,owner,drawer));
 assert.throws(()=>deriveMemoryLookupKey(Buffer.alloc(31),owner));assert.throws(()=>deriveMemoryLookupKey(master,''));
 assert.throws(()=>memoryTopicLookupToken('trial-topic',key,owner,{kind:'unknown'}));
});
test('a tampered index cannot silently return a different decrypted topic',()=>{
 const token=memoryTopicLookupToken('trial-topic',key,owner,drawer);
 assert.doesNotThrow(()=>verifyMemoryTopicLookup('trial-topic',token,key,owner,drawer));
 assert.doesNotThrow(()=>verifyMemoryTopicLookup(null,null,key,owner,drawer));
 for(const pair of [['other-topic',token],[null,token],['trial-topic',null],['trial-topic','x'.repeat(token.length)],['trial-topic',token+'x']])assert.throws(()=>verifyMemoryTopicLookup(pair[0],pair[1],key,owner,drawer));
});
test('SQLite active-topic uniqueness works without storing plaintext or relying on randomized ciphertext equality',()=>{
 const db=new Database(':memory:');
 try{
  db.exec("CREATE TABLE memories(id TEXT PRIMARY KEY,user_id TEXT,drawer_kind TEXT,drawer_key TEXT,topic_cipher TEXT,topic_lookup TEXT,status TEXT); CREATE UNIQUE INDEX topic_unique ON memories(user_id,drawer_kind,drawer_key,topic_lookup) WHERE topic_lookup IS NOT NULL AND COALESCE(status,'active') <> 'replaced'");
  const insert=(id,status,d=drawer,topic='trial-topic')=>{
   const cipher=sealMemoryText(topic??'',key,'topic-encryption-test',{ownerId:owner,memberId:owner,recordId:id,field:'memories.topic_key'});
   db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?)').run(id,owner,d.kind,d.key,cipher,memoryTopicLookupToken(topic,key,owner,d),status);
  };
  insert('first','active');assert.throws(()=>insert('duplicate','active'),/UNIQUE/);
  insert('old','replaced');insert('elsewhere','active',{kind:'project',key:'another'});insert('no-topic-a','active',drawer,null);insert('no-topic-b','active',drawer,null);
  const hit=db.prepare('SELECT id FROM memories WHERE user_id=? AND drawer_kind=? AND drawer_key=? AND topic_lookup=? AND status=?').get(owner,drawer.kind,drawer.key,memoryTopicLookupToken('trial-topic',key,owner,drawer),'active');
  assert.equal(hit.id,'first');
 }finally{db.close();}
});
