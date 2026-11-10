// D11 (owner, 2026-11-10): signing in with Google on the app adds the computer; the other computers are told (Keep / Forget).
import test from 'node:test';import assert from 'node:assert/strict';import {createDproHarness} from './fixtures/dpro-harness.mjs';
const h=await createDproHarness(),{peers,until}=h;test.after(()=>h.close());
async function connect(p){await p.request('connect-start',{kind:'connect'});await until(async()=> (await p.request('flow-status')).state==='ready');return p.request('connect-finish');}
test('the second computer is added by signing in, and the first one is told about it',async()=>{
 const [a,b]=peers;await connect(a);await connect(b);
 assert.equal((await b.request('status')).view.deviceStatus,'approved');
 const told=await until(async()=>{const s=await a.request('status');return s.pairing?.addedWithCode?.length?s.pairing.addedWithCode:false;});
 assert.equal(told[0].deviceId,(await b.request('status')).view.deviceId);
});
test('the computer added by signing in trusts the first one, so it can ask it what it shares',async()=>{
 const [a,b]=peers,first=(await a.request('status')).view.deviceId;
 // The first computer presses Keep (as on the Mac), which pins the new one there.
 const added=await until(async()=>{const s=await a.request('status');return s.pairing?.addedWithCode?.[0]??false;});
 await a.request('keep-added',{deviceId:added.deviceId,publicKey:added.publicKey,checkCode:added.checkCode,confirmed:true});
 // Before the fix every request from b to a failed with account_peer_pin_required.
 const result=await until(async()=>{await b.request('status');try{return await b.request('source',{deviceId:first});}catch(e){if(/account_peer_pin_required/.test(e.message))return false;throw e;}});
 assert.ok(result);
});
