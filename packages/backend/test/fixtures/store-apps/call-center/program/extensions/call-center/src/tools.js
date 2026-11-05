/**
 * Call Center AI Agent Tools
 * Tools that AI agents can use to make and manage calls
 */
import { telephonyRequest } from '../../shared/internal-auth.js';
export const makeCallTool = {
    name: 'make_call',
    description: 'Make an outbound phone call using a configured call point. The AI agent can initiate calls to customers or users.',
    parameters: {
        type: 'object',
        properties: {
            callPointId: {
                type: 'string',
                description: 'ID of the call point to use for making the call',
            },
            toNumber: {
                type: 'string',
                description: 'Phone number to call in E.164 format (e.g., +1234567890)',
            },
            customGreeting: {
                type: 'string',
                description: 'Optional custom greeting message for this call (overrides call point default)',
            },
        },
        required: ['callPointId', 'toNumber'],
    },
    async execute({ callPointId, toNumber, customGreeting }, context) {
        try {
            // SECURITY (S0-A.4): act as the user of the current agent turn.
            const response = await telephonyRequest('make',{callPointId,toNumber,customGreeting},context?.userId);
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to make call');
            }
            const data = await response.json();
            return {
                success: true,
                callSid: data.callSid,
                status: data.status,
                message: `Call initiated to ${toNumber} from call point ${callPointId}`,
            };
        }
        catch (error) {
            return {
                success: false,
                error: error.message,
            };
        }
    },
};
export const hangupCallTool = {
    name: 'hangup_call',
    description: 'Hang up an active phone call',
    parameters: {
        type: 'object',
        properties: {
            callSid: {
                type: 'string',
                description: 'Twilio Call SID of the call to hang up',
            },
        },
        required: ['callSid'],
    },
    async execute({ callSid }, context) {
        try {
            // SECURITY (S0-A.4): act as the user of the current agent turn.
            const response = await telephonyRequest('hangup',{callSid},context?.userId);
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to hang up call');
            }
            return {
                success: true,
                message: `Call ${callSid} ended successfully`,
            };
        }
        catch (error) {
            return {
                success: false,
                error: error.message,
            };
        }
    },
};
