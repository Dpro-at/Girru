// B2: a second computer joins after a Yes on the first one (both show the same pictures), a third joins with the account's authenticator code.
import test from 'node:test';import assert from 'node:assert/strict';import {createDproHarness} from './fixtures/dpro-harness.mjs';
const T=await import('../src/auth/verification/totp.ts');
const h=await createDproHarness(),{peers,until}=h;test.after(()=>h.close());
async function connect(p){await p.request('connect-start',{kind:'connect'});await until(async()=> (await p.request('flow-status')).state==='ready');return p.request('connect-finish');}
test('Yes on the first computer adds the second; both computed the same pictures without carrying a code',async()=>{
 const [a,b]=peers;await connect(a);await connect(b);
 assert.equal((await b.request('status')).view.deviceStatus,'pending');
 let mine,theirs;
 await until(async()=>{const sa=await a.request('status'),sb=await b.request('status');mine=sb.pairing?.self?.code;theirs=sa.pairing?.requests?.[0];return !!mine&&!!theirs?.code;});
 assert.match(mine,/^[a-f0-9]{12}$/);assert.equal(theirs.code,mine,'both computers show the same pictures');
 await assert.rejects(()=>a.request('approve-request',{deviceId:theirs.deviceId,comparisonCode:theirs.code,publicKey:theirs.publicKey,confirmed:false}));
 await assert.rejects(()=>a.request('approve-request',{deviceId:theirs.deviceId,comparisonCode:'0'.repeat(12),publicKey:theirs.publicKey,confirmed:true}),/comparison_changed/,'Yes counts only for the pictures shown');
 assert.deepEqual(await a.request('approve-request',{deviceId:theirs.deviceId,comparisonCode:theirs.code,publicKey:theirs.publicKey,confirmed:true}),{approved:true});
 await until(async()=>{const s=await b.request('status');return s.view?.deviceStatus==='approved'&&s.pairing?.self===null;});
});
test('the account authenticator code adds a third computer, and the first computer is told',async()=>{
 const [a,,c]=peers;
 assert.deepEqual(await a.request('twofactor',{action:'status'}),{enabled:false,available:true});
 const {secret}=await a.request('twofactor',{action:'setup'});const now=()=>T.hotp(T.decodeSecret(secret),BigInt(Math.floor(Date.now()/30000)));
 assert.deepEqual(await a.request('twofactor',{action:'enable',code:now()}),{enabled:true});
 await connect(c);assert.equal((await c.request('status')).view.deviceStatus,'pending');
 await new Promise(r=>setTimeout(r,31000-Date.now()%30000));
 await assert.rejects(()=>c.request('join-with-code',{code:'000000',confirmed:true}));
 assert.deepEqual(await c.request('join-with-code',{code:now(),confirmed:true}),{joined:true});
 assert.equal((await c.request('status')).view.deviceStatus,'approved');
 const cid=(await c.request('status')).view.deviceId;let item;await until(async()=>{item=((await a.request('status')).pairing?.addedWithCode??[]).find(x=>x.deviceId===cid);return !!item;});
 const cCheck=(await c.request('status')).pairing?.thisComputerCheck;assert.equal(item.checkCode,cCheck,'both computers show the same 12-character check code');
 await assert.rejects(()=>a.request('keep-added',{deviceId:cid,publicKey:item.publicKey,checkCode:'0'.repeat(12),confirmed:true}),/comparison_changed/);
 assert.deepEqual(await a.request('keep-added',{deviceId:cid,publicKey:item.publicKey,checkCode:item.checkCode,confirmed:true}),{kept:true},'only Keep with the compared code pins a computer added with the code');
 await until(async()=>!((await a.request('status')).pairing?.addedWithCode??[]).some(x=>x.deviceId===cid));
});
