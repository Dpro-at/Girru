import {currentStoredRunPrincipal} from './stored-run-principal.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {sameDrawer} from '../drawers.js';
/** Actual same-Node selected host for individual memory consumers, never a blanket core/control SQL scope. */
import type {createSelectedEncryptedMemoryHost} from './selected-host.js';
import type {DrawerRef} from '../drawers.js';
import {selectedMemoryExecution} from './execution-context.js';
import {currentEncryptedRunIdentity} from './run-admission.js';
import {MemoryCipherError} from './envelope.js';
type Host=Awaited<ReturnType<typeof createSelectedEncryptedMemoryHost>>;
export type EncryptedMemoryConsumerInput={userId:string;agentId:string;drawers:readonly DrawerRef[];project:string|null;delegatedFrom:readonly string[];audience:'owner'|'outsider';runId?:string;handoffScope?:{kind:'conversation'|'task';id:string;runId?:string|null}};
export type EncryptedMemoryConsumerHost={getHost:()=>Host|null;isSelected:()=>boolean;refreshHostFoundations?:()=>Promise<void>};
let installed:Readonly<EncryptedMemoryConsumerHost>|null=null;const metadataScopes=new AsyncLocalStorage<Readonly<EncryptedMemoryConsumerInput>>();
export function installEncryptedMemoryConsumerHost(input:EncryptedMemoryConsumerHost):()=>void{if(installed||!input||typeof input.getHost!=='function'||typeof input.isSelected!=='function')throw new MemoryCipherError();const host=Object.freeze({getHost:input.getHost.bind(input),isSelected:input.isSelected.bind(input),...(input.refreshHostFoundations?{refreshHostFoundations:input.refreshHostFoundations.bind(input)}:{})});installed=host;return()=>{if(installed===host)installed=null;};}
export async function withEncryptedMemoryConsumer<T>(input:EncryptedMemoryConsumerInput,operation:()=>Promise<T>):Promise<T>{
 if(typeof operation!=='function')throw new MemoryCipherError();const provider=installed;if(provider?.isSelected())await provider.refreshHostFoundations?.();const scoped=selectedMemoryExecution();if(scoped){if(scoped.ownerId!==input.userId)throw new MemoryCipherError();return operation();}if(!provider)return operation();const host=provider.getHost();if(!host){if(provider.isSelected())throw new MemoryCipherError();return operation();}if(host.runtime.ownerId!==input.userId||host.runtime.status()!=='ready'||!input.agentId||!Array.isArray(input.drawers)||!Array.isArray(input.delegatedFrom)||!['owner','outsider'].includes(input.audience))throw new MemoryCipherError();const admitted=currentEncryptedRunIdentity();if(admitted&&(admitted.ownerId!==input.userId||admitted.agentId!==input.agentId||input.runId!==undefined&&admitted.runId!==input.runId))throw new MemoryCipherError();return host.executeLegacyMemory({run:{agentId:input.agentId,delegatedFrom:[...input.delegatedFrom],project:input.project,drawers:input.drawers.map(drawer=>({...drawer})),audience:input.audience},runId:input.runId??admitted?.runId,handoffScope:input.handoffScope?{...input.handoffScope}:undefined},operation);
}

/** Metadata only: normal control/config SQL stays on its actual control connection. */
export async function withEncryptedMemoryConsumerScope<T>(input:EncryptedMemoryConsumerInput,operation:()=>Promise<T>):Promise<T>{
 if(typeof operation!=='function')throw new MemoryCipherError();const provider=installed;if(!metadataScopes.getStore()&&!selectedMemoryExecution()&&!currentEncryptedRunIdentity()&&!currentStoredRunPrincipal()&&(!provider||!provider.isSelected()&&provider.getHost()===null))return operation();
 if(!input||typeof operation!=='function'||!input.userId||!input.agentId||!Array.isArray(input.drawers)||!Array.isArray(input.delegatedFrom)||!['owner','outsider'].includes(input.audience))throw new MemoryCipherError();const prior=metadataScopes.getStore();if(prior&&(prior.userId!==input.userId||prior.agentId!==input.agentId||prior.project!==input.project||JSON.stringify(prior.delegatedFrom)!==JSON.stringify(input.delegatedFrom)||input.drawers.some(drawer=>!prior.drawers.some(open=>sameDrawer(open,drawer)))))throw new MemoryCipherError();const value=Object.freeze({...input,drawers:Object.freeze(input.drawers.map(drawer=>Object.freeze({...drawer}))),delegatedFrom:Object.freeze([...input.delegatedFrom]),...(input.handoffScope?{handoffScope:Object.freeze({...input.handoffScope})}:{})});return metadataScopes.run(value,operation);
}
export async function consumeCurrentEncryptedMemoryScope<T>(operation:()=>Promise<T>):Promise<T>{const scope=metadataScopes.getStore();if(scope)return withEncryptedMemoryConsumer(scope,operation);const provider=installed;if(provider?.isSelected())await provider.refreshHostFoundations?.();if(selectedMemoryExecution())return operation();if(provider?.isSelected())throw new MemoryCipherError();return operation();}

/** A selected or pending encrypted profile may never fall back to legacy memory files. */
export function assertNoLegacyMemoryFileAccess():void{if(selectedMemoryExecution()||installed?.isSelected())throw new MemoryCipherError();}
export function isEncryptedMemoryProfileSelected():boolean{return !!selectedMemoryExecution()||installed?.isSelected()===true;}

/** Unsupported legacy SQL consumers also remain closed while a native profile is selected or pending. */
export const assertNoLegacyMemoryAccess=assertNoLegacyMemoryFileAccess;

/** Owner APIs resolve the actual current host once, including locked/pending selection refusal. */
export async function selectedEncryptedOwnerRuntime(ownerId:string){const provider=installed;if(!provider)return null;if(provider.isSelected()){if(selectedMemoryExecution()||currentEncryptedRunIdentity())throw new MemoryCipherError();await provider.refreshHostFoundations?.();}const host=provider.getHost();if(!host){if(provider.isSelected())throw new MemoryCipherError();return null;}if(host.runtime.ownerId!==ownerId||host.runtime.status()!=='ready')throw new MemoryCipherError();return host.runtime;}
