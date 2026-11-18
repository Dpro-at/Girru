/**
 * CHAT-LIVE-01 (LW2): the agent asks the owner to choose. The chat shows the
 * question with one button per answer; the owner's click comes back as the
 * next message. It changes nothing, so every agent has it without a grant
 * (self-only, like plan_steps). The reply ends here: the agent waits.
 */
import type { Tool, ToolResult } from '../types.js';

export const CHOICE_TOOL = 'ask_choice';
export const MAX_CHOICES = 5;
export type Choice = { question: string; options: string[]; reasons?: string[]; multiple: boolean; suggested?: number };

const clean = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
// Never a way to ask for secrets: those stay in Settings.
const SECRET_ASK = /\b(password|passcode|api[ _-]?key|secret|token|card number|cvv|iban|pin code)\b/i;

/** The question, cleaned, or an error message. */
export function choiceOf(raw: Record<string, unknown> | undefined): Choice | string {
  const question = clean(raw?.question, 300);
  if (!question) return 'question is required';
  if (!Array.isArray(raw?.options)) return 'options must be a list of 2 to 5 answers';
  // CHAT-CONTENT-01: an answer is a short text, or { label, reason } with a one-line reason under it.
  const items = (raw!.options as unknown[]).map(o => o && typeof o === 'object' ? { label: clean((o as { label?: unknown }).label, 80), reason: clean((o as { reason?: unknown }).reason, 140) } : { label: clean(o, 80), reason: '' }).filter(x => x.label);
  const seen = new Set<string>(); const unique = items.filter(x => !seen.has(x.label) && (seen.add(x.label), true));
  const options = unique.map(x => x.label);
  const given = Array.isArray(raw?.reasons) ? (raw!.reasons as unknown[]).map(r => clean(r, 140)) : [];
  const reasons = unique.map((x, i) => x.reason || given[items.indexOf(x)] || given[i] || '');
  if (options.length < 2 || options.length > MAX_CHOICES) return 'give 2 to 5 different answers';
  if (SECRET_ASK.test(question) || options.some(o => SECRET_ASK.test(o)) || reasons.some(r => SECRET_ASK.test(r))) return 'never ask for passwords, keys or payment details in a choice; the owner adds those in Settings';
  const n = raw?.suggested === undefined || raw?.suggested === null ? undefined : Number(raw.suggested);
  const suggested = n !== undefined && Number.isInteger(n) && n >= 1 && n <= options.length ? n : undefined;
  return { question, options, ...(reasons.some(Boolean) ? { reasons } : {}), multiple: raw?.multiple === true, ...(suggested ? { suggested } : {}) };
}

export const askChoiceTool: Tool = {
  name: CHOICE_TOOL,
  selfOnly: true,
  description: 'Ask the owner to decide, with buttons. Use it only when the decision is really theirs (taste, money, people, what to keep) and the chat, memory and files do not already answer it; decide routine things yourself. One question, 2 to 5 short answers with an optional one-line reason for each (reasons, same order), your own pick as "suggested" (its number) when you have one; multiple=true when several answers may be picked. Never for passwords, keys or payment details. After calling it, end your reply with one short line; the owner\'s answer comes as the next message.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question, one sentence' },
      options: { type: 'array', items: { type: 'string' }, description: '2 to 5 short answers' },
      reasons: { type: 'array', items: { type: 'string' }, description: 'Optional: one short reason per answer, in the same order (shown under it)' },
      suggested: { type: 'number', description: 'The number (1-based) of the answer you suggest' },
      multiple: { type: 'boolean', description: 'true when several answers may be picked' },
    },
    required: ['question', 'options'],
  },
  idempotent: true,
  async execute(params): Promise<ToolResult> {
    const choice = choiceOf(params);
    if (typeof choice === 'string') return { content: [{ type: 'text', text: `Not asked: ${choice}.` }], error: choice };
    return {
      content: [{ type: 'text', text: `The owner now sees the question "${choice.question}" with buttons. Stop here: end your reply with one short line, and continue when their answer arrives as the next message.` }],
      details: { status: 'waiting_choice', choice },
    };
  },
};
