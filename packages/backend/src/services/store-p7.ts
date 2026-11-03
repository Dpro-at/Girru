/**
 * STORE-MAP-01 P7 switch (project setup and coding tools). On: every file Girru
 * writes into a project folder goes through the one safe file writer
 * (services/safe-file.ts, SEC2-6). Off (the default), nothing changes.
 *
 *   GIRRU_STORE_P7=1
 */

export const STORE_P7_ENV = 'GIRRU_STORE_P7';

export function storeP7Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env[STORE_P7_ENV] ?? '').trim());
}
