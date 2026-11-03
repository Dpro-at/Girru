/**
 * STORE-MAP-01 P9 switch (memory hardening, privacy and quality). On: recall
 * uses its own in-memory index (memory/recall-index.ts); backups are checked
 * by a real restore and the forget ledger is re-applied after a restore;
 * forget reaches history, files and backups; "Stays on this computer" is
 * enforced end to end; personal data is flagged on import and channel
 * messages; failures are counted for the local health view. Off (the
 * default), nothing changes.
 *
 *   GIRRU_STORE_P9=1
 */

export const STORE_P9_ENV = 'GIRRU_STORE_P9';

export function storeP9Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env[STORE_P9_ENV] ?? '').trim());
}
