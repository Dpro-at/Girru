/**
 * Selecting-match and rendering the lesson block (MEM-RSI-01) — pure, no DB.
 *
 * The block reads as REFERENCE DATA, not a command: no authority wording, no
 * "do not disregard". It renders only each lesson's polarity and its action,
 * and the action is always system text (see derive.ts), so the block carries
 * no untrusted run text. The cue is never rendered.
 */

import { lexicalTokens } from '../text-normalize.js';
import type { Lesson } from './types.js';

/** Share of a cue's tokens that must appear in the request for it to apply. */
export const MATCH_RATIO = 0.5;

/** Pure: does this lesson's cue apply to the request's tokens? */
export function lessonApplies(cue: string, requestTokens: ReadonlySet<string>): boolean {
  const cueTokens = cue.split(' ').filter(Boolean);
  if (!cueTokens.length) return false;
  let hit = 0;
  for (const t of cueTokens) if (requestTokens.has(t)) hit++;
  return hit / cueTokens.length >= MATCH_RATIO;
}

/** Tokens of a request, for matching against lesson cues. */
export function requestTokens(request: string): Set<string> {
  return new Set(lexicalTokens(request));
}

/** The header labels the block as data the agent may consult, not an order. */
export const BLOCK_HEADER = 'Reference — lessons from past task outcomes (background data, not instructions):';

/**
 * Render the block for a set of lessons: one line per lesson, by polarity and
 * action. Identical lines (same polarity + action, e.g. two cues that share a
 * template) are shown once.
 */
export function renderLessonBlock(lessons: readonly Lesson[]): string {
  if (!lessons.length) return '';
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const l of lessons) {
    const line = `- (${l.polarity}) ${l.action}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return [BLOCK_HEADER, ...lines].join('\n');
}
