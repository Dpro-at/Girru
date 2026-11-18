import type {EncryptedOpenQuestion} from './questions-gateway.js';
import type {LegacyGraphAction} from './legacy-graph-mutation.js';
import type {LegacyGraphBundle} from './legacy-graph-bundle.js';
import type {GraphScope} from '../graph/recall.js';
import type {DocHit,DocScopes} from '../docs/recall.js';
/** Trusted-host asynchronous scope for legacy memory consumers. Never set from request JSON or model output. */
import {AsyncLocalStorage} from 'node:async_hooks';
import type {StepRunner} from '../../repositories/sql-steps.js';
import type {createEncryptedMemoryStorageAdapter} from './storage-adapter.js';
import type {ContextPack,MessageRecall,PackInput} from '../context/pack.js';
import type {ReplyPinnedFacts} from '../scopes/pinned.js';
import type {MemorySearchResult,MemorySearchQuery} from '../types.js';
import type {DrawerRef} from '../drawers.js';
import type {TraceRecord} from '../context/trace.js';
import {MemoryCipherError} from './envelope.js';
export type SelectedMemoryExecution={agentNotes:(agentId:string)=>Promise<{content:string;hash:string;memoryId:string}|null>;mutateQuestion:(ownerId:string,id:string,operation:'resolve'|'delete'|'restore',memoryId?:string)=>Promise<EncryptedOpenQuestion|{id:string;undo:true}>;questions:(ownerId:string,id?:string,openOnly?:boolean)=>Promise<EncryptedOpenQuestion[]>;askQuestion:(ownerId:string,agentId:string|null,question:string)=>Promise<{id:string;alreadyAsked:boolean}>;mutateLegacyGraph:(input:{scope:GraphScope;action:LegacyGraphAction;actorId:string})=>Promise<{id:string;status:'active'|'rejected'}|{id:string;dismissed:true}>;projectLegacyGraph:<T>(scope:GraphScope,project:(bundle:LegacyGraphBundle,memories:readonly Record<string,unknown>[])=>T)=>Promise<T>;ownerId:string;runner:StepRunner;storage:ReturnType<typeof createEncryptedMemoryStorageAdapter>;isCurrent:()=>boolean;context:(input:PackInput)=>Promise<ContextPack>;recall:(input:{userId:string;query:string;pack:ContextPack;drawers:readonly DrawerRef[];agentId?:string|null})=>Promise<MessageRecall>;pinned:(ownerId:string,project?:string|null,allow?:{company:boolean;project:boolean;department?:boolean})=>Promise<ReplyPinnedFacts>;graph:(input:{userId:string;drawers?:DrawerRef[];query:string;filters?:Pick<MemorySearchQuery,'type'|'layer'|'minImportance'|'minImportanceScore'>;limit?:number})=>Promise<MemorySearchResult[]>;versions:(ownerId:string,memoryId:string)=>Promise<unknown[]>;traceTiming:(runId:string,ms:number)=>Promise<unknown>;trace:(trace:TraceRecord)=>Promise<unknown>;documentScopes:(input:{userId:string;drawers:readonly DrawerRef[];agentId?:string|null})=>Promise<DocScopes>;documentRecall:(input:{userId:string;query:string;limit?:number;scopes:DocScopes})=>Promise<{items:DocHit[];reliable:boolean;best:number}>};
const execution=new AsyncLocalStorage<Readonly<SelectedMemoryExecution>>();
export function selectedMemoryExecution(){const scope=execution.getStore();if(scope&&scope.isCurrent()!==true)throw new MemoryCipherError();return scope;}
export async function withSelectedMemoryExecution<T>(scope:SelectedMemoryExecution,operation:()=>Promise<T>):Promise<T>{
 if(!scope||typeof operation!=='function'||typeof scope.isCurrent!=='function'||scope.isCurrent()!==true)throw new MemoryCipherError();
 const current=execution.getStore();if(current&&current!==scope)throw new MemoryCipherError();
 let active=true;const hostCurrent=scope.isCurrent.bind(scope),isCurrent=()=>active&&hostCurrent();
 return execution.run(Object.freeze({...scope,isCurrent}),async()=>{try{if(!isCurrent())throw new MemoryCipherError();const result=await operation();if(!isCurrent())throw new MemoryCipherError();return result;}finally{active=false;}});
}
/** Unadapted raw/default database and profile-path access must refuse inside a selected execution. */
export function assertNoDefaultMemoryAccess(){if(execution.getStore())throw new MemoryCipherError();}
