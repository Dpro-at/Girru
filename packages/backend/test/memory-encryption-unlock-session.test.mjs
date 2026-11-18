import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {createMemoryUnlockSession} from '../src/memory/encryption/unlock-session.ts';
import {MemoryCipherError} from '../src/memory/encryption/envelope.ts';
const scope={ownerId:'lease-owner',memberId:'lease-member'};
test('locked default, owner scoping and owned operation buffers',async()=>{
 const session=createMemoryUnlockSession(),key=randomBytes(32),original=Buffer.from(key);
 assert.throws(()=>session.capture(),MemoryCipherError);session.unlock(key,'lease-key',scope);key.fill(0);
 const lease=session.capture();await assert.rejects(lease.resolveKey({user_id:'other'}),MemoryCipherError);
 const material=await lease.resolveKey({user_id:scope.ownerId});assert.deepEqual(material.key,original);material.key.fill(0);
 const second=await lease.resolveKey({user_id:scope.ownerId});assert.deepEqual(second.key,original);second.key.fill(0);
 session.lock();assert.equal(lease.isCurrent(),false);await assert.rejects(lease.resolveKey({user_id:scope.ownerId}),MemoryCipherError);
});
test('expiry, re-unlock and permission invalidation revoke old leases',()=>{
 let at=100;const session=createMemoryUnlockSession(()=>at),key=randomBytes(32);
 session.unlock(key,'lease-key',scope,10);const old=session.capture();at=110;assert.equal(old.isCurrent(),false);assert.equal(session.isUnlocked(),false);
 session.unlock(key,'lease-key',scope);const renewed=session.capture();assert.equal(old.isCurrent(),false);assert.equal(renewed.isCurrent(),true);
 session.invalidatePermissions();assert.equal(renewed.isCurrent(),false);assert.throws(()=>session.capture(),MemoryCipherError);
});
test('invalid replacement always locks the existing session',()=>{
 const session=createMemoryUnlockSession();session.unlock(randomBytes(32),'lease-key',scope);const old=session.capture();
 assert.throws(()=>session.unlock(Buffer.alloc(1),'bad',scope),MemoryCipherError);assert.equal(old.isCurrent(),false);
});
// Deferred until the final whole-task round; host profile lease revokes all captured key access.
test('physical selected-profile lease revocation locks the key session',async()=>{
 let authorized=true;const session=createMemoryUnlockSession(()=>100,()=>authorized),key=Buffer.alloc(32,7);
 try{session.unlock(key,'synthetic-key',{ownerId:'synthetic-owner',memberId:'synthetic-member'});const lease=session.capture();authorized=false;assert.equal(lease.isCurrent(),false);assert.equal(session.isUnlocked(),false);await assert.rejects(lease.resolveKey({user_id:'synthetic-owner'}));}finally{key.fill(0);session.lock();}
});
// Deferred until the final whole-task round.
test('live host owner authorization is checked before key release and denial locks the session',async()=>{
 let allowed=true,checks=0;const session=createMemoryUnlockSession(()=>100,()=>true,async()=>{checks++;return allowed;}),key=Buffer.alloc(32,9);
 try{session.unlock(key,'synthetic-key',{ownerId:'synthetic-owner',memberId:'synthetic-member'});const lease=session.capture(),material=await lease.resolveKey({user_id:'synthetic-owner'});material.key.fill(0);allowed=false;await assert.rejects(lease.resolveKey({user_id:'synthetic-owner'}));assert.equal(session.isUnlocked(),false);allowed=true;assert.throws(()=>session.capture());assert.equal(checks,2);}finally{key.fill(0);session.lock();}
});
// Deferred until whole-task source completion.
test('real session lock subscription revokes a prior captured key epoch on re-unlock and expiry',async()=>{const session=createMemoryUnlockSession(),key=Buffer.alloc(32,7);let notifications=0;const unsubscribe=session.subscribeLock(()=>{notifications++;});try{session.unlock(key,'synthetic-key',{ownerId:'synthetic-owner',memberId:'synthetic-member'},60000);const prior=session.capture(),before=notifications;session.unlock(key,'synthetic-key',{ownerId:'synthetic-owner',memberId:'synthetic-member'},5);assert.equal(prior.isCurrent(),false);assert.equal(notifications,before+1);await new Promise(resolve=>setTimeout(resolve,25));assert.equal(session.isUnlocked(),false);assert.ok(notifications>=before+2);}finally{unsubscribe();session.lock();key.fill(0);}});
