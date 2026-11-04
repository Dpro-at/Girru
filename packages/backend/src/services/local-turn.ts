/**
 * One local chat turn under STORE-MAP-01 P2b (LOCAL-ONLY-01; GIRRU_STORE_P2B):
 * the model's real window, the adaptive budget, tools on demand and the weak
 * tool calling rules, put together for the chat route (both its streamed and
 * its one-piece paths) so every local provider gets the same turn.
 */

import { OLLAMA_URL } from '../llm/ollama.js';
import { lmStudioApiUrl, lmStudioModelName } from '../llm/lmstudio.js';
import { openAiLocalModelName, openAiLocalUrl } from '../llm/openai-local.js';
import { lmStudioWindow, ollamaWindow, openAiCompatWindow, FALLBACK_WINDOW, type ModelWindow } from '../llm/model-window.js';
import { fitLocalTurn, planLocalBudget, shrinkStep, toolOutputChars, toolTokens, type FitMessage, type FitResult, type LocalBudget } from '../memory/context/local-budget.js';
import { CALLS_PER_STEP, OnDemandTools, STEPS_PER_TURN } from '../tools/on-demand.js';
import type { ToolDef } from '../tools/tool-doors.js';
import type { ToolResult } from '../tools/types.js';
import { storeP2bEnabled } from './store-p2b.js';

export const LOCAL_TURN_PROVIDERS = ['ollama', 'lmstudio', 'openai-local'] as const;
export const isLocalTurnProvider = (provider: string | null | undefined): boolean => (LOCAL_TURN_PROVIDERS as readonly string[]).includes(String(provider));

/** P2b applies to this turn: the switch is on and the model runs on this computer. */
export const p2bLocalTurn = (provider: string | null | undefined): boolean => storeP2bEnabled() && isLocalTurnProvider(provider);

/** AG8: memory is never invented (said once, in the stable system text). */
export const NO_INVENTED_MEMORY = 'Memory rule: state a memory only when a memory tool returned it in this turn or it is in the recalled memory with the message. When it is not there, say you do not have it in memory. Never guess or invent a memory.';

/** The window of a local chat model (never throws; unknown → 8192). */
export async function localModelWindow(provider: string, model: string, fetchImpl?: typeof fetch): Promise<ModelWindow> {
  try {
    if (provider === 'lmstudio') return await lmStudioWindow(lmStudioApiUrl(), lmStudioModelName(model) || model, { fetchImpl });
    if (provider === 'openai-local') {
      const url = openAiLocalUrl();
      if (url) return await openAiCompatWindow(url, openAiLocalModelName(model) || model, { fetchImpl });
    }
    if (provider === 'ollama') return await ollamaWindow(OLLAMA_URL, model, { fetchImpl });
  } catch { /* fall through */ }
  return { tokens: FALLBACK_WINDOW, reported: null, source: 'fallback' };
}

export interface LocalTurn<M extends FitMessage> {
  window: ModelWindow;
  budget: LocalBudget;
  toolset: OnDemandTools;
  /** The system text: the given parts, the tool index and the memory rule, fitted. */
  system: string;
  messages: M[];
  fit: FitResult<M>;
  /** For the agent loops. */
  toolSet: { definitions(): ToolDef[] };
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  callCap: number;
  maxSteps: number;
  /** Characters of one tool result for the model, and the per-step shrink that keeps every request in the window. */
  toolOutputChars: number;
  beforeStep(messages: { role: string; content: unknown }[]): void;
  numCtx: number;
  /** The reply limit: the owner's or the agent's when smaller, else the budget's reply room. */
  maxTokens: number;
}

/**
 * Build the turn. `systemHead` is the stable system text; `systemTail` goes
 * after the tool index (the UI spec); `messages` are the conversation without
 * the system text, the new message (with its recalled memory) last.
 */
export function prepareLocalTurn<M extends FitMessage>(input: {
  window: ModelWindow;
  tools: readonly ToolDef[];
  systemHead: string;
  systemTail?: string;
  messages: readonly M[];
  maxTokens?: number;
  run: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}): LocalTurn<M> {
  const budget = planLocalBudget(input.window.tokens);
  const toolset = new OnDemandTools(input.tools, budget.tier);
  const parts = [input.systemHead, toolset.index(), NO_INVENTED_MEMORY, input.systemTail].filter((p) => p && p.trim());
  const fit = fitLocalTurn({ system: parts.join('\n\n---\n\n'), messages: input.messages, tools: toolset.definitions(), budget });
  return {
    window: input.window, budget, toolset, system: fit.system, messages: fit.messages, fit,
    toolSet: { definitions: () => toolset.definitions() },
    execute: (name, args) => toolset.execute(name, args, input.run),
    callCap: CALLS_PER_STEP[budget.tier],
    maxSteps: STEPS_PER_TURN[budget.tier],
    toolOutputChars: toolOutputChars(budget),
    // The system message is part of `messages` in the loops; the tools are sent beside them.
    beforeStep: (messages) => { shrinkStep(messages, budget.promptTokens - toolTokens(toolset.definitions())); },
    numCtx: budget.window,
    maxTokens: input.maxTokens && input.maxTokens > 0 ? Math.min(input.maxTokens, budget.replyTokens) : budget.replyTokens,
  };
}

/** Numbers only, for the log (no prompt text). */
export function localTurnLog(t: LocalTurn<FitMessage>): Record<string, unknown> {
  return { window: t.window.tokens, source: t.window.source, tier: t.budget.tier, toolCount: t.toolset.definitions().length, ...t.fit.tokens, budget: t.budget.promptTokens, cut: t.fit.cut, fits: t.fit.fits };
}
