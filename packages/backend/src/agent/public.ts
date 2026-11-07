/** Supported backend agent boundary. Importing this module does not start a
 * runtime, connect a store or open a profile. Entry adapters authenticate and
 * admit intent; strategies retain sensitive-boundary checks and durable state.
 */
export { executeAgent, executeChatTurn, executeTaskRun } from './execution/runtime.js';
export type { AgentExecutionCommand } from './execution/runtime.js';
export type { ChatTurnInput } from './execution/chat-turn.js';
export type { AgentReply } from './contracts/reply.js';
export type { AgentLoopEvent, AgentLoopResult, AgentToolDefinition, ExecuteAgentTool } from './contracts/execution.js';
export type { AgentRunEvent, AgentRunFrame } from './contracts/events.js';
export type { ResolveInput, ResolvedAgentContext } from './context/resolve.js';
