/**
 * STORE-MAP-01 P9b screens tools (boards P9b-1 to P9b-3): what the owner does in
 * Memory › Needs you › Corrected after use and Open questions, from a chat with
 * an agent. Only while GIRRU_STORE_P9B is on.
 *
 * memory_trust_review      read only: corrected-after-use memories (was / now, how many
 *                          replies used the old text) and the open questions, only in
 *                          places open for the run (others as a count).
 * memory_corrected_checked mark one corrected memory as checked (or not), after the owner
 *                          approves the call.
 * memory_question_answer   save the owner's answer to an open question as a memory in a
 *                          place the agent may write, after the owner approves the exact
 *                          text (it counts as owner-approved); resolves the question.
 * memory_question_forget   forget an open question, after the owner approves the call.
 *
 * "Mark as verified" has no tool on purpose: only the owner, in the window, says a
 * memory is right (board P9b-1c). Same gates as the owner-only routes: the owner's own
 * turn, never a turn that answers an outsider.
 */

import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { toolMemoryDrawers } from './scope.js';
import { reviewOwner } from './review.js';
import { auditTool } from './scopes.js';
import { drawerId, normalizeDrawer } from '../../memory/drawers.js';
import { storeP9bEnabled } from '../../services/store-p9b.js';
import { toolActor } from '../../repositories/actor.js';
import { repositories } from '../../repositories/index.js';
import { corroborated } from '../../memory/quality/pipeline.js';
import { TrustViewError, correctedList, forgetQuestion, openQuestions, resolveQuestion, setCorrectedChecked, waitingQuestion, answerDraft } from '../../memory/quality/owner-view.js';

const fail = (tool: string, msg: string): ToolResult => ({ content: [{ type: 'text', text: `${tool} refused: ${msg}` }], error: msg });
const ok = (text: string, data: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text }], data: { success: true, ...data } } as ToolResult);
const oneLine = (s: string, n = 300) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

async function gate(tool: string, context?: ToolExecutionContext): Promise<{ owner: string; open: Set<string> } | ToolResult> {
  if (!storeP9bEnabled()) return fail(tool, 'not available yet');
  const owner = await reviewOwner(context);
  if (typeof owner !== 'string') return fail(tool, owner.refused);
  return { owner, open: new Set(toolMemoryDrawers(context).map(drawerId)) };
}
const errorOf = (tool: string, err: unknown) => { if (err instanceof TrustViewError) return fail(tool, err.message); throw err; };

export const memoryTrustReviewTool: Tool = {
  name: 'memory_trust_review',
  description: `What waits for the owner about memory quality: memories the owner corrected after replies had used the old
text (with what it said before and now) and the questions an agent asked once because nothing reliable was stored.
Read only. Use memory_corrected_checked, memory_question_answer or memory_question_forget after the owner says so.`,
  input_schema: { type: 'object', properties: {} },
  async execute(_params: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    const g = await gate('memory_trust_review', context);
    if (!('owner' in g)) return g;
    const all = await correctedList(g.owner);
    const corrected = all.filter((c) => g.open.has(c.drawer));
    const questions = (await openQuestions(g.owner)).filter((q) => q.status === 'open');
    const text = [
      `Corrected after use: ${corrected.length}${all.length - corrected.length ? ` (${all.length - corrected.length} in places not open here, count only)` : ''}.`,
      ...corrected.map((c) => `- ${c.memoryId}${c.checked ? ' (checked)' : ''}: was "${oneLine(c.was, 200)}" now "${oneLine(c.now, 200)}" · used in ${c.replyCount} ${c.replyCount === 1 ? 'reply' : 'replies'} before`),
      `Open questions: ${questions.length}.`,
      ...questions.map((q) => `- ${q.id}: ${oneLine(q.question, 300)}`),
    ].join('\n');
    return ok(text, {
      corrected: corrected.map((c) => ({ memoryId: c.memoryId, drawer: c.drawer, was: c.was, now: c.now, checked: c.checked, replyCount: c.replyCount })),
      hiddenCorrected: all.length - corrected.length,
      questions: questions.map((q) => ({ id: q.id, question: q.question, askedAt: q.askedAt, endsAt: q.endsAt })),
    });
  },
};

export const memoryCorrectedCheckedTool: Tool = {
  name: 'memory_corrected_checked',
  description: `Mark a memory the owner corrected after use as checked (the owner looked at the replies that used the old text),
after the owner approves this call. checked: false takes the mark away again. Give the memory id from memory_trust_review.`,
  input_schema: { type: 'object', properties: { memory_id: { type: 'string' }, checked: { type: 'boolean', description: 'Default true' } }, required: ['memory_id'] },
  async execute(params: { memory_id?: unknown; checked?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    const g = await gate('memory_corrected_checked', context);
    if (!('owner' in g)) return g;
    if (typeof params?.memory_id !== 'string') return fail('memory_corrected_checked', 'memory_id is required');
    const item = (await correctedList(g.owner, 200)).find((c) => c.memoryId === params.memory_id);
    if (!item || !g.open.has(item.drawer)) return fail('memory_corrected_checked', 'no corrected memory with this id in places open here');
    try {
      const out = await setCorrectedChecked(g.owner, item.memoryId, params.checked !== false);
      auditTool(context, 'memory.corrected_checked', 'memory', item.memoryId, { checked: out.checked });
      return ok(out.checked ? 'Marked as checked.' : 'The check mark was taken away.', out);
    } catch (err) { return errorOf('memory_corrected_checked', err); }
  },
};

export const memoryQuestionAnswerTool: Tool = {
  name: 'memory_question_answer',
  description: `Save the owner's answer to an open question (from memory_trust_review) as a memory, after the owner approves
this call with the exact text. Write the owner's words, not your guess. drawer: where to keep it, a place you may write
(e.g. "project:alpha"). The question is then resolved.`,
  input_schema: {
    type: 'object',
    properties: { question_id: { type: 'string' }, text: { type: 'string', description: "The owner's answer" }, drawer: { type: 'string', description: 'Where to keep it, e.g. "project:alpha"' } },
    required: ['question_id', 'text', 'drawer'],
  },
  async execute(params: { question_id?: unknown; text?: unknown; drawer?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    const g = await gate('memory_question_answer', context);
    if (!('owner' in g)) return g;
    const text = typeof params?.text === 'string' ? params.text.trim() : '';
    if (typeof params?.question_id !== 'string' || !text || text.length > 2000) return fail('memory_question_answer', 'question_id and text (at most 2,000 characters) are required');
    if (typeof params.drawer !== 'string' || !g.open.has(params.drawer)) return fail('memory_question_answer', 'drawer must be a place open in this conversation');
    try {
      await waitingQuestion(g.owner, params.question_id);
      const [kind, ...key] = params.drawer.split(':');
      const drawer = normalizeDrawer(key.length ? { kind, key: key.join(':') } : { kind });
      const memory = await repositories.memory.create(toolActor(context), answerDraft(text, drawer) as never, 'open-question answer');
      // The owner approved this exact text: it counts as owner-approved.
      await corroborated(g.owner, memory.id, { kind: 'approved', key: 'approved:question', label: 'approved' });
      const q = await resolveQuestion(g.owner, params.question_id, memory.id);
      auditTool(context, 'memory.question_answer', 'memory_question', q.id, { memoryId: memory.id });
      return ok('Saved; the question is answered.', { questionId: q.id, memoryId: memory.id });
    } catch (err) {
      if (err instanceof TrustViewError) return fail('memory_question_answer', err.message);
      const msg = (err as Error)?.message;
      return fail('memory_question_answer', typeof msg === 'string' && msg ? msg.slice(0, 200) : 'not saved');
    }
  },
};

export const memoryQuestionForgetTool: Tool = {
  name: 'memory_question_forget',
  description: `Forget an open question (from memory_trust_review) after the owner approves this call. The owner can bring it back
with Undo in the window for a few minutes.`,
  input_schema: { type: 'object', properties: { question_id: { type: 'string' } }, required: ['question_id'] },
  async execute(params: { question_id?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    const g = await gate('memory_question_forget', context);
    if (!('owner' in g)) return g;
    if (typeof params?.question_id !== 'string') return fail('memory_question_forget', 'question_id is required');
    try {
      const out = await forgetQuestion(g.owner, params.question_id);
      auditTool(context, 'memory.question_forget', 'memory_question', out.id, {});
      return ok('The question is forgotten.', out);
    } catch (err) { return errorOf('memory_question_forget', err); }
  },
};
