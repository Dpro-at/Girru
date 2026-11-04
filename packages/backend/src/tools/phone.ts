/**
 * phone_devices (MOB-PAIR-01): which phones are paired with this computer,
 * for the owner's own agent turns. Read only: names, path, status and last
 * use. No tool pairs, allows or forgets a phone; only the owner does that on
 * the computer (Settings › Phone).
 */
import type { Tool, ToolResult, ToolExecutionContext } from './types.js';
import { toolActor } from '../repositories/actor.js';
import { expiresAt, isExpired, listDevices } from '../phone/store.js';

const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: `Paired phones: ${msg}` }], error: msg });

function ownerOf(context?: ToolExecutionContext): string | { refused: string } {
  if (context?.toolPolicy) return { refused: 'not available when answering someone else' };
  let a;
  try { a = toolActor(context); } catch { return { refused: 'no user for this run' }; }
  if (a.channel) return { refused: 'not available in a channel turn' };
  if (a.role !== 'owner' || !a.userId) return { refused: 'only for the owner' };
  return a.userId;
}

export const phoneDevicesTool: Tool = {
  name: 'phone_devices',
  description: 'List the phones paired with this computer (read only): name, phone type, path (anywhere = through the relay, wifi = local network only), active or expired, when it was last used and when its pairing runs out. Pairing, allowing and removing phones is done only by the owner on the computer (Settings › Phone).',
  input_schema: { type: 'object', properties: {}, required: [] },
  async execute(_params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    const owner = ownerOf(context);
    if (typeof owner !== 'string') return fail(owner.refused);
    const now = Date.now();
    const phones = (await listDevices(owner)).map((d) => {
      const end = expiresAt(d);
      return { name: d.name, model: d.model, path: d.path, status: isExpired(d, now) ? 'expired' : 'active', lastUsedAt: new Date(d.lastUsedAt).toISOString(), expiresAt: end === null ? null : new Date(end).toISOString() };
    });
    const text = phones.length
      ? phones.map((p) => `- ${p.name} (${p.model ?? 'phone'}) · ${p.path} · ${p.status} · last used ${p.lastUsedAt}${p.expiresAt ? ` · runs out ${p.expiresAt}` : ' · never runs out'}`).join('\n')
      : 'No phone is paired.';
    return { content: [{ type: 'text', text }], data: { success: true, phones } } as ToolResult;
  },
};
