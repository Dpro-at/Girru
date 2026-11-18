/**
 * REPO-TRUST-01 switch (outside projects). On: a project whose folder is
 * someone else's git repository goes on the Outside projects list and the
 * guards treat it as someone else's (memory/project-trust.ts). Off: every
 * project counts as the owner's own, as before.
 *
 *   GIRRU_REPO_TRUST=0   turns it off (on by default; services/memory-switches.ts)
 */

import { memorySwitchOn } from './memory-switches.js';

export const REPO_TRUST_ENV = 'GIRRU_REPO_TRUST';

export function repoTrustEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return memorySwitchOn(REPO_TRUST_ENV, env);
}
