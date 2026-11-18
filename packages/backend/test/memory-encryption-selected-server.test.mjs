// Deferred source fixtures: execute only in the final whole-task synthetic verification round.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSelectedEncryptedMemoryServer} from '../src/api/selected-memory-server.ts';
const launch='s'.repeat(43);
function fixture(){
 let state='new',closed=0,activeOperations=0;const calls=[];
 const runtime={ownerId:'synthetic-owner',status:()=>state,async start(){assert.ok(activeOperations>0);state='ready';},async close(){state='closed';closed++;},async listOwnerIds(input){calls.push(input);return{ids:['synthetic-record'],next:null};},async addPinnedFact(input){calls.push(input);return{id:'synthetic-pin'};},async updateOwnerAuxiliary(input){calls.push(input);},async summarizeWeekly(){return{id:'synthetic-summary'};}};
 const host={runtime,async authenticateOwner(token){assert.ok(activeOperations>0);if(token!=='synthetic-owner-token')throw Error('Denied');return{id:runtime.ownerId,role:'owner'};},createBridge(){throw Error('No synthetic bridge enrolled');}};
 return{host,calls,closed:()=>closed,runOperation:async operation=>{activeOperations++;try{return await operation();}finally{activeOperations--;}}};
}
test('selected HTTP host requires launch proof and selected owner, exposes no legacy API',async()=>{
 const f=fixture(),server=await buildSelectedEncryptedMemoryServer({host:f.host,runOperation:f.runOperation,launchToken:launch});
 try{const url=await server.listen();
  assert.equal((await fetch(url+'/health')).status,403);
  const headers={'x-agent-player-launch':launch};assert.equal((await fetch(url+'/api/memory/encryption/status',{headers})).status,401);
  const signed={...headers,authorization:'Bearer synthetic-owner-token'};
  assert.deepEqual(await (await fetch(url+'/api/memory/encryption/status',{headers:signed})).json(),{state:'ready',activationReady:false});
  assert.equal((await fetch(url+'/api/memory/import',{method:'POST',headers:signed})).status,404);
  const rows=await fetch(url+'/api/memory/encryption/rows/memory_pinned_facts?limit=2',{headers:signed});assert.equal(rows.status,200);assert.deepEqual(f.calls.pop(),{table:'memory_pinned_facts',after:undefined,limit:2});
  assert.equal((await fetch(url+'/api/memory/encryption/rows/memory_pinned_facts?limit=201',{headers:signed})).status,400);
  const json={...signed,'content-type':'application/json'};
  assert.equal((await fetch(url+'/api/memory/encryption/pinned-facts',{method:'POST',headers:json,body:JSON.stringify({scope:'owner',text:'Synthetic fact'})})).status,200);
  assert.deepEqual(f.calls.pop(),{scope:'owner',text:'Synthetic fact'});
  assert.equal((await fetch(url+'/api/memory/encryption/pinned-facts',{method:'POST',headers:json,body:'[]'})).status,400);
 }finally{await server.close();}assert.equal(f.closed(),1);
});
test('selected HTTP host refuses missing launch enrollment before creating a listener',async()=>{
 const f=fixture();await assert.rejects(buildSelectedEncryptedMemoryServer({host:f.host,runOperation:f.runOperation,launchToken:''}));assert.equal(f.host.runtime.status(),'new');
});
