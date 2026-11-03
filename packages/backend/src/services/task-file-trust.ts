/**
 * STORE-MAP-01 P7 (GIRRU_STORE_P7), SEC2-3: tasks that arrive from a project's
 * `.girru/tasks.md` are text written by someone else (a cloned repository, a
 * coding app). An agent may plan such a task, but running tools on it needs
 * the owner's approval the first time per project:
 *
 *   - Continue on a task from the file, before approval: the chat opens in
 *     "Plan first" mode, so every tool that changes something asks the owner.
 *   - A scheduled run of such a task, before approval: it does not start, and
 *     the owner is told.
 *   - Rules never come from the file: the block reaches the prompt only as
 *     data in a fence (task-file.ts continueMessage), never as a rule.
 *
 * Off (the default), nothing changes. Girru's own cards (made from a project
 * chat) are not from the file until the file changes their block.
 */
import { q } from '../repositories/sql-steps.js';
import { storeP7Enabled } from './store-p7.js';
import type { TaskBlock } from './task-file-format.js';

export class TaskTrustError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'invalid_request') { super(message); }
}

/** What the file may change of a task that Girru then counts as "from the file". */
const fileFields = (t: TaskBlock) => JSON.stringify([t.title, t.done, t.left, t.next, t.log, t.workedOn]);

/** The file changed a task's text: from now on the task counts as from the file. */
export async function markFromFile(cardId: string, before: TaskBlock | null, fromFile: TaskBlock): Promise<void> {
  if (before && fileFields(before) === fileFields(fromFile)) return;
  await q.run('UPDATE task_file_cards SET from_file = 1 WHERE card_id = ? AND from_file = 0', cardId).catch(() => undefined);
}

export async function projectApproved(projectId: string): Promise<boolean> {
  return !!(await q.one('SELECT project_id FROM task_file_approvals WHERE project_id = ?', projectId).catch(() => undefined));
}

/**
 * The project whose approval a card's run still needs, or null: P7 is on, the
 * card's task came from the file and the owner has not approved the project.
 */
export async function approvalNeeded(cardId: string): Promise<{ projectId: string; taskNo: string } | null> {
  if (!storeP7Enabled()) return null;
  const link = await q.one<{ project_id: string; task_no: string; from_file: number }>('SELECT project_id, task_no, from_file FROM task_file_cards WHERE card_id = ?', cardId).catch(() => undefined);
  if (!link || Number(link.from_file) !== 1 || await projectApproved(link.project_id)) return null;
  return { projectId: link.project_id, taskNo: link.task_no };
}

async function ownProject(ownerId: string, projectId: unknown): Promise<string> {
  if (!storeP7Enabled()) throw new TaskTrustError('Task file approval needs GIRRU_STORE_P7', 409, 'p7_off');
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(projectId)) throw new TaskTrustError('projectId is required');
  const p = await q.one<{ id: string }>('SELECT id FROM chat_projects WHERE id = ? AND user_id = ?', projectId, ownerId);
  if (!p) throw new TaskTrustError('Not found', 404, 'not_found');
  return p.id;
}

export interface TaskTrust { projectId: string; approved: boolean; approvedAt: string | null; waiting: number }

/** For the owner: is the project approved, and how many open tasks from the file wait for it. */
export async function taskTrust(ownerId: string, projectId: unknown): Promise<TaskTrust> {
  const id = await ownProject(ownerId, projectId);
  const row = await q.one<{ approved_at: string }>('SELECT approved_at FROM task_file_approvals WHERE project_id = ?', id);
  const waiting = row ? 0 : Number((await q.one<{ n: number }>('SELECT COUNT(*) AS n FROM task_file_cards WHERE project_id = ? AND from_file = 1 AND finished = 0', id))?.n ?? 0);
  return { projectId: id, approved: !!row, approvedAt: row?.approved_at ?? null, waiting };
}

/** The owner allows tasks from this project's file to run tools (once per project). */
export async function approveTaskFile(ownerId: string, projectId: unknown, body: unknown): Promise<TaskTrust> {
  const id = await ownProject(ownerId, projectId);
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  if (b.confirm !== true) throw new TaskTrustError('confirm: true is required', 400, 'confirm_required');
  await q.run('INSERT INTO task_file_approvals (project_id, owner_id) VALUES (?, ?) ON CONFLICT (project_id) DO NOTHING', id, ownerId);
  return taskTrust(ownerId, id);
}

/** The owner takes the approval back: tasks from the file are planned only again. */
export async function revokeTaskFile(ownerId: string, projectId: unknown): Promise<TaskTrust> {
  const id = await ownProject(ownerId, projectId);
  await q.run('DELETE FROM task_file_approvals WHERE project_id = ?', id);
  return taskTrust(ownerId, id);
}
