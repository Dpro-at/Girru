import {createHash} from 'node:crypto';
import {canonicalEncryptedRow} from './content-commit.js';
/** Original fixed-role audit intents for non-projecting encrypted trace bookkeeping. */
import type {StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryCaptureMetadata} from './auth-capture.js';
import {inspectVerifiedProfilePresenceScope} from './profile-presence-lifecycle.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
const issued=new WeakMap<object,()=>boolean>();
const timingIssued=new WeakMap<object,()=>boolean>();
const identity=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(v);
export function issueTraceAuxiliaryMaintenanceAudit(input:{runner:StepRunner;auth:unknown;presence:unknown;runId:string;traceDigest:string;memoryIds:readonly string[];partIds:readonly string[]}):MemoryReadIntent{
 const auth=authenticatedMemoryCaptureMetadata(input.auth),presence=inspectVerifiedProfilePresenceScope(input.presence);
 if(!auth||auth.kind!=='run'||!presence||presence.runner!==input.runner||presence.ownerId!==auth.ownerId||!identity(input.runId)||!/^[a-f0-9]{64}$/.test(input.traceDigest)||input.memoryIds.length>64||input.memoryIds.some(v=>!identity(v))||new Set(input.memoryIds).size!==input.memoryIds.length||!input.partIds.length||input.partIds.length>1000||input.partIds.some(v=>!identity(v))||new Set(input.partIds).size!==input.partIds.length)throw new MemoryCipherError();
 const originalAuth=input.auth,originalPresence=input.presence;
 const intent:MemoryReadIntent=Object.freeze({readerKind:'system',readerId:'trace-auxiliary-maintenance',purpose:'internal-maintenance',records:Object.freeze([...input.partIds].sort().map(id=>Object.freeze({table:'memory_encryption_auxiliary' as const,id})))}) as unknown as MemoryReadIntent;
 issued.set(intent,()=>{const currentAuth=authenticatedMemoryCaptureMetadata(originalAuth),currentPresence=inspectVerifiedProfilePresenceScope(originalPresence);return !!currentAuth&&currentAuth.kind==='run'&&currentAuth.ownerId===auth.ownerId&&currentAuth.revisionDigest===auth.revisionDigest&&!!currentPresence&&currentPresence.runner===input.runner&&currentPresence.operationId===presence.operationId&&currentPresence.sha256===presence.sha256;});return intent;
}
export function isOriginalTraceAuxiliaryMaintenanceAudit(value:unknown):boolean{try{return !!value&&typeof value==='object'&&issued.get(value)?.()===true;}catch{return false;}}

/** Fixed boolean-only TTFT reseal; never authorizes trace inspection or disclosure. */
export function issueTraceTimingMaintenanceAudit(input:{runner:StepRunner;auth:unknown;presence:unknown;runId:string;row:Readonly<Record<string,unknown>>}):MemoryReadIntent{
 const auth=authenticatedMemoryCaptureMetadata(input.auth),presence=inspectVerifiedProfilePresenceScope(input.presence),row=input.row;
 if(!auth||auth.kind!=='run'||!presence||presence.runner!==input.runner||presence.ownerId!==auth.ownerId||!identity(input.runId)||auth.storedRun&&auth.storedRun.runId!==input.runId||row.run_id!==input.runId||row.user_id!==auth.ownerId||row.agent_id!==auth.agentId||row.ttft_ms!==null)throw new MemoryCipherError();
 const digest=createHash('sha256').update(canonicalEncryptedRow(row)).digest('hex'),originalAuth=input.auth,originalPresence=input.presence;
 const intent=Object.freeze({readerKind:'system',readerId:'trace-timing-maintenance',purpose:'internal-maintenance',records:Object.freeze([Object.freeze({table:'memory_recall_traces',id:input.runId})])}) as unknown as MemoryReadIntent;
 timingIssued.set(intent,()=>{const currentAuth=authenticatedMemoryCaptureMetadata(originalAuth),currentPresence=inspectVerifiedProfilePresenceScope(originalPresence);return !!currentAuth&&currentAuth.kind==='run'&&currentAuth.ownerId===auth.ownerId&&currentAuth.agentId===auth.agentId&&currentAuth.revisionDigest===auth.revisionDigest&&!!currentPresence&&currentPresence.runner===input.runner&&currentPresence.operationId===presence.operationId&&currentPresence.sha256===presence.sha256&&createHash('sha256').update(canonicalEncryptedRow(row)).digest('hex')===digest;});return intent;
}
export function isOriginalTraceTimingMaintenanceAudit(value:unknown):boolean{try{return !!value&&typeof value==='object'&&timingIssued.get(value)?.()===true;}catch{return false;}}
export function isOriginalMemoryMaintenanceAudit(value:unknown):boolean{return isOriginalTraceAuxiliaryMaintenanceAudit(value)||isOriginalTraceTimingMaintenanceAudit(value);}
