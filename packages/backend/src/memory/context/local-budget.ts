/**
 * The adaptive context budget of a local turn (STORE-MAP-01 P2b,
 * LOCAL-ONLY-01 item 2; GIRRU_STORE_P2B).
 *
 * The model's real window (llm/model-window.ts) is split so a turn always
 * fits, with room for the reply:
 *
 *   reply      a fifth of the window (at least 768, at most 4096 tokens)
 *   prompt     the rest, shared by
 *     system   the stable prefix: rules, persona, guides by name, pinned
 *              facts, the tool index (45 %)
 *     tools    the tools sent in full: tool_load, the memory verbs and what
 *              was loaded (20 %)
 *     memory   the memories recalled for this message (15 %)
 *     history  earlier turns: whatever is left
 *
 * Order is kept (A2): the system text first, then the earlier turns, then the
 * new message with its recalled memory, so the stable prefix stays the same
 * from turn to turn and the model's prompt cache keeps working. When a part is
 * over its share it is cut the same way every time (the same input gives the
 * same output): the system text keeps its start and end, recalled memory
 * keeps its best lines (they come first), history drops its oldest turns.
 *
 * Tokens are estimated from characters (3 per token: safe for Arabic and
 * English alike); real Qwen3 counts are lower, so the estimate errs on the
 * safe side.
 */

import { estimateTokens } from './budget.js';
import { capTokens } from '../../services/agent-context/budget.js';
import { tierOf, type ModelTier } from '../../tools/on-demand.js';
import type { ToolDef } from '../../tools/tool-doors.js';

export interface LocalBudget {
  window: number;
  tier: ModelTier;
  replyTokens: number;
  promptTokens: number;
  system: number;
  tools: number;
  memory: number;
}

export function planLocalBudget(windowTokens: number): LocalBudget {
  const window = Math.max(2048, Math.floor(windowTokens));
  const replyTokens = Math.min(4096, Math.max(768, Math.round(window / 5)));
  const promptTokens = window - replyTokens;
  return {
    window, tier: tierOf(window), replyTokens, promptTokens,
    system: Math.floor(promptTokens * 0.45),
    tools: Math.floor(promptTokens * 0.2),
    memory: Math.floor(promptTokens * 0.15),
  };
}

export interface FitMessage { role: string; content: unknown }

const RECALL_START = '[Memory recalled for this message';
const RECALL_END = '[End of recalled memory]';
const textOf = (c: unknown): string => (typeof c === 'string' ? c : JSON.stringify(c ?? ''));
export const toolTokens = (defs: readonly ToolDef[]): number => (defs.length ? estimateTokens(JSON.stringify(defs)) : 0);

/** Keep the first recalled lines (the best ones) until the block fits `tokens`. */
export function trimRecall(content: string, tokens: number): { text: string; dropped: number } {
  const start = content.indexOf(RECALL_START);
  const end = content.indexOf(RECALL_END);
  if (start < 0 || end < start) return { text: content, dropped: 0 };
  const block = content.slice(start, end + RECALL_END.length);
  if (estimateTokens(block) <= tokens) return { text: content, dropped: 0 };
  const lines = block.split('\n');
  const head = lines.filter((l) => !l.startsWith('- ') && l !== RECALL_END);
  const items = lines.filter((l) => l.startsWith('- '));
  const keep: string[] = [];
  let used = estimateTokens(head.join('\n')) + estimateTokens(RECALL_END) + 2;
  for (const l of items) {
    const t = estimateTokens(l) + 1;
    if (used + t > tokens) break;
    keep.push(l);
    used += t;
  }
  const rebuilt = [...head, ...keep, RECALL_END].join('\n');
  return { text: content.slice(0, start) + rebuilt + content.slice(end + RECALL_END.length), dropped: items.length - keep.length };
}

export interface FitResult<M extends FitMessage> {
  system: string;
  messages: M[];
  tokens: { system: number; tools: number; history: number; message: number; total: number };
  cut: { systemTokens: number; recallLines: number; historyTurns: number };
  fits: boolean;
}

/**
 * Fit one local turn into its budget. `messages` are the conversation without
 * the system text; the last one is the new message (with its recalled memory).
 */
export function fitLocalTurn<M extends FitMessage>(input: { system: string; messages: readonly M[]; tools: readonly ToolDef[]; budget: LocalBudget }): FitResult<M> {
  const { budget } = input;
  const toolsT = toolTokens(input.tools);
  let system = input.system;
  const before = estimateTokens(system);
  if (before > budget.system) system = capTokens(system, budget.system);
  const systemT = estimateTokens(system);

  const msgs = [...input.messages];
  let recallLines = 0;
  const last = msgs[msgs.length - 1];
  if (last && typeof last.content === 'string') {
    const r = trimRecall(last.content, budget.memory);
    if (r.dropped) { msgs[msgs.length - 1] = { ...last, content: r.text }; recallLines = r.dropped; }
  }
  let messageT = msgs.length ? estimateTokens(textOf(msgs[msgs.length - 1].content)) : 0;
  // A new message longer than all that is left keeps its start and end (it is never dropped).
  const room = budget.promptTokens - systemT - toolsT;
  if (msgs.length && messageT > room - 64 && typeof msgs[msgs.length - 1].content === 'string') {
    msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: capTokens(msgs[msgs.length - 1].content as string, Math.max(256, room - 64)) };
    messageT = estimateTokens(textOf(msgs[msgs.length - 1].content));
  }
  // History: the oldest turns leave first (a leading assistant turn goes with the user turn before it).
  let history = msgs.slice(0, -1);
  let historyT = history.reduce((n, m) => n + estimateTokens(textOf(m.content)) + 4, 0);
  let historyTurns = 0;
  while (history.length && systemT + toolsT + historyT + messageT > budget.promptTokens) {
    const gone = history.shift()!;
    historyT -= estimateTokens(textOf(gone.content)) + 4;
    historyTurns++;
    while (history.length && history[0].role !== 'user') { const g = history.shift()!; historyT -= estimateTokens(textOf(g.content)) + 4; historyTurns++; }
  }
  const out = msgs.length ? [...history, msgs[msgs.length - 1]] : [];
  const total = systemT + toolsT + historyT + messageT;
  return {
    system, messages: out,
    tokens: { system: systemT, tools: toolsT, history: Math.max(0, historyT), message: messageT, total },
    cut: { systemTokens: Math.max(0, before - systemT), recallLines, historyTurns },
    fits: total <= budget.promptTokens,
  };
}

/**
 * Inside one turn, tool results grow the prompt step by step. Before each
 * model call the oldest tool results, then the oldest earlier answers of this
 * turn, are shortened until the request fits `tokens` again (the system text
 * and the new message are never touched). Mutates `messages`; returns how many
 * were shortened.
 */
export function shrinkStep(messages: { role: string; content: unknown }[], tokens: number, keepChars = 400): number {
  const size = () => messages.reduce((n, m) => n + estimateTokens(textOf(m.content)) + 4, 0);
  let shortened = 0;
  for (const role of ['tool', 'assistant']) {
    for (let i = 0; i < messages.length - 1 && size() > tokens; i++) {
      const m = messages[i];
      if (m.role !== role || typeof m.content !== 'string' || m.content.length <= keepChars + 40) continue;
      m.content = `${m.content.slice(0, keepChars)}\n[… shortened to keep room in this model's window …]`;
      shortened++;
    }
  }
  return shortened;
}

/** Characters of one tool result given back to a model of this budget (its memory share). */
export const toolOutputChars = (b: LocalBudget): number => Math.max(1200, b.memory * 3);
