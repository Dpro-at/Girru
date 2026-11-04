/**
 * STORE-MAP-01 P6 switch (ids in files and proven sync). On: every project's
 * dpro-memory calls need a session capability issued by Girru (a folder path
 * never grants anything), company facts reach coding tools only where the
 * owner allowed them, reads are capped and counted, and project files carry
 * hidden ids and a version stamp. Off (the default), nothing changes.
 *
 *   GIRRU_STORE_P6=1
 */

export const STORE_P6_ENV = 'GIRRU_STORE_P6';

export function storeP6Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env[STORE_P6_ENV] ?? '').trim());
}
