import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';
import {sqliteStepsOn} from '../src/repositories/sql-steps.ts';
import {captureExternalCopyReferencesStep,assertExternalCopyReferencesCurrentStep} from '../src/memory/encryption/external-copy-manifest.ts';
test('metadata references include previous design roots and orphan projections without opening paths',async()=>{
 const db=new Database(':memory:');try{
 db.exec('CREATE TABLE chat_projects(id TEXT,user_id TEXT,folder TEXT);CREATE TABLE memory_project_design(owner_id TEXT,slug TEXT,found TEXT,previous TEXT);CREATE TABLE change_scopes(scope TEXT,owner_id TEXT);CREATE TABLE projection_state(scope TEXT,target TEXT)');
 db.prepare('INSERT INTO chat_projects VALUES(?,?,?)').run('p','owner','/never/open/current');
 db.prepare('INSERT INTO chat_projects VALUES(?,?,?)').run('other','other-owner','/never/open/other');
 db.prepare('INSERT INTO memory_project_design VALUES(?,?,?,?)').run('owner','p',JSON.stringify({root:'/never/open/design',rules:['DO NOT TRANSPORT']}),JSON.stringify({root:'/never/open/previous'}));
 db.prepare('INSERT INTO change_scopes VALUES(?,?)').run('project:deleted','owner');db.prepare('INSERT INTO projection_state VALUES(?,?)').run('project:deleted','/never/open/deleted/.girru/brief.md');
 const runner=sqliteStepsOn(db),read=()=>runner.tx(()=>captureExternalCopyReferencesStep('owner'));
 const refs=await read();await runner.tx(()=>assertExternalCopyReferencesCurrentStep('owner',[...refs].reverse()));assert.equal(refs.length,4);assert.ok(refs.some(r=>r.kind==='previous-design-root'));assert.ok(!JSON.stringify(refs).includes('DO NOT TRANSPORT'));assert.ok(!JSON.stringify(refs).includes('other-owner'));
 db.prepare('UPDATE chat_projects SET folder=? WHERE user_id=?').run('/never/open/changed','owner');await assert.rejects(runner.tx(()=>assertExternalCopyReferencesCurrentStep('owner',refs)));db.prepare('UPDATE chat_projects SET folder=? WHERE user_id=?').run('/never/open/current','owner');
 for(const bad of ['invalid',JSON.stringify({root:42}),JSON.stringify({root:[]})]){db.prepare('UPDATE memory_project_design SET previous=?').run(bad);await assert.rejects(read());}
 db.prepare("UPDATE memory_project_design SET previous='{}'").run();db.prepare('UPDATE chat_projects SET folder=? WHERE user_id=?').run('x'.repeat(1048577),'owner');await assert.rejects(read());
 }finally{db.close();}
});

import {randomBytes} from 'node:crypto';
import {sealExternalReferenceSnapshot,openExternalReferenceSnapshot} from '../src/memory/encryption/external-copy-manifest.ts';
test('encrypted references are bound to owner/member/snapshot id and never authorize writes',()=>{
 const refs=[{kind:'project-root',scope:'synthetic-scope',path:'/never/open/private-root'}],context={ownerId:'synthetic-owner',memberId:'synthetic-member',recordId:'synthetic-snapshot',field:'ignored'},key=randomBytes(32);
 const cipher=sealExternalReferenceSnapshot(refs,context,key,'synthetic-key');
 assert.ok(!cipher.includes(refs[0].path));assert.deepEqual(openExternalReferenceSnapshot(cipher,context,key,'synthetic-key'),refs);
 for(const c of [{...context,ownerId:'other'},{...context,memberId:'other'},{...context,recordId:'other'}])assert.throws(()=>openExternalReferenceSnapshot(cipher,c,key,'synthetic-key'));
 const corrupted=JSON.parse(cipher);corrupted.c=(corrupted.c[0]==='A'?'B':'A')+corrupted.c.slice(1);assert.throws(()=>openExternalReferenceSnapshot(JSON.stringify(corrupted),context,key,'synthetic-key'));
 assert.throws(()=>sealExternalReferenceSnapshot([{...refs[0],authorized:true}],context,key,'synthetic-key'));
 assert.throws(()=>sealExternalReferenceSnapshot(Array.from({length:100},()=>({...refs[0],path:'x'.repeat(16384)})),context,key,'synthetic-key'));
});

import {assertExternalProjectionHoldsCurrentStep} from '../src/memory/encryption/external-copy-manifest.ts';
test('explicit hold receipts reject stale generation, wrong owner, duplicates and released state',async()=>{
 const db=new Database(':memory:');try{
 db.exec('CREATE TABLE memory_encryption_projection_holds(scope TEXT,owner_id TEXT,hold_id TEXT,generation INTEGER,state TEXT)');
 db.prepare('INSERT INTO memory_encryption_projection_holds VALUES(?,?,?,?,?)').run('project:synthetic','owner','receipt',2,'held');
 const runner=sqliteStepsOn(db),hold={scope:'project:synthetic',id:'receipt',generation:2};
 await runner.tx(()=>assertExternalProjectionHoldsCurrentStep('owner',[hold]));
 for(const receipts of [[],[hold,hold],[{...hold,generation:1}],[{...hold,id:'other'}]])await assert.rejects(runner.tx(()=>assertExternalProjectionHoldsCurrentStep('owner',receipts)));
 await assert.rejects(runner.tx(()=>assertExternalProjectionHoldsCurrentStep('other',[hold])));
 db.prepare("UPDATE memory_encryption_projection_holds SET state='released'").run();await assert.rejects(runner.tx(()=>assertExternalProjectionHoldsCurrentStep('owner',[hold])));
 }finally{db.close();}
});
