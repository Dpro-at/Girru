import {beforeEncryptedMemoryEffect,memoryEffectDigest} from './memory-effect.js';
import {memoryControlQuery,bumpMemoryControlAccessVersion} from './control-runner.js';
/** Internal single-record move. Never substitutes for project merge/doctor lifecycle workflows. */
import {one,type StepRunner} from '../../repositories/sql-steps.js';
import {normalizeDrawer,sameDrawer,defaultDrawerForType,type DrawerRef} from '../drawers.js';
import {captureAuthenticatedMemoryRun,authenticatedMemoryRunStep} from './auth-capture.js';
import {createMemoryRevisionValidator} from './revision-validator.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {loadEncryptedMemoryCandidates} from './candidate-loader.js';
import {prepareEncryptedDrawerMove} from './drawer-move.js';
import {commitEncryptedContentStep} from './content-commit.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
export async function moveAuthenticatedMemoryDrawer(input:{runner:StepRunner;token:string;run:Parameters<typeof authenticatedMemoryRunStep>[1];session:ReturnType<typeof createMemoryUnlockSession>;id:string;source:DrawerRef;target:DrawerRef;lookupKey:Buffer;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>}){
 let key:Buffer|undefined,lookup:Buffer|undefined;
 try{
  if(!Buffer.isBuffer(input.lookupKey)||input.lookupKey.length!==32)throw new MemoryCipherError();lookup=Buffer.from(input.lookupKey);
  const runner=input.runner,token=input.token,session=input.session,lease=session.capture(),id=input.id,recordRead=input.recordRead;
  const source=normalizeDrawer(input.source),target=normalizeDrawer(input.target),base={...input.run,delegatedFrom:[...input.run.delegatedFrom],drawers:input.run.drawers.map(normalizeDrawer)};
  if(base.audience!=='owner'||![source,target].every(d=>['owner','project'].includes(d.kind)&&base.drawers.some(s=>sameDrawer(s,d)))||sameDrawer(source,target))throw new MemoryCipherError();
  const scoped=(drawer:DrawerRef)=>({...base,drawers:[drawer],project:drawer.kind==='project'?drawer.key!:null});
  const sourceRun=scoped(source),targetRun=scoped(target),from=await captureAuthenticatedMemoryRun(runner,token,sourceRun),to=await captureAuthenticatedMemoryRun(runner,token,targetRun);
  if(from.ownerId!==to.ownerId||from.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  const validateFrom=createMemoryRevisionValidator(runner,from.revision,session.lock),validateTo=createMemoryRevisionValidator(runner,to.revision,session.lock);
  const check=async()=>{if(!lease.isCurrent()||await validateFrom()!==true||await validateTo()!==true||!lease.isCurrent())throw new MemoryCipherError();};
  await check();const rows=await loadEncryptedMemoryCandidates(runner,from.ownerId),expected=rows.find(r=>r.id===id);
  if(!expected)throw new MemoryCipherError();
  const actual=expected.drawer_kind==null?defaultDrawerForType(typeof expected.type==='string'?expected.type:undefined):normalizeDrawer({kind:expected.drawer_kind,key:expected.drawer_key??''});
  if(!sameDrawer(actual,source)||!from.access.authorizeWrite(expected)||!to.access.authorizeWrite({...expected,drawer_kind:target.kind,drawer_key:target.key??''}))throw new MemoryCipherError();
  await check();if(await recordRead({readerKind:'agent',readerId:base.agentId,purpose:'tool',records:[{table:'memories',id}]})!==true)throw new MemoryCipherError();await check();
  const material=await lease.resolveKey(expected);key=material.key;await check();
  const replacement=prepareEncryptedDrawerMove(expected,target,lease.scope,key,material.id,from.access.authorizeWrite,to.access.authorizeWrite),operationKey=key,lookupKey=lookup;
  await beforeEncryptedMemoryEffect({runner,action:'move-memory',auth:from,isCurrent:()=>lease.isCurrent()&&Date.now()<Math.min(from.revision.validUntil,to.revision.validUntil),targetDigest:memoryEffectDigest([expected,replacement,source,target])});
  await runner.tx(function*(){
   const currentFrom=yield* authenticatedMemoryRunStep(token,sourceRun),currentTo=yield* authenticatedMemoryRunStep(token,targetRun);
   if(JSON.stringify(currentFrom.revision)!==JSON.stringify(from.revision)||JSON.stringify(currentTo.revision)!==JSON.stringify(to.revision)||!currentFrom.access.authorizeWrite(expected)||!currentTo.access.authorizeWrite(replacement)||!lease.isCurrent())throw new MemoryCipherError();
   for(const project of [...from.revision.projects??[],...to.revision.projects??[]])if(yield* memoryControlQuery(()=>one('SELECT 1 AS archived FROM memory_project_scopes WHERE owner_id=? AND slug=? AND archived_at IS NOT NULL',from.ownerId,project)))throw new MemoryCipherError();
   const current=()=>{if(!lease.isCurrent()||Date.now()>=Math.min(from.revision.validUntil,to.revision.validUntil))throw new MemoryCipherError();};current();
   yield* commitEncryptedContentStep(expected,replacement,lease.scope,operationKey,material.id,'agent:'+base.agentId,lookupKey,target);current();
  },{immediate:true});
  // The authorized move is committed; revoke every old captured run before it can persist old-scope context.
  await bumpMemoryControlAccessVersion(runner,from.ownerId);
 }catch{throw new MemoryCipherError();}finally{key?.fill(0);lookup?.fill(0);}
}
