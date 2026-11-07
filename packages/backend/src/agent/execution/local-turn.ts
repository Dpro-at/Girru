/** Backend-only local turn admission. Inputs must already be resolved by server
 * policy/catalogue and the executor must retain registry authorization.
 * Provider choice is explicit: no unknown-provider fallback or protocol guessing.
 * This ephemeral strategy never replaces durable task leases and step receipts.
 */
import { runOllamaAgentLoop, type OllamaLoopOptions } from '../providers/ollama-agent-loop.js';
import { runLmStudioAgentLoop, type LmStudioLoopOptions } from '../providers/lmstudio-agent-loop.js';
import type { AgentLoopResult } from '../contracts/execution.js';

export type LocalTurnCommand =
  | { provider: 'ollama'; options: OllamaLoopOptions }
  | { provider: 'lmstudio' | 'openai-local'; options: LmStudioLoopOptions };

export function executeLocalTurn(command: LocalTurnCommand): Promise<AgentLoopResult> {
  switch (command.provider) {
    case 'ollama': return runOllamaAgentLoop(command.options);
    case 'lmstudio':
    case 'openai-local': return runLmStudioAgentLoop(command.options);
    default: throw new Error('unsupported_local_provider');
  }
}
