import {currentStoredRunPrincipal,assertNoStoredRunOwnerAction} from './stored-run-principal.js';
import {createHash} from 'node:crypto';
import {memoryControlQuery} from './control-runner.js';
/** Inactive authenticated capture; run/delegation/drawer inputs must be server-selected. */
import {one,run,dialect,type StepRunner} from '../../repositories/sql-steps.js';
import {verifyToken} from '../../auth/jwt.js';
import {authSessionTokenHash} from '../../auth/sessions.js';
import {loadStep} from '../../tools/agent-permissions.js';
import {loadSnapshotStep} from '../scopes/access.js';
import {sameDrawer,type DrawerRef} from '../drawers.js';
import {captureEncryptedRunAccess} from './run-access.js';
import type {MemoryRevisionCapture} from './revision-validator.js';
import {MemoryCipherError} from './envelope.js';
export type AuthenticatedMemoryCaptureMetadata=Readonly<{kind:'owner'|'run';ownerId:string;sessionId:string;validUntil:number;revisionDigest:string;agentId?:string;storedRun?:Readonly<{runId:string;grantId:string;workerId:string;generation:number;controlStorageId:string}>}>;
const authenticatedCaptures=new WeakMap<object,AuthenticatedMemoryCaptureMetadata>();
export function authenticatedMemoryCaptureMetadata(value:unknown):AuthenticatedMemoryCaptureMetadata|null{if(!value||typeof value!=='object')return null;const metadata=authenticatedCaptures.get(value);return metadata&&Date.now()<metadata.validUntil?metadata:null;}
type AuthenticatedRunScope={agentId:string;delegatedFrom:readonly string[];project:string|null;drawers:DrawerRef[];audience:'owner'|'outsider'};
function rawAuthenticatedMemoryRunStep(token:string,runScope:AuthenticatedRunScope){
 try{
  const stored=currentStoredRunPrincipal();if(stored)return rawStoredMemoryRunStep(stored,runScope);
  const decoded=verifyToken(token);
  if(!decoded.jti||!decoded.exp||!Number.isSafeInteger(decoded.tokenVersion))throw new MemoryCipherError();
  const tokenHash=authSessionTokenHash(decoded.jti),ownerId=decoded.userId,tokenVersion=decoded.tokenVersion;
  const ids=[runScope.agentId,...runScope.delegatedFrom];
  if(!ids.length||ids.length>32||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id||id.length>256))throw new MemoryCipherError();
  const selected={project:runScope.project,drawers:runScope.drawers.map(d=>({...d})),audience:runScope.audience},tokenExpiresAt=decoded.exp*1000;
  return (function*(){
   if((yield* dialect())==='postgres')yield* run('LOCK TABLE users,auth_sessions,agents_config,agent_permissions,memory_access_versions,memory_access_rules,memory_access_scope_rules,memory_role_templates,memory_agent_roles,memory_project_scopes IN SHARE MODE');
   const at=Date.now();
   const row=yield* one<{id:string;role:string;status:string;token_version:number;session_version:number;expires_at:number;revoked_at:number|null}>(`SELECT s.id,u.role,u.status,u.token_version,s.token_version AS session_version,s.expires_at,s.revoked_at FROM users u JOIN auth_sessions s ON s.user_id=u.id WHERE u.id=? AND s.token_hash=?`,ownerId,tokenHash);
   if(!row||row.status!=='active'||Number(row.token_version)!==tokenVersion||Number(row.session_version)!==tokenVersion||row.revoked_at!==null||Number(row.expires_at)<=at||tokenExpiresAt<=at)throw new MemoryCipherError();
   const chain=[];
   for(const id of ids){if(!(yield* one('SELECT 1 AS present FROM agents_config WHERE id=?',id)))throw new MemoryCipherError();chain.push(yield* loadStep(id));}
   const policy=yield* loadSnapshotStep(ownerId);
   const access=captureEncryptedRunAccess({ownerId,agentId:ids[0],chain,policy,...selected,tokenExpiresAt:Math.min(tokenExpiresAt,Number(row.expires_at))},at);
   const revision:MemoryRevisionCapture={ownerId,sessionId:row.id,role:row.role,tokenVersion:tokenVersion!,policyVersion:access.policyVersion,agents:access.agents,projects:[...new Set(selected.drawers.filter(d=>d.kind==='project').map(d=>d.key!))],validUntil:access.validUntil};
   return {ownerId,access,revision};
  })();
 }catch{throw new MemoryCipherError();}
}

export async function captureAuthenticatedMemoryRun(runner:StepRunner,token:string,runScope:Parameters<typeof authenticatedMemoryRunStep>[1]){
 try{return await runner.tx(()=>authenticatedMemoryRunStep(token,runScope),{immediate:true});}catch{throw new MemoryCipherError();}
}

function rawStoredMemoryRunStep(principal:NonNullable<ReturnType<typeof currentStoredRunPrincipal>>,scope:AuthenticatedRunScope){
 return (function*(){
  const claim=principal.control,native=principal.native;
  if(!principal.isCurrent()||scope.agentId!==claim.agentId||scope.project!==claim.project||scope.audience!=='owner'||JSON.stringify(scope.delegatedFrom)!==JSON.stringify(claim.delegatedFrom)||scope.drawers.some(drawer=>!claim.drawers.some(allowed=>sameDrawer(allowed,drawer))))throw new MemoryCipherError();
  yield* claim.assertCurrentStep();
  const user=yield* one<{role:string;status:string;token_version:number}>('SELECT role,status,token_version FROM users WHERE id=?',claim.ownerId);
  if(!user||user.status!=='active'||user.role!==claim.role||Number(user.token_version)!==claim.tokenVersion||!principal.isCurrent())throw new MemoryCipherError();
  const ids=[claim.agentId,...claim.delegatedFrom],chain=[];
  for(const id of ids){if(!(yield* one('SELECT 1 AS present FROM agents_config WHERE id=?',id)))throw new MemoryCipherError();chain.push(yield* loadStep(id));}
  const policy=yield* loadSnapshotStep(claim.ownerId),access=captureEncryptedRunAccess({ownerId:claim.ownerId,agentId:claim.agentId,chain,policy,project:scope.project,drawers:scope.drawers.map(drawer=>({...drawer})),audience:scope.audience,tokenExpiresAt:Math.min(claim.expiresAt,native.expiresAt)},Date.now());
  const revision:MemoryRevisionCapture={ownerId:claim.ownerId,sessionId:native.grantId,role:user.role,tokenVersion:claim.tokenVersion,policyVersion:access.policyVersion,agents:access.agents,projects:[...new Set(scope.drawers.filter(drawer=>drawer.kind==='project').map(drawer=>drawer.key!))],validUntil:access.validUntil,storedRun:principal};
  yield* claim.assertCurrentStep();if(!principal.isCurrent())throw new MemoryCipherError();return {ownerId:claim.ownerId,access,revision};
 })();
}

/** Owner decision gate; never lets an agent's write capability stand in for owner approval. */
function rawAuthenticatedMemoryOwnerStep(token:string){
 assertNoStoredRunOwnerAction();
 const decoded=verifyToken(token);
 if(!decoded.jti||!decoded.exp||!Number.isSafeInteger(decoded.tokenVersion))throw new MemoryCipherError();
 const ownerId=decoded.userId,tokenVersion=decoded.tokenVersion,hash=authSessionTokenHash(decoded.jti),tokenExpiry=decoded.exp*1000;
 return (function*(){
  if((yield* dialect())==='postgres')yield* run('LOCK TABLE users,auth_sessions IN SHARE MODE');
  const row=yield* one<{id:string;role:string;status:string;token_version:number;session_version:number;expires_at:number;revoked_at:number|null}>('SELECT s.id,u.role,u.status,u.token_version,s.token_version AS session_version,s.expires_at,s.revoked_at FROM users u JOIN auth_sessions s ON s.user_id=u.id WHERE u.id=? AND s.token_hash=?',ownerId,hash);
  const at=Date.now();
  if(!row||row.role!=='owner'||row.status!=='active'||Number(row.token_version)!==tokenVersion||Number(row.session_version)!==tokenVersion||row.revoked_at!==null||!Number.isFinite(Number(row.expires_at))||Math.min(tokenExpiry,Number(row.expires_at))<=at)throw new MemoryCipherError();
  return {ownerId,sessionId:row.id,tokenVersion,validUntil:Math.min(tokenExpiry,Number(row.expires_at))};
 })();
}

/** Final ciphertext transaction checks read the actual same-process control connection synchronously. */
export function* authenticatedMemoryRunStep(token:string,scope:AuthenticatedRunScope):ReturnType<typeof rawAuthenticatedMemoryRunStep>{const value=yield* memoryControlQuery(()=>rawAuthenticatedMemoryRunStep(token,scope));authenticatedCaptures.set(value,Object.freeze({kind:'run',ownerId:value.ownerId,sessionId:value.revision.sessionId,validUntil:value.revision.validUntil,agentId:scope.agentId,...(value.revision.storedRun?{storedRun:Object.freeze({runId:value.revision.storedRun.control.runId,grantId:value.revision.storedRun.native.grantId,workerId:value.revision.storedRun.control.workerId,generation:value.revision.storedRun.control.generation,controlStorageId:value.revision.storedRun.native.controlStorageId})}:{}),revisionDigest:createHash('sha256').update(JSON.stringify(value.revision)).digest('hex')}));return value;}
export function* authenticatedMemoryOwnerStep(token:string):ReturnType<typeof rawAuthenticatedMemoryOwnerStep>{const value=yield* memoryControlQuery(()=>rawAuthenticatedMemoryOwnerStep(token));authenticatedCaptures.set(value,Object.freeze({kind:'owner',ownerId:value.ownerId,sessionId:value.sessionId,validUntil:value.validUntil,revisionDigest:createHash('sha256').update(JSON.stringify(value)).digest('hex')}));return value;}
