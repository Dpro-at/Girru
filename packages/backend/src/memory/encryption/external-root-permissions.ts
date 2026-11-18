/** Explicit owner-only cleanup-planning grants. No discovery-consent inheritance or filesystem effects. */
import path from 'node:path';import {createHmac,randomUUID} from 'node:crypto';
import {one,run,lockName,type Step,type StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import type {ExternalRootPermissionRequest} from './external-reference-plan.js';
import {MemoryCipherError} from './envelope.js';
const TABLE='memory_encryption_external_root_grants';
export function createExternalRootPermissionService(input:{runner:StepRunner;token:string;lookupKey:Buffer}){
 const {runner,token}=input;if(!Buffer.isBuffer(input.lookupKey)||input.lookupKey.length!==32)throw new MemoryCipherError();
 const key=Buffer.from(input.lookupKey);let closed=false;
 const active=()=>{if(closed||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};
 const boundary=()=>{active();if(runner.inTransaction?.()!==false)throw new MemoryCipherError();};
 const guarded=function*<T>(step:Step<T>):Step<T>{
  let next=step.next();
  try{while(!next.done){active();let value;try{value=yield next.value;}catch(error){next=step.throw(error);continue;}active();next=step.next(value);}
   active();return next.value;
  }finally{if(!next.done)step.return(undefined as T);}
 };
 const tx=<T>(step:()=>Step<T>)=>runner.tx(()=>guarded(step()),{immediate:true});
 const rootToken=(ownerId:string,scope:string,root:string)=>{
  active();
  if(typeof scope!=='string'||!scope.startsWith('project:')||Buffer.byteLength(scope)>512||typeof root!=='string'||Buffer.byteLength(root)>16384||root.includes('\0')||!path.isAbsolute(root)||path.resolve(root)!==root||root===path.parse(root).root)throw new MemoryCipherError();
  return createHmac('sha256',key).update(JSON.stringify(['external-forget-plan',1,ownerId,scope,root])).digest('hex');
 };
 return{
  async initialize(){boundary();await tx(function*(){yield* authenticatedMemoryOwnerStep(token);yield* run(`CREATE TABLE IF NOT EXISTS ${TABLE}(owner_id TEXT NOT NULL,scope TEXT NOT NULL,root_mac TEXT NOT NULL,grant_id TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,expires_at BIGINT NOT NULL,PRIMARY KEY(owner_id,scope,root_mac))`);});},
  /** Trusted owner-command boundary only; never call automatically from discovery/planning. */
  async grant(scope:string,root:string,expiresAt:number){
   boundary();if(!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+3600000)throw new MemoryCipherError();
   return tx(function*(){
    const owner=yield* authenticatedMemoryOwnerStep(token),mac=rootToken(owner.ownerId,scope,root);
    yield* lockName('external-root-grant:'+owner.ownerId+':'+mac);
    const project=yield* one<{owner_id:string}>('SELECT owner_id FROM change_scopes WHERE scope=?',scope);if(!project||project.owner_id!==owner.ownerId)throw new MemoryCipherError();
    const old=yield* one<{generation:number|string}>(`SELECT generation FROM ${TABLE} WHERE owner_id=? AND scope=? AND root_mac=?`,owner.ownerId,scope,mac);
    const generation=old?Number(old.generation)+1:1;if(!Number.isSafeInteger(generation)||generation<1)throw new MemoryCipherError();const id=randomUUID();
    yield* run(`INSERT INTO ${TABLE}(owner_id,scope,root_mac,grant_id,generation,state,expires_at) VALUES(?,?,?,?,?,'allowed',?) ON CONFLICT(owner_id,scope,root_mac) DO UPDATE SET grant_id=excluded.grant_id,generation=excluded.generation,state='allowed',expires_at=excluded.expires_at`,owner.ownerId,scope,mac,id,generation,expiresAt);
    return{id,generation};
   });
  },
  async revoke(scope:string,root:string){boundary();await tx(function*(){const owner=yield* authenticatedMemoryOwnerStep(token),mac=rootToken(owner.ownerId,scope,root);yield* lockName('external-root-grant:'+owner.ownerId+':'+mac);yield* run(`UPDATE ${TABLE} SET state='revoked' WHERE owner_id=? AND scope=? AND root_mac=?`,owner.ownerId,scope,mac);});},
  async authorizeRoot(request:ExternalRootPermissionRequest):Promise<boolean>{
   boundary();const {ownerId,scope,root,purpose}=request;if(purpose!=='encrypted-forget-plan')return false;
   return tx(function*(){
    const owner=yield* authenticatedMemoryOwnerStep(token);if(owner.ownerId!==ownerId)return false;
    const mac=rootToken(owner.ownerId,scope,root),project=yield* one<{owner_id:string}>('SELECT owner_id FROM change_scopes WHERE scope=?',scope);
    if(!project||project.owner_id!==owner.ownerId)return false;
    const row=yield* one<{state:string;expires_at:number|string;generation:number|string}>(`SELECT state,expires_at,generation FROM ${TABLE} WHERE owner_id=? AND scope=? AND root_mac=?`,owner.ownerId,scope,mac);
    return !!row&&row.state==='allowed'&&Number.isSafeInteger(Number(row.generation))&&Number(row.generation)>0&&Number.isSafeInteger(Number(row.expires_at))&&Number(row.expires_at)>Date.now();
   });
  },
  close(){closed=true;key.fill(0);},
 };
}
