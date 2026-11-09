/**
 * CP9c: the picture and the name the owner gives each computer, on this computer only.
 * One value per person in `user_prefs`; the page and the MCP tool use the same route.
 */
import type { FastifyInstance } from 'fastify';
import { actorOf } from '../../auth/auth-gate.js';
import { actorOrReply, requireAccount } from '../../repositories/scope.js';
import { getPref, setPref } from '../../repositories/user-prefs.js';

export const COMPUTER_ICON_KEYS = ['macbook', 'imac', 'mac-mini', 'mac-studio', 'windows-laptop', 'windows-pc', 'linux', 'other'] as const;
export interface ComputerLook { icons: Record<string, string>; names: Record<string, string> }
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
/** A saved value made whole: bad entries dropped, at most 64 computers. */
export function computerLook(x: unknown): ComputerLook {
  const v = record(x) ? x : {};
  const pick = (o: unknown, ok: (s: unknown) => boolean) => Object.fromEntries(Object.entries(record(o) ? o : {}).filter(([k, s]) => ID.test(k) && ok(s)).slice(0, 64)) as Record<string, string>;
  return { icons: pick(v.icons, s => (COMPUTER_ICON_KEYS as readonly unknown[]).includes(s)), names: pick(v.names, s => typeof s === 'string' && validName(s)) };
}
const validName = (s: string) => s.trim().length > 0 && s.length <= 64 && !/[\x00-\x1f\x7f]/.test(s);
/** One change: a known computer id and a known picture and/or a plain name ('' clears the name). */
export function computerLookChangeOk(x: unknown): x is { deviceId: string; icon?: string; name?: string } {
  if (!record(x) || !Object.keys(x).every(k => ['deviceId', 'icon', 'name'].includes(k)) || typeof x.deviceId !== 'string' || !ID.test(x.deviceId)) return false;
  if (!('icon' in x) && !('name' in x)) return false;
  if ('icon' in x && !(COMPUTER_ICON_KEYS as readonly unknown[]).includes(x.icon)) return false;
  return !('name' in x) || typeof x.name === 'string' && (x.name === '' || validName(x.name));
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
    if (b.icon !== undefined) look.icons[b.deviceId] = b.icon;
    if (b.name !== undefined) { if (b.name) look.names[b.deviceId] = b.name.trim(); else delete look.names[b.deviceId]; }
    const saved = computerLook(look);
    if (!(b.deviceId in saved.icons) && b.icon !== undefined || b.name && !(b.deviceId in saved.names)) return reply.code(409).send({ error: 'Too many computers', code: 'invalid' });
    await setPref(actor.userId, 'computer-look', saved);
    return saved;
  });
}
