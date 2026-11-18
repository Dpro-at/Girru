/**
 * STORE-MAP-01 P7 switch (project setup and coding tools). On: every file Girru
 * writes into a project folder goes through the one safe file writer
 * (services/safe-file.ts, SEC2-6). On by default; GIRRU_STORE_P7=0 turns it off, and then nothing changes.
 *
 *   GIRRU_STORE_P7=0   turns it off (on by default; services/memory-switches.ts)
 */

import { memorySwitchOn } from './memory-switches.js';

export const STORE_P7_ENV = 'GIRRU_STORE_P7';

export function storeP7Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return memorySwitchOn(STORE_P7_ENV, env);
}
