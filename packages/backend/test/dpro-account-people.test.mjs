process.env.GIRRU_TEST_PAIRING_ONLY='1';
// CP17: the desktop reaches the account service's people operations through the owner-only runtime.
import test from 'node:test';import assert from 'node:assert/strict';import {createDproHarness} from './fixtures/dpro-harness.mjs';
const h=await createDproHarness(),{peers,until}=h;test.after(()=>h.close());
test('your ID, nickname and an empty people list come from the account service',async()=>{
 const [a]=peers;await a.request('connect-start',{kind:'connect'});await until(async()=>(await a.request('flow-status')).state==='ready');await a.request('connect-finish');
 const me=await a.request('people',{action:'me'});
 assert.match(me.publicId,/^GR-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
 assert.deepEqual(await a.request('people',{action:'nickname',nickname:'Owner.One'}),{publicId:me.publicId,nickname:'owner.one'});
 assert.deepEqual(await a.request('people',{action:'find',query:me.publicId}),{found:false});
 assert.deepEqual(await a.request('people',{action:'list'}),{people:[],blocked:[]});
 assert.deepEqual(await a.request('people',{action:'requests'}),{incoming:[],outgoing:[]});
 await assert.rejects(()=>a.request('people',{action:'other'}),/input_invalid/);
 await assert.rejects(()=>a.request('people',{action:'me',secret:'x'}),/input_invalid/);
});
