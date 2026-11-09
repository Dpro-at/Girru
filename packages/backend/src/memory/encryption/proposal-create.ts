import {stampEncryptedProposalRunLineage} from './memory-lineage.js';
import {beforeEncryptedMemoryEffect,memoryEffectDigest} from './memory-effect.js';
import {captureEncryptedRunWriteAdmission,isTrustedEncryptedRunWriteAdmission,observeEncryptedRunFieldProducer} from './run-admission.js';
import {memoryControlQuery} from './control-runner.js';
/** Queue a single encrypted addition for owner review; never auto-approves important learning. */
import {randomUUID,createHash} from 'node:crypto';
import {one,run,type StepRunner,type SqlParam} from '../../repositories/sql-steps.js';
import {captureAuthenticatedMemoryRun,authenticatedMemoryRunStep} from './auth-capture.js';
import {createMemoryRevisionValidator} from './revision-validator.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {normalizeDrawer,drawerId,type DrawerRef} from '../drawers.js';
import {lockProposalQueue,pendingProposalCountStep,MAX_PENDING_PROPOSALS,proposalReviewHash,type MemoryChange} from '../memory-files.js';
import {drawerRevisionStep,type VersionEntry} from '../versions.js';
import {encryptMemoryRow,decryptMemoryRow,memoryRowSurfaceManifest,attachEncryptedRunProducer,encryptedFieldProducer} from './row-codec.js';
import {MemoryCipherError} from './envelope.js';
export function encryptedAdditionBaseHash(ownerId:string,drawer:DrawerRef,revision:number){return createHash('sha256').update(JSON.stringify(['encrypted-addition',1,ownerId,drawerId(drawer),revision])).digest('hex');}
export async function queueAuthenticatedEncryptedAddition(input:{producerAdmission?:NonNullable<ReturnType<typeof captureEncryptedRunWriteAdmission>>;runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;run:Parameters<typeof authenticatedMemoryRunStep>[1];drawer:DrawerRef;entry:VersionEntry;reasons:readonly string[]}){
 const {runner,token,session}=input;let key:Buffer|undefined;
 try{
  const boundary=()=>{if(input.producerAdmission&&!isTrustedEncryptedRunWriteAdmission(input.producerAdmission))throw new MemoryCipherError();if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};boundary();
  const lease=session.capture(),drawer=normalizeDrawer(input.drawer),entry={...input.entry},reasons=[...input.reasons],runScope={...input.run,delegatedFrom:[...input.run.delegatedFrom],drawers:input.run.drawers.map(d=>({...d}))};
  if(typeof entry.content!=='string'||!entry.content.trim()||entry.content.length>50000||typeof entry.type!=='string'||!/^[a-z][a-z_-]{0,31}$/.test(entry.type)||!Number.isInteger(entry.importance)||entry.importance<1||entry.importance>10||reasons.length>20||reasons.some(reason=>typeof reason!=='string'||reason.length>128)||!['owner','project'].includes(drawer.kind))throw new MemoryCipherError();
  const auth=await captureAuthenticatedMemoryRun(runner,token,runScope);boundary();if(auth.ownerId!==lease.scope.ownerId||!lease.isCurrent()||input.producerAdmission&&!isTrustedEncryptedRunWriteAdmission(input.producerAdmission))throw new MemoryCipherError();
  const metadata={user_id:auth.ownerId,status:'active',drawer_kind:drawer.kind,drawer_key:drawer.key??''};if(!auth.access.authorizeWrite(metadata))throw new MemoryCipherError();const validate=createMemoryRevisionValidator(runner,auth.revision,session.lock);
  if(await validate()!==true||!lease.isCurrent()||input.producerAdmission&&!isTrustedEncryptedRunWriteAdmission(input.producerAdmission))throw new MemoryCipherError();boundary();const material=await lease.resolveKey(metadata);key=material.key;boundary();if(await validate()!==true||!lease.isCurrent()||input.producerAdmission&&!isTrustedEncryptedRunWriteAdmission(input.producerAdmission))throw new MemoryCipherError();
  const operationKey=key,id=randomUUID(),changes:MemoryChange[]=[{op:'add',after:entry}];
  const preparedRevision=await runner.tx(function*(){const fresh=yield* authenticatedMemoryRunStep(token,runScope);if(JSON.stringify(fresh.revision)!==JSON.stringify(auth.revision)||!fresh.access.authorizeWrite(metadata)||!lease.isCurrent()||input.producerAdmission&&!isTrustedEncryptedRunWriteAdmission(input.producerAdmission))throw new MemoryCipherError();if((yield* pendingProposalCountStep(auth.ownerId))>=MAX_PENDING_PROPOSALS)throw new MemoryCipherError();if(drawer.kind==='project'&&(yield* memoryControlQuery(()=>one('SELECT 1 AS archived FROM memory_project_scopes WHERE owner_id=? AND slug=? AND archived_at IS NOT NULL',auth.ownerId,drawer.key!))))throw new MemoryCipherError();return yield* drawerRevisionStep(auth.ownerId,drawer);},{immediate:true});boundary();
  await beforeEncryptedMemoryEffect({runner,action:'queue-addition',auth,isCurrent:()=>lease.isCurrent()&&Date.now()<auth.revision.validUntil&&(!input.producerAdmission||isTrustedEncryptedRunWriteAdmission(input.producerAdmission)),targetDigest:memoryEffectDigest([id,drawer,entry,reasons,preparedRevision])});boundary();
  const result=await runner.tx(function*(){
   const fresh=yield* authenticatedMemoryRunStep(token,runScope);if(JSON.stringify(fresh.revision)!==JSON.stringify(auth.revision)||!fresh.access.authorizeWrite(metadata)||!lease.isCurrent()||input.producerAdmission&&!isTrustedEncryptedRunWriteAdmission(input.producerAdmission))throw new MemoryCipherError();
   yield* lockProposalQueue(auth.ownerId);if((yield* pendingProposalCountStep(auth.ownerId))>=MAX_PENDING_PROPOSALS)throw new MemoryCipherError();
   if(drawer.kind==='project'&&(yield* memoryControlQuery(()=>one('SELECT 1 AS archived FROM memory_project_scopes WHERE owner_id=? AND slug=? AND archived_at IS NOT NULL',auth.ownerId,drawer.key!))))throw new MemoryCipherError();
   const revision=yield* drawerRevisionStep(auth.ownerId,drawer),baseHash=encryptedAdditionBaseHash(auth.ownerId,drawer,revision),surface=memoryRowSurfaceManifest().find(s=>s.table==='memory_file_proposals')!;
   if(revision!==preparedRevision)throw new MemoryCipherError();
   const row:Record<string,unknown>=Object.fromEntries([surface.owner,surface.id,...surface.bound,...surface.clear,...surface.text,...surface.binary].map(field=>[field,null]));
   Object.assign(row,{id,user_id:auth.ownerId,agent_id:runScope.agentId,drawer_kind:drawer.kind,drawer_key:drawer.key??'',base_hash:baseHash,base_revision:revision,changes:JSON.stringify(changes),status:'pending',source:'agent',created_by:'agent:'+runScope.agentId,created_at:new Date().toISOString(),reasons:JSON.stringify(reasons)});
   if(input.producerAdmission)row.note=stampEncryptedProposalRunLineage(row,input.producerAdmission,operationKey);
   const cipher=encryptMemoryRow('memory_file_proposals',input.producerAdmission?attachEncryptedRunProducer('memory_file_proposals',row,lease.scope,input.producerAdmission):row,lease.scope,operationKey,material.id),fields=Object.keys(cipher);yield* run(`INSERT INTO memory_file_proposals(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,...fields.map(f=>cipher[f] as SqlParam));
   const stored=yield* one<Record<string,unknown>>('SELECT * FROM memory_file_proposals WHERE id=? AND user_id=?',id,auth.ownerId);if(!stored||decryptMemoryRow('memory_file_proposals',stored,lease.scope,operationKey,material.id).changes!==row.changes||!lease.isCurrent()||input.producerAdmission&&!isTrustedEncryptedRunWriteAdmission(input.producerAdmission))throw new MemoryCipherError();
   if(input.producerAdmission&&!isTrustedEncryptedRunWriteAdmission(input.producerAdmission))throw new MemoryCipherError();return{id,reviewHash:proposalReviewHash({id,drawerId:drawerId(drawer),baseRevision:revision,baseHash,source:'agent',changes})};
  },{immediate:true});boundary();if(await validate()!==true||!lease.isCurrent()||input.producerAdmission&&!isTrustedEncryptedRunWriteAdmission(input.producerAdmission))throw new MemoryCipherError();return result;
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
