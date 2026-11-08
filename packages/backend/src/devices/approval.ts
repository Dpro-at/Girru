/** A one-use execution capability from the existing registry, after its normal grant checks. */
import type { ToolExecutionContext } from '../tools/types.js';
import { consumeApprovalTicket, type ApprovalTicket } from '../tools/approvals.js';
import { q } from '../repositories/sql-steps.js';
const live = new WeakSet<object>(), bound = new WeakMap<ToolExecutionContext, {
    approvalId: string;toolName:string;
}>();
export function consumeComputerTicket(ticket: unknown,toolName='computer_task_accept') { if (!['computer_task_accept','computer_sync_apply'].includes(toolName)||!consumeApprovalTicket(ticket, toolName))
    return null; const cap = { approvalId: (ticket as ApprovalTicket).approvalId,toolName }; live.add(cap); return cap; }
export function bindComputerApproval(context: ToolExecutionContext, cap: {
    approvalId: string;toolName:string;
}) { if (!live.has(cap) || !context.userId || !context.agentId || context.toolPolicy || context.delegation || context.delegatedFrom?.length || context.taskId || context.taskRun)
    throw Error('computer_approval_required'); live.delete(cap); bound.set(context, cap); return context; }
export async function takeComputerApproval(context: ToolExecutionContext | undefined,expected='computer_task_accept') { const cap = context && bound.get(context); if (!context || !cap)
    throw Error('computer_approval_required'); bound.delete(context); const row = await q.one<any>('SELECT user_id,agent_id,tool_name,status FROM tool_approvals WHERE id=?', cap.approvalId); const user = await q.one<any>('SELECT role,status FROM users WHERE id=?', context.userId!); if (row?.status !== 'approved' || row.tool_name !== expected||cap.toolName!==expected || row.user_id !== context.userId || row.agent_id !== context.agentId || user?.role !== 'owner' || user.status !== 'active')
    throw Error('computer_approval_revoked'); return { approvalId: cap.approvalId, userId: context.userId!, agentId: context.agentId! }; }
