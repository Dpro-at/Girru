import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {sqliteStepsOn} from '../src/repositories/sql-steps.ts';
import {assertNoUncoveredProjectCopiesStep} from '../src/memory/encryption/forget-coverage.ts';

test('design exports remain uncovered even without a chat folder or with writing disabled',async()=>{
 const db=new Database(':memory:');
 try{
  db.exec("CREATE TABLE memory_project_design(owner_id TEXT,found TEXT,previous TEXT,file_written_at TEXT,write_file INTEGER)");
  const runner=sqliteStepsOn(db),check=()=>runner.read(assertNoUncoveredProjectCopiesStep('synthetic-owner'));
  await check();
  db.prepare('INSERT INTO memory_project_design VALUES(?,?,?,?,?)').run('other-owner','{"root":"/never/open"}',null,null,1);
  await check();
  db.prepare('INSERT INTO memory_project_design VALUES(?,?,?,?,?)').run('synthetic-owner','{}',null,null,0);
  await check();
  for(const change of ["found='malformed'","previous='{}'","file_written_at='synthetic-time'"]){
   db.prepare('UPDATE memory_project_design SET '+change+" WHERE owner_id='synthetic-owner'").run();
   await assert.rejects(check());
   db.prepare("UPDATE memory_project_design SET found='{}',previous=NULL,file_written_at=NULL WHERE owner_id='synthetic-owner'").run();
  }
 }finally{db.close();}
});

test('orphaned pilot projection remains uncovered after its chat project is deleted',async()=>{
 const db=new Database(':memory:');
 try{
  db.exec("CREATE TABLE change_scopes(scope TEXT,owner_id TEXT); CREATE TABLE projection_state(scope TEXT,target TEXT,content_hash TEXT,pending_hash TEXT); CREATE TABLE chat_projects(user_id TEXT,folder TEXT)");
  db.prepare('INSERT INTO change_scopes VALUES(?,?)').run('project:deleted','synthetic-owner');
  db.prepare('INSERT INTO projection_state VALUES(?,?,?,?)').run('project:deleted',null,null,null);
  const runner=sqliteStepsOn(db),check=()=>runner.read(assertNoUncoveredProjectCopiesStep('synthetic-owner'));
  await check();
  for(const field of ['target','content_hash','pending_hash']){
   db.prepare('UPDATE projection_state SET '+field+'=?').run('synthetic-footprint');
   await assert.rejects(check());
   await runner.read(assertNoUncoveredProjectCopiesStep('another-owner'));
   db.prepare('UPDATE projection_state SET '+field+'=NULL').run();
  }
 }finally{db.close();}
});

test('captured historical copy evidence cannot be hidden by removing current folder rows',async()=>{
 const db=new Database(':memory:');try{
 db.exec('CREATE TABLE memory_encryption_external_plan_checkpoints(owner_id TEXT,ciphertext TEXT)');const runner=sqliteStepsOn(db);
 db.prepare('INSERT INTO memory_encryption_external_plan_checkpoints VALUES(?,?)').run('owner','opaque-encrypted-evidence');
 await assert.rejects(runner.tx(()=>assertNoUncoveredProjectCopiesStep('owner')));await runner.tx(()=>assertNoUncoveredProjectCopiesStep('other-owner'));
 }finally{db.close();}
});
