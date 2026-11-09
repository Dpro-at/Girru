import {assertStoredRunToolAuthority} from '../../memory/encryption/stored-run-tool-policy.js';
import {withEncryptedMemoryConsumer,withEncryptedMemoryConsumerScope,type EncryptedMemoryConsumerInput} from '../../memory/encryption/consumer-host.js';
/** Trusted run lineage entry. Prompt/model/tool arguments never manufacture a memory provenance lease. */
import {createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {encryptedRunAdmissionProvider,type EncryptedRunAdmissionProvider} from '../../memory/encryption/run-admission.js';
import {selectedMemoryExecution} from '../../memory/encryption/execution-context.js';
import type {ToolResult} from '../../tools/types.js';
type Admission=Awaited<ReturnType<EncryptedRunAdmissionProvider['admitRun']>>;
type Entry=Parameters<EncryptedRunAdmissionProvider['admitRun']>[0];
const active=new AsyncLocalStorage<Admission>();
const fail=()=>{throw new Error('encrypted_run_admission_required');};
export function assertRunEntryAvailable(){if(!encryptedRunAdmissionProvider()&&selectedMemoryExecution())fail();}
/** Call after actual server-selected agent/run resolution, before any context read. */
export async function withRunAdmission<T>(entry:Entry,operation:()=>Promise<T>):Promise<T>{
 const provider=encryptedRunAdmissionProvider();if(!provider){assertRunEntryAvailable();return operation();}
 if(active.getStore()||typeof entry.runId!=='string'||!entry.runId||typeof entry.ownerId!=='string'||!entry.ownerId||typeof entry.agentId!=='string'||!entry.agentId)fail();
 const lease=await provider.admitRun(entry);if(!lease?.isCurrent())fail();
 return active.run(lease,()=>lease.run(async()=>{if(!lease.isCurrent())fail();const result=await operation();await lease.beforeModel();if(!lease.isCurrent())fail();return result;}));
}
export function assertRunAdmission(){const lease=active.getStore();if(lease){if(!lease.isCurrent())fail();return;}if(encryptedRunAdmissionProvider()||selectedMemoryExecution())fail();}
export async function beforeAdmittedModel(){const lease=active.getStore();if(lease){await lease.beforeModel();if(!lease.isCurrent())fail();return;}if(encryptedRunAdmissionProvider()||selectedMemoryExecution())fail();}
export function taintRunAdmission(reason:string){assertRunAdmission();active.getStore()?.taint(reason);}
/** IDs only, from actual context readers under the already captured authority head. */
export function observeAdmittedContext(items:readonly {kind:string;id:string}[]){
 assertRunAdmission();const lease=active.getStore();if(!lease)return;
 for(const item of items){if(!['memory','document','handoff','question','auxiliary'].includes(item.kind)||typeof item.id!=='string'||!item.id){lease.taint('unversioned-context-source');continue;}lease.observeContext([{kind:item.kind as 'memory'|'document'|'handoff'|'question'|'auxiliary',id:item.id}]);}
}
// This list never grants tools or proves sources: encrypted gateway readers must
// still register actual IDs. Every other tool taints BEFORE parallel execution.
const gatewayTools=new Set(['memory_search','memory_save','memory_forget','memory_restore','handoff_read','handoff_save']);
export function admitToolBatch(names:readonly string[]){assertRunAdmission();for(const name of names){assertStoredRunToolAuthority(name);if(!gatewayTools.has(name))active.getStore()?.taint('unverified-tool-source:'+String(name).slice(0,128));}}
export async function executeAdmittedTool(registry:{execute:(name:string,args:Record<string,any>)=>Promise<ToolResult>},name:string,args:Record<string,any>):Promise<ToolResult>{await beforeAdmittedModel();assertStoredRunToolAuthority(name);admitToolBatch([name]);const result=await registry.execute(name,args);await beforeAdmittedModel();return result;}

export function admittedModelStep(existing?: (messages:{role:string;content:unknown}[])=>void|Promise<void>){return async(messages:{role:string;content:unknown}[])=>{await beforeAdmittedModel();await existing?.(messages);};}

export async function beforeAdmittedTools(names:readonly string[]){await beforeAdmittedModel();admitToolBatch(names);}

/** Server-owned immutable entry inputs only; the digest carries no prompt content. */
export function runInputDigest(value:unknown){const encoded=JSON.stringify(value);if(typeof encoded!=='string')fail();return createHash('sha256').update(encoded!).digest('hex');}

/** Only the concrete memory callback enters the selected scope; core/config SQL stays outside. */
export async function consumeAdmittedMemory<T>(input:EncryptedMemoryConsumerInput,read:()=>Promise<T>):Promise<T>{await beforeAdmittedModel();return withEncryptedMemoryConsumer(input,read);}

/** Actual run scope metadata only; leaf readers opt into encryption without wrapping core SQL. */
export async function scopeAdmittedMemory<T>(input:EncryptedMemoryConsumerInput,operation:()=>Promise<T>):Promise<T>{await beforeAdmittedModel();return withEncryptedMemoryConsumerScope(input,operation);}
