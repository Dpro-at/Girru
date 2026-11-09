import test from 'node:test';
import assert from 'node:assert/strict';
import {captureOwnerAuxiliaryBundle,forgetAuxiliaryMemories,AUXILIARY_TABLES,AUXILIARY_V2_TABLES} from '../src/memory/encryption/auxiliary-bundle.ts';
const ownerId='synthetic-owner',parents={memories:[{id:'synthetic-memory',user_id:ownerId}],imports:[]};
function bundle(){return{v:2,ownerId,invalidatedPreviewCount:0,rows:Object.fromEntries(AUXILIARY_V2_TABLES.map(table=>[table,[]]))};}
test('auxiliary v1 remains exactly three surfaces and cannot silently claim v2 coverage',()=>{
 const old={v:1,ownerId,invalidatedPreviewCount:0,rows:Object.fromEntries(AUXILIARY_TABLES.map(table=>[table,[]]))};
 assert.deepEqual(Object.keys(captureOwnerAuxiliaryBundle(old,parents).rows),[...AUXILIARY_TABLES]);
 assert.throws(()=>captureOwnerAuxiliaryBundle({...old,v:2},parents));assert.throws(()=>captureOwnerAuxiliaryBundle({...bundle(),v:1},parents));
});
test('auxiliary v2 losslessly preserves exact legacy trust and reply-use metadata',()=>{
 const value=bundle();value.rows.memory_trust=[{memory_id:'synthetic-memory',user_id:ownerId,source:'agent',content_hash:'a'.repeat(32),confidence:0.5,verified:0,use_weight:0,uses:1,last_used_at:'2026-11-01T00:00:00.000Z',flags:'["corrected-after-use"]',enrich_state:'ready',created_at:'2026-11-01T00:00:00.000Z',updated_at:'2026-11-01T00:00:00.000Z'}];
 value.rows.memory_trust_sources=[{memory_id:'synthetic-memory',user_id:ownerId,source_key:'agent:synthetic-agent',kind:'agent',content_hash:'a'.repeat(32),at:'2026-11-01T00:00:00.000Z'}];
 value.rows.memory_recall_uses=[{run_id:'synthetic-run',memory_id:'synthetic-memory',user_id:ownerId,agent_id:'synthetic-agent',created_at:'2026-11-01T00:00:00.000Z'}];
 const captured=captureOwnerAuxiliaryBundle(value,parents);assert.deepEqual(captured,value);const forgotten=forgetAuxiliaryMemories(captured,parents,['synthetic-memory']);for(const rows of Object.values(forgotten.rows))assert.equal(rows.length,0);assert.equal(captured.rows.memory_trust.length,1);
 assert.throws(()=>captureOwnerAuxiliaryBundle({...value,rows:{...value.rows,memory_trust_sources:[{...value.rows.memory_trust_sources[0],user_id:'another-owner'}]}},parents));
 assert.throws(()=>captureOwnerAuxiliaryBundle({...value,rows:{...value.rows,memory_recall_uses:[value.rows.memory_recall_uses[0],value.rows.memory_recall_uses[0]]}},parents));
});
