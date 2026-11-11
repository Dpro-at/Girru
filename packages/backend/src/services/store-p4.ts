/**
 * STORE-MAP-01 P4 switch (one store per piece). On: the old memory index file
 * is retired after a verified backup, handoff notes are read from one place,
 * the old skill marketplace stops being used, and agents' hired text has one
 * writer. On by default; GIRRU_STORE_P4=0 turns it off, and then nothing changes.
 *
 *   GIRRU_STORE_P4=0   turns it off (on by default; services/memory-switches.ts)
 */

import { memorySwitchOn } from './memory-switches.js';

export const STORE_P4_ENV = 'GIRRU_STORE_P4';

export function storeP4Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return memorySwitchOn(STORE_P4_ENV, env);
}
