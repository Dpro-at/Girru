import {all,run} from '../src/repositories/sql-steps.ts';
// Whole-task final verification only. Real SQLite and disposable PostgreSQL, synthetic identities.
import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {createEncryptionDriverFixture} from './fixtures/memory-encryption-drivers.mjs';
for(const driver of ['sqlite','postgres'])test(`${driver}: question scopes, owner archive and head-bound ciphertext undo`,async()=>{
 const fixture=await createEncryptionDriverFixture({driver,name:'questions'});const execute=(sql,params=[])=>fixture.runner.tx(function*(){return yield* run(sql,...params);}),query=(sql,params=[])=>fixture.runner.read(all(sql,...params));let key,session,registry;
 try{const {generateToken,verifyToken}=await import('../src/auth/jwt.ts'),{authSessionTokenHash}=await import('../src/auth/sessions.ts'),{memoryRowSurfaceManifest,encryptMemoryRow}=await import('../src/memory/encryption/row-codec.ts'),{createMemoryUnlockSession}=await import('../src/memory/encryption/unlock-session.ts'),{createEncryptedRunAdmissionRegistry}=await import('../src/memory/encryption/run-admission.ts'),{createAuthenticatedEncryptedQuestion,readAuthenticatedEncryptedQuestions,mutateAuthenticatedEncryptedQuestion}=await import('../src/memory/encryption/questions-gateway.ts');
 const scope={ownerId:'synthetic-question-owner',memberId:'synthetic-question-member'},agentId='synthetic-question-agent',keyId='synthetic-question-key';key=randomBytes(32);if(!process.env.JWT_SECRET)process.env.JWT_SECRET=randomBytes(64).toString('hex');
 const ddl=[
 'users(id TEXT PRIMARY KEY,role TEXT,status TEXT,token_version INTEGER)',
 'auth_sessions(id TEXT PRIMARY KEY,user_id TEXT,token_hash TEXT,token_version INTEGER,expires_at BIGINT,revoked_at BIGINT)',
 'agents_config(id TEXT PRIMARY KEY)',
 'agent_permissions(agent_id TEXT PRIMARY KEY,memory_read TEXT,memory_write TEXT,shared_memory INTEGER,modes TEXT,version INTEGER)',
 'memory_access_versions(owner_id TEXT PRIMARY KEY,version INTEGER)',
 'memory_access_rules(id TEXT,owner_id TEXT,scope_kind TEXT,scope_id TEXT,agent_id TEXT,drawer_kind TEXT,read_mode TEXT,write_mode TEXT,ends_at TEXT,reason TEXT,created_by TEXT,created_at TEXT)',
 'memory_access_scope_rules(id TEXT,owner_id TEXT,scope_kind TEXT,scope_id TEXT,agent_id TEXT,drawer_kind TEXT,read_mode TEXT,write_mode TEXT,ends_at TEXT,reason TEXT,created_by TEXT,created_at TEXT)',
 'memory_role_templates(id TEXT,owner_id TEXT,name TEXT,norm_name TEXT,memory_read TEXT,memory_write TEXT,scope_read TEXT,scope_write TEXT)',
 'memory_agent_roles(owner_id TEXT,agent_id TEXT,template_id TEXT)',
 'memory_project_scopes(owner_id TEXT,slug TEXT,department_id TEXT,archived_at TEXT)'];for(const statement of ddl)await fixture.exec('CREATE TABLE '+statement);
 await execute('INSERT INTO users VALUES(?,?,?,?)',[scope.ownerId,'owner','active',1]);await execute('INSERT INTO agents_config VALUES(?)',[agentId]);await execute('INSERT INTO agent_permissions VALUES(?,?,?,?,?,?)',[agentId,'["project"]','["project"]',0,'{}',1]);
 const token=generateToken(scope.ownerId,1,'5m'),decoded=verifyToken(token);await execute('INSERT INTO auth_sessions VALUES(?,?,?,?,?,NULL)',['synthetic-question-session',scope.ownerId,authSessionTokenHash(decoded.jti),1,decoded.exp*1000]);
 for(const table of ['memories','memory_open_questions']){const s=memoryRowSurfaceManifest().find(s=>s.table===table);await fixture.exec(`CREATE TABLE ${table}(${[s.owner,s.id,...s.bound,...s.clear,...s.text,...s.binary].map(field=>field+' '+(s.binary.includes(field)?driver==='postgres'?'BYTEA':'BLOB':'TEXT')+(field===s.id?' PRIMARY KEY':'')).join(',')})`);}
 let head=0;const anchor=()=>({v:1,...scope,authorityId:'synthetic-question-authority',keyId,epoch:1,forgetSequence:head,forgetMac:String(head).repeat(64)}),captureAuthority=async()=>{const value=anchor();return{anchor:value,isCurrent:()=>value.forgetSequence===head};};session=createMemoryUnlockSession();session.unlock(key,keyId,scope);registry=createEncryptedRunAdmissionRegistry({...scope,profileId:'synthetic-question-profile',captureAuthority,captureProfile:async()=>({profileId:'synthetic-question-profile',storageId:'synthetic-question-storage',isCurrent:()=>true})});
 const run={agentId,delegatedFrom:[],project:'project-a',drawers:[{kind:'project',key:'project-a'},{kind:'project',key:'project-b'}],audience:'owner'},input={runner:fixture.runner,token,session,captureAuthority,recordRead:async()=>true};let id;
 const admission=await registry.admitRun({runId:'synthetic-question-run',ownerId:scope.ownerId,agentId,kind:'chat',unknownSources:[]});await admission.run(async()=>{const first=await createAuthenticatedEncryptedQuestion({...input,run,question:'SYNTHETIC_PRIVATE_QUESTION?'});id=first.id;assert.equal(first.alreadyAsked,false);assert.deepEqual(await createAuthenticatedEncryptedQuestion({...input,run,question:'SYNTHETIC_PRIVATE_QUESTION?'}),{id,alreadyAsked:true});});
 assert.equal((await readAuthenticatedEncryptedQuestions({...input,run}))[0].question,'SYNTHETIC_PRIVATE_QUESTION?');assert.deepEqual(await readAuthenticatedEncryptedQuestions({...input,run:{...run,drawers:[run.drawers[0]]}}),[]);
 const stored=(await query('SELECT * FROM memory_open_questions WHERE id=?',[id]))[0];assert.equal(String(stored.question).includes('SYNTHETIC_PRIVATE_QUESTION'),false);
 await execute('UPDATE memory_open_questions SET question=? WHERE id=?',['unopened-invalid-ciphertext',id]);assert.deepEqual(await readAuthenticatedEncryptedQuestions({...input,run:{...run,drawers:[run.drawers[0]]}}),[]);await execute('UPDATE memory_open_questions SET question=? WHERE id=?',[stored.question,id]);
 assert.deepEqual(await mutateAuthenticatedEncryptedQuestion({...input,id,operation:'delete'}),{id,undo:true});assert.deepEqual(await readAuthenticatedEncryptedQuestions(input),[]);assert.equal((await mutateAuthenticatedEncryptedQuestion({...input,id,operation:'restore'})).question,'SYNTHETIC_PRIVATE_QUESTION?');
 await mutateAuthenticatedEncryptedQuestion({...input,id,operation:'delete'});head++;await assert.rejects(mutateAuthenticatedEncryptedQuestion({...input,id,operation:'restore'}));session.unlock(key,keyId,scope);assert.deepEqual(await readAuthenticatedEncryptedQuestions(input),[]);
 }finally{registry?.close();session?.lock();key?.fill(0);await fixture.close();}
});
