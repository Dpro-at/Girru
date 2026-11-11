import {loadEncryptedMemoryCandidates} from './candidate-loader.js';
/** Internal composition only. No routes/startup hooks or automatic database/profile selection. */
import type {StepRunner} from '../../repositories/sql-steps.js';
import {captureAuthenticatedMemoryRun} from './auth-capture.js';
import {createMemoryRevisionValidator} from './revision-validator.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {recallEncryptedMemories} from './recall.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
import type {EmbeddingResult} from '../embedding.js';
export async function recallAuthenticatedMemory(input:{
 runner:StepRunner;token:string;run:Parameters<typeof captureAuthenticatedMemoryRun>[2];
 session:ReturnType<typeof createMemoryUnlockSession>;
 rows:Iterable<Record<string,unknown>>;query:string;limit?:number;filter?:(row:Readonly<Record<string,unknown>>)=>boolean;embedding?:EmbeddingResult;reader?:{kind:'coding-app';id:string};
 /** Trusted host capability lease, never obtained from request JSON. */
 callerLease?:{isCurrent:()=>boolean;validateCurrent:()=>Promise<boolean>};
 embedQuery?:(query:string)=>Promise<EmbeddingResult>;
 /** Server-owned durable audit writer; must acknowledge persistence before decrypt. */
 recordRead:(intent:MemoryReadIntent)=>Promise<boolean>;
}){
 let cachedKey:{id:string;key:Buffer;scope:{ownerId:string;memberId:string}}|undefined;
 try{
  const lease=input.session.capture(),lock=input.session.lock,recordRead=input.recordRead,rows=input.rows,query=input.query,limit=input.limit;
  const reader=input.reader?{...input.reader}:undefined;if(reader&&(reader.kind!=='coding-app'||(!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(reader.id))))throw new MemoryCipherError();
  const runner=input.runner,readerId=reader?.id??input.run.agentId,embedding=input.embedding?{...input.embedding,vector:[...input.embedding.vector]}:undefined;
  const callerLease=input.callerLease?{isCurrent:input.callerLease.isCurrent.bind(input.callerLease),validateCurrent:input.callerLease.validateCurrent.bind(input.callerLease)}:undefined;
  if(reader&&!callerLease)throw new MemoryCipherError();
  const callerCurrent=()=>!callerLease||callerLease.isCurrent()===true;
  if(!callerCurrent()||callerLease&&await callerLease.validateCurrent()!==true||!callerCurrent())throw new MemoryCipherError();
  const authenticated=await captureAuthenticatedMemoryRun(runner,input.token,input.run);
  if(authenticated.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  const validateRevision=createMemoryRevisionValidator(runner,authenticated.revision,lock);
  const validateCurrent=async()=>{if(!callerCurrent()||await validateRevision()!==true||!callerCurrent())return false;if(callerLease&&await callerLease.validateCurrent()!==true)return false;return callerCurrent()&&lease.isCurrent();};
  return await recallEncryptedMemories(rows,{
   ...lease,resolveKey:async metadata=>{if(!lease.isCurrent()||!callerCurrent())throw new MemoryCipherError();if(!cachedKey)cachedKey=await lease.resolveKey(metadata);if(!lease.isCurrent()||!callerCurrent())throw new MemoryCipherError();return{...cachedKey,key:Buffer.from(cachedKey.key),scope:{...cachedKey.scope}};},isCurrent:()=>lease.isCurrent()&&callerCurrent(),query,limit,embedding,filter:input.filter,authorize:authenticated.access.authorize,validateCurrent,
   recordRead:ids=>recordRead({readerKind:reader?.kind??'agent',readerId,purpose:'recall',records:ids.map(id=>({table:'memories',id}))}),
  });
 }catch{throw new MemoryCipherError();}finally{cachedKey?.key.fill(0);}
}

/** Authenticates before bounded DB transfer and revalidates after loading. No routes are registered. */
export async function recallAuthenticatedMemoryFromDatabase(input:Omit<Parameters<typeof recallAuthenticatedMemory>[0],'rows'>){
 let ownedEmbedding:EmbeddingResult|undefined;
 try{
  const lease=input.session.capture();
  const callerLease=input.callerLease?{isCurrent:input.callerLease.isCurrent.bind(input.callerLease),validateCurrent:input.callerLease.validateCurrent.bind(input.callerLease)}:undefined;
  if(input.reader&&!callerLease||callerLease&&(!callerLease.isCurrent()||await callerLease.validateCurrent()!==true||!callerLease.isCurrent()))throw new MemoryCipherError();
  const captured={...input,callerLease,reader:input.reader?{...input.reader}:undefined,embedding:input.embedding?{...input.embedding,vector:[...input.embedding.vector]}:undefined,run:{...input.run,delegatedFrom:[...input.run.delegatedFrom],drawers:input.run.drawers.map(d=>({...d}))}};
  const auth=await captureAuthenticatedMemoryRun(captured.runner,captured.token,captured.run);
  if(auth.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  if(!captured.embedding&&captured.embedQuery){captured.embedding=await captured.embedQuery(captured.query);ownedEmbedding=captured.embedding;if(!lease.isCurrent()||callerLease&&(!callerLease.isCurrent()||await callerLease.validateCurrent()!==true))throw new MemoryCipherError();}
  const rows=await loadEncryptedMemoryCandidates(captured.runner,auth.ownerId);
  if(!lease.isCurrent())throw new MemoryCipherError();
  return await recallAuthenticatedMemory({...captured,rows});
 }catch{throw new MemoryCipherError();}finally{ownedEmbedding?.vector.fill(0);}
}
