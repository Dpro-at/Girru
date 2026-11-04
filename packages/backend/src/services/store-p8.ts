/**
 * STORE-MAP-01 P8 switch (task links, handoffs between agents, run notes). On:
 * a handoff carries blockers, files touched and the task (T-n), chat and card
 * it belongs to; a task page reads everything linked to its task in one call;
 * a lead hands a structured note to a specialist; a run keeps short working
 * notes that end as its handoff and suggested lessons. On by default; GIRRU_STORE_P8=0 turns it off, and then
 * nothing changes.
 *
 *   GIRRU_STORE_P8=0   turns it off (on by default; services/memory-switches.ts)
 */

import { memorySwitchOn } from './memory-switches.js';

export const STORE_P8_ENV = 'GIRRU_STORE_P8';

export function storeP8Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return memorySwitchOn(STORE_P8_ENV, env);
}
