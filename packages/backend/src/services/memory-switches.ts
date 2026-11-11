/**
 * STORE-MAP-01 memory switches, on by default since the memory release.
 *
 * Every switch is ON unless its variable turns it off:
 *
 *   GIRRU_STORE_P3=0        (or false / no / off) turns P3 off
 *   GIRRU_STORE_P3=1        (or unset)            keeps it on
 *
 * Any other value keeps the default (on) and is reported once in the log, so a
 * typo never turns memory off silently.
 *
 * OPS9: each switch has a removal date one release after it went on by
 * default. After that date the off path is removed from the code; until then
 * the memory doctor lists a switch someone turned off, and one past its date.
 *
 * GIRRU_STORE_PILOT is not in this list: it names ONE project (and
 * GIRRU_STORE_PILOT_AGENT one agent) and was the pilot that P2 (every agent)
 * and P6 (every project) replaced. With P2 and P6 on it adds nothing; it stays
 * opt-in until its removal date (see PILOT_SWITCH below).
 */

export interface MemorySwitch {
  /** Environment variable. */
  env: string;
  /** Short key shown on the health view and in /api/store-switches. */
  key: string;
  /** What it turns on, in a few words. */
  what: string;
  /** The day it went on by default. */
  onByDefaultSince: string;
  /** OPS9: remove the off path after this date (one release after on by default). */
  removeBy: string;
}

const SINCE = '2026-11-04';
/** One release after the memory release (D-RELEASE-HOLD: one release, then the next). */
const REMOVE_BY = '2027-01-31';

export const MEMORY_SWITCHES: readonly MemorySwitch[] = Object.freeze([
  { env: 'GIRRU_STORE_P2', key: 'p2', what: 'one resolved agent context and one Girru section', onByDefaultSince: SINCE, removeBy: REMOVE_BY },
  { env: 'GIRRU_STORE_P2B', key: 'p2b', what: 'local models: tools on demand and adaptive context', onByDefaultSince: SINCE, removeBy: REMOVE_BY },
  { env: 'GIRRU_STORE_P3', key: 'p3', what: 'departments by id, validity, vectors, project keys', onByDefaultSince: SINCE, removeBy: REMOVE_BY },
  { env: 'GIRRU_STORE_P4', key: 'p4', what: 'one store per piece: personality record, one handoff table', onByDefaultSince: SINCE, removeBy: REMOVE_BY },
  { env: 'GIRRU_STORE_P5', key: 'p5', what: 'agent packages and agent notes', onByDefaultSince: SINCE, removeBy: REMOVE_BY },
  { env: 'GIRRU_STORE_P6', key: 'p6', what: 'session capabilities and proven sync for every project', onByDefaultSince: SINCE, removeBy: REMOVE_BY },
  { env: 'GIRRU_STORE_P7', key: 'p7', what: 'project layout, task-file trust, more coding clients', onByDefaultSince: SINCE, removeBy: REMOVE_BY },
  { env: 'GIRRU_STORE_P8', key: 'p8', what: 'task links', onByDefaultSince: SINCE, removeBy: REMOVE_BY },
  { env: 'GIRRU_STORE_P9', key: 'p9', what: 'memory hardening, privacy and quality', onByDefaultSince: SINCE, removeBy: REMOVE_BY },
  { env: 'GIRRU_STORE_P9B', key: 'p9b', what: 'memory quality engine', onByDefaultSince: SINCE, removeBy: REMOVE_BY },
  { env: 'GIRRU_MEMORY_HELPER', key: 'memoryHelper', what: 'the memory helper (local embedding model) installs itself', onByDefaultSince: SINCE, removeBy: REMOVE_BY },
  { env: 'GIRRU_REPO_TRUST', key: 'repoTrust', what: 'outside projects: someone else\'s repository is kept apart', onByDefaultSince: SINCE, removeBy: REMOVE_BY },
  { env: 'GIRRU_DOC_INDEX', key: 'docIndex', what: 'document memory: project and knowledge files (md, txt, pdf) cited by file and page', onByDefaultSince: SINCE, removeBy: REMOVE_BY },
]);

/** The pilot switch: opt-in (it names a project), superseded by P2 + P6. */
export const PILOT_SWITCH = Object.freeze({ env: 'GIRRU_STORE_PILOT', removeBy: REMOVE_BY });

const OFF = /^(0|false|no|off)$/i;
const ON = /^(1|true|yes|on)$/i;
const warned = new Set<string>();

/** On unless the variable says off (0 / false / no / off). */
export function memorySwitchOn(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env[name] ?? '').trim();
  if (!raw || ON.test(raw)) return true;
  if (OFF.test(raw)) return false;
  if (!warned.has(name)) {
    warned.add(name);
    console.warn(`[Memory] ${name} has an unknown value; it stays on (use 0 to turn it off)`);
  }
  return true;
}

export interface SwitchState extends MemorySwitch {
  on: boolean;
  /** True when today is past the removal date: the off path should be gone. */
  expired: boolean;
}

/** Every switch with its state today, for the memory doctor and support bundles. */
export function memorySwitchStates(env: NodeJS.ProcessEnv = process.env, today: Date = new Date()): SwitchState[] {
  const day = today.toISOString().slice(0, 10);
  return MEMORY_SWITCHES.map((s) => ({ ...s, on: memorySwitchOn(s.env, env), expired: day > s.removeBy }));
}

/** The switches someone turned off, by key (empty when everything is on). */
export function memorySwitchesOff(env: NodeJS.ProcessEnv = process.env): string[] {
  return MEMORY_SWITCHES.filter((s) => !memorySwitchOn(s.env, env)).map((s) => s.key);
}
