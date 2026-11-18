/**
 * STORE-MAP-01 P3 (OPS1, OPS2): why Girru could not start, said once in a
 * form the desktop's start-up page can read.
 *
 *   layout_newer       the data was written by a newer Girru (migrations this
 *                      build does not know): nothing is opened or written
 *   migration_failed   an update step failed; nothing after it ran, the step's
 *                      transaction was rolled back
 *
 * The backend prints one line `GIRRU_START_PROBLEM {json}` on stderr and stops
 * with START_PROBLEM_EXIT. Both are on only while GIRRU_STORE_P3 is on; off,
 * start-up behaves as before (a newer layout is only logged).
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const START_PROBLEM_MARK = 'GIRRU_START_PROBLEM';
export const START_PROBLEM_EXIT = 78;

export type StartProblemKind = 'layout_newer' | 'migration_failed';

export class StartProblem extends Error {
  constructor(readonly kind: StartProblemKind, message: string, readonly details: Record<string, unknown>) { super(message); }
}

/** A short id people can quote when they ask for help, e.g. E-7F3A-21. */
export function newErrorId(): string {
  const h = randomBytes(3).toString('hex').toUpperCase();
  return `E-${h.slice(0, 4)}-${h.slice(4)}`;
}

/** This build's version (package.json of the backend, or GIRRU_APP_VERSION from the desktop). */
export function appVersion(): string {
  if (process.env.GIRRU_APP_VERSION) return process.env.GIRRU_APP_VERSION;
  try { return String(JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).version ?? 'unknown'); } catch { return 'unknown'; }
}

/** Migration ids the data has but this build does not know (sorted). */
export function unknownMigrations(applied: Iterable<string>, known: Iterable<string>): string[] {
  const k = new Set(known);
  return [...new Set(applied)].filter((id) => !k.has(id)).sort();
}

export function newerLayout(unknown: string[], writtenBy: string | null): StartProblem {
  return new StartProblem('layout_newer', `This workspace was last opened by a newer Girru${writtenBy ? ` (${writtenBy})` : ''}. Nothing was opened or changed.`,
    { unknown, writtenBy, thisVersion: appVersion() });
}

/** Prints the marker line for a StartProblem; false for any other error. */
export function reportStartProblem(err: unknown, write: (line: string) => void = (l) => process.stderr.write(l)): boolean {
  if (!(err instanceof StartProblem)) return false;
  write(`${START_PROBLEM_MARK} ${JSON.stringify({ kind: err.kind, message: err.message, ...err.details })}\n`);
  return true;
}

/** The marker from a log line, or null (used by the desktop shell; kept here with the writer). */
export function parseStartProblem(line: string): Record<string, unknown> | null {
  const i = line.indexOf(`${START_PROBLEM_MARK} `);
  if (i < 0) return null;
  try { const v = JSON.parse(line.slice(i + START_PROBLEM_MARK.length + 1)); return v && typeof v === 'object' ? v : null; } catch { return null; }
}
