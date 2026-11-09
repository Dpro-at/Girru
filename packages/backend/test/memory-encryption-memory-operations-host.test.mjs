import {fileURLToPath as backendFixtureFileURLToPath} from 'node:url';
import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,existsSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const backend = backendFixtureFileURLToPath(new URL('../',import.meta.url)),root=realpathSync(mkdtempSync(join(tmpdir(),'girru-memory-operations-'))),profile=join(root,'profile'),memory=join(profile,'memory');mkdirSync(memory,{recursive:true});process.chdir(root);process.env.HOME=root;process.env.USERPROFILE=root;process.env.DATABASE_PATH=join(profile,'test.sqlite');process.env.AGENT_PLAYER_DATA_DIR=profile;process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.GIRRU_STORE_P9='1';
const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('No network in temporary memory operation acceptance');};const load=p=>import(join(backend,'src',p));
const {getDatabase,closeDatabase}=await load('db/database.ts'),db=getDatabase();await db.initialize();const {sqliteStepsOn}=await load('repositories/sql-steps.ts'),runner=sqliteStepsOn(db.getDb());
const {generateToken}=await load('auth/jwt.ts'),{recordSession}=await load('auth/sessions.ts'),{createMemoryUnlockSession}=await load('memory/encryption/unlock-session.ts'),{encryptMemoryRow,decryptMemoryRow}=await load('memory/encryption/row-codec.ts');
const {initializeEncryptedTopicIndexStep}=await load('memory/encryption/topic-index.ts'),{createMemoryReadAuditStore}=await load('memory/encryption/read-audit.ts'),{createEncryptedMemoryOperationsHost}=await load('memory/encryption/memory-operations-host.ts');
const scope={ownerId:'operations-owner',memberId:'operations-member'},key=randomBytes(32),keyId='operations-key',lookup=randomBytes(32);
db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,token_version) VALUES('operations-owner','operations@example.test','operations-owner','x','owner','active',1)").run();await runner.tx(initializeEncryptedTopicIndexStep);
const token=generateToken(scope.ownerId,1,'5m');await recordSession(token,'Unknown device');const audit=createMemoryReadAuditStore(runner,scope.ownerId,randomBytes(32));await audit.initialize();let head=audit.genesis(),reads=0;const recordRead=async intent=>{reads++;head=await audit.append(head,intent);return true;};
// Explicit empty auxiliary native-journal double; this fixture does not establish OS custody.
const auxiliaryMutationJournal=async(before,after)=>{assert.deepEqual(before,[]);assert.deepEqual(after,[]);return{purpose:'memory-auxiliary',isCurrent:()=>true,commit:async()=>true};};
const session=createMemoryUnlockSession();session.unlock(key,keyId,scope);const host=createEncryptedMemoryOperationsHost({runner,token,session,lookupKey:lookup,recordRead,auxiliaryMutationJournal,profile:{profileRoot:profile,memoryRoot:memory,exportFiles:[],indexRunner:runner}});
function seed(id){db.prepare("INSERT INTO memories(id,user_id,type,content,created_at,drawer_kind,drawer_key,topic_key) VALUES(?,?,?,'SYNTHETIC_PRIVATE_MEMORY',datetime('now'),'owner','',NULL)").run(id,scope.ownerId,'fact');const plain=db.prepare('SELECT * FROM memories WHERE id=?').get(id),cipher=encryptMemoryRow('memories',plain,scope,key,keyId),fields=Object.keys(cipher);db.prepare('UPDATE memories SET '+fields.map(f=>f+'=?').join(',')+' WHERE id=?').run(...fields.map(f=>cipher[f]),id);return plain;}
test('one explicit operations host trashes/restores safely, permanently forgets owned copies and refuses resurrection',async()=>{
 await assert.rejects(host.deleteToTrash('not-started'));await host.start();assert.equal(host.status(),'ready');
 const plain=seed('operations-memory');await host.deleteToTrash(plain.id);assert.equal(db.prepare('SELECT id FROM memories WHERE id=?').get(plain.id),undefined);await host.restore(plain.id);assert.equal(decryptMemoryRow('memories',db.prepare('SELECT * FROM memories WHERE id=?').get(plain.id),scope,key,keyId).content,plain.content);
 const owned=join(memory,scope.ownerId);mkdirSync(owned,{recursive:true});const file=join(owned,'fact-'+plain.id+'.md');writeFileSync(file,plain.content);
 const result=await host.forget(plain.id);assert.equal(result.completeForget,true);assert.equal(existsSync(file),false);assert.equal(db.prepare('SELECT id FROM memories WHERE id=?').get(plain.id),undefined);await assert.rejects(host.restore(plain.id));assert.equal(session.isUnlocked(),false);session.unlock(key,keyId,scope);await audit.verify(head);
});
test('historical checkpoint evidence blocks Trash/restore/forget before decrypt audit even after project metadata disappears',async()=>{
 const plain=seed('historical-memory');db.prepare('INSERT INTO memory_encryption_external_plan_checkpoints(id,owner_id,snapshot_id,ciphertext,created_at) VALUES(?,?,?,?,?)').run('historical-evidence',scope.ownerId,'old-copy','opaque-not-opened','2026-01-01');const before=reads;
 for(const operation of [()=>host.deleteToTrash(plain.id),()=>host.restore(plain.id),()=>host.forget(plain.id)]){session.unlock(key,keyId,scope);await assert.rejects(operation());assert.equal(reads,before);assert.ok(db.prepare('SELECT id FROM memories WHERE id=?').get(plain.id));}
 session.unlock(key,keyId,scope);await host.stop();assert.equal(host.status(),'closed');assert.equal(session.isUnlocked(),false);await assert.rejects(host.restore(plain.id));
});
test.after(async()=>{await host.stop();closeDatabase();process.chdir(backend);globalThis.fetch=oldFetch;rmSync(root,{recursive:true,force:true});});
// Deferred integration fixture for the final whole-task verification round.
test('agent write revocation inside the mutation transaction prevents source deletion',async()=>{
 const {captureEncryptedMutationGuard}=await load('memory/encryption/run-mutation-guard.ts'),{run}=await load('repositories/sql-steps.ts');
 db.prepare('DELETE FROM memory_encryption_external_plan_checkpoints').run();
 db.prepare("INSERT INTO agents_config(id,name) VALUES('mutation-agent','Synthetic mutation agent')").run();
 db.prepare("INSERT INTO agent_permissions(agent_id,memory_read,memory_write,modes,version) VALUES('mutation-agent','[\"owner\"]','[\"owner\"]','{}',1)").run();
 const plain=seed('guarded-mutation-memory');session.unlock(key,keyId,scope);
 const guard=await captureEncryptedMutationGuard({runner,token,session,id:plain.id,run:{agentId:'mutation-agent',delegatedFrom:[],project:null,drawers:[{kind:'owner'}],audience:'owner'}});
 db.prepare("UPDATE agent_permissions SET memory_write='[]',version=2 WHERE agent_id='mutation-agent'").run();
 await assert.rejects(runner.tx(function*(){yield* guard(plain);yield* run('DELETE FROM memories WHERE id=?',plain.id);},{immediate:true}));
 assert.ok(db.prepare('SELECT id FROM memories WHERE id=?').get(plain.id));
});
