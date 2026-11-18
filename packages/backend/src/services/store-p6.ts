/**
 * STORE-MAP-01 P6 switch (ids in files and proven sync). On: every project's
 * dpro-memory calls need a session capability issued by Girru (a folder path
 * never grants anything), company facts reach coding tools only where the
 * owner allowed them, reads are capped and counted, and project files carry
 * hidden ids and a version stamp. On by default; GIRRU_STORE_P6=0 turns it off, and then nothing changes.
 *
 *   GIRRU_STORE_P6=0   turns it off (on by default; services/memory-switches.ts)
 */

import { memorySwitchOn } from './memory-switches.js';

export const STORE_P6_ENV = 'GIRRU_STORE_P6';

export function storeP6Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return memorySwitchOn(STORE_P6_ENV, env);
}
