/** Synchronous task provenance from the actual local orchestrator, never model-supplied scopes. */
import {createHash} from 'node:crypto';
import {getOrchestrator} from '../../multi-agent/index.js';
import {MemoryCipherError} from '../../memory/encryption/envelope.js';
function fail():never{throw new MemoryCipherError();}
export function captureStoredTaskScope(taskId:string,_ownerId:string){
 const orchestrator=getOrchestrator();
 const capture=()=>{const records:unknown[]=[],delegatedFrom=new Set<string>(),seen=new Set<string>();let id:string|null=taskId;
  while(id){if(seen.has(id)||seen.size>=16)fail();seen.add(id);const task=orchestrator.getTask(id);if(!task)fail();
   if(task.spawnedBy)delegatedFrom.add(task.spawnedBy);else if(task.origin!=='owner')fail();
   if(id!==taskId&&task.assignedTo)delegatedFrom.add(task.assignedTo);
   records.push({id:task.id,parentId:task.parentId??null,spawnedBy:task.spawnedBy??null,origin:task.origin,assignedTo:task.assignedTo??null,description:task.description,input:task.input,requiredCapabilities:task.requiredCapabilities});id=task.parentId??null;
  }
  return {digest:createHash('sha256').update(JSON.stringify(records)).digest('hex'),delegatedFrom:[...delegatedFrom].sort()};};
 const initial=capture(),task=orchestrator.getTask(taskId);if(!task)fail();const taskHash=createHash('sha256').update(JSON.stringify({id:task.id,title:task.title,description:task.description,input:task.input,assignedTo:task.assignedTo})).digest('hex');return Object.freeze({taskHash,project:null,delegatedFrom:Object.freeze(initial.delegatedFrom.filter(id=>id!==task.assignedTo)),isCurrent:()=>{try{return capture().digest===initial.digest;}catch{return false;}}});
}
