/**
 * CP11a: an agent offers to run parts of the work on the owner's other computers. It sends nothing:
 * the chat shows a card (Send · Change… · Keep it here) and only the owner sends, through the same
 * route as Computers › Send a task; the other computer still allows each task there. Self-only, like
 * board_suggest_card, so every agent can offer without a grant.
 */
import type { Tool, ToolResult } from './types.js';

export const OFFER_MAX_STEPS = 6;
export type ComputerOfferStep = { title: string; computer: string; text: string };
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], error: text });
// eslint-disable-next-line no-control-regex
const line = (s: unknown, max: number) => typeof s === 'string' ? s.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
// eslint-disable-next-line no-control-regex
const body = (s: unknown, max: number) => typeof s === 'string' ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, max) : '';

/** The offer, cleaned, or an error message. `computer` is the other computer's name as Computers shows it. */
export function computerOffer(params: Record<string, unknown>): { why: string; steps: ComputerOfferStep[] } | string {
  const raw = params.steps;
  if (!Array.isArray(raw) || !raw.length) return 'steps is required';
  if (raw.length > OFFER_MAX_STEPS) return `at most ${OFFER_MAX_STEPS} steps`;
  const steps: ComputerOfferStep[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') return 'each step needs title, computer and text';
    const step = { title: line((s as any).title, 120), computer: line((s as any).computer, 64), text: body((s as any).text, 8000) };
    if (!step.title || !step.computer || !step.text) return 'each step needs title, computer and text';
    steps.push(step);
  }
  return { why: line(params.why, 300), steps };
}

export const computerOfferTool: Tool = {
  name: 'computer_offer',
  selfOnly: true,
  description: 'Offer the owner to run some steps of the current work on their other computers (from workspace_devices status: free computers that have the project). Nothing is sent by this call: the owner sees a card with Send, Change… and Keep it here, and each computer still allows the task there. Use it when the work splits into independent parts and another computer is free. Then wait for the owner.',
  input_schema: {
    type: 'object',
    properties: {
      why: { type: 'string', description: 'One short sentence, e.g. "Office PC and MacBook Air are free and have the project."' },
      steps: { type: 'array', description: `At most ${OFFER_MAX_STEPS} steps`, items: { type: 'object', properties: {
        title: { type: 'string', description: 'Short step title' },
        computer: { type: 'string', description: 'The other computer’s name, as in Computers' },
        text: { type: 'string', description: 'What that computer should do, complete on its own' },
      }, required: ['title', 'computer', 'text'] } },
    },
    required: ['steps'],
  },
  idempotent: true,
  async execute(params): Promise<ToolResult> {
    const o = computerOffer(params);
    if (typeof o === 'string') return fail(`Not offered: ${o}.`);
    return { content: [{ type: 'text', text: `Offer shown to the owner: ${o.steps.length} step(s) on other computers. Nothing is sent until they press Send; wait for their reply.` }], details: { offer: o } };
  },
};
