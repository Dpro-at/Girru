// Deferred private-admission rejection fixtures; no real profile, SQL or key access.
import test from 'node:test';
import assert from 'node:assert/strict';
import {issueTraceAuxiliaryMaintenanceAudit,isOriginalTraceAuxiliaryMaintenanceAudit} from '../src/memory/encryption/internal-maintenance-audit.ts';
import {prepareTraceAuxiliaryMaintenance} from '../src/memory/encryption/trace-auxiliary-maintenance.ts';
test('JSON run and presence claims cannot issue an internal non-egress audit',()=>{
 const value={runner:{},auth:{kind:'run',ownerId:'owner-a',agentId:'agent-a'},presence:{purpose:'verified-memory-profile-presence',isCurrent:()=>true},runId:'run-a',traceDigest:'a'.repeat(64),memoryIds:['memory-a'],partIds:['part-a']};
 assert.throws(()=>issueTraceAuxiliaryMaintenanceAudit(value));assert.equal(isOriginalTraceAuxiliaryMaintenanceAudit({readerKind:'system',readerId:'trace-auxiliary-maintenance',purpose:'internal-maintenance',records:[{table:'memory_encryption_auxiliary',id:'part-a'}]}),false);
});
test('fabricated maintenance admission cannot read SQL, request a key or prepare a native mutation',async()=>{
 let reads=0,keys=0,native=0,locked=0;const runner={inTransaction:()=>false,tx:async()=>{reads++;throw Error('Unexpected SQL');}},session={capture:()=>({scope:{ownerId:'owner-a',memberId:'member-a'},isCurrent:()=>true,resolveKey:async()=>{keys++;throw Error('Unexpected key');}}),lock(){locked++;}};
 await assert.rejects(()=>prepareTraceAuxiliaryMaintenance({runner,session,auth:{kind:'run',ownerId:'owner-a',agentId:'agent-a'},runId:'run-a',agentId:'agent-a',memoryIds:['memory-a'],traceDigest:'a'.repeat(64),createdAt:'2026-11-09T00:00:00Z',validate:async()=>{},recordRead:async()=>{reads++;throw Error('Unexpected audit');},captureAuxiliaryRoot:async()=>{native++;throw Error('Unexpected root');},auxiliaryMutationJournal:async()=>{native++;throw Error('Unexpected journal');}}));assert.equal(reads,0);assert.equal(keys,0);assert.equal(native,0);assert.equal(locked,1);
});
