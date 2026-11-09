// Deferred source fixtures; run only after the whole current task's code is complete.
import test from 'node:test';import assert from 'node:assert/strict';
import {renderScopedPinnedFacts} from '../src/memory/scopes/pinned.ts';
import {renderContextPackRows} from '../src/memory/context/pack.ts';
test('shared encrypted pack rendering keeps scope facts and existing pinned/topic order',()=>{
 const scopeFacts=renderScopedPinnedFacts([{id:'synthetic-pin',scope:'company',text:'Synthetic owner fact',position:0,createdBy:'owner',createdAt:'2026-11-06',updatedAt:'2026-11-06'}],null,null);
 const rows=[{id:'synthetic-memory',type:'fact',content:'Synthetic memory',metadata:null,importance_score:0.95,topic_key:null,dk:'owner',dkey:'',expiry_timestamp:null,created_at:'2026-11-06'}];
 const pack=renderContextPackRows({userId:'owner',agentId:'agent',drawers:[{kind:'owner'}],persona:'Synthetic persona',scopeFacts},rows,'synthetic-key');
 assert.equal(pack.key,'synthetic-key');assert.deepEqual(pack.ids,['synthetic-memory']);assert.equal(pack.items[0].kind,'fact');assert.equal(pack.items[1].kind,'memory');assert.ok(pack.text.indexOf('Synthetic persona')<pack.text.indexOf('Pinned facts'));assert.ok(pack.text.includes('Synthetic memory'));
});
