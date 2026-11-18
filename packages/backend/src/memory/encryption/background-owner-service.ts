import {MemoryCipherError} from './envelope.js';
export type BackgroundDefinitionChoice=Readonly<{kind:'task'|'agent-cron';id:string;label:string}>;
type Definition={kind:'task';taskId:string}|{kind:'agent-cron';agentId:string};
type Unlocked=Readonly<{profileId:string;ownerId:string;controlStorageId:string;unlockEpoch:string;isCurrent:()=>boolean}>;
/** Real owner context, definition issuer and private native handles are supplied by the same-Node bootstrap. */
export function createBackgroundMemoryOwnerService(input:{
 withOwner:<T>(ownerId:string,token:string,operation:()=>Promise<T>)=>Promise<T>;
 captureUnlocked:()=>Unlocked|null;
 supported:()=>boolean;
 listDefinitions:()=>Promise<readonly BackgroundDefinitionChoice[]>;
 produceDefinition:(definition:Definition)=>Promise<object>;
 inspectDefinition:(definition:unknown)=>Readonly<{ownerId:string;profileId:string;controlStorageId:string;operationId:string;isCurrent:()=>boolean}>|null;
 registerDefinition:(original:object)=>string;
 approveNative:(definitionHandle:string)=>Promise<unknown>;
}){
 const identity=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
 return Object.freeze({async request(ownerId:string,token:string,method:'background-definitions'|'background-approve',body:Record<string,unknown>){
  if(!identity(ownerId)||typeof token!=='string'||!token||!body||typeof body!=='object'||Array.isArray(body))throw new MemoryCipherError();
  return input.withOwner(ownerId,token,async()=>{
   if(!input.supported())return{state:'unsupported-legacy-layout' as const,definitions:[]};
   const unlocked=input.captureUnlocked();if(!unlocked||unlocked.ownerId!==ownerId||!unlocked.isCurrent())return{state:'waiting-owner-unlock' as const,definitions:[]};
   if(method==='background-definitions'){
    if(Object.keys(body).length)throw new MemoryCipherError();const rows=await input.listDefinitions();
    if(!unlocked.isCurrent()||!Array.isArray(rows)||rows.length>1000)throw new MemoryCipherError();
    const seen=new Set<string>();const definitions=rows.map(row=>{if(!row||!['task','agent-cron'].includes(row.kind)||!identity(row.id)||typeof row.label!=='string'||!row.label.trim()||row.label.length>256||Object.keys(row).sort().join(',')!=='id,kind,label'||seen.has(row.kind+':'+row.id))throw new MemoryCipherError();seen.add(row.kind+':'+row.id);return Object.freeze({kind:row.kind,id:row.id,label:row.label});});
    return{state:'ready' as const,definitions};
   }
   if(method!=='background-approve'||Object.keys(body).sort().join(',')!=='id,kind'||!['task','agent-cron'].includes(String(body.kind))||!identity(body.id))throw new MemoryCipherError();
   const definition=await input.produceDefinition(body.kind==='task'?{kind:'task',taskId:body.id}:{kind:'agent-cron',agentId:body.id}),metadata=input.inspectDefinition(definition);
   if(!metadata||metadata.ownerId!==ownerId||metadata.profileId!==unlocked.profileId||metadata.controlStorageId!==unlocked.controlStorageId||!metadata.isCurrent()||!unlocked.isCurrent())throw new MemoryCipherError();
   const definitionHandle=input.registerDefinition(definition);if(typeof definitionHandle!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(definitionHandle))throw new MemoryCipherError();
   const result=await input.approveNative(definitionHandle);
   if(!metadata.isCurrent()||!unlocked.isCurrent()||!result||typeof result!=='object'||Array.isArray(result)||(result as Record<string,unknown>).state!=='approved')throw new MemoryCipherError();
   // Return no protected grant ID, scope hashes, private handles or key material to the page.
   const acknowledgement=result as Record<string,unknown>;let counts:{}|{bound:number;waiting:number}={};
   if('bound' in acknowledgement||'waiting' in acknowledgement){if(!Number.isSafeInteger(acknowledgement.bound)||Number(acknowledgement.bound)<0||Number(acknowledgement.bound)>5000||!Number.isSafeInteger(acknowledgement.waiting)||Number(acknowledgement.waiting)<0||Number(acknowledgement.waiting)>5000)throw new MemoryCipherError();counts={bound:Number(acknowledgement.bound),waiting:Number(acknowledgement.waiting)};}
   return{state:'approved' as const,kind:body.kind,id:body.id,...counts};
  });
 }});
}
