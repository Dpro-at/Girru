/** Internal topic search. The keyed index is an untrusted hint, never an access grant. */
import type {StepRunner} from '../../repositories/sql-steps.js';
import {normalizeDrawer,sameDrawer,defaultDrawerForType,type DrawerRef} from '../drawers.js';
import {captureAuthenticatedMemoryRun} from './auth-capture.js';
import {createMemoryRevisionValidator} from './revision-validator.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {loadEncryptedMemoryCandidates} from './candidate-loader.js';
import {findEncryptedTopicCandidateStep} from './topic-index.js';
import {memoryTopicLookupToken,verifyMemoryTopicLookup} from './topic-lookup.js';
import {decryptMemoryRow} from './row-codec.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
export async function findAuthenticatedMemoryByTopic(input:{runner:StepRunner;token:string;run:Parameters<typeof captureAuthenticatedMemoryRun>[2];session:ReturnType<typeof createMemoryUnlockSession>;drawer:DrawerRef;topic:string;lookupKey:Buffer;recordRead:(intent:MemoryReadIntent)=>Promise<boolean>}):Promise<{id:string;content:string}|null>{
 let lookupKey:Buffer|undefined,operationKey:Buffer|undefined;
 try{
  if(!Buffer.isBuffer(input.lookupKey)||input.lookupKey.length!==32)throw new MemoryCipherError();lookupKey=Buffer.from(input.lookupKey);
  const runner=input.runner,token=input.token,session=input.session,lease=session.capture(),drawer=normalizeDrawer(input.drawer),topic=input.topic,recordRead=input.recordRead;
  const run={...input.run,delegatedFrom:[...input.run.delegatedFrom],drawers:input.run.drawers.map(d=>({...d}))};
  const auth=await captureAuthenticatedMemoryRun(runner,token,run);
  if(auth.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  const validate=createMemoryRevisionValidator(runner,auth.revision,session.lock);
  const check=async()=>{if(!lease.isCurrent()||await validate()!==true||!lease.isCurrent())throw new MemoryCipherError();};
  await check();
  if(!auth.access.authorize({user_id:auth.ownerId,status:'active',drawer_kind:drawer.kind,drawer_key:drawer.key??''}))return null;
  const expectedToken=memoryTopicLookupToken(topic,lookupKey,auth.ownerId,drawer);
  const candidateId=await runner.read(findEncryptedTopicCandidateStep(auth.ownerId,drawer,topic,lookupKey));await check();
  if(candidateId===null)return null;
  const candidates=await loadEncryptedMemoryCandidates(runner,auth.ownerId),row=candidates.find(r=>r.id===candidateId);await check();
  if(!row||!auth.access.authorize(row))return null;
  const cipherDrawer=row.drawer_kind==null?defaultDrawerForType(typeof row.type==='string'?row.type:undefined):normalizeDrawer({kind:row.drawer_kind,key:row.drawer_key??''});
  if(!sameDrawer(cipherDrawer,drawer))return null;
  if(await recordRead({readerKind:'agent',readerId:run.agentId,purpose:'recall',records:[{table:'memories',id:candidateId}]})!==true)throw new MemoryCipherError();await check();
  const material=await lease.resolveKey(row);operationKey=material.key;await check();
  if(material.scope.ownerId!==lease.scope.ownerId||material.scope.memberId!==lease.scope.memberId)throw new MemoryCipherError();
  const plain=decryptMemoryRow('memories',row,lease.scope,operationKey,material.id);
  // Re-authorize authenticated plaintext metadata and verify the actual topic, not just the index hint.
  if(!auth.access.authorize(plain)||plain.id!==candidateId||typeof plain.content!=='string'||typeof plain.topic_key!=='string')throw new MemoryCipherError();
  const actualDrawer=plain.drawer_kind==null?defaultDrawerForType(typeof plain.type==='string'?plain.type:undefined):normalizeDrawer({kind:plain.drawer_kind,key:plain.drawer_key??''});
  if(!sameDrawer(actualDrawer,drawer))throw new MemoryCipherError();
  verifyMemoryTopicLookup(plain.topic_key,expectedToken,lookupKey,auth.ownerId,actualDrawer);
  await check();return {id:candidateId,content:plain.content};
 }catch{throw new MemoryCipherError();}finally{operationKey?.fill(0);lookupKey?.fill(0);}
}
