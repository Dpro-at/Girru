import {isConfiguredComputerAuthority,type ComputerAuthority} from './authority.js';
import {requireSyntheticAuthority,type SyntheticAuthority} from './synthetic-authority.js';
import type { Tool } from '../tools/types.js';
import { takeComputerApproval } from './approval.js';
const receivers = new Map<string, (approval: {
    approvalId: string;
    userId: string;
    agentId: string;
}, params: Record<string, unknown>) => Promise<unknown>>();
export function registerComputerReceiver(authority:ComputerAuthority,id: string, receiver: (approval: {
    approvalId: string;
    userId: string;
    agentId: string;
}, params: Record<string, unknown>) => Promise<unknown>) { if(authority.testOnly)requireSyntheticAuthority(authority as SyntheticAuthority);else if(!isConfiguredComputerAuthority(authority))throw Error('computer_authority_configuration_required');if (receivers.has(id))
    throw Error('computer_receiver_unavailable'); receivers.set(id, receiver); return () => receivers.delete(id); }
export const computerTaskAcceptTool: Tool = { name: 'computer_task_accept', requiresApproval: true, description: 'Accept one exact task on this computer after the local owner reviews it. No new grants. Normal local runtime admission and every applicable tool approval remain required.', input_schema: { type: 'object', properties: { target: { type: 'string' }, taskId: { type: 'string' }, fingerprint: { type: 'string' }, preview: { type: 'object' } }, required: ['target', 'taskId', 'fingerprint', 'preview'], additionalProperties: false }, async execute(params, context) { try {
        const approval = await takeComputerApproval(context);
        const receiver = receivers.get(params.target);
        if (!receiver)
            throw Error('computer_receiver_unavailable');
        const result = await receiver(approval, params);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], data: result };
    }
    catch (error) {
        return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'computer_task_refused' }], error: 'computer_task_refused' };
    } } };
export function syntheticComputerTools() { return [computerTaskAcceptTool]; }
