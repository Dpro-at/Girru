import {readMemoryControlStep} from './control-runner.js';
import {memoryControlQuery} from './control-runner.js';
/** Selected-runner bridge policy. Reuses existing capability scopes/project-key mapping; no folder-path authority. */
import {createHash,timingSafeEqual} from 'node:crypto';
import {one,dialect,type StepRunner} from '../../repositories/sql-steps.js';
import {TOOL_SCOPE,CAPABILITY_SCOPES} from '../bridge/capability.js';
import {isBridgeClient} from '../bridge/clients.js';
import {keyStateStep} from '../project-keys.js';
import type {createEncryptedMemoryBridgeAdapter} from './bridge-adapter.js';
import {MemoryCipherError} from './envelope.js';
type Authorizer=Parameters<typeof createEncryptedMemoryBridgeAdapter>[0]['authorizeCall'];
export function createSelectedEncryptedBridgePolicy(input:{runner:StepRunner;ownerId:string;verifyInstallToken:(ownerId:string,client:string,token:string)=>Promise<boolean>;authorizeProject:(ownerId:string,projectId:string)=>Promise<{isCurrent:()=>boolean;allowsCwd?:(cwd:string)=>boolean}|null>}){
 const {runner,ownerId,verifyInstallToken,authorizeProject}=input;if(typeof verifyInstallToken!=='function'||typeof authorizeProject!=='function')throw new MemoryCipherError();let closed=false;
 const boundary=()=>{if(closed||runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};
 const authorizeCall:Authorizer=async request=>{
  boundary();const captured={...request,args:{...request.args}};if(!isBridgeClient(captured.client)||typeof captured.capabilityToken!=='string'||!/^gcap_[0-9a-f]{64}$/.test(captured.capabilityToken)||!TOOL_SCOPE[captured.tool])throw new MemoryCipherError();
  if(await verifyInstallToken(ownerId,captured.client,captured.sessionToken)!==true)throw new MemoryCipherError();boundary();const hash=createHash('sha256').update(captured.capabilityToken).digest('hex');
  async function load(){boundary();const row=await runner.tx(function*(){
   const driver=yield* dialect(),size=driver==='postgres'?'octet_length(s.scopes)':'length(CAST(s.scopes AS BLOB))';
   return yield* memoryControlQuery(()=>one<{id:string;owner_id:string;actor_id:string;actor_role:string;project_id:string;client:string|null;expires_at:string;revoked_at:string|null;scopes:string;token_hash:string;agent_id:string|null;enabled:number|string;slug:string;company_facts:number|string|null}>(`SELECT s.id,s.owner_id,s.actor_id,s.actor_role,s.project_id,s.client,s.expires_at,s.revoked_at,CASE WHEN ${size}<=2048 THEN s.scopes ELSE NULL END AS scopes,s.token_hash,s.agent_id,c.enabled,p.slug,f.company_facts FROM session_capabilities s JOIN memory_bridge_clients c ON c.owner_id=s.owner_id AND c.client=? JOIN chat_projects p ON p.id=s.project_id AND p.user_id=s.owner_id LEFT JOIN memory_bridge_folders f ON f.owner_id=s.owner_id AND f.project_id=s.project_id WHERE s.owner_id=? AND s.token_hash=?`,captured.client,ownerId,hash));
  },{immediate:true});boundary();
   if(!row||Number(row.enabled)!==1||row.owner_id!==ownerId||row.actor_role!=='owner'||row.actor_id!==ownerId||row.revoked_at!==null||row.client!==null&&row.client!==captured.client||!Number.isFinite(Date.parse(row.expires_at))||Date.parse(row.expires_at)<=Date.now()||typeof row.scopes!=='string'||typeof row.token_hash!=='string'||!/^[a-f0-9]{64}$/.test(row.token_hash)||!timingSafeEqual(Buffer.from(hash,'hex'),Buffer.from(row.token_hash,'hex')))throw new MemoryCipherError();
   let scopes:unknown;try{scopes=JSON.parse(row.scopes);}catch{throw new MemoryCipherError();}if(!Array.isArray(scopes)||scopes.length>CAPABILITY_SCOPES.length||new Set(scopes).size!==scopes.length||scopes.some(scope=>!(CAPABILITY_SCOPES as readonly unknown[]).includes(scope))||!scopes.includes(TOOL_SCOPE[captured.tool]))throw new MemoryCipherError();
   return{...row,scopes:scopes as string[]};
  }
  const initial=await load(),project=await authorizeProject(ownerId,initial.project_id);boundary();if(!project||typeof project.isCurrent!=='function'||!project.isCurrent())throw new MemoryCipherError();const projectCurrent=project.isCurrent.bind(project),cwdCheck=project.allowsCwd?.bind(project),cwdCurrent=()=>captured.cwd===undefined||!!cwdCheck&&cwdCheck(captured.cwd)===true,expires=Date.parse(initial.expires_at),keyState=await readMemoryControlStep(runner,keyStateStep(ownerId)),scopeKey=keyState==='id'?initial.project_id:initial.slug;boundary();
  const projectRow=await readMemoryControlStep(runner,one<{archived_at:string|null}>('SELECT archived_at FROM memory_project_scopes WHERE owner_id=? AND slug=?',ownerId,scopeKey));boundary();if(!projectRow||projectRow.archived_at!==null)throw new MemoryCipherError();
  const agentId=initial.agent_id??(await readMemoryControlStep(runner,one<{id:string}>('SELECT id FROM agents_config WHERE is_primary=1 ORDER BY id LIMIT 1')))?.id;boundary();if(!agentId||!await readMemoryControlStep(runner,one('SELECT id FROM agents_config WHERE id=?',agentId)))throw new MemoryCipherError();boundary();
  const current=()=>!closed&&projectCurrent()&&cwdCurrent()&&Date.now()<expires&&process.env.AGENT_PLAYER_READONLY!=='1';
  const validateCurrent=async()=>{try{if(!current()||await verifyInstallToken(ownerId,captured.client,captured.sessionToken)!==true)return false;boundary();const fresh=await load();if(JSON.stringify(fresh)!==JSON.stringify(initial)||!current())return false;const scope=await readMemoryControlStep(runner,one<{archived_at:string|null}>('SELECT archived_at FROM memory_project_scopes WHERE owner_id=? AND slug=?',ownerId,scopeKey));boundary();const freshKeyState=await readMemoryControlStep(runner,keyStateStep(ownerId));boundary();const freshAgent=initial.agent_id??(await readMemoryControlStep(runner,one<{id:string}>('SELECT id FROM agents_config WHERE is_primary=1 ORDER BY id LIMIT 1')))?.id;boundary();return !!scope&&scope.archived_at===null&&freshKeyState===keyState&&freshAgent===agentId&&!!await readMemoryControlStep(runner,one('SELECT id FROM agents_config WHERE id=?',agentId))&&current();}catch{return false;}};
  if(!await validateCurrent())throw new MemoryCipherError();
  return{ownerId,client:captured.client,capabilityId:initial.id,run:{agentId,delegatedFrom:[],project:scopeKey,drawers:[{kind:'project' as const,key:scopeKey},...(initial.scopes.includes('company:read')&&Number(initial.company_facts)===1?[{kind:'owner' as const}]:[])],audience:'owner' as const},isCurrent:current,validateCurrent};
 };
 return{authorizeCall,close(){closed=true;}};
}
