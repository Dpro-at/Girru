/**
 * Evidence-gated, self-retiring lessons (MEM-RSI-01): shared types, limits and
 * the cue normalization every part of the layer uses.
 *
 * A lesson is cross-task knowledge derived deterministically from CLOSED tasks:
 * it records what earlier outcomes proved, not what a model guessed. The three
 * rules the whole layer keeps:
 *   - admission: a lesson exists only with a cue, an action and >= 1 confirmed
 *     evidence row;
 *   - idempotent: evidence is keyed by (lesson, source_kind, source_id), so
 *     re-running extraction on the same source can never inflate support;
 *   - reversible: a disposition flip retracts an evidence row, a lesson retires
 *     when support hits zero, and a later confirmation restores it.
 */

import { lexicalTokens } from '../text-normalize.js';

/** positive = confirmed/reproduced; negative = do not repeat without a new
 * approach; caution = recheck before acting on it. */
export const POLARITIES = ['positive', 'negative', 'caution'] as const;
export type Polarity = typeof POLARITIES[number];

/** confirmed evidence counts toward support; reversed is kept but does not. */
export const DISPOSITIONS = ['confirmed', 'reversed'] as const;
export type Disposition = typeof DISPOSITIONS[number];

export type LessonStatus = 'active' | 'retired';

/**
 * The bounded, SYSTEM-written reason codes extraction may record. A code —
 * never the free-text status_reason — selects the fixed action template a
 * lesson carries, so no untrusted run text can ever reach a prompt. '' means
 * "no code" (evidence recorded by a path other than run extraction).
 */
export const REASON_CODES = ['task_completed', 'task_failed'] as const;
export type ReasonCode = typeof REASON_CODES[number];

export function isReasonCode(v: unknown): v is ReasonCode {
  return typeof v === 'string' && (REASON_CODES as readonly string[]).includes(v);
}

/**
 * The three modes of the layer (env GIRRU_RSI_LESSONS):
 *   off     (default) nothing is extracted, selected or injected;
 *   shadow  lessons are selected and LOGGED (what WOULD be injected), but
 *           nothing is added to any prompt;
 *   inject  the selected lessons are returned as a code-owned block to append
 *           to the prompt (a UI prompt edit cannot remove it).
 */
export const MODES = ['off', 'shadow', 'inject'] as const;
export type RsiMode = typeof MODES[number];

export const MAX_CUE_LENGTH = 200;
export const MAX_ACTION_LENGTH = 400;
/** At most this many lessons are offered to one prompt. */
export const MAX_INJECTED_LESSONS = 5;
/** Source kinds evidence can come from. */
export const SOURCE_KIND_TASK_RUN = 'task_run';

export interface Lesson {
  id: string;
  userId: string;
  /** Match key only; never rendered into a prompt (see LessonDraft.cue). */
  cue: string;
  action: string;
  polarity: Polarity;
  /** The bounded system reason code behind the action, or '' (audit only). */
  reasonCode: ReasonCode | '';
  support: number;
  status: LessonStatus;
  createdAt: string;
  updatedAt: string;
}

/** One lesson a source proves, before it is stored. */
export interface LessonDraft {
  /** Match key only — derived from (untrusted) run output and NEVER rendered
   * into any prompt; used to retrieve a lesson for a request. */
  cue: string;
  /** The text that may be rendered into a prompt. For run extraction this is a
   * fixed system template, never free text. */
  action: string;
  polarity: Polarity;
  sourceKind: string;
  sourceId: string;
  disposition: Disposition;
  /** The bounded system reason code behind the action (audit; '' when none). */
  reasonCode?: ReasonCode | '';
}

export function isPolarity(v: unknown): v is Polarity {
  return typeof v === 'string' && (POLARITIES as readonly string[]).includes(v);
}

export function isMode(v: unknown): v is RsiMode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v);
}

/**
 * The normalized cue: the lexical tokens of the text (Arabic normalization,
 * umlaut folding, stop words dropped, light stemming; see text-normalize.ts)
 * joined by one space, length-capped. '' when nothing is left — a cue made
 * only of stop words cannot be matched and no lesson is formed from it.
 */
export function normalizeCue(text: string): string {
  return lexicalTokens(String(text || '')).join(' ').slice(0, MAX_CUE_LENGTH);
}

/** Display form of an action: trimmed, inner spaces collapsed, length-capped. */
export function cleanAction(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, MAX_ACTION_LENGTH) : '';
}
