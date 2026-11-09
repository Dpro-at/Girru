import {getOrchestrator} from '../../multi-agent/index.js';
/** A scheduled run gets its owner only from a unique current native parent grant. */
import type {StepRunner} from '../../repositories/sql-steps.js';
import {createRun} from '../../services/task-runs.js';
import {inspectStoredRunDefinition} from '../../memory/encryption/stored-run-definition.js';
import {bindStoredRunDefinition} from '../../memory/encryption/stored-run-binding.js';
import {isEncryptedMemoryProfileSelected} from '../../memory/encryption/consumer-host.js';
import {MemoryCipherError} from '../../memory/encryption/envelope.js';
type Definition={kind:'task';taskId:string}|{kind:'agent-cron';agentId:string};
type Parent=Readonly<{grantId:string;ownerId:string;profileId:string;expiresAt:number;isCurrent:()=>boolean}>;
type Provider={runner:StepRunner;describe:(definition:Definition)=>Promise<object>;matchingParent:(definition:object)=>Promise<object>;inspectParent:(proof:unknown)=>Parent|null};
let provider:Provider|null=null;function fail():never{throw new MemoryCipherError();}
export function installStoredRunScheduler(input:Provider){if(provider||!input.runner||typeof input.describe!=='function'||typeof input.matchingParent!=='function'||typeof input.inspectParent!=='function')fail();provider=Object.freeze({...input});const own=provider;return()=>{if(provider===own)provider=null;};}
export async function createScheduledEncryptedRun(definition:Definition,taskId?:string){
 const source=provider;if(!source){if(isEncryptedMemoryProfileSelected())fail();return null;}
 const original=await source.describe(definition),metadata=inspectStoredRunDefinition(original);if(!metadata?.isCurrent())fail();
 const proof=await source.matchingParent(original),parent=source.inspectParent(proof);const current=()=>provider===source&&source.inspectParent(proof)===parent&&!!parent?.isCurrent()&&metadata.isCurrent()&&parent.ownerId===metadata.ownerId&&parent.profileId===metadata.profileId&&Date.now()<parent.expiresAt;
 if(!current())fail();const template=metadata.template();
 if(definition.kind==='task'){if(taskId&&taskId!==definition.taskId)fail();taskId=definition.taskId;}else{
  if(taskId)fail();const orchestrator=getOrchestrator(),created=orchestrator.createTask({title:`Scheduled heartbeat: ${metadata.label}`,description:template.prompt,inputData:{backgroundDefinition:definition,backgroundGrantId:parent!.grantId,backgroundTemplateDigest:metadata.templateDigest},origin:'owner',maxRetries:0});if(!orchestrator.assignTask(created.id,metadata.scope.agentId)||!current())fail();taskId=created.id;
 }
 const run=await createRun({taskId:taskId!,agentId:metadata.scope.agentId,userId:parent!.ownerId,prompt:template.prompt,contract:template.contract});
 await bindStoredRunDefinition({runner:source.runner,runId:run.id,definition:original,prompt:template.prompt,contract:template.contract,grantId:parent!.grantId,validateParent:current});if(!current())fail();return run;
}
/** Bind only exact queued owner task/schedule runs after actual native approval; different or ownerless history stays waiting. */
export async function bindApprovedQueuedStoredRuns(original:object,parentProof:object){
 const source=provider,metadata=inspectStoredRunDefinition(original);if(!source||!metadata?.isCurrent()||metadata.mode!=='owner')fail();const parent=source.inspectParent(parentProof);
 const current=()=>provider===source&&source.inspectParent(parentProof)===parent&&!!parent?.isCurrent()&&metadata.isCurrent()&&parent.ownerId===metadata.ownerId&&parent.profileId===metadata.profileId&&Date.now()<parent.expiresAt;
 if(!current())fail();const {all}=await import('../../repositories/sql-steps.js'),rows=metadata.scope.definition.kind==='task'?await source.runner.read(all<{id:string;user_id:string|null;agent_id:string;total:number}>("SELECT id,user_id,agent_id,COUNT(*) OVER() AS total FROM task_runs WHERE task_id=? AND status IN ('queued','running') ORDER BY created_at,id LIMIT 16",metadata.scope.definition.taskId)):await source.runner.read(all<{id:string;user_id:string|null;agent_id:string;total:number}>("SELECT r.id,r.user_id,r.agent_id,COUNT(*) OVER() AS total FROM task_runs r JOIN memory_background_run_bindings b ON b.run_id=r.id WHERE r.status IN ('queued','running') AND r.user_id=? AND r.agent_id=? AND b.definition_json=? ORDER BY r.created_at,r.id LIMIT 16",metadata.ownerId,metadata.scope.agentId,JSON.stringify(metadata.scope.definition))),template=metadata.template();const total=rows.length?Number(rows[0].total):0;if(!Number.isSafeInteger(total)||total<rows.length)fail();let bound=0,waiting=total-rows.length;
 for(const row of rows){if(!current())fail();if(row.user_id!==metadata.ownerId||row.agent_id!==metadata.scope.agentId){waiting++;continue;}try{await bindStoredRunDefinition({runner:source.runner,runId:row.id,definition:original,prompt:template.prompt,contract:template.contract,grantId:parent!.grantId,validateParent:current,replacePriorParent:true});bound++;}catch(error){if(!current())throw error;waiting++;}}
 if(!current())fail();return Object.freeze({bound,waiting});
}
