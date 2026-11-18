/**
 * STORE-MAP-01 P8 (D27): run_note, a short working note for the run the agent is
 * in now (a chat reply, a board task run or a part a lead handed over). The note
 * stays with the run, never becomes memory by itself, and is cleared 14 days
 * later; at the run's end lines starting "Done:", "Left:", "Next:", "Blocked:",
 * "File:" become its handoff and "Lesson:" lines go to the owner as suggestions.
 * Self-only; registered only while GIRRU_STORE_P8 is on and only for models that
 * are not on this computer (LOCAL-ONLY-01). Never in a channel turn.
 */
import type { Tool, ToolExecutionContext, ToolResult } from '../types.js';
import { appendRunNote, MAX_NOTE_CHARS, RunNoteError, type RunKind } from '../../memory/handoff/run-notes.js';
import { cardOfConversation, cardOfTask } from '../../memory/handoff/links.js';
import { taskRunOwner } from '../../memory/handoff/scope.js';
import { currentChatRun } from '../../services/chat-run-context.js';
import { one, sql } from '../../repositories/sql-steps.js';

const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], error: text });

/** The run this call belongs to, from trusted context only; or an error text. */
async function runOf(context: ToolExecutionContext | undefined): Promise<{ ownerId: string; runKind: RunKind; runId: string; agentId: string; cardId: string | null } | string> {
  if (!context || context.toolPolicy || !context.agentId) return 'working notes are kept only inside a run';
  if (context.delegation && context.userId) {
    return { ownerId: context.userId, runKind: 'delegation', runId: context.delegation.runId, agentId: context.agentId, cardId: context.delegation.cardId };
  }
  if (context.taskId && context.taskRun) {
    const row = await sql().read(one<{ task_id: string; agent_id: string; user_id: string | null }>('SELECT task_id, agent_id, user_id FROM task_runs WHERE id = ?', context.taskRun.runId));
    if (!row || row.task_id !== context.taskId || row.agent_id !== context.agentId) return 'this task run is unknown';
    const ownerId = await taskRunOwner(row.user_id);
    if (!ownerId) return 'this task run has no owner';
    return { ownerId, runKind: 'task', runId: context.taskRun.runId, agentId: context.agentId, cardId: (await cardOfTask(ownerId, row.task_id))?.id ?? null };
  }
  const run = currentChatRun();
  if (context.chatPlan === true && context.userId && context.sessionId && run?.runId) {
    return { ownerId: context.userId, runKind: 'chat', runId: run.runId, agentId: context.agentId, cardId: (await cardOfConversation(context.userId, context.sessionId))?.id ?? null };
  }
  return 'working notes are kept only inside a run';
}

export const runNoteTool: Tool = {
  name: 'run_note',
  selfOnly: true,
  description: 'Keep a short working note for this run (read only for the owner, cleared after 14 days, never memory by itself). Start a line with "Done:", "Left:", "Next:", "Blocked:" or "File:" and it goes into this run\'s handoff when you write none; "Lesson:" suggests a lasting lesson the owner reviews. Never put keys, passwords or tokens in it.',
  input_schema: { type: 'object', properties: { text: { type: 'string', description: `The note (one line, at most ${MAX_NOTE_CHARS} characters)` } }, required: ['text'] },
  async execute(params, context): Promise<ToolResult> {
    const where = await runOf(context);
    if (typeof where === 'string') return fail(`Note not kept: ${where}.`);
    try {
      const seq = await appendRunNote(where, params.text);
      return { content: [{ type: 'text', text: `Note ${seq} kept with this run.` }], details: { seq } };
    } catch (err) {
      if (err instanceof RunNoteError) return fail(`Note not kept: ${err.message}.`);
      throw err;
    }
  },
};
