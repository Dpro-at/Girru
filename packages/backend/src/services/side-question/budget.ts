/**
 * AGENT-BTW-01: the side-question channel's own context budget.
 *
 * Independent of the main run's budget. The input budget is
 *   window - output cap - safety margin
 * and the assembled prompt is the snapshot context (oldest trimmed first),
 * then the side channel's own rolling summary and recent Q&A, then the new
 * question. A trim never splits a tool call from its result (messages that
 * share a `pairId` are kept or dropped together, keeping the newest that fit).
 */

import { estimateTokens } from '../../memory/context/budget.js';
import type { SnapshotMessage } from './snapshot.js';

export const FALLBACK_WINDOW = 8192;
export const DEFAULT_OUTPUT_CAP = 1024;
export const DEFAULT_SAFETY_MARGIN = 512;

export interface SideBudget {
  window: number;
  outputCap: number;
  safetyMargin: number;
  /** Tokens available for the whole assembled input. */
  inputTokens: number;
}

export function sideBudget(opts: { window?: number; outputCap?: number; safetyMargin?: number } = {}): SideBudget {
  const window = Math.max(1024, Math.floor(opts.window ?? FALLBACK_WINDOW));
  const outputCap = Math.max(64, Math.floor(opts.outputCap ?? DEFAULT_OUTPUT_CAP));
  const safetyMargin = Math.max(0, Math.floor(opts.safetyMargin ?? DEFAULT_SAFETY_MARGIN));
  const inputTokens = Math.max(256, window - outputCap - safetyMargin);
  return { window, outputCap, safetyMargin, inputTokens };
}

export interface SideQa {
  readonly question: string;
  readonly answer: string;
}

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssembleInput {
  systemPrompt: string;
  /** The immutable snapshot context (oldest first). */
  context: ReadonlyArray<SnapshotMessage>;
  /** The side channel's rolling summary of older Q&A (may be empty). */
  summary: string;
  /** Recent verbatim Q&A for this side channel (oldest first). */
  recent: ReadonlyArray<SideQa>;
  question: string;
  budget: SideBudget;
}

export interface AssembledPrompt {
  /** System text for the provider (the snapshot's system prompt, unchanged). */
  system: string;
  /** The conversation to send: trimmed snapshot context + the side-channel turn. */
  messages: ProviderMessage[];
  /** How many of the oldest snapshot messages were dropped to fit. */
  droppedContext: number;
}

/**
 * Group snapshot messages into atomic units: a message and any that share its
 * `pairId` (a tool call plus its result) stay together. Order is preserved.
 */
function pairedUnits(context: ReadonlyArray<SnapshotMessage>): SnapshotMessage[][] {
  const units: SnapshotMessage[][] = [];
  let i = 0;
  while (i < context.length) {
    const msg = context[i];
    if (msg.pairId) {
      const unit = [msg];
      let j = i + 1;
      while (j < context.length && context[j].pairId === msg.pairId) { unit.push(context[j]); j++; }
      units.push(unit);
      i = j;
    } else {
      units.push([msg]);
      i++;
    }
  }
  return units;
}

function unitTokens(unit: SnapshotMessage[]): number {
  return unit.reduce((n, m) => n + estimateTokens(`${m.role}: ${m.content}`) + 4, 0);
}

/** Build the side-channel turn (summary + recent Q&A + the new question) as one user message. */
export function sideChannelTurn(summary: string, recent: ReadonlyArray<SideQa>, question: string): string {
  const parts: string[] = [];
  parts.push(
    'You are answering a quick side question about the work above, from a read-only ' +
    'snapshot of the main agent\'s context. Do not act, call tools, or change anything; ' +
    'just answer the question using that context and the earlier side questions below.',
  );
  if (summary.trim()) parts.push(`## Earlier side questions (summary)\n${summary.trim()}`);
  if (recent.length) {
    const lines = recent.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n\n');
    parts.push(`## Recent side questions\n${lines}`);
  }
  parts.push(`## Side question\n${question.trim()}`);
  return parts.join('\n\n');
}

/**
 * Assemble the provider prompt within the budget. The system prompt, the
 * side-channel turn and the new question are always kept; the snapshot context
 * is trimmed from the oldest paired unit until the whole input fits.
 */
export function assemblePrompt(input: AssembleInput): AssembledPrompt {
  const turn = sideChannelTurn(input.summary, input.recent, input.question);
  const fixed = estimateTokens(input.systemPrompt) + estimateTokens(turn) + 8;
  const room = Math.max(0, input.budget.inputTokens - fixed);

  const units = pairedUnits(input.context);
  // Keep the newest units that fit in `room`, walking from the end.
  const kept: SnapshotMessage[][] = [];
  let used = 0;
  let dropped = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    const cost = unitTokens(units[i]);
    if (used + cost <= room) { kept.unshift(units[i]); used += cost; }
    else { dropped += units[i].length; }
  }

  const messages: ProviderMessage[] = [];
  for (const unit of kept) {
    for (const m of unit) {
      // The provider conversation takes user/assistant turns; map system/tool
      // lines to a user turn so their text still informs the answer.
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
  }
  messages.push({ role: 'user', content: turn });
  return { system: input.systemPrompt, messages, droppedContext: dropped };
}
