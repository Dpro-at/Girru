import './fixtures/trading-runtime.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {PaperPracticeStore} from '../src/services/trading-paper-practice.ts';
function fixture(t){let now=1800000000000;const store=new PaperPracticeStore(()=>now);t.after(()=>store.close());const initial=store.start('owner'),order=(patch={})=>store.order('owner',{sessionId:initial.sessionId,requestId:randomUUID(),symbol:'DEMO-ALPHA',side:'buy',quantity:2,...patch});return {store,initial,order,advance:ms=>now+=ms};}
test('practice buys/sells through the paper risk engine with fees, positions and loss accounting',t=>{
 const {initial,order}=fixture(t);assert.equal(initial.cashMinor,1000000);
 const bought=order();assert.equal(bought.cashMinor,997995);assert.equal(bought.positions[0].quantity,2);assert.equal(bought.orders[0].feeMinor,5);assert.equal(bought.netResultMinor,-5);
 const sold=order({side:'sell',quantity:1});assert.equal(sold.cashMinor,998992);assert.equal(sold.positions[0].quantity,1);assert.equal(sold.netResultMinor,-8);assert.equal(sold.orders[0].side,'sell');
});
test('replay executes only once; changed intent and oversells create no partial reservation or fee',t=>{
 const {store,order}=fixture(t),requestId=randomUUID();const first=order({requestId});assert.equal(order({requestId}).replayed,true);assert.equal(store.read('owner').orders.length,1);
 assert.throws(()=>order({requestId,quantity:3}));assert.throws(()=>order({side:'sell',quantity:3}));const {replayed,...snapshot}=first;assert.deepEqual(store.read('owner'),snapshot);
});
test('fictional instruments, quantities and spending limits refuse without side effects',t=>{
 const {store,order}=fixture(t),before=store.read('owner');
 for(const input of [{symbol:'REAL'},{quantity:0},{quantity:1.2},{quantity:101},{symbol:'DEMO-GAMMA',quantity:100}]){assert.throws(()=>order(input));assert.deepEqual(store.read('owner'),before);}
});
test('bot steps share the existing finite bot cap; stop preserves manual practice',t=>{
 const {store,initial,order}=fixture(t);for(let n=0;n<20;n++)store.order('owner',{sessionId:initial.sessionId,requestId:randomUUID(),symbol:'DEMO-ALPHA',side:'buy',quantity:1},true);
 assert.equal(store.read('owner').bot.ticks,20);const before=store.read('owner');assert.throws(()=>store.order('owner',{sessionId:initial.sessionId,requestId:randomUUID(),symbol:'DEMO-ALPHA',side:'buy',quantity:1},true));assert.deepEqual(store.read('owner'),before);
 store.stopBot('owner',initial.sessionId);assert.equal(store.read('owner').bot.stopped,true);assert.equal(order().orders.length,21);
});
test('owners and server instances are isolated; expiry/end/reset invalidate old session identities',t=>{
 const f=fixture(t),other=new PaperPracticeStore();t.after(()=>other.close());assert.equal(other.read('owner').active,false);assert.equal(f.store.read('other-owner').active,false);assert.throws(()=>f.store.order('other-owner',{sessionId:f.initial.sessionId,requestId:randomUUID(),symbol:'DEMO-ALPHA',side:'buy',quantity:1}));
 assert.throws(()=>f.store.end('owner',randomUUID()));assert.equal(f.store.start('owner').sessionId,f.initial.sessionId);f.advance(7200001);assert.equal(f.store.read('owner').active,false);const next=f.store.start('owner');assert.notEqual(next.sessionId,f.initial.sessionId);assert.throws(()=>f.order());assert.equal(f.store.end('owner',next.sessionId).active,false);
});

test('capacity, closed stores and repeated bot stop preserve bounded lifecycle',t=>{
 let now=1800000000000;const store=new PaperPracticeStore(()=>now,1);t.after(()=>store.close());const first=store.start('first');assert.throws(()=>store.start('second'));store.stopBot('first',first.sessionId);assert.equal(store.stopBot('first',first.sessionId).bot.stopped,true);now+=7200001;assert.equal(store.start('second').active,true);store.close();store.close();assert.throws(()=>store.read('second'));
});
