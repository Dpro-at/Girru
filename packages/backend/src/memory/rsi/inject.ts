/**
 * Selecting and injecting lessons (MEM-RSI-01).
 *
 * The block is CODE-OWNED: it is built here and appended by the prompt builder
 * itself, so editing an agent's prompt in the UI cannot remove it. It carries
 * only system text (render.ts), never untrusted run text. The three modes
 * decide what happens with the selection:
 *   off     nothing is selected or injected;
 *   shadow  the selection is logged (console + rsi_lesson_usage) as what WOULD
 *           be injected; NOTHING is returned to append;
 *   inject  the selection is logged and returned as the block to append.
 *
 * Selection is deterministic: a lesson applies when its cue's tokens overlap
 * the request's tokens (no model, no network).
 */

import { listLessons, logUsage } from './store.js';
import { rsiMode } from './mode.js';
import { lessonApplies, renderLessonBlock, requestTokens } from './render.js';
import { MAX_INJECTED_LESSONS, type Lesson, type RsiMode } from './types.js';

/** Active lessons scanned per selection (ranked by support first). */
const SCAN = 100;

/** The active lessons that apply to a request, best support first. */
export async function selectLessons(userId: string, request: string, limit = MAX_INJECTED_LESSONS): Promise<Lesson[]> {
  const tokens = requestTokens(request);
  if (!tokens.size) return [];
  const active = await listLessons(userId, { status: 'active', limit: SCAN });
  return active.filter((l) => lessonApplies(l.cue, tokens)).slice(0, Math.max(1, limit));
}

export interface Injection {
  mode: RsiMode;
  /** The lessons selected (empty in off mode). */
  lessons: Lesson[];
  /** The text to append to the prompt — only in inject mode; null otherwise. */
  block: string | null;
  /** True only when something is actually appended (inject mode with matches). */
  injected: boolean;
}

/**
 * Select the lessons that apply to a request and act per the current mode.
 * In shadow and inject the selection is logged to rsi_lesson_usage and to the
 * console; only inject returns a block to append.
 */
export async function buildLessonInjection(userId: string, request: string): Promise<Injection> {
  const mode = rsiMode();
  if (mode === 'off') return { mode, lessons: [], block: null, injected: false };
  const lessons = await selectLessons(userId, request);
  if (lessons.length) {
    for (const l of lessons) await logUsage(userId, l.id, mode, request);
    const what = lessons.map((l) => `${l.polarity}:${l.id}`).join(', ');
    if (mode === 'shadow') console.info(`[RSI-Lessons] shadow: would inject ${lessons.length} lesson(s): ${what}`);
    else console.info(`[RSI-Lessons] inject: appending ${lessons.length} lesson(s): ${what}`);
  }
  if (mode === 'shadow') return { mode, lessons, block: null, injected: false };
  const block = renderLessonBlock(lessons);
  return { mode, lessons, block: block || null, injected: !!block };
}
