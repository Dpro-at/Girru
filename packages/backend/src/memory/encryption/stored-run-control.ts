/** Original control-connection claims; task JSON and model arguments are not principals. */
import {createHash} from 'node:crypto';
import {one,type Step,type StepRunner} from '../../repositories/sql-steps.js';
import {loadStep,strictest} from '../../tools/agent-permissions.js';
import {loadSnapshotStep,narrowPermissions} from '../scopes/access.js';
import {selectDrawers,drawerId,type DrawerRef} from '../drawers.js';
import {captureStoredHeartbeatTemplate} from '../../agent/execution/stored-run-template.js';
import {readStoredRunBindingStep} from './stored-run-binding.js';
import {runContract} from '../../services/task-runs.js';
import {contractRunDrawers,type TaskContract} from '../../services/task-contracts.js';
import {MemoryCipherError} from './envelope.js';
type TaskScope=Readonly<{taskHash:string;project:string|null;delegatedFrom:readonly string[];isCurrent:()=>boolean}>;
type Metadata=Readonly<{definitionScope:Readonly<Record<string,unknown>>;templateDigest:string;grantId:string;ownerId:string;runId:string;taskId:string;agentId:string;project:string|null;workerId:string;generation:number;expiresAt:number;inputDigest:string;contractDigest:string;policyDigest:string;tokenVersion:number;role:string;drawers:readonly DrawerRef[];delegatedFrom:readonly string[];isCurrent:()=>boolean;assertCurrentStep:()=>Step<void>;renew:()=>Promise<void>}>;
export type StoredRunControlClaim=Readonly<{purpose:'stored-run-control';isCurrent:()=>boolean}>;
const issued=new WeakMap<object,Metadata>();
function fail():never{throw new MemoryCipherError();}
export const storedRunDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>item instanceof Map?[...item.entries()].sort(([a],[b])=>String(a).localeCompare(String(b))):item)).digest('hex');
export const storedRunModelPolicyHash=(agent:{provider:string;model:string;system_prompt:string|null;temperature:number;max_tokens:number})=>storedRunDigest({provider:agent.provider,model:agent.model,systemPrompt:agent.system_prompt,temperature:agent.temperature,maxTokens:agent.max_tokens});
const hash=storedRunDigest;
const freezeDeep=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeDeep(child);Object.freeze(value);}return value;};
/** Scope capture is installed by the actual task executor, never supplied by a request. */
let captureScope:((taskId:string,ownerId:string)=>TaskScope)|null=null;
export function installStoredRunTaskScopeCapture(capture:NonNullable<typeof captureScope>){if(captureScope||typeof capture!=='function')fail();captureScope=capture;return()=>{if(captureScope===capture)captureScope=null;};}
function* readClaim(runId:string,workerId:string,contract?:TaskContract|null):Step<any>{
 const row=yield* one<any>('SELECT r.*,u.status AS owner_status,u.role AS owner_role,u.token_version FROM task_runs r JOIN users u ON u.id=r.user_id WHERE r.id=?',runId);
 if(!row||row.status!=='running'||row.cancel_requested!==0||row.lease_owner!==workerId||row.owner_status!=='active'||row.owner_role!=='owner'||!row.user_id||!Number.isSafeInteger(row.lease_generation)||!Number.isFinite(row.lease_expires_at)||row.lease_expires_at<=Date.now())fail();
 const binding=yield* readStoredRunBindingStep(runId);if(binding.owner_id!==row.user_id||binding.input_digest!==hash([row.input_encrypted,row.input_iv,row.input_tag])||binding.contract_digest!==hash([row.contract_encrypted,row.contract_iv,row.contract_tag]))fail();
 const agent=yield* one<any>('SELECT id,name,provider,model,system_prompt,temperature,max_tokens,cron_schedule,cron_enabled FROM agents_config WHERE id=?',row.agent_id);if(!agent||!['ollama','lmstudio'].includes(agent.provider))fail();
 const scope=captureScope?.(row.task_id,row.user_id);if(!scope?.isCurrent()||scope.delegatedFrom.length>31||scope.delegatedFrom.includes(row.agent_id)||new Set(scope.delegatedFrom).size!==scope.delegatedFrom.length)fail();
 const permissions=[];for(const id of [row.agent_id,...scope.delegatedFrom])permissions.push(yield* loadStep(id));
 const access=yield* loadSnapshotStep(row.user_id),effective=narrowPermissions(strictest(row.agent_id,permissions),access,scope.project,Date.now());
 const allowed=selectDrawers({audience:'owner',project:scope.project,task:row.task_id}).filter(drawer=>effective.memoryRead.includes(drawer.kind));
 const bounded=contract?contractRunDrawers(contract,allowed):allowed,drawers=bounded.filter(d=>binding.scope.drawers.includes(drawerId(d)));
 const currentContract=binding.definition.kind==='task'?yield* one<any>('SELECT contract_encrypted,contract_iv,contract_tag FROM task_contracts WHERE task_id=?',row.task_id):null;if(binding.scope.contractHash!==hash(currentContract??null))fail();
 const expectedTaskHash=binding.definition.kind==='task'?scope.taskHash:hash({definition:binding.definition,template:captureStoredHeartbeatTemplate(agent.name).hash});
 if(binding.scope.ownerId!==row.user_id||binding.scope.agentId!==row.agent_id||binding.scope.taskHash!==expectedTaskHash||binding.scope.permissionsHash!==hash({permissions,access})||binding.scope.scheduleHash!==hash({schedule:agent.cron_schedule,enabled:agent.cron_enabled})||binding.scope.modelPolicyHash!==storedRunModelPolicyHash(agent)||binding.scope.modelPolicy!=='local-only'||binding.scope.keyPolicy!=='current-unlocked-profile-only'||hash(binding.scope.delegatedFrom)!==hash([...scope.delegatedFrom].sort()))fail();
 return {row,scope,binding,drawers,policyDigest:hash({agent,permissions,access,project:scope.project,delegatedFrom:scope.delegatedFrom,drawers})};
}
export async function captureStoredRunControlClaim(input:{runner:StepRunner;runId:string;workerId:string}):Promise<StoredRunControlClaim>{
 const {runner,runId,workerId}=input;if(runner.dialect!=='sqlite'||typeof runner.readSync!=='function'||!runId||!workerId||!captureScope)fail();
 const first=await runner.tx(()=>readClaim(runId,workerId)),contract=await runContract(first.row),initial=await runner.tx(()=>readClaim(runId,workerId,contract)),row=initial.row;
 if(hash([first.row.contract_encrypted,first.row.contract_iv,first.row.contract_tag])!==hash([row.contract_encrypted,row.contract_iv,row.contract_tag]))fail();
 const inputDigest=hash([row.input_encrypted,row.input_iv,row.input_tag]),contractDigest=hash([row.contract_encrypted,row.contract_iv,row.contract_tag]);
 const stable=hash({runId,taskId:row.task_id,agentId:row.agent_id,ownerId:row.user_id,workerId,generation:row.lease_generation,inputDigest,contractDigest,policyDigest:initial.policyDigest,binding:initial.binding,tokenVersion:row.token_version,role:row.owner_role});
 function* assertCurrentStep():Step<void>{const next=yield* readClaim(runId,workerId,contract),r=next.row;if(!initial.scope.isCurrent()||hash({runId,taskId:r.task_id,agentId:r.agent_id,ownerId:r.user_id,workerId,generation:r.lease_generation,inputDigest:hash([r.input_encrypted,r.input_iv,r.input_tag]),contractDigest:hash([r.contract_encrypted,r.contract_iv,r.contract_tag]),policyDigest:next.policyDigest,binding:next.binding,tokenVersion:r.token_version,role:r.owner_role})!==stable)fail();}
 let expiresAt=row.lease_expires_at;
 const renew=async()=>{await runner.tx(()=>assertCurrentStep());const fresh=runner.readSync!(readClaim(runId,workerId,contract));if(!initial.scope.isCurrent())fail();expiresAt=fresh.row.lease_expires_at;};
 const isCurrent=()=>{try{if(Date.now()>=expiresAt)return false;runner.readSync!(assertCurrentStep());return true;}catch{return false;}};
 const claim=Object.freeze({purpose:'stored-run-control' as const,isCurrent});const metadata:Metadata=Object.freeze({definitionScope:freezeDeep(initial.binding.scope),templateDigest:initial.binding.template_digest,grantId:initial.binding.grant_id,ownerId:row.user_id,runId,taskId:row.task_id,agentId:row.agent_id,project:initial.scope.project,workerId,generation:row.lease_generation,get expiresAt(){return expiresAt;},inputDigest,contractDigest,policyDigest:initial.policyDigest,binding:initial.binding,tokenVersion:row.token_version,role:row.owner_role,drawers:Object.freeze(initial.drawers.map((d:DrawerRef)=>Object.freeze({...d}))),delegatedFrom:Object.freeze([...initial.scope.delegatedFrom]),isCurrent,assertCurrentStep,renew});issued.set(claim,metadata);if(!isCurrent())fail();return claim;
}
export function inspectStoredRunControlClaim(value:unknown):Metadata|null{return value&&typeof value==='object'?issued.get(value)??null:null;}
