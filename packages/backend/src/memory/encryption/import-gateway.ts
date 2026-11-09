import {beforeEncryptedMemoryEffect,memoryEffectDigest} from './memory-effect.js';
import {prepareOwnerNewContent,captureOwnerNewContentAdmission,isTrustedOwnerNewContentAdmission} from './owner-content-admission.js';
import {memoryControlQuery,readMemoryControlStep} from './control-runner.js';
/** Explicit owner text import into one encrypted review proposal. No plaintext preview store, file reads or model calls. */
import {randomUUID} from 'node:crypto';
import {one,run,type StepRunner,type SqlParam} from '../../repositories/sql-steps.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {chunkMarkdown,chunkPlain} from '../import/pipeline.js';
import {redactImportText} from '../import/redact.js';
import {normalizeDrawer,drawerId,type DrawerRef} from '../drawers.js';
import {projectStep} from '../scopes/store.js';
import {drawerRevisionStep} from '../versions.js';
import {lockProposalQueue,pendingProposalCountStep,MAX_PENDING_PROPOSALS,type MemoryChange} from '../memory-files.js';
import {encryptedAdditionBaseHash} from './proposal-create.js';
import {memoryRowSurfaceManifest,encryptMemoryRow,attachOwnerNewContentProducer} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import {MemoryCipherError} from './envelope.js';
export async function queueAuthenticatedEncryptedOwnerImport(input:{runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;text:string;format:'markdown'|'text';drawer:DrawerRef;sourceLease?:()=>boolean;sourceDigest?:string}){
 const {runner,token,session}=input;const sourceLease=input.sourceLease,sourceDigest=input.sourceDigest;let key:Buffer|undefined;
 try{
  const sourceCurrent=()=>sourceLease===undefined?sourceDigest===undefined:typeof sourceLease==='function'&&typeof sourceDigest==='string'&&/^[a-f0-9]{64}$/.test(sourceDigest)&&sourceLease()===true;
  const boundary=()=>{if(!sourceCurrent()||runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};boundary();
  const drawer=normalizeDrawer(input.drawer);if(!['owner','project'].includes(drawer.kind)||typeof input.text!=='string'||Buffer.byteLength(input.text)>512*1024||!['markdown','text'].includes(input.format))throw new MemoryCipherError();
  const prepared=prepareOwnerNewContent(sourceLease?'file-import':'text-import',null,drawerId(drawer),input.text,input.format),sanitized=prepared.text,seen=new Set<string>(),chunks=(input.format==='markdown'?chunkMarkdown(sanitized):chunkPlain(sanitized)).filter(chunk=>{const value=chunk.content.trim();if(!value||seen.has(value))return false;seen.add(value);return true;});
  if(!chunks.length||chunks.length>200||chunks.some(chunk=>chunk.content.length>50000))throw new MemoryCipherError();const changes:MemoryChange[]=chunks.map(chunk=>({op:'add',after:{content:chunk.content,type:'fact',importance:5}}));if(Buffer.byteLength(JSON.stringify(changes))>768*1024)throw new MemoryCipherError();
  const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(owner.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  const admission=captureOwnerNewContentAdmission(owner.ownerId,lease.scope.memberId,prepared.intent);if(!admission)throw new MemoryCipherError();
  const check=async()=>{boundary();if(!isTrustedOwnerNewContentAdmission(admission))throw new MemoryCipherError();const fresh=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});boundary();if(!sourceCurrent()||JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();};await check();
  const agent=await readMemoryControlStep(runner,one<{id:string}>('SELECT id FROM agents_config WHERE is_primary=1 ORDER BY id LIMIT 1'));await check();if(!agent)throw new MemoryCipherError();
  const material=await lease.resolveKey({user_id:owner.ownerId});key=material.key;if(material.id!==admission.anchor.keyId)throw new MemoryCipherError();await check();const operationKey=key,id=randomUUID();
  await runner.tx(function*(){if((yield* pendingProposalCountStep(owner.ownerId))>=MAX_PENDING_PROPOSALS)throw new MemoryCipherError();if(drawer.kind==='project'){const project=yield* memoryControlQuery(()=>projectStep(owner.ownerId,drawer.key!));if(!project||project.archived)throw new MemoryCipherError();}if(!(yield* memoryControlQuery(()=>one('SELECT id FROM agents_config WHERE id=?',agent.id))))throw new MemoryCipherError();},{immediate:true});await check();
  await beforeEncryptedMemoryEffect({runner,action:'queue-owner-import',auth:owner,isCurrent:()=>lease.isCurrent()&&sourceCurrent()&&isTrustedOwnerNewContentAdmission(admission),targetDigest:memoryEffectDigest([id,drawer,changes,sourceDigest??null,prepared.intent])});
  await runner.tx(function*(){const fresh=yield* authenticatedMemoryOwnerStep(token);if(!sourceCurrent()||JSON.stringify(fresh)!==JSON.stringify(owner)||!lease.isCurrent())throw new MemoryCipherError();
   yield* lockProposalQueue(owner.ownerId);if((yield* pendingProposalCountStep(owner.ownerId))>=MAX_PENDING_PROPOSALS)throw new MemoryCipherError();if(drawer.kind==='project'){const project=yield* memoryControlQuery(()=>projectStep(owner.ownerId,drawer.key!));if(!project||project.archived)throw new MemoryCipherError();}
   if(!(yield* memoryControlQuery(()=>one('SELECT id FROM agents_config WHERE id=?',agent.id))))throw new MemoryCipherError();
   const revision=yield* drawerRevisionStep(owner.ownerId,drawer),surface=memoryRowSurfaceManifest().find(surface=>surface.table==='memory_file_proposals')!,plain:Record<string,unknown>=Object.fromEntries([surface.owner,surface.id,...surface.bound,...surface.clear,...surface.text,...surface.binary].map(field=>[field,null]));
   Object.assign(plain,{id,user_id:owner.ownerId,agent_id:agent.id,drawer_kind:drawer.kind,drawer_key:drawer.key??'',base_hash:encryptedAdditionBaseHash(owner.ownerId,drawer,revision),base_revision:revision,changes:JSON.stringify(changes),status:'pending',source:'import',created_by:owner.ownerId,created_at:new Date().toISOString(),reasons:JSON.stringify(['Explicit owner import; review all additions before applying']),import_batch_id:randomUUID(),note:sourceDigest?JSON.stringify({source:'explicit-host-file',sha256:sourceDigest}):null});
   const cipher=encryptMemoryRow('memory_file_proposals',attachOwnerNewContentProducer('memory_file_proposals',plain,lease.scope,admission),lease.scope,operationKey,material.id),fields=Object.keys(cipher);yield* run(`INSERT INTO memory_file_proposals(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,...fields.map(field=>cipher[field] as SqlParam));
   const stored=yield* one<Record<string,unknown>>('SELECT * FROM memory_file_proposals WHERE id=? AND user_id=?',id,owner.ownerId);if(!stored||canonicalEncryptedRow(stored)!==canonicalEncryptedRow(cipher)||!lease.isCurrent()||Date.now()>=owner.validUntil||!sourceCurrent()||!isTrustedOwnerNewContentAdmission(admission))throw new MemoryCipherError();
  },{immediate:true});await check();return{proposalId:id,count:changes.length};
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
