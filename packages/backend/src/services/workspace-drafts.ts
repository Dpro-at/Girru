import {auditMcpOutcome} from './mcp-audit.js';
/** Owner review notes only. Nothing here applies a template, assigns an agent, activates a rule or grants access. */
import {createHash,randomUUID} from 'node:crypto';
import type {Actor} from '../repositories/actor.js';
import {isOwner,ScopeError} from '../repositories/scope.js';
import {one,all,run,sql,lockName,type Step} from '../repositories/sql-steps.js';
import {validateProfile} from './personality-library-profile.js';
export class WorkspaceDraftError extends Error{constructor(message:string,readonly status=400){super(message);}}
const kinds=['skill','personality','specialty','rule','agent'];
const record=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const plain=(v:unknown)=>{if(typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v)||v.includes('..'))throw new WorkspaceDraftError('Invalid identifier');return v;};
const canonical=(v:any):string=>v&&typeof v==='object'?(Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}'):JSON.stringify(v);
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
function actorId(actor:Actor|null|undefined){if(!isOwner(actor)||!actor?.userId||actor.channel)throw new ScopeError(actor?403:401,'Active owner required');return actor.userId;}
function* active(owner:string):Step<void>{const u=yield* one<{role:string;status:string}>('SELECT role,status FROM users WHERE id=?',owner);if(u?.role!=='owner'||u.status!=='active')throw new ScopeError(403,'Active owner required');}
const targets:Record<string,string>={skill:'SELECT id,name,description,revision,content_hash FROM central_skills WHERE id=?',personality:'SELECT id,revision,profile_json,archived FROM personality_library WHERE id=?',specialty:'SELECT id,name,department,description,revision,content_hash FROM specialty_templates WHERE id=?',rule:'SELECT id,text,version,status,paused,project_id FROM agent_rules WHERE id=?',agent:'SELECT id,name,description,emoji,department FROM agents_config WHERE id=?'};
function* contextStep(owner:string,kind:string,targetId:string|undefined,agentId:string|undefined):Step<any>{
 if(!kinds.includes(kind))throw new WorkspaceDraftError('Unknown draft kind');
 const target=targetId?yield* one<any>(targets[kind],targetId):null;if(targetId&&!target)throw new ScopeError(404,'Draft target unavailable');
 if(kind==='rule'&&target?.project_id&&!(yield* one('SELECT id FROM chat_projects WHERE id=? AND user_id=?',target.project_id,owner)))throw new ScopeError(404,'Draft target unavailable');
 const agent=agentId?yield* one(targets.agent,agentId):null;if(agentId&&!agent)throw new ScopeError(404,'Assignment agent unavailable');
 let affected:unknown[]=[];
 if(targetId&&kind==='personality')affected=yield* all('SELECT agent_id AS id,linked FROM agent_personality_links WHERE personality_id=? ORDER BY agent_id LIMIT 101',targetId);
 if(targetId&&kind==='skill')affected=yield* all('SELECT agent_id AS id FROM central_agent_skills WHERE skill_id=? ORDER BY agent_id LIMIT 101',targetId);
 if(targetId&&kind==='specialty')affected=yield* all('SELECT agent_id AS id FROM agent_template_snapshots WHERE template_id=? ORDER BY agent_id LIMIT 101',targetId);
 // A full exact linked-content impact review remains in the existing library operation.
 return {kind,targetId:targetId??null,agentId:agentId??null,fingerprint:targetId?hash({target,agent}):'new',revision:target?.revision??target?.version??null,affectedAgents:affected.slice(0,100),affectedTruncated:affected.length>100,applyAvailable:false,review:'Read the draft, then use the existing owner app editor and its exact impact review. This is not an approval card.'};
}
export async function draftContext(actor:Actor|null|undefined,input:unknown){const owner=actorId(actor);if(!record(input)||Object.keys(input).some(k=>!['kind','targetId','agentId'].includes(k))||!kinds.includes(input.kind))throw new WorkspaceDraftError('Invalid draft context');return sql().read((function*(){yield* active(owner);return yield* contextStep(owner,input.kind,input.targetId===undefined?undefined:plain(input.targetId),input.agentId===undefined?undefined:plain(input.agentId));})());}
function payload(kind:string,value:unknown){
 if(!record(value))throw new WorkspaceDraftError('Draft content must be an object');
 if(kind==='personality'){if(Object.keys(value).some(k=>k!=='profile'))throw new WorkspaceDraftError('Unknown profile draft field');try{return {profile:validateProfile(value.profile)};}catch{throw new WorkspaceDraftError('A valid personality profile is required');}}
 const fields:Record<string,string[]>={skill:['name','description','content'],specialty:['name','department','description','instructions'],rule:['text','when','reason','projectId'],agent:['name','description','emoji','department']};
 if(Object.keys(value).some(k=>!fields[kind]?.includes(k))||!Object.keys(value).length)throw new WorkspaceDraftError('Unsupported draft field; grants, roles, providers and primary status are not authorable here');
 for(const [key,text]of Object.entries(value)){if(key==='projectId'&&text===null)continue;if(typeof text!=='string'||text.length>(['content','instructions','text'].includes(key)?12000:1000)||!text.trim()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))throw new WorkspaceDraftError('Invalid bounded draft text');}
 return value;
}
async function saveWorkspaceDraftInner(actor:Actor|null|undefined,input:unknown){
 const owner=actorId(actor);if(!record(input)||Object.keys(input).some(k=>!['requestId','kind','action','targetId','agentId','expectedFingerprint','draft'].includes(k))||!kinds.includes(input.kind)||!['create','update','assign'].includes(input.action))throw new WorkspaceDraftError('Invalid review draft');
 const requestId=plain(input.requestId),targetId=input.targetId===undefined?undefined:plain(input.targetId),agentId=input.agentId===undefined?undefined:plain(input.agentId);
 if(input.action==='create'?(targetId!==undefined||agentId!==undefined||input.expectedFingerprint!=='new'):(!targetId||!(/^[a-f0-9]{64}$/).test(input.expectedFingerprint)))throw new WorkspaceDraftError('Explicit current target fingerprint required');
 if(input.action==='assign'&&(!agentId||input.kind==='agent')||input.action!=='assign'&&agentId)throw new WorkspaceDraftError('Invalid assignment request');
 const draft=input.action==='assign'?{}:payload(input.kind,input.draft);if(input.action==='assign'&&(!record(input.draft)||Object.keys(input.draft).length))throw new WorkspaceDraftError('Assignment requests accept no authored grants or content');
 if(/-----BEGIN [^-]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{8,}|\b(?:password|api[_ -]?key|access[_ -]?token)\s*[=:]\s*[^\s,;]+/i.test(JSON.stringify(draft)))throw new WorkspaceDraftError('Credential-shaped content cannot be stored in a review draft');
 if(Buffer.byteLength(JSON.stringify(draft))>24000)throw new WorkspaceDraftError('Draft is too large');
 const normalized={requestId,kind:input.kind,action:input.action,targetId:targetId??null,agentId:agentId??null,expectedFingerprint:input.expectedFingerprint,draft},fingerprint=hash(normalized);
 return sql().tx(function*(){yield* active(owner);yield* lockName('workspace-draft:'+owner+':'+requestId);
  const old=yield* one<any>('SELECT * FROM workspace_control_drafts WHERE owner_id=? AND request_id=?',owner,requestId);if(old){if(old.payload_hash!==fingerprint)throw new WorkspaceDraftError('Draft request changed',409);return {id:old.id,state:'draft',applied:false,replayed:true};}
  const context=yield* contextStep(owner,input.kind,targetId,agentId);if(context.fingerprint!==input.expectedFingerprint)throw new WorkspaceDraftError('Draft target changed; refresh context',409);
  if(input.kind==='rule'&&draft.projectId&&!(yield* one('SELECT id FROM chat_projects WHERE id=? AND user_id=?',draft.projectId,owner)))throw new ScopeError(404,'Rule project unavailable');
  const id=randomUUID();yield* run('INSERT INTO workspace_control_drafts(id,owner_id,request_id,payload_hash,kind,action,target_id,agent_id,target_fingerprint,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?)',id,owner,requestId,fingerprint,input.kind,input.action,targetId??null,agentId??null,input.expectedFingerprint,JSON.stringify(draft));return {id,state:'draft',applied:false,replayed:false,review:context.review};
 });
}
export async function listWorkspaceDrafts(actor:Actor|null|undefined){const owner=actorId(actor);return sql().read((function*(){yield* active(owner);return {drafts:yield* all('SELECT id,kind,action,target_id AS "targetId",agent_id AS "agentId",created_at AS "createdAt" FROM workspace_control_drafts WHERE owner_id=? ORDER BY created_at DESC,id DESC LIMIT 100',owner),applyAvailable:false};})());}
export async function readWorkspaceDraft(actor:Actor|null|undefined,key:unknown){const owner=actorId(actor);return sql().read((function*(){yield* active(owner);const r=yield* one<any>('SELECT id,kind,action,target_id AS "targetId",agent_id AS "agentId",target_fingerprint AS "expectedFingerprint",payload_json,created_at AS "createdAt" FROM workspace_control_drafts WHERE owner_id=? AND id=?',owner,plain(key));if(!r)throw new ScopeError(404,'Review draft unavailable');const {payload_json,...summary}=r;return {...summary,draft:JSON.parse(payload_json),state:'draft',applied:false,applyAvailable:false};})());}

export async function saveWorkspaceDraft(actor:Actor|null|undefined,input:unknown){try{const receipt=await saveWorkspaceDraftInner(actor,input);auditMcpOutcome(actor?.userId,'workspace_draft.prepare','workspace_draft',receipt.id,receipt.replayed?'replayed':'created');return receipt;}catch(error){auditMcpOutcome(actor?.userId,'workspace_draft.prepare','workspace_draft',undefined,'refused',error instanceof WorkspaceDraftError||error instanceof ScopeError?error.status:500);throw error;}}
