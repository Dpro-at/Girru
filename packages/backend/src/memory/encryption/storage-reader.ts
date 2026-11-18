/** Read-side storage dependency for a trusted selected run. No plaintext storage, SQL singleton or file index fallback. */
import type {MemorySearchQuery,MemorySearchResult} from '../types.js';
import {memoryFromDecryptedRow} from '../row-memory.js';
import {normalizeTopicKey} from '../topic-key.js';
import {sameDrawer,drawerId,type DrawerRef} from '../drawers.js';
import type {createEncryptedMemoryRuntime} from './runtime-host.js';
import type {captureAuthenticatedMemoryRun} from './auth-capture.js';
import {MemoryCipherError} from './envelope.js';
type Run=Parameters<typeof captureAuthenticatedMemoryRun>[2];
export function createEncryptedMemoryStorageReader(input:{runtime:ReturnType<typeof createEncryptedMemoryRuntime>;resolveRun:()=>Promise<Run>}){
 const {runtime,resolveRun}=input;
 const narrow=(selected:Run,drawers:readonly DrawerRef[])=>{if(drawers.some(drawer=>!selected.drawers.some(open=>sameDrawer(open,drawer))))throw new MemoryCipherError();return{...selected,drawers:drawers.map(drawer=>({...drawer,...(selected.drawers.some(open=>sameDrawer(open,drawer)&&open.readOnly===true)?{readOnly:true}:{})}))};};
 async function run(){if(runtime.status()!=='ready')throw new MemoryCipherError();const selected=await resolveRun();return{...selected,delegatedFrom:[...selected.delegatedFrom],drawers:selected.drawers.map(drawer=>({...drawer}))};}
 return Object.freeze({
  async initialize(){if(runtime.status()!=='ready')throw new MemoryCipherError();},
  async get(id:string){const row=await runtime.readForRun({run:await run(),id});return row?memoryFromDecryptedRow(row):null;},
  async getOwned(ownerId:string,id:string){if(ownerId!==runtime.ownerId)throw new MemoryCipherError();const row=await runtime.readForRun({run:await run(),id});return row?memoryFromDecryptedRow(row):null;},
  async getByUser(ownerId:string,layer?:string){if(ownerId!==runtime.ownerId||layer!==undefined&&(typeof layer!=='string'||layer.length>128))throw new MemoryCipherError();return(await runtime.listForRun({run:await run()})).map(memoryFromDecryptedRow).filter(memory=>layer===undefined||memory.memoryLayer===layer);},
  async getByDrawers(ownerId:string,drawers:DrawerRef[]){if(ownerId!==runtime.ownerId||!Array.isArray(drawers))throw new MemoryCipherError();const captured=drawers.map(drawer=>({...drawer}));return(await runtime.listForRun({run:narrow(await run(),captured)})).map(memoryFromDecryptedRow);},
  async getByTopicKey(ownerId:string,drawer:DrawerRef,topic:string){if(ownerId!==runtime.ownerId)throw new MemoryCipherError();const captured={...drawer},selected=narrow(await run(),[captured]),found=await runtime.findByTopic({run:selected,drawer:captured,topic});if(!found)return null;const row=await runtime.readForRun({run:selected,id:found.id});if(!row||normalizeTopicKey(row.topic_key)!==normalizeTopicKey(topic))throw new MemoryCipherError();return memoryFromDecryptedRow(row);},
  async listDrawers(ownerId:string){if(ownerId!==runtime.ownerId)throw new MemoryCipherError();const rows=await runtime.listForRun({run:await run()}),counts=new Map<string,DrawerRef&{count:number}>();for(const row of rows){const memory=memoryFromDecryptedRow(row),drawer=memory.drawer!;const identity=drawerId(drawer),previous=counts.get(identity);counts.set(identity,{...drawer,count:(previous?.count??0)+1});}return [...counts.values()];},
  async search(query:MemorySearchQuery):Promise<MemorySearchResult[]>{
   if(!query)throw new MemoryCipherError();query={...query,...(query.drawers?{drawers:query.drawers.map(drawer=>({...drawer}))}:{})};
   // Unsupported legacy filters refuse rather than silently broadening or changing their meaning.
   if(!query||query.userId!==runtime.ownerId||Object.keys(query).some(key=>!['userId','query','limit','drawers','type','layer','minImportance','minImportanceScore'].includes(key))||typeof query.query!=='string'||query.limit!==undefined&&(!Number.isInteger(query.limit)||query.limit<1||query.limit>50))throw new MemoryCipherError();
   if(query.type!==undefined&&(typeof query.type!=='string'||query.type.length>64)||query.layer!==undefined&&(typeof query.layer!=='string'||query.layer.length>64)||query.minImportance!==undefined&&(!Number.isFinite(query.minImportance)||query.minImportance<1||query.minImportance>10)||query.minImportanceScore!==undefined&&(!Number.isFinite(query.minImportanceScore)||query.minImportanceScore<0||query.minImportanceScore>1))throw new MemoryCipherError();
   const minimum=query.minImportanceScore??(query.minImportance===undefined?undefined:query.minImportance/10),filter=(row:Readonly<Record<string,unknown>>)=>(query.type===undefined||row.type===query.type)&&(query.layer===undefined||row.memory_layer===query.layer)&&(minimum===undefined||Number(row.importance_score)>=minimum);
   const selected=await run();
   if(query.drawers){if(!Array.isArray(query.drawers)||query.drawers.some(drawer=>!selected.drawers.some(open=>sameDrawer(open,drawer))))throw new MemoryCipherError();selected.drawers=query.drawers.map(drawer=>({...drawer,...(selected.drawers.some(open=>sameDrawer(open,drawer)&&open.readOnly===true)?{readOnly:true}:{})}));}
   const results=await runtime.recall({run:selected,query:query.query,limit:query.limit,filter});
   const rows=await runtime.listForRun({run:selected,ids:results.map(row=>row.id)}),byId=new Map(rows.map(row=>[String(row.id),memoryFromDecryptedRow(row)]));
   return results.flatMap(result=>{const memory=byId.get(result.id);return memory?[{memory,similarity:result.score}]:[];});
  },
 });
}
