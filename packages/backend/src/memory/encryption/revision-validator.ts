import type {currentStoredRunPrincipal} from './stored-run-principal.js';
import {readMemoryControlStep} from './control-runner.js';
/** Uncached DB checkpoint; never grants access, only revokes an already authorized captured run. */
import {one,type StepRunner} from '../../repositories/sql-steps.js';
import {MemoryCipherError} from './envelope.js';
export interface MemoryRevisionCapture {
 ownerId:string; sessionId:string; tokenVersion:number; role:string; policyVersion:number;
 agents:Array<{id:string;version:number}>;
 projects?:readonly string[];
 /** Earliest token expiry or time-dependent permission boundary from the authorized run. */
 validUntil:number;
 storedRun?:NonNullable<ReturnType<typeof currentStoredRunPrincipal>>;
}
export function createMemoryRevisionValidator(runner:StepRunner,input:MemoryRevisionCapture,onInvalid:()=>void,now:()=>number=Date.now):()=>Promise<boolean>{
 const capture={...input,agents:input.agents?.map(a=>({...a})),projects:[...(input.projects??[])]};
 const id=(s:unknown)=>typeof s==='string'&&s.length>0&&s.length<=256;
 const version=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0;
 if(!id(capture.ownerId)||!id(capture.sessionId)||!id(capture.role)||!version(capture.tokenVersion)||!version(capture.policyVersion)||!Number.isFinite(capture.validUntil)||!Array.isArray(capture.agents)||capture.agents.length>32||new Set(capture.agents.map(a=>a.id)).size!==capture.agents.length||capture.agents.some(a=>!id(a.id)||!version(a.version))||capture.projects.length>64||new Set(capture.projects).size!==capture.projects.length||capture.projects.some(p=>!id(p))||typeof onInvalid!=='function')throw new MemoryCipherError();
 let revoked=false;
 return async()=>{
  if(revoked)return false;
  try{
   const at=now();if(!Number.isFinite(at)||at>=capture.validUntil)throw new MemoryCipherError();
   const extra=capture.agents.map((_,i)=>`,(SELECT p.version FROM agent_permissions p WHERE p.agent_id=?) AS v${i},(SELECT count(*) FROM agents_config a WHERE a.id=?) AS a${i}`).join('');
   const archive=capture.projects.length?`,(SELECT count(*) FROM memory_project_scopes WHERE owner_id=? AND slug IN (${capture.projects.map(()=>'?').join(',')}) AND archived_at IS NOT NULL) AS archived_projects`:`,0 AS archived_projects`;
   if(capture.storedRun){
    const principal=capture.storedRun;
    if(!principal.isCurrent()||principal.control.ownerId!==capture.ownerId||principal.native.grantId!==capture.sessionId)throw new MemoryCipherError();
    await readMemoryControlStep(runner,principal.control.assertCurrentStep());
    const row=await readMemoryControlStep(runner,one<Record<string,unknown>>(`SELECT u.status,u.role,u.token_version,COALESCE((SELECT version FROM memory_access_versions WHERE owner_id=u.id),0) AS policy_version${extra}${archive} FROM users u WHERE u.id=?`,...capture.agents.flatMap(a=>[a.id,a.id]),...(capture.projects.length?[capture.ownerId,...capture.projects]:[]),capture.ownerId));
    if(!row||row.status!=='active'||row.role!==capture.role||Number(row.token_version)!==capture.tokenVersion||Number(row.policy_version)!==capture.policyVersion||Number(row.archived_projects)!==0||!principal.isCurrent()||now()>=capture.validUntil)throw new MemoryCipherError();
    for(let i=0;i<capture.agents.length;i++)if(Number(row['a'+i])!==1||Number(row['v'+i]??0)!==capture.agents[i].version)throw new MemoryCipherError();
    return true;
   }
   const row=await readMemoryControlStep(runner,one<Record<string,unknown>>(`SELECT u.status,u.role,u.token_version,s.revoked_at,s.expires_at,s.token_version AS session_version,COALESCE((SELECT version FROM memory_access_versions WHERE owner_id=u.id),0) AS policy_version${extra}${archive} FROM users u JOIN auth_sessions s ON s.user_id=u.id WHERE u.id=? AND s.id=?`,...capture.agents.flatMap(a=>[a.id,a.id]),...(capture.projects.length?[capture.ownerId,...capture.projects]:[]),capture.ownerId,capture.sessionId));
   if(revoked||!row||Number(row.archived_projects)!==0||row.status!=='active'||row.role!==capture.role||Number(row.token_version)!==capture.tokenVersion||Number(row.session_version)!==capture.tokenVersion||row.revoked_at!==null||!Number.isFinite(Number(row.expires_at))||Number(row.expires_at)<=now()||now()>=capture.validUntil||Number(row.policy_version)!==capture.policyVersion)throw new MemoryCipherError();
   for(let i=0;i<capture.agents.length;i++)if(Number(row['a'+i])!==1||Number(row['v'+i]??0)!==capture.agents[i].version)throw new MemoryCipherError();
   return true;
  }catch{revoked=true;try{onInvalid();}catch{}return false;}
 };
}
