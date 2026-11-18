/** Explicit selected-runtime storage operations. Writes retain authoritative IDs and owner review outcomes. */
import {createEncryptedMemoryStorageReader} from './storage-reader.js';
import {learnEncryptedRoutine} from './learning-gateway.js';
import type {createEncryptedMemoryRuntime} from './runtime-host.js';
import type {captureAuthenticatedMemoryRun} from './auth-capture.js';
import type {DrawerRef} from '../drawers.js';
import type {VersionEntry} from '../versions.js';
import {normalizeDrawer} from '../drawers.js';
import {redactImportText} from '../import/redact.js';
import {isMemoryType} from '../types.js';
import {MemoryCipherError} from './envelope.js';
type Run=Parameters<typeof captureAuthenticatedMemoryRun>[2];
export function createEncryptedMemoryStorageAdapter(input:{runtime:ReturnType<typeof createEncryptedMemoryRuntime>;resolveRun:()=>Promise<Run>;authorizeMutation?:(operation:'trash'|'restore'|'forget',id:string)=>Promise<boolean>}){
 const {runtime,resolveRun,authorizeMutation}=input,reader=createEncryptedMemoryStorageReader(input);
 const mutate=async(operation:'trash'|'restore'|'forget',id:string)=>{const run=await selected();if(typeof authorizeMutation!=='function'||await authorizeMutation(operation,id)!==true)throw new MemoryCipherError();return runtime.mutateForRun({run,id,operation});};
 const selected=async()=>{if(runtime.status()!=='ready')throw new MemoryCipherError();const run=await resolveRun();return{...run,delegatedFrom:[...run.delegatedFrom],drawers:run.drawers.map(drawer=>({...drawer}))};};
 return Object.freeze({...reader,
  async readHistory(memoryId:string){return runtime.readHistory({run:await selected(),memoryId});},
  async readContext(request:Pick<Parameters<typeof runtime.readContext>[0],'persona'|'handoffScope'>){const captured={...request,handoffScope:request.handoffScope?{...request.handoffScope}:undefined};return runtime.readContext({...captured,run:await selected()});},
  async readPinnedFacts(){return runtime.readPinnedFacts({run:await selected()});},
  async saveRecallTrace(trace:Parameters<typeof runtime.saveRecallTrace>[0]['trace']){return runtime.saveRecallTrace({run:await selected(),trace});},
  async learn(request:{drawer:DrawerRef;content:string;type?:string;importance?:number}){
   const captured={...request,drawer:{...request.drawer}},run=await selected();return learnEncryptedRoutine({runtime,run,...captured});
  },
  async proposeUpdate(id:string,entry:VersionEntry){
   entry={...entry};const run=await selected();if(typeof entry.content!=='string'||entry.content.length>50000||!isMemoryType(entry.type)||!Number.isInteger(entry.importance)||entry.importance<1||entry.importance>10)throw new MemoryCipherError();
   const content=redactImportText(entry.content).text;if(!content.trim())throw new MemoryCipherError();const current=await runtime.readForRun({run,id});if(!current)throw new MemoryCipherError();
   const drawer=normalizeDrawer({kind:current.drawer_kind,key:current.drawer_key??''});
   return runtime.queueConflict({run,drawer,memoryId:id,entry:{content,type:entry.type,importance:entry.importance},reasons:['Explicit encrypted storage update requires owner review']});
  },
  async trash(id:string){return mutate('trash',id);},
  async restore(id:string){return mutate('restore',id);},
  async forget(id:string){return mutate('forget',id);},
 });
}
