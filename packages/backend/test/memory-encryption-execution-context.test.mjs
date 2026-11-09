// Deferred source fixtures. Final execution must use synthetic HOME/data only.
import test from 'node:test';import assert from 'node:assert/strict';
import {withSelectedMemoryExecution} from '../src/memory/encryption/execution-context.ts';
import {sql,one,run} from '../src/repositories/sql-steps.ts';
import {getDatabase} from '../src/db/database.ts';
import {dataRoot} from '../src/config/data-root.ts';
function fixture(){let calls=0;const runner={dialect:'sqlite',inTransaction:()=>false,async read(step){calls++;let next=step.next();while(!next.done){next=step.next(next.value.kind==='dialect'?'sqlite':{value:'synthetic-selected'});}return next.value;},async tx(body){return this.read(body());}};const refused=async()=>{throw Error('Unexpected adapter call');};return{calls:()=>calls,scope:{ownerId:'synthetic-owner',runner,storage:{},isCurrent:()=>true,context:refused,recall:refused,pinned:refused,trace:refused,traceTiming:refused,versions:refused,graph:refused}};}
test('legacy SQL uses selected runner but refuses writes and default database/profile access',async()=>{
 const f=fixture();let captured;
 await withSelectedMemoryExecution(f.scope,async()=>{
  assert.equal((await sql().read(one('SELECT value FROM synthetic_metadata'))).value,'synthetic-selected');
  await assert.rejects(sql().read(run('DELETE FROM memories')));assert.throws(()=>getDatabase());assert.throws(()=>dataRoot());captured=sql();
 });
 assert.equal(f.calls(),2);await assert.rejects(async()=>captured.read(one('SELECT value FROM synthetic_metadata')));
});
test('legacy read hooks dispatch to selected adapters without touching the default stores',async()=>{
 const {contextPack,messageRecall}=await import('../src/memory/context/pack.ts'),{pinnedFactsForReply}=await import('../src/memory/scopes/pinned.ts'),{saveTrace}=await import('../src/memory/context/trace.ts');
 const f=fixture(),calls=[];const pack={key:'synthetic',text:'SYNTHETIC ENCRYPTED CONTEXT',memoryChars:0,items:[],ids:[],validUntil:null,hit:false};
 await withSelectedMemoryExecution({...f.scope,context:async input=>{calls.push(['context',input.userId]);return pack;},recall:async input=>{calls.push(['recall',input.userId]);return{text:'',items:[],hit:false};},pinned:async owner=>{calls.push(['pinned',owner]);return{text:'',facts:[]};},trace:async trace=>{calls.push(['trace',trace.runId]);}},async()=>{
  assert.equal(await contextPack({userId:'synthetic-owner',agentId:'agent',drawers:[],persona:''}),pack);
  await messageRecall({userId:'synthetic-owner',drawers:[],query:'synthetic',pack,agentId:'agent'});
  await pinnedFactsForReply('synthetic-owner',null);await saveTrace({runId:'synthetic-run'});
 });assert.deepEqual(calls,[['context','synthetic-owner'],['recall','synthetic-owner'],['pinned','synthetic-owner'],['trace','synthetic-run']]);assert.equal(f.calls(),0);
});
test('legacy version-history entry dispatches to encrypted selected history',async()=>{
 const {memoryVersions}=await import('../src/memory/versions.ts');const f=fixture();let calls=0;
 await withSelectedMemoryExecution({...f.scope,versions:async(owner,id)=>{calls++;assert.equal(owner,'synthetic-owner');assert.equal(id,'synthetic-memory');return[{version:1,content:'SYNTHETIC AUTHORIZED HISTORY'}];}},async()=>{assert.deepEqual(await memoryVersions('synthetic-owner','synthetic-memory'),[{version:1,content:'SYNTHETIC AUTHORIZED HISTORY'}]);});assert.equal(calls,1);assert.equal(f.calls(),0);
});

test('legacy graph recall dispatches only to the selected encrypted graph adapter',async()=>{
 const {graphRecall}=await import('../src/memory/graph/recall.ts');const f=fixture();let seen;
 await withSelectedMemoryExecution({...f.scope,graph:async input=>{seen=input;return[];}},async()=>{assert.deepEqual(await graphRecall({userId:'synthetic-owner',drawers:[{kind:'owner'}]},'synthetic',{limit:3}),[]);});
 assert.equal(seen.userId,'synthetic-owner');assert.equal(seen.limit,3);assert.equal(f.calls(),0);
});
