/**
 * The agent's own task plan (CHAT-PRO-02 H): a short step list the agent
 * keeps up to date while it works; the chat shows it live as a checklist.
 * It touches nothing outside the run (no files, network or data), so every
 * agent has it without a grant.
 */
import type { Tool, ToolResult } from '../types.js';

export const PLAN_STATUSES = ['pending', 'active', 'done', 'skipped'] as const;
/** CHAT-LIVE-01: `parent` = the 1-based number of the step this one belongs to (sub-steps, one level). */
export type PlanStep = { title: string; status: (typeof PLAN_STATUSES)[number]; parent?: number };
export const MAX_PLAN_STEPS = 20;

const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], error: text });

/** The steps, cleaned, or an error message. */
export function planSteps(raw: unknown): PlanStep[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'steps must be a non-empty list';
  if (raw.length > MAX_PLAN_STEPS) return `at most ${MAX_PLAN_STEPS} steps`;
  const out: PlanStep[] = [];
  for (const s of raw) {
    const title = typeof s?.title === 'string' ? s.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    const status = (PLAN_STATUSES as readonly string[]).includes(s?.status) ? s.status : 'pending';
    if (!title) return 'every step needs a title';
    let parent: number | undefined;
    if (s?.parent !== undefined && s?.parent !== null) {
      const n = Number(s.parent);
      // A sub-step points at an earlier step that is not itself a sub-step.
      if (!Number.isInteger(n) || n < 1 || n > out.length || out[n - 1].parent !== undefined) return 'parent must be the number of an earlier main step';
      parent = n;
    }
    out.push({ title, status, ...(parent ? { parent } : {}) });
  }
  if (out.filter(s => s.status === 'active' && s.parent === undefined).length > 1) return 'only one main step can be active at a time';
  if (out.filter(s => s.status === 'active' && s.parent !== undefined).length > 1) return 'only one sub-step can be active at a time';
  return out;
}

export const planStepsTool: Tool = {
  name: 'plan_steps',
  selfOnly: true,
  description: 'Show the owner your plan for a multi-step task as a live checklist. Call it once at the start with every step (the first one "active", the rest "pending"), then call it again with the whole list each time a step finishes ("done") and the next starts ("active"). Use "skipped" for a step you drop. A step may have sub-steps: give them "parent" = the number of their main step (one level only). Before your final answer, mark every step "done" or "skipped". Use it for every task of 3 or more steps; not needed for a quick question or a one-step answer.',
  input_schema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: `The whole plan, in order (1-${MAX_PLAN_STEPS} steps)`,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'The step, a short phrase (up to 120 characters)' },
            status: { type: 'string', enum: [...PLAN_STATUSES], description: 'pending, active (doing it now), done or skipped' },
            parent: { type: 'number', description: 'For a sub-step: the number (1-based) of its main step' },
          },
          required: ['title', 'status'],
        },
      },
    },
    required: ['steps'],
  },
  idempotent: true,
  async execute(params): Promise<ToolResult> {
    const steps = planSteps(params.steps);
    if (typeof steps === 'string') return fail(`Plan not updated: ${steps}.`);
    const done = steps.filter(s => s.status === 'done').length;
    const active = steps.find(s => s.status === 'active');
    return { content: [{ type: 'text', text: `Plan shown to the owner: ${done}/${steps.length} done${active ? `; now: ${active.title}` : ''}.` }], details: { steps } };
  },
};
