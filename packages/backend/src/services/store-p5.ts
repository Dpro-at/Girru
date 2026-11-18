/**
 * STORE-MAP-01 P5 switch (agent memory and agent packages). On: each agent's
 * MEMORY.md is imported once into its own drawer and read from there, and
 * agent packages can be exported and imported (as untrusted data). Off (GIRRU_STORE_P5=0), nothing changes.
 *
 *   GIRRU_STORE_P5=0   turns it off (on by default; services/memory-switches.ts)
 */

import { memorySwitchOn } from './memory-switches.js';

export const STORE_P5_ENV = 'GIRRU_STORE_P5';

export function storeP5Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return memorySwitchOn(STORE_P5_ENV, env);
}
