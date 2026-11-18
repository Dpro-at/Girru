/** Merge authenticated observations without trusting chronology, ownership or historical completeness. */
import {parseExternalPlanSnapshot,type ExternalPlanSnapshot} from './external-plan-schema.js';
import {MemoryCipherError} from './envelope.js';
export function mergeExternalCopyHistory(observations:readonly {checkpointId:string;snapshot:ExternalPlanSnapshot}[]){
 if(!Array.isArray(observations)||observations.length>100)throw new MemoryCipherError();
 const files=new Map<string,{ownerId:string;scope:string;root:string;path:string;versions:Map<string,{sha256:string;bytes:number;checkpointIds:string[]}>}>(),withoutInventory:string[]=[];let total=0;const seen=new Set<string>(),owners=new Set<string>();
 for(const {checkpointId,snapshot} of observations){
  total+=Buffer.byteLength(JSON.stringify(snapshot));if(total>2097152||typeof checkpointId!=='string'||!/^[A-Za-z0-9-]{1,128}$/.test(checkpointId))throw new MemoryCipherError();if(seen.has(checkpointId))throw new MemoryCipherError();seen.add(checkpointId);parseExternalPlanSnapshot(JSON.stringify(snapshot),snapshot.ownerId,snapshot.snapshotId);owners.add(snapshot.ownerId);if(owners.size>1)throw new MemoryCipherError();
  if(!snapshot.inventories){withoutInventory.push(checkpointId);continue;}
  for(const inventory of snapshot.inventories)for(const file of inventory.files){
   const key=JSON.stringify([snapshot.ownerId,inventory.scope,inventory.root,file.path]);
   let entry=files.get(key);if(!entry){entry={ownerId:snapshot.ownerId,scope:inventory.scope,root:inventory.root,path:file.path,versions:new Map()};files.set(key,entry);if(files.size>4096)throw new MemoryCipherError();}
   const versionKey=JSON.stringify([file.sha256,file.bytes]);let version=entry.versions.get(versionKey);if(!version){version={sha256:file.sha256,bytes:file.bytes,checkpointIds:[]};entry.versions.set(versionKey,version);}if(!version.checkpointIds.includes(checkpointId))version.checkpointIds.push(checkpointId);
  }
 }
 return{completeHistoricalCoverage:false as const,executionAuthorized:false as const,withoutInventory,files:[...files.values()].map(file=>({...file,versions:[...file.versions.values()]}))};
}
