/** Deferred claim-boundary fixtures. These do not grant native delegation or unlock a profile. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {captureStoredRunControlClaim,inspectStoredRunControlClaim,installStoredRunTaskScopeCapture} from '../src/memory/encryption/stored-run-control.ts';
test('serialized task metadata cannot become an original stored-run principal',()=>{
 assert.equal(inspectStoredRunControlClaim({purpose:'stored-run-control',ownerId:'owner',runId:'run',isCurrent:()=>true}),null);
 assert.equal(inspectStoredRunControlClaim(null),null);
});
test('a missing real scope producer refuses before any control SQL or model work',async()=>{
 const runner={dialect:'sqlite',readSync(){assert.fail('no scope authority');},tx(){assert.fail('no scope authority');}};
 await assert.rejects(captureStoredRunControlClaim({runner,runId:'run',workerId:'worker'}));
});
test('PostgreSQL or a structural async runner cannot stand in for the held synchronous control connection',async()=>{
 const remove=installStoredRunTaskScopeCapture(()=>{assert.fail('invalid runner must refuse first');});
 try{await assert.rejects(captureStoredRunControlClaim({runner:{dialect:'postgres',readSync(){},tx(){}},runId:'run',workerId:'worker'}));}finally{remove();}
});
