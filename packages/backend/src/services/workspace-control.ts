import {checkComputerEffectGuard,computerEffectGuardStep,type ComputerEffectGuard} from '../devices/effect-guard.js';
import {PERMISSION_CATEGORIES} from '../tools/agent-permissions.js';
import {forUpdate} from '../db/pg/dialect.js';
import {consumeControlAuthority} from '../tools/control-command.js';
/** Shared real owner-reviewed configuration operations. Preview text never grants execution authority. */
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {q,sql,one,all,run,lockName,dialect,type Step} from '../repositories/sql-steps.js';
import {isOwner,ScopeError} from '../repositories/scope.js';
import type {Actor} from '../repositories/actor.js';
import {repositories} from '../repositories/index.js';
import {insertAgentConfigStep,newAgentId,roleAndDepartment} from '../repositories/agents-config.js';
import {validateAgentName} from './agent-names.js';
import {canonicalModelSelection,loadModelCatalogue} from './model-catalogue.js';
import {PersonalityLibrary} from './personality-library.js';
import {validateProfile} from './personality-library-profile.js';
import {getCurrentPersonality} from './personality-store.js';
import {writePersonalityView} from './personality-record.js';
import {SpecialtyTemplates} from './specialty-templates.js';
import {centralSkills} from '../skills/central-store.js';
import {checkRule,getRule,applyReviewedRule} from './agent-rules.js';
import {redactImportText} from '../memory/import/redact.js';
import {requestApproval} from '../tools/approvals.js';
import {workspaceControlApplyTool} from '../tools/tasks/workspace-control.js';
import {auditMcpOutcome} from './mcp-audit.js';
import {agentRenamed} from './task-file.js';
import {linkAgentDepartment} from './departments.js';
import {storeP3Enabled} from './store-p3.js';

type Origin={kind:'external'}|{kind:'native';agentId:string;sessionId:string};
type Operation={admission_guard_json?:string|null;id:string;owner_id:string;source:string;source_agent_id:string|null;source_session_id:string|null;request_id:string;request_hash:string;fingerprint:string;binding_nonce:string;kind:string;action:string;resource_id:string;payload_json:string;snapshot_json:string;preview_json:string;state:string;approval_id:string|null;result_json:string|null};
export class ControlError extends Error{constructor(message:string,readonly status=400){super(message);}}
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const only=(v:unknown,keys:string[])=>{if(!object(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new ControlError('Unknown control field');return v;};
const id=(v:unknown)=>{if(typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v)||v.includes('..'))throw new ControlError('Invalid identifier');return v;};
const canonical=(v:any):string=>v&&typeof v==='object'?(Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}'):JSON.stringify(v);
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
function sanitized(value:any):{value:any;redactions:number}{if(typeof value==='string'){const clean=redactImportText(value);return {value:clean.text,redactions:clean.total};}if(Array.isArray(value)){let n=0;const result=value.map(v=>{const clean=sanitized(v);n+=clean.redactions;return clean.value;});return {value:result,redactions:n};}if(value&&typeof value==='object'){let n=0;const result=Object.fromEntries(Object.entries(value).map(([k,v])=>{const clean=sanitized(v);n+=clean.redactions;return [k,clean.value];}));return {value:result,redactions:n};}return {value,redactions:0};}

function owner(a:Actor|null|undefined){if(!isOwner(a)||!a?.userId||a.channel)throw new ScopeError(a?403:401,'Active owner required');return a.userId;}
async function active(user:string){const u=await q.one<{role:string;status:string}>('SELECT role,status FROM users WHERE id=?',user);if(u?.role!=='owner'||u.status!=='active')throw new ScopeError(403,'Active owner required');}
const agentSafe=(a:any)=>a&&Object.fromEntries(['id','name','description','emoji','system_prompt','department','role','model','provider','version'].map(k=>[k,a[k]??null]));
function size(v:unknown,max=60000){if(Buffer.byteLength(JSON.stringify(v))>max)throw new ControlError('Complete review exceeds its size limit');}
async function project(user:string,key:unknown){if(key!==undefined&&key!==null&&!(await q.one('SELECT id FROM chat_projects WHERE id=? AND user_id=?',id(key),user)))throw new ScopeError(404,'Project unavailable');}
async function agentRow(user:Actor,key:unknown){const row=await repositories.agents.getConfig(user,id(key));if(!row||row.id==='small-local-agent')throw new ScopeError(404,'Agent unavailable');return row;}
const emptyConfig=()=>({primarySkill:null,skills:[],tools:[],memoryRead:[],memoryWrite:[],sharedMemory:false,modes:Object.fromEntries(PERMISSION_CATEGORIES.map(category=>[category,'off']))});
async function parseInput(raw:unknown){
 const b=only(raw,['requestId','kind','action','targetId','expectedRevision','draft']);id(b.requestId);
 if(!['agent','personality','specialty','skill','rule'].includes(b.kind)||!['create','update','assign'].includes(b.action)||b.kind==='agent'&&b.action==='assign'||!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<0)throw new ControlError('Unsupported control operation');
 if(b.action==='create'?(b.targetId!==undefined||b.expectedRevision!==0):!b.targetId)throw new ControlError('Exact current target/revision required');if(b.targetId!==undefined)id(b.targetId);
 size(b,48000);if(redactImportText(JSON.stringify(b.draft)).total)throw new ControlError('Credential-shaped content refused');
 let draft:Record<string,any>;
 if(b.kind==='agent'){
  draft=only(b.draft,['name','description','emoji','system_prompt','department','role','modelSelection']);if(!Object.keys(draft).length)throw new ControlError('Empty agent change');
  if(draft.role==='main'||draft.role!==undefined&&!['manager','specialist','evaluator',null].includes(draft.role))throw new ControlError('Primary role is not changeable');
  if(b.action==='create'||draft.name!==undefined)draft={...draft,name:validateAgentName(draft.name)};
  for(const key of ['description','system_prompt','emoji'])if(draft[key]!==undefined&&(typeof draft[key]!=='string'||draft[key].length>(key==='system_prompt'?12000:key==='description'?2000:24)))throw new ControlError('Invalid agent text');
  const checked=roleAndDepartment(draft);draft={...draft,...(draft.role!==undefined?{role:checked.role}:{}),...(draft.department!==undefined?{department:checked.department}:{})};
  if(draft.modelSelection!==undefined){const {modelSelection,...rest}=draft;draft={...rest,...canonicalModelSelection(modelSelection,(await loadModelCatalogue()).models)};}
 }else if(b.kind==='personality'){
  if(b.action==='assign'){draft=only(b.draft,['id','revision','expectedVersion','linked']);id(draft.id);if(!Number.isSafeInteger(draft.revision)||draft.revision<1||draft.expectedVersion!==b.expectedRevision||typeof draft.linked!=='boolean')throw new ControlError('Exact personality assignment required');}
  else{const p=only(b.draft,['profile']);draft={profile:validateProfile(p.profile)};}
 }else if(b.kind==='specialty'){
  if(b.action==='assign'){draft=only(b.draft,['agentIds']);if(!Array.isArray(draft.agentIds)||draft.agentIds.length>100||new Set(draft.agentIds).size!==draft.agentIds.length)throw new ControlError('Invalid agent selection');draft={agentIds:draft.agentIds.map(id).sort()};}
  else{draft=only(b.draft,['name','department','description','instructions']);for(const [key,max]of [['name',80],['department',64],['description',1800],['instructions',12000]] as const)if(typeof draft[key]!=='string'||draft[key].length>max||(key!=='description'&&!draft[key].trim()))throw new ControlError('Complete specialty text required');}
 }else if(b.kind==='skill'){
  if(b.action==='assign'){draft=only(b.draft,['selected']);if(!Array.isArray(draft.selected)||draft.selected.length>50||new Set(draft.selected).size!==draft.selected.length)throw new ControlError('Invalid skill selection');draft={selected:draft.selected.map(id).sort()};}
  else{draft=only(b.draft,['name','files']);if(typeof draft.name!=='string'||!Array.isArray(draft.files))throw new ControlError('Markdown bundle required');centralSkills().validatePortable(draft.name,draft.files);}
 }else{draft=checkRule(b.draft,b.action!=='create');}
 return {requestId:b.requestId,kind:b.kind,action:b.action,targetId:b.targetId??null,expectedRevision:b.expectedRevision,draft};
}
async function snapshot(actor:Actor,b:any){
 const user=owner(actor),personalities=new PersonalityLibrary(),specialties=new SpecialtyTemplates(),skills=centralSkills();let before:any=null,after:any=b.draft,impact:any=[],revision=0,privateData:any={guardQueries:[]};
 const capture=async(query:string,...params:(string|number)[])=>{const expected=await q.all(query,...params);privateData.guardQueries.push({query,params,expected});};
 if(b.kind==='agent'){
  if(b.draft.model!==undefined){const selected=canonicalModelSelection(b.draft.model,(await loadModelCatalogue()).models);if(selected.provider!==b.draft.provider)throw new ControlError('Model selection changed',409);}
  if(b.action!=='create'){const row=await agentRow(actor,b.targetId);before=agentSafe(row);revision=row.version;after={...before,...b.draft};}else after={name:b.draft.name,description:b.draft.description??'',emoji:b.draft.emoji??'🤖',system_prompt:b.draft.system_prompt??'',model:b.draft.model??'claude-sonnet-4-5-20250929',provider:b.draft.provider??'claude',role:b.draft.role??'specialist',department:b.draft.department??null};
 }else if(b.kind==='personality'){
  if(b.action==='assign'){await agentRow(actor,b.targetId);const current=await getCurrentPersonality(b.targetId);if(!current)throw new ControlError('Personality unavailable',404);const template=await personalities.read(b.draft.id);if(template.revision!==b.draft.revision)throw new ControlError('Personality revision changed',409);const assignmentAgent=await agentRow(actor,b.targetId);before={agent:agentSafe(assignmentAgent),assignment:await personalities.assignment(b.targetId),current};after={...b.draft,profile:template.profile};revision=current.version;impact=[{id:b.targetId,name:assignmentAgent.name,locked:current.locked,version:current.version}];}
  else if(b.action==='update'){const current=await personalities.read(b.targetId);before=current;revision=current.revision;const review=await personalities.preview(b.targetId,{revision,profile:b.draft.profile});privateData.confirmation=review.confirmation;impact=review.agents;after={id:b.targetId,revision:revision+1,profile:b.draft.profile};}
 }else if(b.kind==='specialty'){
  if(b.action!=='create'){const template=await specialties.get(b.targetId);before=template;revision=template.revision;privateData.config=template.config;
   if(b.action==='assign'){const linked=await q.all<{agent_id:string}>('SELECT agent_id FROM agent_specialties WHERE template_id=? ORDER BY agent_id',b.targetId);privateData.expectedAgentIds=linked.map(x=>x.agent_id);for(const key of b.draft.agentIds)await agentRow(actor,key);after={agentIds:b.draft.agentIds};impact={beforeAgentIds:privateData.expectedAgentIds,afterAgentIds:b.draft.agentIds};}
   else{const draft={...b.draft,config:template.config,revision};const review=await specialties.impact(b.targetId,draft,template.config);privateData.confirmImpact=review.confirmation;impact=review.agents;after={...draft,revision:revision+1};}
  }else after={...b.draft,config:emptyConfig(),revision:1};
 }else if(b.kind==='skill'){
  if(b.action==='assign'){await agentRow(actor,b.targetId);before={...(await skills.assignments(b.targetId)),agent:agentSafe(await agentRow(actor,b.targetId))};revision=before.revision;privateData.skills=[];for(const key of b.draft.selected){const row=await q.one('SELECT id,revision,content_hash FROM central_skills WHERE id=?',key);if(!row)throw new ControlError('Skill unavailable',404);privateData.skills.push(row);}after={selected:b.draft.selected};impact=[{id:b.targetId,name:before.agent.name}];}
  else{const prepared=skills.validatePortable(b.draft.name,b.draft.files);privateData.bundleHash=prepared.hash;if(b.action==='update'){before=await skills.read(b.targetId);revision=before.skill.revision;if(before.skill.name!==b.draft.name)throw new ControlError('Skill renaming is not supported');impact=await q.all('SELECT a.id,a.name,a.version FROM central_agent_skills s JOIN agents_config a ON a.id=s.agent_id WHERE s.skill_id=? ORDER BY a.id',b.targetId);}after={name:prepared.name,description:prepared.description,version:prepared.version,files:prepared.files};}
 }else{
  if(b.action!=='create'){before=await getRule(b.targetId);if(!before||before.locked||!['active','suggested'].includes(before.status))throw new ControlError('Rule unavailable or locked',409);await project(user,before.projectId);revision=before.version;after={...before,...b.draft};}
  await project(user,b.draft.projectId);const who=b.draft.who??before?.who??'all',targets=b.draft.targets??before?.targets??[];if(who==='agents')for(const key of targets)await agentRow(actor,key);impact={who,targets,projectId:b.draft.projectId??before?.projectId??null};
 }
 if(b.action!=='create'){
  if(b.kind==='agent')await capture('SELECT version,is_primary FROM agents_config WHERE id=?',b.targetId);
  if(b.kind==='personality'){
   if(b.action==='assign'){await capture('SELECT id,revision,profile_json,archived FROM personality_library WHERE id=?',b.draft.id);await capture('SELECT id,name,version FROM agents_config WHERE id=?',b.targetId);}
   else{await capture('SELECT revision,profile_json,archived FROM personality_library WHERE id=?',b.targetId);await capture('SELECT l.agent_id,l.revision,l.linked,l.applied_version,a.version FROM agent_personality_links l JOIN agents_config a ON a.id=l.agent_id WHERE l.personality_id=? ORDER BY l.agent_id',b.targetId);}
  }
  if(b.kind==='specialty'){await capture('SELECT revision,config_json,content_hash FROM specialty_templates WHERE id=?',b.targetId);await capture('SELECT s.agent_id,a.version FROM agent_specialties s JOIN agents_config a ON a.id=s.agent_id WHERE s.template_id=? ORDER BY s.agent_id',b.targetId);if(b.action==='assign')for(const key of b.draft.agentIds)await capture('SELECT id,name,version FROM agents_config WHERE id=?',key);}
  if(b.kind==='skill'){
   if(b.action==='assign'){await capture('SELECT id,name,version FROM agents_config WHERE id=?',b.targetId);await capture('SELECT skill_id FROM central_agent_skills WHERE agent_id=? ORDER BY skill_id',b.targetId);for(const key of b.draft.selected)await capture('SELECT id,revision,content_hash FROM central_skills WHERE id=?',key);}
   else{await capture('SELECT revision,content_hash FROM central_skills WHERE id=?',b.targetId);await capture('SELECT s.agent_id,a.name,a.version FROM central_agent_skills s JOIN agents_config a ON a.id=s.agent_id WHERE s.skill_id=? ORDER BY s.agent_id',b.targetId);}
  }
  if(b.kind==='rule')await capture('SELECT version,status,shipped_key FROM agent_rules WHERE id=?',b.targetId);
 }
 if(b.kind==='rule'){const projectId=b.draft.projectId??before?.projectId;if(projectId)await capture('SELECT id,user_id FROM chat_projects WHERE id=? AND user_id=?',projectId,user);}
 if(revision!==b.expectedRevision)throw new ControlError('Target revision changed',409);const review={before,after,affected:impact};size(review);return {review,privateData};
}
const receipt=(r:Operation)=>({operationId:r.id,kind:r.kind,action:r.action,resourceId:r.resource_id,fingerprint:r.fingerprint,state:r.state,approvalId:r.approval_id,...(r.result_json?{result:sanitized(JSON.parse(r.result_json)).value}:{}),...(r.state==='uncertain'||r.state==='applying'?{attention:'Execution may have committed. Never automatically retry; inspect the stable resource and history.'}:{})});
async function row(user:string,key:unknown){const r=await q.one<Operation>('SELECT * FROM workspace_control_operations WHERE owner_id=? AND id=?',user,id(key));if(!r)throw new ScopeError(404,'Control operation unavailable');return r;}
export async function previewWorkspaceControl(actor:Actor,raw:unknown,origin:Origin={kind:'external'},admissionGuard?:ComputerEffectGuard){
 const user=owner(actor);await active(user);await checkComputerEffectGuard(admissionGuard);const b=await parseInput(raw),print=hash(b);const prior=await q.one<Operation>('SELECT * FROM workspace_control_operations WHERE owner_id=? AND source=? AND request_id=?',user,origin.kind,b.requestId);if(prior){if(prior.request_hash!==print||canonical(prior.admission_guard_json?JSON.parse(prior.admission_guard_json):null)!==canonical(admissionGuard??null))throw new ControlError('Request payload changed',409);return {...receipt(prior),preview:JSON.parse(prior.preview_json)};}
 const state=await snapshot(actor,b),operationId=randomUUID(),resourceId=b.action==='create'?(b.kind==='agent'?newAgentId():randomUUID()):b.targetId;
 const publicReview=sanitized(state.review);const preview={kind:b.kind,action:b.action,resourceId,expectedRevision:b.expectedRevision,...publicReview.value,redactions:publicReview.redactions,permissionChanges:false,source:origin.kind,...(admissionGuard?{computerSource:{peerId:admissionGuard.peerId,recordId:admissionGuard.recordId,epoch:admissionGuard.epoch}}:{})};size(preview);
 const bindingNonce=randomBytes(32).toString('hex'),fingerprint=hash({bindingNonce,b,state,resourceId,source:origin,...(admissionGuard?{admissionGuard}:{})});
 const chosen=await sql().tx(function*(){yield* lockName('workspace-control-preview:'+user+':'+origin.kind+':'+b.requestId);const exists=yield* one<Operation>('SELECT * FROM workspace_control_operations WHERE owner_id=? AND source=? AND request_id=?',user,origin.kind,b.requestId);if(exists){if(exists.request_hash!==print)throw new ControlError('Request payload changed',409);return exists.id;}yield* run("INSERT INTO workspace_control_operations(id,owner_id,source,source_agent_id,source_session_id,request_id,request_hash,fingerprint,binding_nonce,kind,action,resource_id,payload_json,snapshot_json,preview_json,state,admission_guard_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'preview',?)",operationId,user,origin.kind,origin.kind==='native'?origin.agentId:null,origin.kind==='native'?origin.sessionId:null,b.requestId,print,fingerprint,bindingNonce,b.kind,b.action,resourceId,JSON.stringify(b),JSON.stringify(state),JSON.stringify(preview),admissionGuard?JSON.stringify(admissionGuard):null);if(admissionGuard?.kind==='computer')yield* run('INSERT INTO computer_operation_projection(local_device_id,operation_id) VALUES(?,?)',admissionGuard.localId,operationId);return operationId;});
 const current=await row(user,chosen);auditMcpOutcome(user,'workspace_control.preview.'+origin.kind,'workspace_control',chosen,'created');return {...receipt(current),preview:JSON.parse(current.preview_json)};
}
export async function requestWorkspaceControl(actor:Actor,raw:unknown){
 const user=owner(actor);await active(user);const p=only(raw,['operationId','fingerprint']),op=await row(user,p.operationId);if(op.source!=='external'||p.fingerprint!==op.fingerprint)throw new ControlError('Operation binding changed',409);if(op.state!=='preview')return receipt(op);
 const b=JSON.parse(op.payload_json),fresh=await snapshot(actor,b);if(hash({bindingNonce:op.binding_nonce,b,state:fresh,resourceId:op.resource_id,source:{kind:'external'},...(op.admission_guard_json?{admissionGuard:JSON.parse(op.admission_guard_json)}:{})})!==op.fingerprint)throw new ControlError('Stored operation binding changed',409);if(canonical(fresh)!==canonical(JSON.parse(op.snapshot_json)))throw new ControlError('Impact changed; prepare a new review',409);
 const params={operationId:op.id,fingerprint:op.fingerprint,preview:JSON.parse(op.preview_json)};
 try{const result=await requestApproval(workspaceControlApplyTool,params,{workspaceDir:process.cwd(),userId:user},'settings',approvalId=>(function*(){yield* lockName('workspace-control:'+op.id);const update=yield* run("UPDATE workspace_control_operations SET approval_id=?,state='pending',updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_id=? AND state='preview' AND fingerprint=?",approvalId,op.id,user,op.fingerprint);if(update.changes!==1)throw new ControlError('Approval already requested',409);})());if(result.error)throw new ControlError('Approval queue refused the request',409);}catch(error){const current=await row(user,op.id);if(current.approval_id&&current.state==='pending')return receipt(current);throw error;}
 auditMcpOutcome(user,'workspace_control.request','workspace_control',op.id,'created');return receipt(await row(user,op.id));
}
export async function workspaceControlStatus(actor:Actor,key:unknown){const user=owner(actor);await active(user);const op=await row(user,key),approval=op.approval_id?await q.one<{status:string}>('SELECT status FROM tool_approvals WHERE id=? AND user_id=?',op.approval_id,user):null;return {...receipt(op),approvalStatus:approval?.status??null,preview:JSON.parse(op.preview_json)};}
export async function workspaceControlHistory(actor:Actor){const user=owner(actor);await active(user);return {operations:await q.all('SELECT id AS \"operationId\",kind,action,resource_id AS \"resourceId\",fingerprint,state,approval_id AS \"approvalId\" FROM workspace_control_operations WHERE owner_id=? ORDER BY created_at DESC,id DESC LIMIT 100',user)};}
function* guard(op:Operation):Step<void>{
 yield* computerEffectGuardStep(op.admission_guard_json?JSON.parse(op.admission_guard_json):null);
 const d=yield* dialect(),lock=forUpdate(d);
 const current=yield* one<Operation>('SELECT * FROM workspace_control_operations WHERE id=? AND owner_id=?'+lock,op.id,op.owner_id);
 const u=yield* one<{role:string;status:string}>('SELECT role,status FROM users WHERE id=?'+lock,op.owner_id);
 const a=yield* one<{status:string}>('SELECT status FROM tool_approvals WHERE id=? AND user_id=?'+lock,op.approval_id!,op.owner_id);
 if(!current||current.state!=='applying'||current.fingerprint!==op.fingerprint||u?.role!=='owner'||u.status!=='active'||a?.status!=='approved')throw new ControlError('Owner approval context revoked',403);
 const stored=JSON.parse(op.snapshot_json);for(const fence of stored.privateData.guardQueries??[]){const currentRows=yield* all(fence.query+lock,...fence.params);if(canonical(currentRows)!==canonical(fence.expected))throw new ControlError('Approved resource or impact changed',409);}
 if(op.source==='native'){
  const main=yield* one<any>('SELECT a.is_primary,s.archived_at FROM agents_config a JOIN chat_sessions s ON s.agent_id=a.id WHERE a.id=? AND s.id=? AND s.user_id=?'+lock,op.source_agent_id!,op.source_session_id!,op.owner_id);
  const profile=yield* one<{parent_agent_id:string|null}>('SELECT parent_agent_id FROM agent_grant_profiles WHERE agent_id=?'+lock,op.source_agent_id!);
  if(main?.is_primary!==1||main.archived_at||profile?.parent_agent_id)throw new ControlError('Main agent context revoked',403);
 }
}

export async function applyWorkspaceControl(authority:{actor:Actor;approvalId:string;source:string;agentId:string|null;sessionId:string|null},raw:unknown){
 if(!consumeControlAuthority(authority))throw new ControlError('Genuine approved execution capability required',403);
 const user=owner(authority.actor);await active(user);const p=only(raw,['operationId','fingerprint','preview']);let op=await row(user,p.operationId);
 if(op.fingerprint!==p.fingerprint||canonical(p.preview)!==canonical(JSON.parse(op.preview_json))||op.source!==authority.source||op.source_agent_id!==authority.agentId||op.source_session_id!==authority.sessionId)throw new ControlError('Approved operation binding changed',409);
 if(op.state==='applied')return receipt(op);if(!['preview','pending'].includes(op.state))throw new ControlError('Operation is uncertain or already executing; do not retry',409);
 if(op.source==='external'&&op.approval_id!==authority.approvalId)throw new ControlError('Approval binding changed',403);
 await checkComputerEffectGuard(op.admission_guard_json?JSON.parse(op.admission_guard_json):null);
 const b=JSON.parse(op.payload_json),fresh=await snapshot(authority.actor,b),origin=authority.source==='native'?{kind:'native',agentId:authority.agentId,sessionId:authority.sessionId}:{kind:'external'};if(hash({bindingNonce:op.binding_nonce,b,state:fresh,resourceId:op.resource_id,source:origin,...(op.admission_guard_json?{admissionGuard:JSON.parse(op.admission_guard_json)}:{})})!==op.fingerprint)throw new ControlError('Stored operation binding changed',409);if(canonical(fresh)!==canonical(JSON.parse(op.snapshot_json)))throw new ControlError('Approved impact changed',409);
 await sql().tx(function*(){yield* lockName('workspace-control:'+op.id);const update=yield* run("UPDATE workspace_control_operations SET approval_id=?,state='applying',updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_id=? AND state IN ('preview','pending') AND fingerprint=?",authority.approvalId,op.id,user,op.fingerprint);if(update.changes!==1)throw new ControlError('Operation already claimed',409);});op={...op,approval_id:authority.approvalId,state:'applying'};
 const state=JSON.parse(op.snapshot_json);let result:unknown;
 try{
  if(op.kind==='agent'){
   if(op.action==='create'){const d={...b.draft,role:b.draft.role??'specialist'},checked=roleAndDepartment(d);await sql().tx(function*(){yield* guard(op);yield* insertAgentConfigStep({id:op.resource_id,name:validateAgentName(d.name),language:null,body:d,role:checked.role,department:checked.department,explicit:null,userId:user});});if(checked.department&&storeP3Enabled())await linkAgentDepartment(op.resource_id);result=agentSafe(await repositories.agents.getConfig(authority.actor,op.resource_id));}
   else{await sql().read(guard(op));const updated=await repositories.agents.updateConfig(authority.actor,op.resource_id,{...b.draft,expectedVersion:b.expectedRevision},undefined,()=>guard(op));if(b.draft.name!==undefined)await agentRenamed(op.resource_id);result=agentSafe(updated);}
  }else if(op.kind==='personality'){
   const store=new PersonalityLibrary();await sql().read(guard(op));if(op.action==='assign'){result=await store.assign(user,op.resource_id,b.draft,()=>guard(op));await writePersonalityView(op.resource_id);}else{result=await store.save(user,op.resource_id,{revision:b.expectedRevision,profile:b.draft.profile,...(state.privateData.confirmation?{confirmation:state.privateData.confirmation}:{})},()=>guard(op));for(const a of state.review.affected??[])await writePersonalityView(a.id);}
  }else if(op.kind==='specialty'){
   const store=new SpecialtyTemplates();await sql().read(guard(op));if(op.action==='assign')result=await store.assign(user,op.resource_id,{revision:b.expectedRevision,agentIds:b.draft.agentIds,expectedAgentIds:state.privateData.expectedAgentIds},()=>guard(op),true);else result=await store.save(op.resource_id,{...b.draft,revision:b.expectedRevision,config:state.privateData.config??emptyConfig(),...(state.privateData.confirmImpact?{confirmImpact:state.privateData.confirmImpact}:{})},()=>guard(op),op.action==='update'?state.privateData.config:undefined);
  }else if(op.kind==='skill'){
   const store=centralSkills();await sql().read(guard(op));if(op.action==='assign')result=await store.assign(op.resource_id,b.draft.selected,b.expectedRevision,()=>guard(op));else result=await store.installReviewedPortable(b.draft.name,b.draft.files,{id:op.action==='create'?null:op.resource_id,revision:b.expectedRevision,hash:state.review.before?.skill?.content_hash??null,generatedId:op.resource_id},()=>guard(op));
  }else result=await applyReviewedRule(user,op.resource_id,b.draft,b.expectedRevision,()=>guard(op));
  size(result);await q.run("UPDATE workspace_control_operations SET state='applied',result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_id=? AND state='applying'",JSON.stringify(result),op.id,user);auditMcpOutcome(user,'workspace_control.apply.'+(authority.source==='native'?'native_main_approved':'external_owner_approved'),'workspace_control',op.id,'applied');return receipt(await row(user,op.id));
 }catch(error){try{await q.run("UPDATE workspace_control_operations SET state='uncertain',updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_id=? AND state='applying'",op.id,user);}catch{/* Keep applying as an uncertain checkpoint if receipt persistence is unavailable. */}auditMcpOutcome(user,'workspace_control.apply.'+(authority.source==='native'?'native_main_approved':'external_owner_approved'),'workspace_control',op.id,'uncertain');throw new ControlError('Operation may have committed; execution is uncertain. Inspect the stable resource and history; never retry automatically.',409);}
}

export async function workspaceControlOptions(actor:Actor){const user=owner(actor);await active(user);return sanitized({kinds:['agent','personality','specialty','skill','rule'],actions:['create','update','assign'],roles:['manager','specialist','evaluator'],models:(await loadModelCatalogue()).models.map((m:any)=>({id:m.id,provider:m.provider,label:m.label??m.name??m.id,available:m.available!==false})),schemas:{preview:['requestId','kind','action','targetId?','expectedRevision','draft'],request:['operationId','fingerprint'],agent:{create:['name','description?','emoji?','system_prompt?','department?','role?','modelSelection?'],update:['name?','description?','emoji?','system_prompt?','department?','role?','modelSelection?'],revision:'agents.read.version'},personality:{createOrUpdate:{profile:'complete validated personality profile'},assign:['id','revision','expectedVersion','linked'],revision:'library revision; assign uses current personality version'},specialty:{createOrUpdate:['name','department','description','instructions'],assign:{agentIds:'exact full selected set'},revision:'template revision'},skill:{createOrUpdate:{name:'existing name for update',files:'Markdown-only [{path,content}] with SKILL.md'},assign:{selected:'complete selected skill IDs; targetId is agent ID'},revision:'skill revision or assignment-list revision'},rule:{createOrUpdate:['text?','when?','projectId?','who?','targets?','paused?'],assign:'update exact who/targets/projectId',revision:'rule version'}},skills:await q.all('SELECT id,name,revision FROM central_skills ORDER BY name LIMIT 200'),rules:await q.all("SELECT r.id,r.text,r.version,r.paused,r.status FROM agent_rules r WHERE r.project_id IS NULL OR EXISTS (SELECT 1 FROM chat_projects p WHERE p.id=r.project_id AND p.user_id=?) ORDER BY r.created_at DESC LIMIT 200",user),approval:'Existing owner Approvals full view; external callers request and poll only',permissionChanges:false}).value;}
