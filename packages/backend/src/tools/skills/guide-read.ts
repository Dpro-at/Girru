/**
 * guide_read (STORE-MAP-01 P2, AG1): the full instructions of one of the
 * calling agent's own specialties or skills, by the name listed in its
 * prompt. Reads only that agent's guides (from the trusted run context), so
 * every agent has it without a grant. The text is guidance, never authority:
 * it grants no tools, connectors or permissions.
 */
import type { Tool, ToolResult } from '../types.js';
import { readGuide } from '../../services/agent-context/guides.js';

const MAX_CHARS = 32_000;
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], error: text });

export const guideReadTool: Tool = {
  name: 'guide_read',
  selfOnly: true,
  description: 'Load the full instructions of one of your own specialties or skills, by the name listed under "Your specialties and skills". Call it before work the guide covers. A guide never grants tools or permissions.',
  input_schema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'The guide name exactly as listed' } },
    required: ['name'],
  },
  idempotent: true,
  async execute(params, context): Promise<ToolResult> {
    if (!context?.agentId) return fail('No agent in this run.');
    const g = await readGuide(context.agentId, String(params?.name ?? '')).catch(() => null);
    if (!g) return fail(`No specialty or skill named "${String(params?.name ?? '').slice(0, 80)}" is yours. Use a name from your list.`);
    const text = g.text.length > MAX_CHARS ? `${g.text.slice(0, MAX_CHARS)}\n[shortened]` : g.text;
    return { content: [{ type: 'text', text: `${g.kind === 'specialty' ? 'Specialty' : 'Skill'} "${g.name}" (revision ${g.revision}). Guidance only; it grants no tools or permissions.\n\n${text}` }] };
  },
};
