/**
 * MODELS-01-INSTALL switch. On: Girru makes sure the memory helper (the local
 * runtime plus the embedding model) is ready, in the background, after
 * start-up; it never blocks start-up or setup (OPS3), talks to 127.0.0.1
 * only, re-embeds rows saved with the offline hash model afterwards, and the
 * memory health view shows a "Memory helper" row (memory/helper.ts). Off (GIRRU_MEMORY_HELPER=0), nothing changes: the embedding model is used only when it is
 * already installed, otherwise the hash fallback.
 *
 *   GIRRU_MEMORY_HELPER=0   turns it off (on by default; services/memory-switches.ts)
 */

import { memorySwitchOn } from './memory-switches.js';

export const MEMORY_HELPER_ENV = 'GIRRU_MEMORY_HELPER';

export function memoryHelperEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return memorySwitchOn(MEMORY_HELPER_ENV, env);
}
