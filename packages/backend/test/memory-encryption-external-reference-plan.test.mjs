import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';
import {sqliteStepsOn} from '../src/repositories/sql-steps.ts';
import {captureExternalCopyReferencesStep} from '../src/memory/encryption/external-copy-manifest.ts';
import {prepareAuthorizedExternalReferencePlan} from '../src/memory/encryption/external-reference-plan.ts';
test('canonical project holds and mandatory live root permission bind each temporary reference',async()=>{
 const db=new Database(':memory:'),old=process.env.GIRRU_STORE_P3;process.env.GIRRU_STORE_P3='1';
 try{
 db.exec("CREATE TABLE memory_key_state(owner_id TEXT,keyed_by TEXT);INSERT INTO memory_key_state VALUES('owner','id');CREATE TABLE chat_projects(id TEXT,slug TEXT,user_id TEXT,folder TEXT);CREATE TABLE memory_project_design(owner_id TEXT,slug TEXT,found TEXT,previous TEXT);CREATE TABLE change_scopes(scope TEXT,owner_id TEXT);CREATE TABLE memory_encryption_projection_holds(scope TEXT,owner_id TEXT,hold_id TEXT,generation INTEGER,state TEXT)");
 db.prepare('INSERT INTO chat_projects VALUES(?,?,?,?)').run('distinct-id','legacy-slug','owner','/tmp/synthetic-current-root');
 db.prepare('INSERT INTO memory_project_design VALUES(?,?,?,?)').run('owner','legacy-slug',JSON.stringify({root:'/tmp/synthetic-design-root'}),JSON.stringify({root:'/tmp/synthetic-old-root'}));
 db.prepare('INSERT INTO change_scopes VALUES(?,?)').run('project:distinct-id','owner');
 db.prepare('INSERT INTO memory_encryption_projection_holds VALUES(?,?,?,?,?)').run('project:distinct-id','owner','receipt',1,'held');
 const runner=sqliteStepsOn(db),references=await runner.tx(()=>captureExternalCopyReferencesStep('owner')),hold={scope:'project:distinct-id',id:'receipt',generation:1};
 const make=(authorizeRoot,holds=[hold])=>prepareAuthorizedExternalReferencePlan({runner,ownerId:'owner',references,holds,authorizeRoot});
 const requests=[];const plan=await make(async request=>{requests.push(request);return true;});assert.equal(plan.length,3);assert.ok(plan.every(p=>p.scope==='project:distinct-id'));assert.equal(requests.length,6);assert.ok(requests.every(r=>r.purpose==='encrypted-forget-plan'));await assert.rejects(make(async request=>request.purpose==='discovery-scan'));
 await assert.rejects(make(async()=>false));await assert.rejects(make(async()=>true,[]));await assert.rejects(make(async()=>true,[{...hold,generation:2}]));
 let calls=0;await assert.rejects(make(async()=>++calls<=3));
 await assert.rejects(make(async()=>{db.prepare("UPDATE memory_encryption_projection_holds SET state='released'").run();return true;}));
 db.prepare("UPDATE memory_encryption_projection_holds SET state='held'").run();
 await assert.rejects(make(async()=>{db.prepare("UPDATE chat_projects SET folder='/tmp/synthetic-changed-root'").run();return true;}));
 }finally{db.close();if(old===undefined)delete process.env.GIRRU_STORE_P3;else process.env.GIRRU_STORE_P3=old;}
});
