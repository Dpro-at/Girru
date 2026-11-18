import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';
import {sqliteStepsOn} from '../src/repositories/sql-steps.ts';
import {createMemoryRevisionValidator} from '../src/memory/encryption/revision-validator.ts';
function fixture(){const db=new Database(':memory:');db.exec(`CREATE TABLE memory_project_scopes(owner_id TEXT,slug TEXT,archived_at TEXT);CREATE TABLE memory_project_kinds(owner_id TEXT,slug TEXT,kind TEXT);CREATE TABLE users(id TEXT,status TEXT,role TEXT,token_version INTEGER);CREATE TABLE auth_sessions(id TEXT,user_id TEXT,revoked_at INTEGER,expires_at INTEGER,token_version INTEGER);CREATE TABLE memory_access_versions(owner_id TEXT,version INTEGER);CREATE TABLE agents_config(id TEXT);CREATE TABLE agent_permissions(agent_id TEXT,version INTEGER);INSERT INTO users VALUES('owner','active','owner',1);INSERT INTO auth_sessions VALUES('session','owner',NULL,10000,1);INSERT INTO agents_config VALUES('agent');INSERT INTO agent_permissions VALUES('agent',2);INSERT INTO memory_access_versions VALUES('owner',3);`);return db;}
const capture={ownerId:'owner',sessionId:'session',tokenVersion:1,role:'owner',policyVersion:3,agents:[{id:'agent',version:2}],validUntil:9000};
test('uncached checkpoint detects session, account, owner policy and delegated permission changes',async()=>{
 for(const change of ["UPDATE auth_sessions SET revoked_at=1","DELETE FROM auth_sessions","UPDATE users SET token_version=2","UPDATE users SET role='user'","UPDATE memory_access_versions SET version=4","UPDATE agent_permissions SET version=3","DELETE FROM agents_config"]){
  const db=fixture();let locked=0;try{const validate=createMemoryRevisionValidator(sqliteStepsOn(db),capture,()=>locked++,()=>100);assert.equal(await validate(),true);db.exec(change);assert.equal(await validate(),false);assert.equal(locked,1);assert.equal(await validate(),false);}finally{db.close();}
 }
});
test('expiry, query failure and mutable caller inputs fail closed without resurrecting a capture',async()=>{
 const db=fixture();let at=100,locked=0;try{
  const input=structuredClone(capture),validate=createMemoryRevisionValidator(sqliteStepsOn(db),input,()=>locked++,()=>at);input.agents[0].version=999;
  assert.equal(await validate(),true);at=9000;assert.equal(await validate(),false);at=100;assert.equal(await validate(),false);assert.equal(locked,1);
  const broken=createMemoryRevisionValidator(sqliteStepsOn(db),capture,()=>locked++,()=>100);db.exec('DROP TABLE users');assert.equal(await broken(),false);assert.equal(locked,2);
 }finally{db.close();}
});

test('selected project archive changes revoke the capture independently of policy versions',async()=>{
 const db=fixture();let locked=0;try{
  const validate=createMemoryRevisionValidator(sqliteStepsOn(db),{...capture,projects:['selected']},()=>locked++,()=>100);
  assert.equal(await validate(),true);
  db.exec("INSERT INTO memory_project_scopes VALUES('owner','unrelated','2026-01-01')");assert.equal(await validate(),true);
  db.exec("INSERT INTO memory_project_scopes VALUES('owner','selected','2026-01-01')");assert.equal(await validate(),false);assert.equal(locked,1);
  db.exec('DELETE FROM memory_project_scopes');assert.equal(await validate(),false);
 }finally{db.close();}
});
