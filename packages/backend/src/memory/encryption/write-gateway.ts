import {beforeEncryptedMemoryEffect,memoryEffectDigest} from './memory-effect.js';
import {captureEncryptedRunWriteAdmission,isTrustedEncryptedRunWriteAdmission,stampEncryptedRunLineage} from './run-admission.js';
import {decryptMemoryRow,encryptMemoryRow,attachEncryptedRunProducer,memoryRowSurfaceManifest} from './row-codec.js';
import {memoryControlQuery} from './control-runner.js';
/** Internal content-only write composition. No application routes or plaintext file/graph writes. */
import {packVector} from '../vectors.js';
import {redactImportText} from '../import/redact.js';
import type {EmbeddingResult} from '../embedding.js';
import {one,type StepRunner} from '../../repositories/sql-steps.js';
import {authenticatedMemoryRunStep,captureAuthenticatedMemoryRun} from './auth-capture.js';
import {loadEncryptedMemoryCandidates} from './candidate-loader.js';
import {createMemoryRevisionValidator} from './revision-validator.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {prepareEncryptedContentUpdate} from './content-update.js';
import {commitEncryptedContentStep} from './content-commit.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
export async function updateAuthenticatedMemoryContent(input:{producerAdmission?:NonNullable<ReturnType<typeof captureEncryptedRunWriteAdmission>>;runner:StepRunner;token:string;run:Parameters<typeof authenticatedMemoryRunStep>[1];session:ReturnType<typeof createMemoryUnlockSession>;id:string;patch:Record<string,unknown>;lookupKey?:Buffer;embedDocument?:(text:string)=>Promise<EmbeddingResult>;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>}){
 let operationKey:Buffer|undefined,lookupKey:Buffer|undefined,generatedVector:Buffer|undefined;
 try{
  if(input.lookupKey){if(!Buffer.isBuffer(input.lookupKey)||input.lookupKey.length!==32)throw new MemoryCipherError();lookupKey=Buffer.from(input.lookupKey);}
  const session=input.session,lease=session.capture(),runner=input.runner,token=input.token,id=input.id,recordRead=input.recordRead;
  const run={...input.run,delegatedFrom:[...input.run.delegatedFrom],drawers:input.run.drawers.map(d=>({...d}))},patch=Object.fromEntries(Object.entries(input.patch).map(([f,v])=>[f,Buffer.isBuffer(v)?Buffer.from(v):v]));
  const capture=await captureAuthenticatedMemoryRun(runner,token,run);
  if(capture.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  const validate=createMemoryRevisionValidator(runner,capture.revision,session.lock);
  const check=async()=>{if(input.producerAdmission&&!isTrustedEncryptedRunWriteAdmission(input.producerAdmission)||!lease.isCurrent()||await validate()!==true||!lease.isCurrent())throw new MemoryCipherError();};
  await check();
  if(Object.hasOwn(patch,'content')){
   if(typeof patch.content!=='string'||!patch.content.trim()||patch.content.length>50000)throw new MemoryCipherError();const content=redactImportText(patch.content).text;patch.content=content;if(!content.trim())throw new MemoryCipherError();
   if(input.embedDocument){
    const embedded=await input.embedDocument(content);await check();
    try{if(!embedded||!Number.isInteger(embedded.dims)||embedded.dims<1||embedded.dims>8192||embedded.vector.length!==embedded.dims||embedded.vector.some(value=>!Number.isFinite(value)||Math.abs(value)>3.4028234663852886e38)||typeof embedded.model!=='string'||!embedded.model||embedded.model.length>256)throw new MemoryCipherError();
     generatedVector=packVector(embedded.vector);Object.assign(patch,{embedding:null,embedding_vec:generatedVector,embedding_model:embedded.model,embedding_dims:embedded.dims});
    }finally{embedded?.vector.fill(0);}
   }else Object.assign(patch,{embedding:null,embedding_vec:null,embedding_model:null,embedding_dims:null});
  }
  const rows=await loadEncryptedMemoryCandidates(runner,capture.ownerId),expected=rows.find(row=>row.id===id);
  if(!expected||!capture.access.authorizeWrite(expected))throw new MemoryCipherError();
  await check();
  if(await recordRead({readerKind:'agent',readerId:run.agentId,purpose:'tool',records:[{table:'memories',id}]})!==true)throw new MemoryCipherError();
  await check();
  const material=await lease.resolveKey(expected);operationKey=material.key;await check();
  let replacement=prepareEncryptedContentUpdate(expected,patch,lease.scope,operationKey,material.id,capture.access.authorizeWrite);if(input.producerAdmission){if(input.producerAdmission.agentId!==run.agentId||!isTrustedEncryptedRunWriteAdmission(input.producerAdmission))throw new MemoryCipherError();const plain=decryptMemoryRow('memories',replacement,lease.scope,operationKey,material.id),s=memoryRowSurfaceManifest().find(s=>s.table==='memories')!,fields=new Set<string>([...s.text,...s.binary]);if(Object.hasOwn(patch,'content'))plain.metadata=stampEncryptedRunLineage(plain,input.producerAdmission,operationKey);replacement=encryptMemoryRow('memories',attachEncryptedRunProducer('memories',plain,lease.scope,input.producerAdmission,[...new Set([...Object.keys(patch),...(Object.hasOwn(patch,'content')?['metadata']:[])])].filter(field=>fields.has(field))),lease.scope,operationKey,material.id);}
  const key=operationKey;
  await beforeEncryptedMemoryEffect({runner,action:'update-memory',auth:capture,isCurrent:()=>lease.isCurrent()&&Date.now()<capture.revision.validUntil&&(!input.producerAdmission||isTrustedEncryptedRunWriteAdmission(input.producerAdmission)),targetDigest:memoryEffectDigest([expected,replacement])});
  await runner.tx(function*(){
   const current=yield* authenticatedMemoryRunStep(token,run);
   if(JSON.stringify(current.revision)!==JSON.stringify(capture.revision)||!current.access.authorizeWrite(expected)||!lease.isCurrent()||Date.now()>=capture.revision.validUntil)throw new MemoryCipherError();
   for(const project of current.revision.projects??[])if(yield* memoryControlQuery(()=>one('SELECT 1 AS archived FROM memory_project_scopes WHERE owner_id=? AND slug=? AND archived_at IS NOT NULL',current.ownerId,project)))throw new MemoryCipherError();
   yield* commitEncryptedContentStep(expected,replacement,lease.scope,key,material.id,'agent:'+run.agentId,lookupKey);
   if(input.producerAdmission&&!isTrustedEncryptedRunWriteAdmission(input.producerAdmission)||!lease.isCurrent()||Date.now()>=capture.revision.validUntil)throw new MemoryCipherError();
  },{immediate:true});
 }catch{throw new MemoryCipherError();}finally{operationKey?.fill(0);lookupKey?.fill(0);generatedVector?.fill(0);}
}

/** Strict derived-index entry point; legacy limited primitive remains explicit and inactive. */
export async function updateAuthenticatedIndexedMemoryContent(input:Parameters<typeof updateAuthenticatedMemoryContent>[0]&{lookupKey:Buffer}){
 if(!Buffer.isBuffer(input.lookupKey)||input.lookupKey.length!==32)throw new MemoryCipherError();
 await updateAuthenticatedMemoryContent(input);
}
