import {AsyncLocalStorage} from 'node:async_hooks';
import type {DrawerRef} from '../drawers.js';
import type {Step} from '../../repositories/sql-steps.js';
import {MemoryCipherError} from './envelope.js';
/** Private same-process authority; persisted task JSON is never an owner session. */
export type StoredRunClaimMetadata=Readonly<{
 ownerId:string;runId:string;taskId:string;agentId:string;project:string|null;
 workerId:string;generation:number;expiresAt:number;inputDigest:string;contractDigest:string;policyDigest:string;
 tokenVersion:number;role:string;definitionScope:Readonly<Record<string,unknown>>;templateDigest:string;grantId:string;drawers:readonly DrawerRef[];delegatedFrom:readonly string[];
 isCurrent:()=>boolean;assertCurrentStep:()=>Step<void>;renew:()=>Promise<void>;
}>;
export type StoredRunGrantMetadata=Readonly<{
 grantId:string;ownerId:string;profileId:string;controlStorageId:string;runId:string;agentId:string;
 workerId:string;generation:number;expiresAt:number;inputDigest:string;contractDigest:string;policyDigest:string;
 isCurrent:()=>boolean;
}>;
export type StoredRunPrincipalAuthority=Readonly<{
 inspectControlClaim:(claim:unknown)=>StoredRunClaimMetadata|null;
 claimNativeGrant:(claim:object)=>Promise<object>;
 inspectNativeGrant:(grant:unknown)=>StoredRunGrantMetadata|null;
}>;
type State={claim:object;grant:object;control:StoredRunClaimMetadata;native:StoredRunGrantMetadata;provider:StoredRunPrincipalAuthority;generation:number;closed:boolean};
const scopes=new AsyncLocalStorage<State>();let authority:StoredRunPrincipalAuthority|null=null;let authorityGeneration=0;
const identifier=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256;
const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
/** Installed only by the actual private native bootstrap, never an HTTP or tool handler. */
export function installStoredRunPrincipalAuthority(value:StoredRunPrincipalAuthority):()=>void{
 if(authority||!value||typeof value.inspectControlClaim!=='function'||typeof value.claimNativeGrant!=='function'||typeof value.inspectNativeGrant!=='function')throw new MemoryCipherError();
 authorityGeneration++;authority=Object.freeze({...value});const installed=authority;return()=>{if(authority===installed){authority=null;authorityGeneration++;}};
}
function current(state:State):boolean{
 try{if(state.closed||authority!==state.provider||authorityGeneration!==state.generation||!authority||authority.inspectControlClaim(state.claim)!==state.control||authority.inspectNativeGrant(state.grant)!==state.native)return false;
 return Date.now()<Math.min(state.control.expiresAt,state.native.expiresAt)&&state.control.isCurrent()===true&&state.native.isCurrent()===true;
 }catch{return false;}
}
export async function runWithStoredRunPrincipal<T>(claim:object,operation:()=>Promise<T>):Promise<T>{
 if(!authority||scopes.getStore()||!claim||typeof operation!=='function')throw new MemoryCipherError();const provider=authority,generation=authorityGeneration,control=provider.inspectControlClaim(claim);
 if(!control||typeof control.renew!=='function'||!Object.isFrozen(control)||!Array.isArray(control.drawers)||control.drawers.length>64||!Array.isArray(control.delegatedFrom)||control.delegatedFrom.length>31||new Set([control.agentId,...control.delegatedFrom]).size!==control.delegatedFrom.length+1||!control.delegatedFrom.every(identifier)||![control.ownerId,control.runId,control.taskId,control.agentId,control.workerId,control.role].every(identifier)||![control.inputDigest,control.contractDigest,control.policyDigest,control.templateDigest].every(digest)||!identifier(control.grantId)||!control.definitionScope||!Object.isFrozen(control.definitionScope)||!Number.isSafeInteger(control.generation)||control.generation<0||!Number.isSafeInteger(control.tokenVersion)||control.tokenVersion<0||!Number.isFinite(control.expiresAt)||Date.now()>=control.expiresAt||!control.isCurrent())throw new MemoryCipherError();
 const grant=await provider.claimNativeGrant(claim),native=provider.inspectNativeGrant(grant);
 if(authority!==provider||authorityGeneration!==generation||!native||!Object.isFrozen(native)||![native.grantId,native.profileId,native.controlStorageId].every(identifier)||native.ownerId!==control.ownerId||native.runId!==control.runId||native.agentId!==control.agentId||native.workerId!==control.workerId||native.generation!==control.generation||native.inputDigest!==control.inputDigest||native.contractDigest!==control.contractDigest||native.policyDigest!==control.policyDigest||!Number.isFinite(native.expiresAt)||!native.isCurrent()||!control.isCurrent())throw new MemoryCipherError();
 const state:State={claim,grant,control,native,provider,generation,closed:false};if(!current(state))throw new MemoryCipherError();
 return scopes.run(state,async()=>{try{const result=await operation();if(!current(state))throw new MemoryCipherError();return result;}finally{state.closed=true;}});
}
export function currentStoredRunPrincipal(){const state=scopes.getStore();if(!state)return null;if(!current(state))throw new MemoryCipherError();return Object.freeze({control:state.control,native:state.native,isCurrent:()=>scopes.getStore()===state&&current(state)});}
export function assertNoStoredRunOwnerAction():void{if(scopes.getStore())throw new MemoryCipherError();}

/** Refresh only the same persisted worker/generation heartbeat before ordinary lease checks. */
export async function refreshStoredRunPrincipal():Promise<void>{
 const state=scopes.getStore();if(!state)return;
 if(state.closed||authority!==state.provider||authorityGeneration!==state.generation||!authority||authority.inspectControlClaim(state.claim)!==state.control||authority.inspectNativeGrant(state.grant)!==state.native||Date.now()>=state.native.expiresAt||!state.native.isCurrent())throw new MemoryCipherError();
 await state.control.renew();if(!current(state))throw new MemoryCipherError();
}
/** Original same-process claim for the private native bridge; never serializes authority to a caller. */
export function captureCurrentStoredRunControlClaim():object|null{const state=scopes.getStore();if(!state)return null;if(!current(state))throw new MemoryCipherError();return state.claim;}
