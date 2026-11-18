/** External prepared memory changes remain owner-reviewed proposals; never direct saves. */
import {createHash} from 'node:crypto';
import type {Actor} from '../repositories/actor.js';
import {ScopeError,isOwner} from '../repositories/scope.js';
import {one,run,lockName,sql,type Step} from '../repositories/sql-steps.js';
import {parseDrawerId,drawerId,type DrawerRef} from '../memory/drawers.js';
import {chatProjectKeyColumn} from '../memory/project-keys.js';
import {isMemoryType} from '../memory/types.js';
import {drawerRevisionStep,lockMemoryHistory} from '../memory/versions.js';
import {createChangeProposalStep,getProposalStep,lockProposalQueue,type MemoryProposal,type MemoryChange} from '../memory/memory-files.js';

export class PreparedMemoryError extends Error {constructor(message:string,readonly status=400){super(message);}}
type Entry={type:string;importance:number;content:string};
export type PreparedMemoryInput={operation:'propose_add'|'propose_update';scope:string;agentId:string;requestId:string;expectedRevision:number;after:Entry;id?:string;expectedVersion?:number;before?:Entry};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const identifier=(v:unknown)=>{if(typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(v)||v.includes('..'))throw new PreparedMemoryError('Invalid plain identifier');return v;};
const integer=(v:unknown,min=0)=>{if(!Number.isSafeInteger(v)||Number(v)<min)throw new PreparedMemoryError('Invalid expected revision or version');return Number(v);};
function entry(v:unknown):Entry{if(!object(v)||Object.keys(v).some(k=>!['type','importance','content'].includes(k))||!isMemoryType(v.type)||!Number.isInteger(v.importance)||Number(v.importance)<1||Number(v.importance)>10||typeof v.content!=='string'||!v.content.trim()||v.content.length>12000)throw new PreparedMemoryError('Entry requires a known type, importance 1..10 and nonempty content up to 12000 characters');return {type:v.type,importance:Number(v.importance),content:v.content};}
export function parsePreparedMemory(v:unknown):PreparedMemoryInput{
 if(!object(v)||!['propose_add','propose_update'].includes(String(v.operation)))throw new PreparedMemoryError('Only add and update proposals are supported');
 const update=v.operation==='propose_update';const allowed=['operation','scope','agentId','requestId','expectedRevision','after',...(update?['id','expectedVersion','before']:[])];
 if(Object.keys(v).some(k=>!allowed.includes(k)))throw new PreparedMemoryError('Unknown proposal argument');
 let drawer:DrawerRef;try{drawer=parseDrawerId(v.scope);}catch{throw new PreparedMemoryError('One explicit memory drawer is required');}
 return {operation:v.operation as PreparedMemoryInput['operation'],scope:drawerId(drawer),agentId:identifier(v.agentId),requestId:identifier(v.requestId),expectedRevision:integer(v.expectedRevision),after:entry(v.after),...(update?{id:identifier(v.id),expectedVersion:integer(v.expectedVersion,1),before:entry(v.before)}:{})};
}
function owner(actor:Actor|null|undefined):string{if(!isOwner(actor)||!actor?.userId||actor.channel)throw new ScopeError(actor?403:401,'An active owner account is required');return actor.userId;}
function* activeOwner(userId:string):Step<void>{const row=yield* one<{role:string;status:string}>('SELECT role,status FROM users WHERE id = ?',userId);if(row?.role!=='owner'||row.status!=='active')throw new ScopeError(403,'An active owner account is required');}
/** Project association is exact and owned; other keyed drawers must already belong to this owner. */
function* validDrawer(userId:string,drawer:DrawerRef):Step<void>{
 if(drawer.kind==='project'){
  const p=yield* one('SELECT id FROM chat_projects WHERE user_id = ? AND '+chatProjectKeyColumn()+' = ?',userId,drawer.key!);
  if(!p)throw new ScopeError(404,'Memory drawer not found');
  const state=yield* one<{archived_at:string|null;merged_into:string|null}>('SELECT archived_at,merged_into FROM memory_project_scopes WHERE owner_id = ? AND slug = ?',userId,drawer.key!);
  if(state?.archived_at||state?.merged_into)throw new PreparedMemoryError('This project drawer is inactive',409);
 }else if(drawer.kind==='task'||drawer.kind==='people'){
  const r=yield* one('SELECT id FROM memories WHERE user_id = ? AND drawer_kind = ? AND drawer_key = ? LIMIT 1',userId,drawer.kind,drawer.key!);if(!r)throw new ScopeError(404,'Memory drawer not found');
 }
}
export async function preparedMemoryContext(actor:Actor|null|undefined,scope:unknown){const userId=owner(actor);let drawer:DrawerRef;try{drawer=parseDrawerId(scope);}catch{throw new PreparedMemoryError('One explicit memory drawer is required');}return sql().read((function*(){yield* activeOwner(userId);yield* validDrawer(userId,drawer);return {scope:drawerId(drawer),revision:yield* drawerRevisionStep(userId,drawer)};})());}
function receipt(p:MemoryProposal,replayed:boolean){return {proposalId:p.id,scope:p.drawerId,status:p.status,pendingApproval:p.status==='pending',saved:false,replayed,decisions:'owner_in_app'};}
export async function prepareMemoryProposal(actor:Actor|null|undefined,raw:unknown){
 const userId=owner(actor),input=parsePreparedMemory(raw),drawer=parseDrawerId(input.scope);
 // Canonical field order is produced by the parser, independent of caller JSON key order.
 const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
 return sql().tx(function*(){
  yield* activeOwner(userId);yield* lockName(`mcp-memory-request:${userId}:${input.requestId}`);
  const prior=yield* one<{payload_hash:string;proposal_id:string}>('SELECT payload_hash,proposal_id FROM mcp_memory_requests WHERE owner_id = ? AND request_id = ?',userId,input.requestId);
  if(prior){if(prior.payload_hash!==fingerprint)throw new PreparedMemoryError('requestId was already used with a different payload',409);const proposal=yield* getProposalStep(userId,prior.proposal_id);if(!proposal)throw new PreparedMemoryError('The recorded proposal is unavailable',409);return receipt(proposal,true);}
  yield* validDrawer(userId,drawer);
  if(!(yield* one('SELECT id FROM agents_config WHERE id = ?',input.agentId)))throw new ScopeError(404,'Proposal association agent not found');
  yield* lockProposalQueue(userId);
  if(input.id)yield* lockMemoryHistory(input.id);
  const revision=yield* drawerRevisionStep(userId,drawer);if(revision!==input.expectedRevision)throw new PreparedMemoryError('Memory drawer revision changed; read it again',409);
  let change:MemoryChange={op:'add',after:input.after};
  if(input.operation==='propose_update'){
   const m=yield* one<{id:string;type:string;content:string;importance_score:number;drawer_kind:string;drawer_key:string;status:string;version:number}>('SELECT m.id,m.type,m.content,m.importance_score,m.drawer_kind,m.drawer_key,m.status,(SELECT MAX(v.version) FROM memory_versions v WHERE v.memory_id=m.id AND v.user_id=m.user_id) AS version FROM memories m WHERE m.user_id = ? AND m.id = ?',userId,input.id!);
   if(!m||m.drawer_kind!==drawer.kind||(m.drawer_key||'')!==(drawer.key||''))throw new ScopeError(404,'Memory not found in this drawer');
   if(m.status!=='active'||m.version!==input.expectedVersion||m.type!==input.before!.type||m.content!==input.before!.content||Math.min(10,Math.max(1,Math.round(m.importance_score*10)))!==input.before!.importance)throw new PreparedMemoryError('Memory version or before-state changed; read it again',409);
   if(JSON.stringify(input.before)===JSON.stringify(input.after))throw new PreparedMemoryError('The proposal has no changes');
   change={op:'update',id:input.id!,before:input.before!,after:input.after};
  }
  const proposal=yield* createChangeProposalStep({userId,agentId:input.agentId,drawer,changes:[change],source:'import',reasons:['External MCP prepared proposal; owner review required'],createdBy:userId});
  yield* run('INSERT INTO mcp_memory_requests (owner_id,request_id,payload_hash,proposal_id) VALUES (?,?,?,?)',userId,input.requestId,fingerprint,proposal.id);
  return receipt(proposal,false);
 });
}
