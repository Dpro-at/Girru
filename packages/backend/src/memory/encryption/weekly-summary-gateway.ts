import {beforeEncryptedMemoryEffect,memoryEffectDigest} from './memory-effect.js';
import {captureMemoryRestoreAnchor,sameMemoryRestoreAnchor} from './restore-package.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
/** Deterministic encrypted summary, reusing the existing digest renderer; no model/network or background key creation. */
import {one,run,type StepRunner,type SqlParam} from '../../repositories/sql-steps.js';
import {orderedId} from '../../repositories/ordered-id.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {loadEncryptedForgetRows,encryptedForgetRowsStep,sameForgetRows} from './forget-scrub-store.js';
import {decryptMemoryRow,encryptMemoryRow,encryptedFieldProducer} from './row-codec.js';
import {buildWeeklyDigestFromRows,renderDigest,SUMMARY_DAYS,type WeeklyDigestInputRows} from '../weekly-summary.js';
import {normalizeDrawer,defaultDrawerForType,drawerId,type DrawerRef} from '../drawers.js';
import {canonicalEncryptedRow} from './content-commit.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
export async function runAuthenticatedEncryptedWeeklySummary(input:{captureAuthority?:()=>Promise<MemoryRestoreAuthorityLease|null>;runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>;now?:Date}){
 const {runner,token,session,recordRead}=input;let key:Buffer|undefined;
 try{
  const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};boundary();
  const capturedAuthority=input.captureAuthority?await input.captureAuthority():undefined;if(input.captureAuthority&&(!capturedAuthority||!capturedAuthority.isCurrent()))throw new MemoryCipherError();const anchor=capturedAuthority?captureMemoryRestoreAnchor(capturedAuthority.anchor):undefined;
  const now=new Date(input.now?.getTime()??Date.now());if(!Number.isFinite(now.getTime()))throw new MemoryCipherError();const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(owner.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  const check=async()=>{boundary();if(input.captureAuthority){const freshAuthority=await input.captureAuthority();if(!anchor||!capturedAuthority?.isCurrent()||!freshAuthority||!freshAuthority.isCurrent()||!sameMemoryRestoreAnchor(anchor,freshAuthority.anchor))throw new MemoryCipherError();}const fresh=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();};
  const captured=await loadEncryptedForgetRows(runner,owner.ownerId);await check();const records:MemoryReadIntent['records']=[];
  for(const table of ['memories','memory_versions','memory_file_proposals'] as const)for(const row of captured[table]){if(typeof row.id!=='string')throw new MemoryCipherError();records.push({table,id:row.id});}
  for(let i=0;i<records.length;i+=500){if(await recordRead({readerKind:'user',readerId:owner.ownerId,purpose:'view',records:records.slice(i,i+500)})!==true)throw new MemoryCipherError();await check();}
  const material=await lease.resolveKey({user_id:owner.ownerId});key=material.key;await check();const plain=captured.memories.map(row=>decryptMemoryRow('memories',row,lease.scope,key!,material.id)),versions=captured.memory_versions.map(row=>decryptMemoryRow('memory_versions',row,lease.scope,key!,material.id)),proposals=captured.memory_file_proposals.map(row=>decryptMemoryRow('memory_file_proposals',row,lease.scope,key!,material.id));
  if(anchor){for(const [table,rows,field] of [['memories',plain,'content'],['memory_file_proposals',proposals.filter(row=>row.status==='pending'),'changes']] as const)for(const row of rows){const producer=encryptedFieldProducer(table,row,field,lease.scope);if(!producer||!sameMemoryRestoreAnchor(anchor,{v:1,ownerId:producer.ownerId,memberId:producer.memberId,authorityId:producer.authorityId,keyId:producer.keyId,epoch:producer.epoch,forgetSequence:producer.forgetSequence,forgetMac:producer.forgetMac}))throw new MemoryCipherError();}}
  const drawers=new Map<string,DrawerRef&{count:number}>(),pending=new Map<string,{drawer_kind:string;drawer_key:string;n:number}>(),current=new Map(plain.map(row=>[String(row.id),typeof row.content==='string'?row.content:null]));
  for(const row of plain){const d=row.drawer_kind==null?defaultDrawerForType(typeof row.type==='string'?row.type:undefined):normalizeDrawer({kind:row.drawer_kind,key:row.drawer_key??''}),id=drawerId(d),previous=drawers.get(id);drawers.set(id,{...d,count:(previous?.count??0)+1});}
  for(const row of proposals)if(row.status==='pending'){const d=normalizeDrawer({kind:row.drawer_kind,key:row.drawer_key??''}),id=drawerId(d),previous=pending.get(id);pending.set(id,{drawer_kind:d.kind,drawer_key:d.key??'',n:(previous?.n??0)+1});}
  const start=now.getTime()-SUMMARY_DAYS*24*60*60*1000,rows:WeeklyDigestInputRows['rows']=versions.filter(row=>['create','update','delete','forget'].includes(String(row.change))&&typeof row.created_at==='string'&&Date.parse(row.created_at)>=start&&Date.parse(row.created_at)<=now.getTime()).sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))||String(a.memory_id).localeCompare(String(b.memory_id))||Number(a.version)-Number(b.version)).map(row=>({memory_id:String(row.memory_id),drawer_kind:String(row.drawer_kind),drawer_key:typeof row.drawer_key==='string'?row.drawer_key:'',change:row.change as 'create'|'update'|'delete'|'forget',created_at:String(row.created_at),current:current.get(String(row.memory_id))??null}));
  const digest=buildWeeklyDigestFromRows(owner.ownerId,now,SUMMARY_DAYS,{drawers:[...drawers.values()],rows,pending:[...pending.values()]}),text=renderDigest(digest),id=orderedId(),record={id,user_id:owner.ownerId,period_start:digest.periodStart,period_end:digest.periodEnd,digest:JSON.stringify(digest),text,model_text:null,model:null,created_by:owner.ownerId,created_at:new Date().toISOString()};
  const cipher=encryptMemoryRow('memory_weekly_summaries',record,lease.scope,key,material.id);await check();await beforeEncryptedMemoryEffect({runner,action:'create-weekly-summary',auth:owner,isCurrent:()=>lease.isCurrent()&&Date.now()<owner.validUntil,targetDigest:memoryEffectDigest([cipher])});await runner.tx(function*(){
   const fresh=yield* authenticatedMemoryOwnerStep(token);if(capturedAuthority&&!capturedAuthority.isCurrent()||JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent()||!sameForgetRows(captured,yield* encryptedForgetRowsStep(owner.ownerId)))throw new MemoryCipherError();
   const fields=Object.keys(cipher);yield* run(`INSERT INTO memory_weekly_summaries(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,...fields.map(field=>cipher[field] as SqlParam));const stored=yield* one<Record<string,unknown>>('SELECT * FROM memory_weekly_summaries WHERE id=? AND user_id=?',id,owner.ownerId);if(!stored||canonicalEncryptedRow(stored)!==canonicalEncryptedRow(cipher)||!lease.isCurrent()||Date.now()>=owner.validUntil||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();
  },{immediate:true});await check();return{id};
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
