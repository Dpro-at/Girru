// Deferred whole-task fixture; intentionally no SQL, model, profile or key reads.
import test from 'node:test';import assert from 'node:assert/strict';
import {saveAuthenticatedEncryptedRecallTrace} from '../src/memory/encryption/trace-gateway.ts';
test('encrypted trace rejects text-bearing or unconverted document references before database access',async()=>{
 for(const item of [{kind:'memory',id:'memory-a',drawer:'owner',why:'keyword',excerpt:'SYNTHETIC-PRIVATE-TEXT'},{kind:'document',id:'document-a',drawer:'project:synthetic',why:'document'}]){
  let calls=0;const runner={inTransaction:()=>false,tx:async()=>{calls++;throw Error('Unexpected SQL');}},session={lock(){},capture(){calls++;throw Error('Unexpected key capture');}};
  await assert.rejects(saveAuthenticatedEncryptedRecallTrace({runner,token:'synthetic',session,run:{agentId:'agent-a',delegatedFrom:[],project:null,drawers:[{kind:'owner'}],audience:'owner'},trace:{runId:'run-a',userId:'owner-a',sessionId:'session-a',agentId:'agent-a',items:[item],context:{keptTurns:0,summarisedTurns:0,summaries:[],droppedTurns:0,fromCache:{pack:false,recall:false},budgetTokens:1000,numCtx:1000},packHit:false,packChars:0,promptTokens:0}}));assert.equal(calls,0);
 }
});
