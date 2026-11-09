// Deferred source fixture: no key, profile, database or recovery execution while writing code.
import test from 'node:test';import assert from 'node:assert/strict';
import {recoverAuthenticatedMemoryMasterOnCopy} from '../src/memory/encryption/recovery-host.ts';
test('recovery requires host-authorized physical copy before reading auth or writing audit rows',async()=>{
 let reads=0,enrollments=0,authorizations=0;const runner={inTransaction:()=>false,tx:async()=>{reads++;throw Error('Unexpected database access');}};
 const input={runner,token:'synthetic',ownerId:'synthetic-owner',memberId:'synthetic-member',recoveryRecord:{id:'synthetic-recovery',wrapped:'synthetic'},recoveryCode:'SYNTHETIC-NOT-A-REAL-CODE',memberKey:{id:'synthetic-key',wrapped:'synthetic'},package:{},captureAuthority:async()=>{throw Error('Unexpected authority access');},authorizeRecovery:async()=>true,auditCustody:{capture:async()=>null,advance:async()=>false},authorizeRecoveryCopy:async(candidate)=>{assert.equal(candidate,runner);authorizations++;return null;},enrollProtectedMaster:async()=>{enrollments++;return true;}};
 await assert.rejects(recoverAuthenticatedMemoryMasterOnCopy(input));assert.equal(authorizations,1);assert.equal(reads,0);assert.equal(enrollments,0);
});
