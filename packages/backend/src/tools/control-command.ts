/** Single-use owner-command capability, admitted only by a genuine approval execution ticket. */
import {consumeApprovalTicket,type ApprovalTicket} from './approvals.js';
import type {ToolExecutionContext} from './types.js';
import {userActor,type Actor} from '../repositories/actor.js';
import {q} from '../repositories/sql-steps.js';
import {mainAdminEligible} from './tasks/team-admin-authority.js';
type Capability={approvalId:string;toolName:string};
const authorities=new WeakSet<object>();
export const consumeControlAuthority=(value:object)=>{if(!authorities.has(value))return false;authorities.delete(value);return true;};
const live=new WeakSet<object>(),bound=new WeakMap<ToolExecutionContext,Capability>();
export function consumeControlTicket(ticket:unknown,toolName:string):Capability|null{if(!['workspace_control_apply','team_control_apply'].includes(toolName))return null;if(!consumeApprovalTicket(ticket,toolName))return null;const cap=Object.freeze({approvalId:(ticket as ApprovalTicket).approvalId,toolName});live.add(cap);return cap;}
export async function bindControlCommand(context:ToolExecutionContext,cap:Capability){
 if(!live.has(cap)||!context.userId||context.toolPolicy||context.taskId||context.taskRun||context.delegation||context.delegatedFrom?.length)throw Error('control_forbidden');live.delete(cap);
 if(cap.toolName==='workspace_control_apply'?!!context.agentId||!!context.sessionId:!await mainAdminEligible(context))throw Error('control_forbidden');
 bound.set(context,cap);return context;
}
export async function approvedControlActor(context:ToolExecutionContext|undefined){
 const cap=context&&bound.get(context);if(!context||!cap||!context.userId)throw Error('control_approval_required');
 const owner=await q.one<{role:string;status:string}>('SELECT role,status FROM users WHERE id=?',context.userId);
 const approval=await q.one<any>('SELECT id,user_id,agent_id,session_id,tool_name,status FROM tool_approvals WHERE id=?',cap.approvalId);
 if(owner?.role!=='owner'||owner.status!=='active'||!approval||approval.status!=='approved'||approval.user_id!==context.userId||approval.tool_name!==cap.toolName||(approval.agent_id??null)!==(context.agentId??null)||(approval.session_id??null)!==(context.sessionId??null))throw Error('control_approval_revoked');
 if(context.agentId&&!await mainAdminEligible(context))throw Error('control_forbidden');
 const authority=Object.freeze({actor:userActor({id:context.userId,role:'owner'}) as Actor,approvalId:cap.approvalId,source:context.agentId?'native':'external',agentId:context.agentId??null,sessionId:context.sessionId??null});authorities.add(authority);return authority;
}
