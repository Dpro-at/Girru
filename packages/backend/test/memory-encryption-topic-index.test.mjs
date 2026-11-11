import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import Database from 'better-sqlite3';
import {sqliteStepsOn,run} from '../src/repositories/sql-steps.ts';import {initializeEncryptedTopicIndexStep,syncEncryptedTopicIndexStep,findEncryptedTopicCandidateStep} from '../src/memory/encryption/topic-index.ts';
const key=randomBytes(32),row=(id,extra={})=>({id,user_id:'topic-owner',drawer_kind:'project',drawer_key:'project-a',topic_key:'preference-report-style',status:'active',...extra});
test('keyed index enforces owner/drawer topic uniqueness without storing plaintext topics',async()=>{
 const db=new Database(':memory:'),runner=sqliteStepsOn(db);try{
  await runner.tx(initializeEncryptedTopicIndexStep);await runner.tx(()=>syncEncryptedTopicIndexStep(row('a'),key));
  assert.equal(await runner.read(findEncryptedTopicCandidateStep('topic-owner',{kind:'project',key:'project-a'},row('a').topic_key,key)),'a');
  await assert.rejects(runner.tx(()=>syncEncryptedTopicIndexStep(row('b'),key)));
  await runner.tx(()=>syncEncryptedTopicIndexStep(row('b',{drawer_key:'project-b'}),key));await runner.tx(()=>syncEncryptedTopicIndexStep(row('c',{user_id:'other-owner'}),key));
  assert.ok(!db.serialize().includes(Buffer.from(row('a').topic_key)));
  db.prepare("UPDATE memory_encryption_topics SET memory_id=? WHERE owner_id='topic-owner' AND drawer_key='project-a'").run('\0'+'x'.repeat(300));
  assert.equal(await runner.read(findEncryptedTopicCandidateStep('topic-owner',{kind:'project',key:'project-a'},row('a').topic_key,key)),null);
 }finally{db.close();}
});
test('replacement releases the claim; duplicate move rolls back its surrounding transaction',async()=>{
 const db=new Database(':memory:'),runner=sqliteStepsOn(db);try{
  await runner.tx(initializeEncryptedTopicIndexStep);await runner.tx(()=>syncEncryptedTopicIndexStep(row('a'),key));await runner.tx(()=>syncEncryptedTopicIndexStep(row('b',{drawer_key:'project-b'}),key));
  db.exec('CREATE TABLE synthetic_state(value INTEGER);INSERT INTO synthetic_state VALUES(0)');
  await assert.rejects(runner.tx(function*(){yield* run('UPDATE synthetic_state SET value=1');yield* syncEncryptedTopicIndexStep(row('b'),key);}));assert.equal(db.prepare('SELECT value FROM synthetic_state').get().value,0);
  await runner.tx(()=>syncEncryptedTopicIndexStep(row('a',{status:'replaced'}),key));await runner.tx(()=>syncEncryptedTopicIndexStep(row('b'),key));
  assert.equal(await runner.read(findEncryptedTopicCandidateStep('topic-owner',{kind:'project',key:'project-a'},row('b').topic_key,key)),'b');
 }finally{db.close();}
});
