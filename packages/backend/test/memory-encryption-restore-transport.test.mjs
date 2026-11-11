// Source fixtures, deferred until final whole-task verification.
import test from 'node:test';import assert from 'node:assert/strict';import {captureUnverifiedMemoryRestoreTransport} from '../src/memory/encryption/restore-transport.ts';
test('unverified transport takes owned byte copies and rejects accessor/cycle inputs',()=>{const source={bytes:Buffer.from('SYNTHETIC_CIPHERTEXT'),rows:[{id:'memory-a',value:'encrypted'}]};const copy=captureUnverifiedMemoryRestoreTransport(source);source.bytes.fill(0);source.rows[0].value='changed';assert.equal(copy.bytes.toString(),'SYNTHETIC_CIPHERTEXT');assert.equal(copy.rows[0].value,'encrypted');const cyclic={};cyclic.self=cyclic;assert.throws(()=>captureUnverifiedMemoryRestoreTransport(cyclic));let getterCalled=false;const accessor={};Object.defineProperty(accessor,'secret',{enumerable:true,get(){getterCalled=true;return 'secret';}});assert.throws(()=>captureUnverifiedMemoryRestoreTransport(accessor));assert.equal(getterCalled,false);});

test('transport retains bounded historical rows above the former 1000-row ceiling',()=>{
 const source={rows:Array.from({length:1866},(_,i)=>({id:'history-'+i,content:'ciphertext'}))};
 const copy=captureUnverifiedMemoryRestoreTransport(source);assert.equal(copy.rows.length,1866);assert.notEqual(copy.rows,source.rows);
 assert.throws(()=>captureUnverifiedMemoryRestoreTransport({rows:Array.from({length:5001},()=>null)}));
});
