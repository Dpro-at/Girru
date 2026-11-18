/**
 * memory_lessons tool (MEM-RSI-01): read the owner's evidence-gated lessons.
 *
 *   op 'list'     active lessons (optional polarity; status 'active' |
 *                 'retired' | 'all')
 *   op 'lesson'   one lesson (by `id`): its evidence rows and how often it was
 *                 selected for a prompt
 *   op 'preview'  the lessons that WOULD be selected for `query`, and the
 *                 current mode — changes nothing, injects nothing
 *   op 'mode'     the current mode (off / shadow / inject)
 *
 * memory_lessons_review (approval-gated): the owner corrects a source's
 * disposition — 'reverse' retracts its evidence (a lesson retires when support
 * reaches zero), 'confirm' restores it, 'forget' removes it. The owner's
 * approval of the call is the explicit confirm.
 *
 * Same gates as the memory graph tool: read-only, the run user must be the
 * owner account, never in a turn that answers an outsider.
 */

import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { toolMemoryUser, toolOwnerTurn } from './scope.js';
import { one, sql } from '../../repositories/sql-steps.js';
import {
  buildLessonInjection,
  forgetSource,
  getLesson,
  listEvidence,
  listLessons,
  rsiMode,
  selectLessons,
  setSourceDisposition,
  usageCount,
  type Polarity,
} from '../../memory/rsi/index.js';

const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: `Memory lessons: ${msg}` }], error: msg });
const OPS = ['list', 'lesson', 'preview', 'mode'] as const;

async function isOwnerAccount(userId: string): Promise<boolean> {
  const row = await sql().read(one<{ role: string }>('SELECT role FROM users WHERE id = ?', userId));
  return row?.role === 'owner';
}

function ownerGate(context?: ToolExecutionContext): { userId: string } | ToolResult {
  const userId = toolMemoryUser(context);
  if (!userId) return fail('no user for this memory');
  if (!toolOwnerTurn(context)) return fail("only in the owner's own turn, not in a board task run");
  if (context?.toolPolicy) return fail('not available when answering someone else');
  return { userId };
}

export const memoryLessonsTool: Tool = {
  name: 'memory_lessons',
  description: `Read the owner's evidence-gated lessons: what closed tasks proved, kept only while real evidence supports it (positive = repeat this, negative = do not repeat without a new approach, caution = recheck first). Lessons retire by themselves when their evidence is gone.

Ops:
- list: active lessons (optional polarity = positive|negative|caution; status = active|retired|all)
- lesson: one lesson by id, with its evidence rows and how often it was used
- preview: the lessons that WOULD apply to "query", and the current mode (changes and injects nothing)
- mode: the current mode (off / shadow / inject)

Read-only. The owner only.`,
  input_schema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: [...OPS], description: 'What to read' },
      id: { type: 'string', description: 'lesson: the lesson id' },
      polarity: { type: 'string', enum: ['positive', 'negative', 'caution'], description: 'list: polarity filter' },
      status: { type: 'string', enum: ['active', 'retired', 'all'], description: 'list: which lessons (default active)' },
      query: { type: 'string', description: 'preview: the request to test selection against' },
      limit: { type: 'number', minimum: 1, maximum: 50, description: 'Maximum items (default 20)' },
    },
    required: ['op'],
  },

  async execute(params: Record<string, any>, context?: ToolExecutionContext): Promise<ToolResult> {
    const gate = ownerGate(context);
    if ('content' in gate) return gate;
    const userId = gate.userId;
    if (!(await isOwnerAccount(userId))) return fail('lessons are for the owner only');
    const op = params?.op;
    if (!OPS.includes(op)) return fail(`op must be one of ${OPS.join(', ')}`);
    const limit = typeof params.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(params.limit))) : 20;

    if (op === 'mode') {
      const mode = rsiMode();
      return { content: [{ type: 'text', text: `Lessons mode: ${mode}.` }], data: { success: true, mode } } as ToolResult;
    }

    if (op === 'list') {
      const lessons = await listLessons(userId, { polarity: params.polarity as Polarity, status: params.status, limit });
      const text = lessons.length
        ? lessons.map((l, i) => `${i + 1}. (${l.polarity}, ${l.status}, support ${l.support}) ${l.action} [id ${l.id}]`).join('\n')
        : 'No lessons.';
      return { content: [{ type: 'text', text }], data: { success: true, lessons } } as ToolResult;
    }

    if (op === 'lesson') {
      const lesson = typeof params.id === 'string' ? await getLesson(userId, params.id) : null;
      if (!lesson) return fail('lesson not found');
      const evidence = await listEvidence(userId, lesson.id);
      const used = await usageCount(userId, lesson.id);
      const text = [
        `(${lesson.polarity}, ${lesson.status}, support ${lesson.support}) ${lesson.action}`,
        `Cue: ${lesson.cue}`,
        `Evidence (${evidence.length}):`,
        ...evidence.map((e) => `- ${e.disposition} from ${e.sourceKind} ${e.sourceId}`),
        `Selected for a prompt ${used} time(s).`,
      ].join('\n');
      return { content: [{ type: 'text', text }], data: { success: true, lesson, evidence, usage: used } } as ToolResult;
    }

    // op 'preview'
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    if (!query) return fail('query is required');
    const lessons = await selectLessons(userId, query, limit);
    const mode = rsiMode();
    const text = lessons.length
      ? [`Mode ${mode}. ${lessons.length} lesson(s) would apply:`, ...lessons.map((l) => `- (${l.polarity}) ${l.action}`)].join('\n')
      : `Mode ${mode}. No lessons apply to this request.`;
    return { content: [{ type: 'text', text }], data: { success: true, mode, lessons } } as ToolResult;
  },
};

export const memoryLessonsReviewTool: Tool = {
  name: 'memory_lessons_review',
  description: `Correct the evidence a lesson stands on, after the owner approves this call.
action "reverse" (source_kind, source_id): the finding from that source was wrong — retract its evidence from every lesson it supports; a lesson retires when its support reaches zero.
action "confirm" (source_kind, source_id): restore a reversed source's evidence; a retired lesson comes back if support climbs above zero.
action "forget" (source_kind, source_id): remove that source's evidence entirely; a lesson left with no evidence is deleted.`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['reverse', 'confirm', 'forget'] },
      source_kind: { type: 'string', description: 'The evidence source kind (e.g. task_run)' },
      source_id: { type: 'string', description: 'The evidence source id' },
    },
    required: ['action', 'source_kind', 'source_id'],
  },
  async execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    const gate = ownerGate(context);
    if ('content' in gate) return gate;
    const userId = gate.userId;
    if (!(await isOwnerAccount(userId))) return fail('lessons are for the owner only');
    const kind = typeof params.source_kind === 'string' ? params.source_kind : '';
    const id = typeof params.source_id === 'string' ? params.source_id : '';
    if (!kind || !id) return fail('source_kind and source_id are required');
    // The owner's approval of this call is the explicit confirm.
    if (params.action === 'reverse') {
      const touched = await setSourceDisposition(userId, kind, id, 'reversed');
      return { content: [{ type: 'text', text: `Evidence retracted; ${touched.length} lesson(s) recomputed.` }], data: { success: true, lessons: touched } } as ToolResult;
    }
    if (params.action === 'confirm') {
      const touched = await setSourceDisposition(userId, kind, id, 'confirmed');
      return { content: [{ type: 'text', text: `Evidence restored; ${touched.length} lesson(s) recomputed.` }], data: { success: true, lessons: touched } } as ToolResult;
    }
    if (params.action === 'forget') {
      const touched = await forgetSource(userId, kind, id);
      return { content: [{ type: 'text', text: `Evidence removed; ${touched.length} lesson(s) recomputed.` }], data: { success: true, lessons: touched } } as ToolResult;
    }
    return fail('action must be reverse, confirm or forget');
  },
};
