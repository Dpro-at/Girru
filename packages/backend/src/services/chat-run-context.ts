import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolResult } from '../tools/types.js';

/** Trusted execution context, never read from model arguments or HTTP bodies. */
/** CHAT-BUILD-01 stage 3 (CH3): how freely the team works in this chat; never looser than the agent's own rules. */
export type ChatMode = 'auto' | 'ask' | 'accept_edits' | 'plan';
export type ChatThinking = 'quick' | 'normal' | 'deep';
export interface ChatRunContext {
  reviewTools: boolean;
  /** RUNS-01: this reply's run id, so work it starts (hand-offs, coding apps, small helpers) shows as its sub-tasks. */
  runId?: string;
  chatMode?: ChatMode;
  thinking?: ChatThinking;
  /** The project's added folders the agent may read (absolute paths). */
  readRoots?: string[];
  /** CHAT-BUILD-01 stage 4: the model that wrote this reply and the estimated tokens it was given (tokens by model). */
  usage?: { model: string; tokensIn: number };
  /** CHAT-BUILD-01 stage 5: messages the owner sent while the agent works (taken at the next step). */
  takeSteers?: () => string[];
  /** A notice shown in the chat (a tool result that tried to give orders, the chat summed up). */
  notice?: (code: string, text?: string) => void;
  failed?: boolean;
  beforeTool(name: string, params: Record<string, unknown>): Promise<string>;
  afterTool(id: string, result: ToolResult): Promise<void>;
}
const storage = new AsyncLocalStorage<ChatRunContext>();
export const currentChatRun = () => storage.getStore();
export function withChatRun<T>(context: ChatRunContext, execute: () => T): T { return storage.run(context, execute); }
