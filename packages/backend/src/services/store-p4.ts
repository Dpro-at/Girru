/**
 * STORE-MAP-01 P4 switch (one store per piece). On: the old memory index file
 * is retired after a verified backup, handoff notes are read from one place,
 * the old skill marketplace stops being used, and agents' hired text has one
 * writer. Off (the default), nothing changes.
 *
 *   GIRRU_STORE_P4=1
 */

export const STORE_P4_ENV = 'GIRRU_STORE_P4';

export function storeP4Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env[STORE_P4_ENV] ?? '').trim());
}
