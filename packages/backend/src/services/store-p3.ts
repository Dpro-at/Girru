/**
 * STORE-MAP-01 P3 switch (foundations). On, the one list of departments is
 * the authority (agents, projects, boards, rules, specialties, hire items and
 * meeting decisions follow a rename or merge), and the start-up backfill fills
 * the new id columns. On by default; GIRRU_STORE_P3=0 turns it off, and then nothing reads or writes them; the
 * migrations only add tables and columns.
 *
 *   GIRRU_STORE_P3=0   turns it off (on by default; services/memory-switches.ts)
 */

import { memorySwitchOn } from './memory-switches.js';

export const STORE_P3_ENV = 'GIRRU_STORE_P3';

export function storeP3Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return memorySwitchOn(STORE_P3_ENV, env);
}

/** The table that holds project departments: the one list while P3 is on. */
export function departmentTable(): 'departments' | 'memory_departments' {
  return storeP3Enabled() ? 'departments' : 'memory_departments';
}
