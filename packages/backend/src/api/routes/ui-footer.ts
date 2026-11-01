/**
 * Footer choices (SH3): which sections the window's footer shows, their
 * order, icons only, and whether Approvals comes back when something waits.
 * One value per person in `user_prefs`; the page and the MCP tool use the
 * same route. Settings is never a section here, so it cannot be hidden.
 */
import type { FastifyInstance } from 'fastify';
import { actorOf } from '../../auth/auth-gate.js';
import { actorOrReply, requireAccount } from '../../repositories/scope.js';
import { getPref, setPref } from '../../repositories/user-prefs.js';

// Library (Personalities, Specialties, Skills) shows by default; MCP connections live in Settings, not in the footer.
export const FOOTER_SECTIONS = ['chat', 'agents', 'library', 'board', 'memory', 'approvals', 'store', 'genvr', 'terminal', 'code', 'browser', 'skills', 'personalities', 'specialties'] as const;
type Section = typeof FOOTER_SECTIONS[number];
export interface FooterPrefs { order: Section[]; hidden: Section[]; iconsOnly: boolean; approvalsWhenWaiting: boolean }
const DEFAULT_HIDDEN: Section[] = ['genvr', 'terminal', 'code', 'browser', 'skills', 'personalities', 'specialties'];
const ADDED_AFTER: Partial<Record<Section, Section>> = { library: 'agents' };
/** SA6: Apps became Store › My apps; an older saved order keeps the Store where Apps was. */
const renamed = (id: unknown) => id === 'apps' ? 'store' : id;
const KEYS = ['order', 'hidden', 'iconsOnly', 'approvalsWhenWaiting'];
const known = (v: unknown): v is Section => typeof v === 'string' && (FOOTER_SECTIONS as readonly string[]).includes(v);
const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const ids = (x: unknown) => Array.isArray(x) && x.length <= FOOTER_SECTIONS.length && x.every(known) && new Set(x).size === x.length;

/** A change the route accepts: known keys only, known sections, no repeats. */
export function footerChangeOk(x: unknown): x is Partial<FooterPrefs> {
  if (!record(x) || !Object.keys(x).length || !Object.keys(x).every(k => KEYS.includes(k))) return false;
  if ('order' in x && !ids(x.order)) return false;
  if ('hidden' in x && !ids(x.hidden)) return false;
  return ['iconsOnly', 'approvalsWhenWaiting'].every(k => !(k in x) || typeof x[k] === 'boolean');
}

/** Any saved value made whole: unknown ids dropped, a new section appears in its usual place. */
export function footerPrefs(x: unknown): FooterPrefs {
  const v = record(x) ? x : {};
  const listed = Array.isArray(v.order) ? v.order.map(renamed).filter((id, i, all): id is Section => known(id) && all.indexOf(id) === i) : [];
  const order = [...listed, ...FOOTER_SECTIONS.filter(id => !listed.includes(id))];
  // A section added later lands next to its neighbour in an older saved order (Library after Agents).
  for (const [id, after] of Object.entries(ADDED_AFTER) as [Section, Section][]) if (!listed.includes(id) && listed.includes(after)) { order.splice(order.indexOf(id), 1); order.splice(order.indexOf(after) + 1, 0, id); }
  const hidden = Array.isArray(v.hidden) ? FOOTER_SECTIONS.filter(id => (v.hidden as unknown[]).includes(id)) : [...DEFAULT_HIDDEN];
  return { order, hidden, iconsOnly: typeof v.iconsOnly === 'boolean' ? v.iconsOnly : false, approvalsWhenWaiting: typeof v.approvalsWhenWaiting === 'boolean' ? v.approvalsWhenWaiting : true };
}

export async function uiFooterRoutes(fastify: FastifyInstance) {
  fastify.get('/api/me/footer', async (request, reply) => {
    const actor = actorOrReply(reply, actorOf(request), requireAccount);
    if (!actor) return reply;
    if (!actor.userId) return reply.code(403).send({ error: 'A signed-in account is required', code: 'forbidden' });
    return { footer: footerPrefs(await getPref(actor.userId, 'footer')) };
  });
  fastify.put<{ Body: unknown }>('/api/me/footer', async (request, reply) => {
    const actor = actorOrReply(reply, actorOf(request), requireAccount);
    if (!actor) return reply;
    if (!actor.userId) return reply.code(403).send({ error: 'A signed-in account is required', code: 'forbidden' });
    if (!footerChangeOk(request.body)) return reply.code(400).send({ error: 'Unknown footer setting', code: 'invalid' });
    const footer = footerPrefs({ ...footerPrefs(await getPref(actor.userId, 'footer')), ...request.body });
    await setPref(actor.userId, 'footer', footer);
    return { footer };
  });
}
