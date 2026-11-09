// Deferred fixtures; the final harness supplies only disposable SQLite/PostgreSQL databases.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createEncryptionDriverFixture} from './fixtures/memory-encryption-drivers.mjs';
import {isolateNewControlMemorySinks} from '../src/memory/encryption/control-content-isolation.ts';
async function fixture(t,driver='sqlite'){
 const db=await createEncryptionDriverFixture({driver,name:'control-content-isolation'});t.after(()=>db.close());
 await db.exec('CREATE TABLE memories(id TEXT PRIMARY KEY,content TEXT); CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT)');
 let current=true;return{db,revoke(){current=false;},input:{runner:db.runner,lease:{kind:'new-app-owned-control',profileId:'synthetic-profile',storageId:'synthetic-control',isCurrent:()=>current}}};
}
test('empty control memory writes refuse while unrelated control rows remain writable',async t=>{
 const f=await fixture(t),guard=await isolateNewControlMemorySinks(f.input);await guard.verify();
 await assert.rejects(()=>f.db.exec("INSERT INTO memories VALUES('synthetic','must not persist')"),/encrypted_control_content_disabled/);
 await f.db.exec("INSERT INTO users VALUES('synthetic-owner','owner')");assert.equal((await f.db.query('SELECT count(*) n FROM users'))[0].n,1);
 assert.equal((await f.db.query('SELECT count(*) n FROM memories'))[0].n,0);
});
test('nonempty control refuses without altering or deleting payload',async t=>{
 const f=await fixture(t);await f.db.exec("INSERT INTO memories VALUES('synthetic','preserve this synthetic payload')");
 await assert.rejects(()=>isolateNewControlMemorySinks(f.input));assert.equal((await f.db.query('SELECT content FROM memories'))[0].content,'preserve this synthetic payload');
 assert.equal((await f.db.query("SELECT count(*) n FROM sqlite_master WHERE type='trigger'"))[0].n,0);
});
test('revoked actual control lease prevents installation and later validation',async t=>{
 const f=await fixture(t),guard=await isolateNewControlMemorySinks(f.input);f.revoke();await assert.rejects(()=>guard.verify());await assert.rejects(()=>isolateNewControlMemorySinks(f.input));
});
test('later plaintext sink schema is rejected until the trusted bootstrap isolates it',async t=>{
 const f=await fixture(t),guard=await isolateNewControlMemorySinks(f.input);await f.db.exec('CREATE TABLE memory_open_questions(id TEXT PRIMARY KEY,question TEXT)');await assert.rejects(()=>guard.verify());
});
test('virtual indexes require a real no-legacy-index bootstrap and are not dropped',async t=>{
 const f=await fixture(t);await f.db.exec('CREATE VIRTUAL TABLE memory_fts USING fts5(content)');await assert.rejects(()=>isolateNewControlMemorySinks(f.input));assert.equal((await f.db.query("SELECT count(*) n FROM sqlite_master WHERE name='memory_fts'"))[0].n,1);
});
test('PostgreSQL does not inherit an unproved SQLite isolation contract',async t=>{
 const f=await fixture(t,'postgres');await assert.rejects(()=>isolateNewControlMemorySinks(f.input));
});
