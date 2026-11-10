/**
 * CP9c: the picture and the name the owner gives each computer, on this computer only.
 * One value per person in `user_prefs`; the page and the MCP tool use the same route.
 */
import type { FastifyInstance } from 'fastify';
import { actorOf } from '../../auth/auth-gate.js';
import { actorOrReply, requireAccount } from '../../repositories/scope.js';
import { getPref, setPref } from '../../repositories/user-prefs.js';

export const COMPUTER_ICON_KEYS = ['macbook', 'imac', 'mac-mini', 'mac-studio', 'windows-laptop', 'windows-pc', 'linux', 'other'] as const;
/** notices: CP11c “From my other computers” system notices (on unless turned off). */
export interface ComputerLook { icons: Record<string, string>; names: Record<string, string>; notices: boolean }
const ID = { test: (x: string) => /^[A-Za-z0-9_-]{1,128}$/.test(x) && !['__proto__', 'constructor', 'prototype'].includes(x) };
const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
/** A saved value made whole: bad entries dropped, at most 64 computers. */
export function computerLook(x: unknown): ComputerLook {
  const v = record(x) ? x : {};
  const pick = (o: unknown, ok: (s: unknown) => boolean) => Object.fromEntries(Object.entries(record(o) ? o : {}).filter(([k, s]) => ID.test(k) && ok(s)).slice(0, 64)) as Record<string, string>;
  return { icons: pick(v.icons, s => (COMPUTER_ICON_KEYS as readonly unknown[]).includes(s)), names: pick(v.names, s => typeof s === 'string' && validName(s)), notices: v.notices !== false };
}
const validName = (s: string) => s.trim().length > 0 && s.length <= 64 && !/[\x00-\x1f\x7f]/.test(s);
/** One change: a known computer id and a known picture and/or a plain name ('' clears the name). */
export function computerLookChangeOk(x: unknown): x is { deviceId?: string; icon?: string; name?: string; notices?: boolean } {
  if (record(x) && Object.keys(x).length === 1 && typeof x.notices === 'boolean') return true;
  if (!record(x) || !Object.keys(x).every(k => ['deviceId', 'icon', 'name'].includes(k)) || typeof x.deviceId !== 'string' || !ID.test(x.deviceId)) return false;
  if (!('icon' in x) && !('name' in x)) return false;
  if ('icon' in x && !(COMPUTER_ICON_KEYS as readonly unknown[]).includes(x.icon)) return false;
  return !('name' in x) || typeof x.name === 'string' && (x.name === '' || validName(x.name));
}

/** One computer's picture and/or name applied and made whole; null when the list is full and the change would be dropped. */
export function applyComputerLookChange(look: ComputerLook, change: { deviceId?: string; icon?: string; name?: string }): ComputerLook | null {
  const id = change.deviceId;
  if (typeof id !== 'string' || !ID.test(id)) return null;
  // Edited as Maps: a request-chosen id is a map key, never a property name on a live object.
  const icons = new Map(Object.entries(look.icons)), names = new Map(Object.entries(look.names));
  if (change.icon !== undefined) icons.set(id, change.icon);
  if (change.name !== undefined) { if (change.name) names.set(id, change.name.trim()); else names.delete(id); }
  const saved = computerLook({ icons: Object.fromEntries(icons), names: Object.fromEntries(names), notices: look.notices });
  if (change.icon !== undefined && !Object.hasOwn(saved.icons, id) || change.name && !Object.hasOwn(saved.names, id)) return null;
  return saved;
}

export async function computerLookRoutes(fastify: FastifyInstance) {
  fastify.get('/api/computers/look', async (request, reply) => {
    const actor = actorOrReply(reply, actorOf(request), requireAccount);
    if (!actor) return reply;
    if (!actor.userId) return reply.code(403).send({ error: 'A signed-in account is required', code: 'forbidden' });
    return computerLook(await getPref(actor.userId, 'computer-look'));
  });
  fastify.post<{ Body: unknown }>('/api/computers/look', async (request, reply) => {
    const actor = actorOrReply(reply, actorOf(request), requireAccount);
    if (!actor) return reply;
    if (!actor.userId) return reply.code(403).send({ error: 'A signed-in account is required', code: 'forbidden' });
    if (!computerLookChangeOk(request.body)) return reply.code(400).send({ error: 'Unknown computer look', code: 'invalid' });
    const b = request.body, look = computerLook(await getPref(actor.userId, 'computer-look'));
    if (b.notices !== undefined) { look.notices = b.notices; await setPref(actor.userId, 'computer-look', look); return look; }
    const saved = applyComputerLookChange(look, b);
    if (!saved) return reply.code(409).send({ error: 'Too many computers', code: 'invalid' });
    await setPref(actor.userId, 'computer-look', saved);
    return saved;
  });
}
