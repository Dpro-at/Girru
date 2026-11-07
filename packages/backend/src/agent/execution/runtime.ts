/** Public backend execution boundary. Entry adapters must authenticate/admit the
 * command first. Each strategy retains its sensitive-boundary authorization;
 * an accepted command is never a grant. Lazy wiring avoids domain import cycles.
 */
import type { AgentReply } from '../contracts/reply.js';
import type { ChatTurnInput } from './chat-turn.js';
import type { AttemptResult } from './task-turn.js';

export type AgentExecutionCommand =
  | { strategy: 'chat'; reply: AgentReply; input: ChatTurnInput }
  | { strategy: 'durable'; runId: string; worker?: string };

export function executeAgent(command: Extract<AgentExecutionCommand, { strategy: 'durable' }>): Promise<AttemptResult>;
export function executeAgent(command: Extract<AgentExecutionCommand, { strategy: 'chat' }>): Promise<unknown>;
export async function executeAgent(command: AgentExecutionCommand): Promise<unknown> {
  switch (command.strategy) {
    case 'chat': return (await import('./chat-turn.js')).executeChatTurn(command.reply, command.input);
    case 'durable': return (await import('./task-turn.js')).executeTaskRun(command.runId, command.worker);
    default: throw new Error('unsupported_execution_strategy');
  }
}

export function executeChatTurn(reply: AgentReply, input: ChatTurnInput): Promise<unknown> {
  return executeAgent({ strategy: 'chat', reply, input });
}
export function executeTaskRun(runId: string, worker?: string): Promise<AttemptResult> {
  return executeAgent({ strategy: 'durable', runId, worker });
}
