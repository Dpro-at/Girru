import {createRequire} from 'node:module';
import {canonicalEncryptedRow} from './content-commit.js';
import {inspectEncryptedMemoryEffectAdmission} from './memory-effect.js';
/** Fixed non-projecting auxiliary maintenance. Hidden memory/Trash content is never decrypted or returned. */
import {all,one,dialect,type Step,type StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryCaptureMetadata} from './auth-capture.js';
import {captureVerifiedProfilePresenceScope,inspectVerifiedProfilePresenceScope,refreshVerifiedProfilePresenceScope} from './profile-presence-lifecycle.js';
import {historicalGraphReferenceParentsStep} from './logical-memory-parents.js';
import {captureProfileCipherPresenceStep} from './profile-presence.js';
import {issueTraceAuxiliaryMaintenanceAudit} from './internal-maintenance-audit.js';
import {loadAuxiliaryRecordsStep,openAuxiliaryRecords,prepareAuxiliaryRecords,replaceAuxiliaryRecordsStep} from './auxiliary-records.js';
import {captureAuxiliaryRootAnchor,type AuxiliaryRootLease} from './auxiliary-root-gateway.js';
import {replaceEncryptedTraceUses} from './encrypted-quality-owner.js';
import type {AuxiliaryForgetMutationJournal,PreparedAuxiliaryForgetMutation} from './forget-scrub-gateway.js';
import type {createMemoryUnlockSession} from './unlock-session.js';
import type {MemoryReadIntent} from './read-audit.js';
import {memoryEffectDigest} from './memory-effect.js';
import {MemoryCipherError} from './envelope.js';
function fail():never{throw new MemoryCipherError();}
const wire=createRequire(import.meta.url)('../../../../identity/src/memory-native-proof.cjs');
type CipherRow=Record<string,unknown>;
const mutationPlans=new WeakMap<object,{runner:StepRunner;ownerId:string;profileId:string;operationId:string;before:readonly string[];after:readonly string[];metadata:Readonly<any>}>();
export function captureTraceAuxiliaryMutationPlan(admission:unknown):Readonly<{purpose:'trace-auxiliary-cipher-plan';profileId:string;ownerId:string;operationId:string;runId:string;action:'save-trace';targetDigest:string;beforeCipherDigest:string;afterCipherDigest:string;isCurrent:()=>boolean}>|null{
 if(!admission||typeof admission!=='object')return null;const plan=mutationPlans.get(admission);return plan&&plan.metadata.isCurrent()?plan.metadata:null;
}
export function assertTraceAuxiliaryMutationRows(admission:unknown,input:{runner:StepRunner;ownerId:string;profileId:string;operationId:string;rows:readonly CipherRow[]}):void{
 const plan=admission&&typeof admission==='object'?mutationPlans.get(admission):null;if(!plan||!plan.metadata.isCurrent()||plan.runner!==input.runner||plan.ownerId!==input.ownerId||plan.profileId!==input.profileId||plan.operationId!==input.operationId||!Array.isArray(input.rows)||input.rows.length>11)fail();const rows=JSON.stringify([...input.rows].sort((a,b)=>Number(a.ordinal)-Number(b.ordinal)).map(canonicalEncryptedRow));if(rows!==JSON.stringify(plan.before)&&rows!==JSON.stringify(plan.after))fail();
}

export async function prepareTraceAuxiliaryMaintenance(input:{runner:StepRunner;auth:unknown;session:ReturnType<typeof createMemoryUnlockSession>;runId:string;agentId:string;memoryIds:readonly string[];traceDigest:string;createdAt:string;validate:()=>Promise<void>;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>;captureAuxiliaryRoot:()=>Promise<AuxiliaryRootLease|null>;auxiliaryMutationJournal:AuxiliaryForgetMutationJournal}){
 let key:Buffer|undefined;
 try{
  if(typeof input.validate!=='function')fail();await input.validate();
  const {runner}=input,auth=authenticatedMemoryCaptureMetadata(input.auth),lease=input.session.capture();if(!auth||auth.kind!=='run'||auth.agentId!==input.agentId||auth.ownerId!==lease.scope.ownerId||runner.inTransaction?.()!==false)fail();
  let proof=captureVerifiedProfilePresenceScope(runner,auth.ownerId);if(!proof)fail();const scope=inspectVerifiedProfilePresenceScope(proof);if(!scope||scope.runner!==runner||scope.memberId!==lease.scope.memberId)fail();
  const supplied=await input.captureAuxiliaryRoot();if(!supplied||supplied.purpose!=='memory-auxiliary'||supplied.profileId!==scope.profileId||!supplied.isCurrent())fail();const root=captureAuxiliaryRootAnchor(supplied.anchor);if(root.ownerId!==auth.ownerId||root.memberId!==scope.memberId||root.authorityId!==scope.authority.authorityId||root.keyId!==scope.authority.keyId||root.epoch!==scope.authority.epoch||root.forgetSequence!==scope.authority.forgetSequence||root.forgetMac!==scope.authority.forgetMac)fail();
  proof=await refreshVerifiedProfilePresenceScope(runner,auth.ownerId);if(!proof)fail();const parents=await runner.tx(()=>historicalGraphReferenceParentsStep(proof!),{immediate:true});
  const imports=await runner.tx(function*():Step<{id:string;user_id:string}[]>{const driver=yield* dialect(),size=yield* one<{n:number|string;b:number|string|null}>(`SELECT count(*) n,SUM(${driver==='sqlite'?'length(CAST(id AS BLOB))+length(CAST(user_id AS BLOB))':'octet_length(id)+octet_length(user_id)'}) b FROM memory_import_batches WHERE user_id=?`,auth.ownerId);if(!size||!Number.isSafeInteger(Number(size.n))||Number(size.n)<0||Number(size.n)>5000||!Number.isSafeInteger(Number(size.b??0))||Number(size.b??0)>4*1024*1024)fail();const rows=yield* all<{id:string;user_id:string}>('SELECT id,user_id FROM memory_import_batches WHERE user_id=? ORDER BY id',auth.ownerId);if(rows.length!==Number(size.n))fail();return rows;},{immediate:true});
  const before=await runner.tx(()=>loadAuxiliaryRecordsStep(auth.ownerId),{immediate:true});if(!before.length||before.length!==root.parts||before.some((row,index)=>row.owner_id!==auth.ownerId||row.bundle_id!==root.bundleId||row.sha256!==root.sha256||Number(row.parts)!==root.parts||Number(row.ordinal)!==index))fail();
  proof=await refreshVerifiedProfilePresenceScope(runner,auth.ownerId);if(!proof)fail();
  const intent=issueTraceAuxiliaryMaintenanceAudit({runner,auth:input.auth,presence:proof,runId:input.runId,traceDigest:input.traceDigest,memoryIds:input.memoryIds,partIds:before.map(row=>String(row.id))});if(await input.recordRead(intent)!==true)fail();
  proof=await refreshVerifiedProfilePresenceScope(runner,auth.ownerId);if(!proof||!lease.isCurrent()||!authenticatedMemoryCaptureMetadata(input.auth))fail();
  await input.validate();proof=await refreshVerifiedProfilePresenceScope(runner,auth.ownerId);
  const material=await lease.resolveKey({user_id:auth.ownerId});key=material.key;if(material.id!==root.keyId)fail();const parentSet={memories:[...parents],imports},bundle=openAuxiliaryRecords(before,parentSet,lease.scope,key,material.id);if(!bundle||bundle.v!==2||input.memoryIds.some(id=>!parents.some(parent=>parent.id===id)))fail();
  const next=replaceEncryptedTraceUses(bundle,{ownerId:auth.ownerId,runId:input.runId,agentId:input.agentId,memoryIds:input.memoryIds,createdAt:input.createdAt}),after=prepareAuxiliaryRecords(next,parentSet,lease.scope,key,material.id,input.createdAt);await input.validate();proof=await refreshVerifiedProfilePresenceScope(runner,auth.ownerId);if(!inspectVerifiedProfilePresenceScope(proof)||!lease.isCurrent())fail();
  // Only encrypted rows survive preparation. No caller-selected projector or payload callback exists.
  const digest=memoryEffectDigest(['trace-auxiliary-maintenance',input.runId,input.traceDigest,input.memoryIds,before,after]);let pending:PreparedAuxiliaryForgetMutation|undefined,state:'prepared'|'preparing'|'native-pending'|'writing'|'written'|'committing'|'committed'|'closed'='prepared';
  const current=()=>state!=='closed'&&lease.isCurrent()&&authenticatedMemoryCaptureMetadata(input.auth)?.revisionDigest===auth.revisionDigest;
  return Object.freeze({digest,
   async prepare(admission:unknown,targetDigest:string){if(state!=='prepared'||!current())fail();const effect=inspectEncryptedMemoryEffectAdmission(admission);if(!admission||typeof admission!=='object'||!effect||effect.action!=='save-trace'||effect.ownerId!==auth.ownerId||effect.profileId!==scope.profileId||effect.operationId!==scope.operationId||effect.targetDigest!==targetDigest||effect.auth.revisionDigest!==auth.revisionDigest||mutationPlans.has(admission))fail();
    const metadata=Object.freeze({purpose:'trace-auxiliary-cipher-plan' as const,profileId:scope.profileId,ownerId:auth.ownerId,operationId:scope.operationId,runId:input.runId,action:'save-trace' as const,targetDigest,beforeCipherDigest:wire.digest(before),afterCipherDigest:wire.digest(after),isCurrent:()=>inspectEncryptedMemoryEffectAdmission(admission)===effect});mutationPlans.set(admission,{runner,ownerId:auth.ownerId,profileId:scope.profileId,operationId:scope.operationId,before:Object.freeze(before.map(canonicalEncryptedRow)),after:Object.freeze(after.map(canonicalEncryptedRow)),metadata});state='preparing';pending=await input.auxiliaryMutationJournal(before.map(row=>Object.freeze({...row})),after.map(row=>Object.freeze({...row})));if(!pending||pending.purpose!=='memory-auxiliary'||!pending.isCurrent()||!current())fail();state='native-pending';},
   writeStep:function*():Step<void>{if(state!=='native-pending'||!pending?.isCurrent()||!current())fail();state='writing';const presence=yield* captureProfileCipherPresenceStep(auth.ownerId);if(presence.sha256!==scope.sha256)fail();yield* replaceAuxiliaryRecordsStep(auth.ownerId,before,after);if(!pending.isCurrent()||!current())fail();state='written';},
   async commit(){if(state!=='written'||!pending?.isCurrent()||!current())fail();state='committing';if(await pending.commit()!==true||!current())fail();state='committed';},
   close(){state='closed';before.length=0;after.length=0;},
  });
 }catch{input.session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
