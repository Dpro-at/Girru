'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const W=require('../../identity/src/memory-native-owner-wire.cjs');
const O='a'.repeat(43),binding={launchId:O,epoch:'b'.repeat(43)};
const open=()=>({v:1,type:'memory-owner-channel',binding,frameId:O,id:O,kind:'open',owner:null,mode:'background',profileId:'profile',foundation:null,background:{ownerId:'owner',controlStorageId:'control',operationId:'actual-operation',definitionHandle:null,claimHandle:O,grantHandle:null}});
test('background wire has no fabricated owner session and exact original claim handle',()=>{const value=W.parse(open());assert.equal(value.owner,null);assert.equal(value.background.claimHandle,O);assert.equal(value.background.ownerId,'owner');});
test('background rejects a copied owner JWT/session descriptor or extra privileges',()=>{const owner=open();owner.owner={ownerId:'owner',sessionId:'fake',controlStorageId:'control',operationId:'actual-operation'};assert.throws(()=>W.parse(owner));const extra=open();extra.background.canUnlock=true;assert.throws(()=>W.parse(extra));});
test('native approval is fixed owner outer and claim uses private inner method only',()=>{assert.ok(W.OUTER.includes('background-approve'));assert.equal(W.OUTER.includes('background/claim'),false);assert.ok(W.NATIVE.includes('background/claim'));});
