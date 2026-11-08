import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {createDeviceHarness,until} from './fixtures/device-full-harness.mjs';
const h=await createDeviceHarness({manualPresence:false,waitForDirect:false,pgUrls:process.env.DEVICE_FULL_PG_URLS?.split(',')});test.after(()=>h.close());
test('configured composition advertises automatically and stopped peer presence expires',async()=>{
 await h.start();await until(async()=>{const views=await Promise.all(h.peers.map(p=>p.request('view')));return views.every(v=>v.devices.every(d=>d.state==='available'));},22000);await h.peers[2].request('disconnect');await until(async()=>{const v=await h.peers[0].request('view');return v.devices.some(d=>d.id===h.peers[2].identity.id&&d.state==='offline');},19000);
});
test('reviewed artifact project mapping stays fenced at the actual write transaction',async()=>{
 const [a,b]=h.peers;await a.request('task',{target:b.identity.id,taskId:'artifact_review_task'});await h.approveTask(1,'artifact_review_task');await until(async()=> (await a.request('view')).attempts.some(t=>t.taskId==='artifact_review_task'&&t.state==='completed'));await a.request('create-source',{category:'artifact',name:'review.txt',base64:Buffer.from('Explicit selected artifact').toString('base64')});const selected=await a.request('select',{peer:b.identity.id,selection:{category:'artifact',localId:'artifact',logicalId:'review_artifact',revision:1,parentHash:null,taskId:'artifact_review_task',projectId:a.identity.projectId,path:'review.txt'}});await until(async()=> (await b.request('sync')).records.find(r=>r.id===selected.recordId));await b.request('review',{id:selected.recordId,mapping:{expectedRevision:0}});await b.request('change-artifact-project');const result=await h.approveRecord(1,selected.recordId);assert.ok(result.result.error);assert.equal((await b.request('sync-read',{id:selected.recordId})).state,'unknown');const target=await b.request('source-path');assert.equal(existsSync(join(target.root,'.girru','shared-artifacts')),false);assert.equal((await b.request('stats')).effects.length,1);
});
