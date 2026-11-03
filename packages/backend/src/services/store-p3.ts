/**
 * STORE-MAP-01 P3 switch (foundations). On, the one list of departments is
 * the authority (agents, projects, boards, rules, specialties, hire items and
 * meeting decisions follow a rename or merge), and the start-up backfill fills
 * the new id columns. Off (the default), nothing reads or writes them; the
 * migrations only add tables and columns.
 *
 *   GIRRU_STORE_P3=1
 */

export const STORE_P3_ENV = 'GIRRU_STORE_P3';

export function storeP3Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env[STORE_P3_ENV] ?? '').trim());
}

/** The table that holds project departments: the one list while P3 is on. */
export function departmentTable(): 'departments' | 'memory_departments' {
  return storeP3Enabled() ? 'departments' : 'memory_departments';
}
