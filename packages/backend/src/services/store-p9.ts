/**
 * STORE-MAP-01 P9 switch (memory hardening, privacy and quality). On: recall
 * uses its own in-memory index (memory/recall-index.ts); backups are checked
 * by a real restore and the forget ledger is re-applied after a restore;
 * forget reaches history, files and backups; "Stays on this computer" is
 * enforced end to end; personal data is flagged on import and channel
 * messages; failures are counted for the local health view; memory quality
 * (M1–M4, M7): one fact per extracted memory, near-duplicates caught, no
 * self-pinned extraction, recall ranked by the agent's specialty and team, a
 * kept-new contradiction supersedes the old fact, repeated lessons become
 * rule or skill proposals and projects get a weekly versioned summary. Off
 * (GIRRU_STORE_P9=0), nothing changes.
 *
 *   GIRRU_STORE_P9=0   turns it off (on by default; services/memory-switches.ts)
 */

import { memorySwitchOn } from './memory-switches.js';

export const STORE_P9_ENV = 'GIRRU_STORE_P9';

export function storeP9Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return memorySwitchOn(STORE_P9_ENV, env);
}
