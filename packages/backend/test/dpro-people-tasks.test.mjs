process.env.GIRRU_TEST_PAIRING_ONLY='1';
// CP17 D: two different Girru accounts link, then one sends a task to the other through the real relay.
// Nothing runs until the receiver allows it; only the answer goes back.
import test from 'node:test';import assert from 'node:assert/strict';import {createDproHarness} from './fixtures/dpro-harness.mjs';
const h=await createDproHarness({subjects:['111111','222222','333333']}),{peers,until}=h;test.after(()=>h.close());
const [mohamed,sara,stranger]=peers;
async function connect(p){await p.request('connect-start',{kind:'connect'});await until(async()=>(await p.request('flow-status')).state==='ready');return p.request('connect-finish');}
let link;
test('two accounts link with the 90-second code',async()=>{
 for(const p of [mohamed,sara,stranger])await connect(p);
 const [m,s]=[await mohamed.request('people',{action:'me'}),await sara.request('people',{action:'me'})];
 await sara.request('people',{action:'nickname',nickname:'sara.dev'});
 assert.equal((await mohamed.request('people',{action:'find',query:'sara.dev'})).found,true);
 await mohamed.request('people',{action:'request',publicId:s.publicId});
 const incoming=(await sara.request('people',{action:'requests'})).incoming[0];
 assert.equal(incoming.person.publicId,m.publicId);
 assert.equal((await sara.request('people',{action:'accept',linkId:incoming.linkId,code:incoming.code,confirmed:true})).linked,true);
 link=(await mohamed.request('people',{action:'list'})).people[0];
 assert.equal(link.person.nickname,'sara.dev');
 await sara.request('people',{action:'list'});
});
test('a task to a person waits for their Allow; Decline goes back to the sender',async()=>{
 const sent=await until(async()=>{try{return await mohamed.request('people',{action:'send',linkId:link.linkId,text:'Say which branch you are on.'});}catch{return null;}});
 assert.equal(sent.sent,true);
 const waiting=await until(async()=>(await sara.request('people',{action:'tasks'})).tasks.find(t=>t.id===sent.taskId&&t.state==='waiting'));
 assert.equal(waiting.direction,'in');assert.equal(waiting.person.name,(await mohamed.request('people',{action:'me'})).publicId);
 assert.equal(waiting.text,'Say which branch you are on.');
 assert.equal((await mohamed.request('people',{action:'tasks'})).tasks[0].state,'waiting');
 await assert.rejects(()=>sara.request('people',{action:'allow',taskId:sent.taskId}),/input_invalid/,'Allow needs an explicit confirmation');
 assert.deepEqual(await sara.request('people',{action:'decline-task',taskId:sent.taskId}),{declined:true});
 await until(async()=>(await mohamed.request('people',{action:'tasks'})).tasks.find(t=>t.id===sent.taskId)?.state==='declined');
});
test('Allow starts it in the receiver\'s own chat and the result goes back',async()=>{
 const sent=await until(async()=>{try{return await mohamed.request('people',{action:'send',linkId:link.linkId,text:'Report the date.'});}catch{return null;}});
 await until(async()=>(await sara.request('people',{action:'tasks'})).tasks.find(t=>t.id===sent.taskId));
 // The fixture has no model: the run either answers or ends; either way the sender learns the outcome.
 await sara.request('people',{action:'allow',taskId:sent.taskId,confirmed:true}).catch(()=>{});
 const back=await until(async()=>{const t=(await mohamed.request('people',{action:'tasks'})).tasks.find(x=>x.id===sent.taskId);return t&&t.state!=='waiting'&&t.state!=='running'?t:null;});
 assert.ok(['done','failed'].includes(back.state));assert.ok(back.answer.length>0);
});
test('someone not linked cannot send a task; the link is needed both ways',async()=>{
 await assert.rejects(()=>stranger.request('people',{action:'send',linkId:link.linkId,text:'hello'}),/unavailable/);
 await sara.request('people',{action:'remove',linkId:link.linkId,confirmed:true});
 await assert.rejects(()=>mohamed.request('people',{action:'send',linkId:link.linkId,text:'still there?'}),/unavailable/);
});
