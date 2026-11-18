/** Owner-reviewed background definitions, captured from actual control/configuration sources. */
import type {StepRunner,Step} from '../../repositories/sql-steps.js';
import {all,one} from '../../repositories/sql-steps.js';
import {loadStep,strictest} from '../../tools/agent-permissions.js';
import {loadSnapshotStep,narrowPermissions} from '../scopes/access.js';
import {selectDrawers,drawerId} from '../drawers.js';
import {decryptContract,contractRunDrawers,contractPrompt} from '../../services/task-contracts.js';
import {getOrchestrator} from '../../multi-agent/index.js';
import {captureStoredTaskScope} from '../../agent/execution/stored-task-scope.js';
import {storedRunDigest as hash,storedRunModelPolicyHash} from './stored-run-control.js';
import {storedTaskPrompt,captureStoredHeartbeatTemplate} from '../../agent/execution/stored-run-template.js';
import {MemoryCipherError} from './envelope.js';
type Definition={kind:'task';taskId:string}|{kind:'agent-cron';agentId:string};
type Unlock={profileId:string;ownerId:string;controlStorageId:string;unlockEpoch:string;isCurrent:()=>boolean};
const originals=new WeakMap<object,any>();function fail():never{throw new MemoryCipherError();}
export function inspectStoredRunDefinition(value:unknown){return value&&typeof value==='object'?originals.get(value)??null:null;}
export function createStoredRunDefinitionProducer(input:{runner:StepRunner;captureOwner:()=>Promise<{ownerId:string;operationId:string;isCurrent:()=>boolean}>;captureUnlocked:()=>Unlock;captureScheduler?:()=>{operationId:string;isCurrent:()=>boolean}}){
 if(input.runner.dialect!=='sqlite'||!input.runner.readSync)fail();
 const produce=async(definition:Definition,mode:'owner'|'scheduler'='owner')=>{
  const unlock=input.captureUnlocked();let owner:{ownerId:string;operationId:string;isCurrent:()=>boolean};
  if(mode==='owner')owner=await input.captureOwner();else{const scheduler=input.captureScheduler?.();if(!scheduler)fail();owner={ownerId:unlock.ownerId,operationId:scheduler.operationId,isCurrent:scheduler.isCurrent};}
  if(!owner.isCurrent()||!unlock.isCurrent()||owner.ownerId!==unlock.ownerId)fail();
  const task=definition.kind==='task'?getOrchestrator().getTask(definition.taskId):null,agentId=definition.kind==='task'?task?.assignedTo:definition.agentId;if(!agentId)fail();
  const taskScope=task?captureStoredTaskScope(task.id,owner.ownerId):null;
  function* capture():Step<any>{const agent=yield* one<any>('SELECT id,name,provider,model,system_prompt,temperature,max_tokens,cron_schedule,cron_enabled FROM agents_config WHERE id=?',agentId!);if(!agent||!['ollama','lmstudio'].includes(agent.provider)||definition.kind==='agent-cron'&&agent.cron_enabled!==1)fail();const contract=(task?yield* one<any>('SELECT contract_encrypted,contract_iv,contract_tag FROM task_contracts WHERE task_id=?',task.id):null)??null;const permissions=[];for(const id of [agentId!,...(taskScope?.delegatedFrom??[])])permissions.push(yield* loadStep(id));const access=yield* loadSnapshotStep(owner.ownerId);return{agent,contract,permissions,access};}
  const captured=await input.runner.tx(()=>capture()),contract=captured.contract?await decryptContract(captured.contract.contract_encrypted,captured.contract.contract_iv,captured.contract.contract_tag):null;
  const effective=narrowPermissions(strictest(agentId,captured.permissions),captured.access,taskScope?.project??null),allowed=selectDrawers({audience:'owner',task:task?.id}).filter(d=>effective.memoryRead.includes(d.kind)),drawers=(contract?contractRunDrawers(contract,allowed):allowed).map(drawerId).sort();
  if(!drawers.length)fail();const heartbeat=task?null:captureStoredHeartbeatTemplate(captured.agent.name);const prompt=task?storedTaskPrompt(task,contract):heartbeat!.prompt;
  const taskHash=hash(task?{id:task.id,title:task.title,description:task.description,input:task.input,assignedTo:task.assignedTo}: {definition,template:heartbeat!.hash}),observed=hash(captured),expiresAt=Date.now()+8*60*60*1000;
  const scope=Object.freeze({v:1,profileId:unlock.profileId,ownerId:owner.ownerId,controlStorageId:unlock.controlStorageId,definition:Object.freeze({...definition}),agentId,project:taskScope?.project??null,taskHash,contractHash:hash(captured.contract),scheduleHash:hash({schedule:captured.agent.cron_schedule,enabled:captured.agent.cron_enabled}),permissionsHash:hash({permissions:captured.permissions,access:captured.access}),modelPolicyHash:storedRunModelPolicyHash(captured.agent),modelPolicy:'local-only',drawers:Object.freeze(drawers),actions:Object.freeze(['memory-read','trace-maintenance']),delegatedFrom:Object.freeze([...(taskScope?.delegatedFrom??[])].sort()),expiresAt,useLimit:32,keyPolicy:'current-unlocked-profile-only',unlockEpoch:unlock.unlockEpoch});
  const isCurrent=()=>{try{return owner.isCurrent()&&unlock.isCurrent()&&(!taskScope||taskScope.isCurrent())&&(!heartbeat||heartbeat.isCurrent())&&Date.now()<expiresAt&&hash(input.runner.readSync!(capture()))===observed&&(!task||hash((()=>{const t=getOrchestrator().getTask(task.id);if(!t)fail();return{id:t.id,title:t.title,description:t.description,input:t.input,assignedTo:t.assignedTo};})())===taskHash);}catch{return false;}};
  const object=Object.freeze({purpose:'stored-run-definition',isCurrent}),metadata=Object.freeze({ownerId:owner.ownerId,operationId:owner.operationId,profileId:unlock.profileId,controlStorageId:unlock.controlStorageId,scope,mode,template:()=>{if(!isCurrent())fail();return {prompt,contract};},label:task?.title??captured.agent.name,templateDigest:hash(prompt),promptPreview:prompt.slice(0,11900)+(prompt.length>11900?'\n[Preview truncated; complete template is hash-bound]':''),isCurrent});originals.set(object,metadata);if(!isCurrent())fail();return object;
 };
 return Object.assign(produce,{describeScheduled:(definition:Definition)=>produce(definition,'scheduler'),listDefinitions:async()=>{const owner=await input.captureOwner(),unlock=input.captureUnlocked();if(!owner.isCurrent()||!unlock.isCurrent()||owner.ownerId!==unlock.ownerId)fail();const agents=await input.runner.read(all<{id:string;name:string}>('SELECT id,name FROM agents_config WHERE provider IN (?,?) ORDER BY name,id','ollama','lmstudio'));const allowed=new Set(agents.map(a=>a.id));const tasks=getOrchestrator().listTasks({limit:500});return [...tasks.filter(t=>t.assignedTo&&allowed.has(t.assignedTo)).map(t=>({kind:'task' as const,id:t.id,label:t.title})),...agents.map(a=>({kind:'agent-cron' as const,id:a.id,label:a.name}))];}});
}
