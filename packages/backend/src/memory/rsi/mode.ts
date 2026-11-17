/**
 * The lessons layer mode (MEM-RSI-01), from the environment.
 *
 *   GIRRU_RSI_LESSONS=off      (or unset)  nothing is extracted or injected
 *   GIRRU_RSI_LESSONS=shadow               select + LOG what WOULD be injected
 *   GIRRU_RSI_LESSONS=inject                append the lessons to the prompt
 *
 * Off is the default so the feature is dark until the owner turns it on, and
 * shadow is the safe step before inject: it proves what the layer would do
 * without changing any prompt.
 */

import { isMode, type RsiMode } from './types.js';

export const RSI_LESSONS_ENV = 'GIRRU_RSI_LESSONS';

const warned = new Set<string>();

/** The current mode (off by default; an unknown value stays off and is warned once). */
export function rsiMode(env: NodeJS.ProcessEnv = process.env): RsiMode {
  const raw = String(env[RSI_LESSONS_ENV] ?? '').trim().toLowerCase();
  if (!raw) return 'off';
  if (isMode(raw)) return raw;
  if (!warned.has(raw)) {
    warned.add(raw);
    console.warn(`[RSI-Lessons] ${RSI_LESSONS_ENV} has an unknown value "${raw}"; staying off (use off / shadow / inject)`);
  }
  return 'off';
}

export function rsiLessonsOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return rsiMode(env) !== 'off';
}
