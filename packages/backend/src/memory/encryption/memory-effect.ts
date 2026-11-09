/** Private validated pre-effect handoff. SQL text and caller JSON cannot issue a runtime write admission. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import type {StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryCaptureMetadata,type AuthenticatedMemoryCaptureMetadata} from './auth-capture.js';
import {captureMemoryRestoreAnchor,type MemoryRestoreAnchor} from './restore-package.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
import type {ProfileCipherPresence} from './profile-presence.js';
import {MemoryCipherError} from './envelope.js';
export const MEMORY_EFFECT_ACTIONS=['create-memory','update-memory','move-memory','trash-memory','restore-memory','forget-memory','forget-person-graph','cleanup-forget','queue-addition','queue-conflict','decide-addition','decide-supersession','reject-proposal','create-pin','update-owner-auxiliary','create-handoff','create-weekly-summary','save-trace','time-trace','configure-documents','preview-document-import','decide-document-import','index-document-file','review-graph','mutate-legacy-graph','create-question','mutate-question','answer-question','queue-owner-import','queue-owner-correction','rotate-profile','restore-profile'] as const;
export type MemoryEffectAction=typeof MEMORY_EFFECT_ACTIONS[number];
export type ProfilePresenceAnchor=MemoryRestoreAnchor&{sha256:string;tables:20;generation:number};
export type ProfilePresenceLease={purpose:'memory-profile-presence';profileId:string;anchor:ProfilePresenceAnchor;isCurrent:()=>boolean};
export type PreparedProfilePresence={purpose:'memory-profile-presence';id:string;isCurrent:()=>boolean;commit:(next:{presence:ProfileCipherPresence;authority:MemoryRestoreAnchor})=>Promise<boolean>};
export type MemoryEffectAdmission={purpose:'memory-profile-write';isCurrent:()=>boolean};
export type MemoryEffectAdmissionMetadata=Readonly<{purpose:'memory-profile-write';profileId:string;ownerId:string;operationId:string;action:MemoryEffectAction;targetDigest:string;authority:Readonly<MemoryRestoreAnchor>;auth:AuthenticatedMemoryCaptureMetadata}>;
type EffectState={runner:StepRunner;ownerId:string;profileId:string;operationId:string;readOnly:boolean;active:boolean;isRuntimeCurrent:()=>boolean;captureAuthority:()=>Promise<MemoryRestoreAuthorityLease|null>;prepare:(proof:MemoryEffectAdmission)=>Promise<PreparedProfilePresence>;pending:PreparedProfilePresence|null;admissions:MemoryEffectAdmission[]};
const scopes=new AsyncLocalStorage<EffectState>(),protectedRunners=new WeakMap<StepRunner,{ownerId:string;profileId:string}>(),admissions=new WeakMap<object,{metadata:MemoryEffectAdmissionMetadata;current:()=>boolean}>();
export function registerProtectedMemoryRunner(runner:StepRunner,ownerId:string,profileId:string){const previous=protectedRunners.get(runner);if(previous&&(previous.ownerId!==ownerId||previous.profileId!==profileId))throw new MemoryCipherError();protectedRunners.set(runner,Object.freeze({ownerId,profileId}));}
export function isProtectedMemoryRunner(runner:StepRunner):boolean{return protectedRunners.has(runner);}
export function inspectEncryptedMemoryEffectAdmission(value:unknown):MemoryEffectAdmissionMetadata|null{try{if(!value||typeof value!=='object')return null;const captured=admissions.get(value);return captured&&captured.current()?captured.metadata:null;}catch{return null;}}
export function memoryEffectDigest(value:unknown):string{const seen=new Set<object>();const encode=(item:unknown):unknown=>{if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return item;if(Buffer.isBuffer(item))return['bytes',item.toString('base64')];if(!item||typeof item!=='object'||seen.has(item))throw new MemoryCipherError();seen.add(item);try{if(Array.isArray(item))return item.map(encode);return Object.keys(item).sort().map(key=>[key,encode((item as Record<string,unknown>)[key])]);}finally{seen.delete(item);}};const raw=JSON.stringify(encode(value));if(Buffer.byteLength(raw)>32*1024*1024)throw new MemoryCipherError();return createHash('sha256').update(raw).digest('hex');}
/** Call only after complete argument/target/permission preparation, immediately before the first effect. */
export async function beforeEncryptedMemoryEffect(input:{runner:StepRunner;action:MemoryEffectAction;auth:unknown;isCurrent:()=>boolean;targetDigest:string}):Promise<void>{
 const state=scopes.getStore(),protectedBinding=protectedRunners.get(input.runner);if(!state){if(protectedBinding)throw new MemoryCipherError();return;}if(state.runner!==input.runner||state.readOnly||!state.active||!state.isRuntimeCurrent()||!MEMORY_EFFECT_ACTIONS.includes(input.action)||typeof input.targetDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.targetDigest))throw new MemoryCipherError();const auth=authenticatedMemoryCaptureMetadata(input.auth);if(!auth||auth.ownerId!==state.ownerId||input.isCurrent()!==true)throw new MemoryCipherError();
 const captured=await state.captureAuthority();if(!captured||!captured.isCurrent()||input.isCurrent()!==true||!state.active||!state.isRuntimeCurrent())throw new MemoryCipherError();const authority=captureMemoryRestoreAnchor(captured.anchor);if(authority.ownerId!==state.ownerId)throw new MemoryCipherError();
 // The original authority is evidence for prepare, not an old-head liveness test:
 // an explicitly admitted forget/rotation may advance it before its final commit.
 const isCurrent=()=>{try{return state.active&&state.isRuntimeCurrent()&&Date.now()<auth.validUntil&&input.isCurrent()===true;}catch{return false;}};
 const metadata=Object.freeze({purpose:'memory-profile-write' as const,profileId:state.profileId,ownerId:state.ownerId,operationId:state.operationId,action:input.action,targetDigest:input.targetDigest,authority:Object.freeze(authority),auth}),proof=Object.freeze({purpose:'memory-profile-write' as const,isCurrent});admissions.set(proof,{metadata,current:isCurrent});state.admissions.push(proof);if(!isCurrent())throw new MemoryCipherError();
 if(!state.pending){const pending=await state.prepare(proof);if(!pending||pending.purpose!=='memory-profile-presence'||!pending.id||!pending.isCurrent()||!isCurrent())throw new MemoryCipherError();state.pending=pending;}else if(!state.pending.isCurrent())throw new MemoryCipherError();
}
export async function withEncryptedMemoryEffectScope<T>(input:Omit<EffectState,'active'|'pending'|'admissions'>,operation:(state:Readonly<{pending:()=>PreparedProfilePresence|null;admission:()=>MemoryEffectAdmission|null}>)=>Promise<T>):Promise<T>{
 if(scopes.getStore()||!input.operationId||!input.profileId||typeof operation!=='function')throw new MemoryCipherError();const state:EffectState={...input,active:true,pending:null,admissions:[]};return scopes.run(state,async()=>{try{return await operation(Object.freeze({pending:()=>state.pending,admission:()=>state.admissions[0]??null}));}finally{state.active=false;}});
}
/** Exact current effect handle for a fixed internal writer; it cannot create or expand an admission. */
export function captureCurrentMemoryEffectAdmission(runner:StepRunner,action:MemoryEffectAction,targetDigest:string):MemoryEffectAdmission|null{
 const state=scopes.getStore();if(!state||state.runner!==runner||!state.active||!state.isRuntimeCurrent())return null;
 for(let index=state.admissions.length-1;index>=0;index--){const proof=state.admissions[index],metadata=inspectEncryptedMemoryEffectAdmission(proof);if(metadata&&metadata.action===action&&metadata.targetDigest===targetDigest&&metadata.operationId===state.operationId&&metadata.profileId===state.profileId&&metadata.ownerId===state.ownerId)return proof;}
 return null;
}
