import { assertNoDefaultMemoryAccess } from '../encryption/execution-context.js';
/**
 * Lesson extraction (MEM-RSI-01): derive lessons deterministically when a task
 * run reaches a terminal state, and write them as evidence.
 *
 * Deterministic and rule-based: no model, no network. Extraction records what
 * the outcome PROVED. It is idempotent per source (store.ts keys evidence by
 * (lesson, source_kind, source_id)), so the same run extracted twice never
 * inflates support; a run whose terminal signal later reverses retracts its
 * evidence through setSourceDisposition.
 *
 * It only runs when the layer is on (shadow or inject); in 'off' (the default)
 * nothing is extracted, so production behaviour is unchanged until the owner
 * turns the layer on.
 */

import { one, sql } from '../../repositories/sql-steps.js';
import { recordEvidence, rsiTablesExist } from './store.js';
import { rsiMode } from './mode.js';
import { deriveLessonsFromRun, type RunOutcome } from './derive.js';

export { deriveLessonsFromRun, type RunOutcome };

/** Extract and store the lessons a set of run outcomes prove. Returns how many evidence rows changed. */
export async function extractLessons(runs: readonly RunOutcome[]): Promise<number> {
  assertNoDefaultMemoryAccess();
  if (!(await rsiTablesExist())) return 0;
  let changed = 0;
  for (const run of runs) {
    for (const draft of deriveLessonsFromRun(run)) {
      const r = await recordEvidence(run.userId, draft);
      if (r?.changed) changed++;
    }
  }
  return changed;
}

interface RunRow { id: string; user_id: string; status: string; status_reason: string | null }

/**
 * Read one finished run and extract its lessons. Called from the task-run
 * terminal transition (services/task-runs.ts) in the background: a failure is
 * swallowed so it never breaks finishing a run. Does nothing unless the layer
 * is on.
 */
export async function extractLessonsForRun(runId: string): Promise<void> {
  if (rsiMode() === 'off') return;
  if (!(await rsiTablesExist())) return;
  const row = await sql().read(one<RunRow>('SELECT id, user_id, status, status_reason FROM task_runs WHERE id = ?', runId));
  if (!row || !row.user_id) return;
  if (row.status !== 'completed' && row.status !== 'failed' && row.status !== 'cancelled') return;
  await extractLessons([{ id: row.id, userId: row.user_id, status: row.status, statusReason: row.status_reason }]);
}

/**
 * Fire-and-forget hook for the terminal transition. Runs behind a promise
 * chain so extractions never race, and logs (never throws) on failure.
 */
let queue: Promise<unknown> = Promise.resolve();
export function onRunFinished(runId: string): void {
  if (rsiMode() === 'off') return;
  queue = queue.then(() => extractLessonsForRun(runId)).catch((err) => {
    console.warn('[RSI-Lessons] extraction failed:', (err as Error).message);
  });
}

/** Resolves when every queued extraction has finished (tests, shutdown). */
export function rsiExtractionIdle(): Promise<void> {
  return queue.then(() => undefined, () => undefined);
}
