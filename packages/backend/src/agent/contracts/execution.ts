/** Backend execution contracts. Provider messages remain adapter-specific.
 * Events describe progress, never grants or durable execution receipts.
 * Persisted chat/task events retain their existing sequence/lease contracts.
 */
import type { ToolResult } from '../../tools/types.js';

export type AgentLoopEvent =
  | { type: 'reasoning'; content: string }
  | { type: 'text'; content: string }
  | { type: 'tool_start'; step: number; tools: { id: string; name: string; input: string }[] }
  | { type: 'tool_result'; step: number; results: { id: string; name: string; output: string; isError: boolean; ms: number }[] }
  | { type: 'done'; done: true; steps: number }
  | { type: 'notice'; code: 'local_model_slow' };

export interface AgentToolDefinition { name: string; description: string; input_schema: unknown }

/** Execution must be supplied by the governed registry at the entry boundary. */
export type ExecuteAgentTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
export interface AgentLoopResult { steps: number; answer: string; aborted: boolean }
