import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';
import {sqliteStepsOn} from '../src/repositories/sql-steps.ts';import {classifyExternalCopiesStep} from '../src/memory/encryption/external-copy-classification.ts';
test('registered byte association distinguishes changed/current/shared/unverified copies without granting deletion',async()=>{
 const db=new Database(':memory:');try{
 db.exec('CREATE TABLE change_scopes(scope TEXT,owner_id TEXT);CREATE TABLE projection_state(scope TEXT,consumer TEXT,target TEXT,content_hash TEXT)');
 db.prepare('INSERT INTO change_scopes VALUES(?,?)').run('project:synthetic','owner');const hash='a'.repeat(64);
 db.prepare('INSERT INTO projection_state VALUES(?,?,?,?)').run('project:synthetic','brief-file','/tmp/synthetic/.girru/brief.md',hash);
 const runner=sqliteStepsOn(db),files=['.girru/brief.md','AGENTS.md','.girru/brief.outside-2.md','.girru/brief.md.0123456789abcdef.tmp'].map(path=>({path,bytes:5,sha256:hash}));
 const classify=(owner='owner',root='/tmp/synthetic')=>runner.tx(()=>classifyExternalCopiesStep(owner,'project:synthetic',root,files));
 assert.deepEqual((await classify()).map(f=>f.classification),['registered-projection-match','shared-document','historical-copy-unverified','staged-copy-unverified']);
 files[0].sha256='b'.repeat(64);assert.equal((await classify())[0].classification,'registered-projection-changed');assert.equal((await classify('owner','/tmp/other'))[0].classification,'unclassified');await assert.rejects(classify('other-owner'));
 }finally{db.close();}
});
