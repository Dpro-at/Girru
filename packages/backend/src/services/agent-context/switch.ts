/**
 * STORE-MAP-01 P2 switch. On, every agent uses the one resolved context
 * (chat, task runs, coding apps), loads skills and specialties by name with
 * the full text on demand, gets its owner rules in precedence order, and
 * project files get one Girru section. Off (the default), nothing changes.
 *
 *   GIRRU_STORE_P2=1
 */

export const STORE_P2_ENV = 'GIRRU_STORE_P2';

export function storeP2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env[STORE_P2_ENV] ?? '').trim());
}

/**
 * The one resolved context is used by every entry point: with P2 on, and with
 * P4 on (the personality record and the job text reach chat, task runs and
 * coding apps the same way; D16). Guides by name stay a P2 choice.
 */
export function oneContextEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return storeP2Enabled(env) || /^(1|true|yes|on)$/i.test(String(env.GIRRU_STORE_P4 ?? '').trim());
}

/**
 * STORE-MAP-01 P2 (MD4): what agents save and what they leave out. One text,
 * used by memory_save and by the project brief that coding tools read.
 */
export const SAVE_CRITERIA = 'Save only what will matter later: decisions with their reason, the owner\'s preferences, facts that will be needed again, and lessons with what happened. Do not save drafts, small talk, passing status or anything already written in the project files, and never a secret.';
