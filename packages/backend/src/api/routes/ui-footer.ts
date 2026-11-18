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
export const FOOTER_SECTIONS = ['chat', 'agents', 'library', 'board', 'runs', 'reports', 'memory', 'approvals', 'store', 'computers', 'genvr', 'terminal', 'code', 'browser', 'skills', 'personalities', 'specialties'] as const;
type Section = typeof FOOTER_SECTIONS[number];
export interface FooterPrefs { order: Section[]; hidden: Section[]; iconsOnly: boolean; approvalsWhenWaiting: boolean }
const DEFAULT_HIDDEN: Section[] = ['genvr', 'terminal', 'code', 'browser', 'skills', 'personalities', 'specialties'];
const ADDED_AFTER: Partial<Record<Section, Section>> = { library: 'agents', runs: 'board', reports:'runs', computers:'store' };
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

const THEMES = ['system', 'light', 'dark'] as const;
/** CP13: the theme is saved in the program (not only the window), so “Same as” can bring it to a new computer. */
export async function uiThemeRoutes(fastify: FastifyInstance) {
  fastify.get('/api/me/theme', async (request, reply) => {
    const actor = actorOrReply(reply, actorOf(request), requireAccount);
    if (!actor) return reply;
    if (!actor.userId) return reply.code(403).send({ error: 'A signed-in account is required', code: 'forbidden' });
    const saved = await getPref(actor.userId, 'theme');
    return { theme: (THEMES as readonly unknown[]).includes(saved) ? saved : null };
  });
  fastify.put<{ Body: unknown }>('/api/me/theme', async (request, reply) => {
    const actor = actorOrReply(reply, actorOf(request), requireAccount);
    if (!actor) return reply;
    if (!actor.userId) return reply.code(403).send({ error: 'A signed-in account is required', code: 'forbidden' });
    const body = request.body as { theme?: unknown } | null;
    if (!body || Object.keys(body).join() !== 'theme' || !(THEMES as readonly unknown[]).includes(body.theme)) return reply.code(400).send({ error: 'Unknown theme', code: 'invalid' });
    await setPref(actor.userId, 'theme', body.theme);
    return { theme: body.theme };
  });
}

/** CP15: the owner's switch “Agents can run commands on this computer”. Turning it on lets the agents use run_command (owner Run for risky ones). */
export async function agentCommandsRoutes(fastify: FastifyInstance) {
  const ownerOnly = (request: any, reply: any) => { const actor = actorOrReply(reply, actorOf(request), requireAccount); if (!actor) return null; if (!actor.userId || actor.role !== 'owner') { reply.code(403).send({ error: 'Only the owner can change this', code: 'forbidden' }); return null; } return actor; };
  fastify.get('/api/me/agent-commands', async (request, reply) => { const actor = ownerOnly(request, reply); if (!actor) return reply; return { on: (await getPref(actor.userId!, 'agent-commands')) === true }; });
  fastify.put<{ Body: unknown }>('/api/me/agent-commands', async (request, reply) => {
    const actor = ownerOnly(request, reply); if (!actor) return reply;
    const body = request.body as { on?: unknown } | null;
    if (!body || Object.keys(body).join() !== 'on' || typeof body.on !== 'boolean') return reply.code(400).send({ error: 'Send on: true or false', code: 'invalid' });
    await setPref(actor.userId!, 'agent-commands', body.on);
    if (body.on) { const { q } = await import('../../repositories/sql-steps.js'); for (const tool of ['run_command', 'run_command_owner']) await q.run("INSERT INTO agent_tool_grants (agent_id, tool_name, scopes, granted_by) SELECT a.id, ?, NULL, ? FROM agents_config a WHERE NOT EXISTS (SELECT 1 FROM agent_tool_grants g WHERE g.agent_id = a.id AND g.tool_name = ?)", tool, actor.userId!, tool); }
    return { on: body.on };
  });
}

/** CP15 (MCP): a coding app connected to Girru runs a command in one of the owner's projects, with the same rules as
 *  in a chat: off unless the owner's switch is on; known read and sync commands run at once; any other command becomes
 *  a Run request in Approvals and runs only after the owner presses Run there. */
export async function agentCommandRunRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: unknown }>('/api/commands/run', async (request, reply) => {
    const actor = actorOrReply(reply, actorOf(request), requireAccount); if (!actor) return reply;
    if (!actor.userId || actor.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can run commands', code: 'forbidden' });
    const body = request.body as Record<string, unknown> | null;
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
    if (!keys || keys.some(k => !['projectId', 'command', 'timeout'].includes(k)) || typeof body!.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body!.projectId) || typeof body!.command !== 'string')
      return reply.code(400).send({ error: 'Send projectId and command (and an optional timeout in milliseconds).', code: 'invalid' });
    const { findProject } = await import('../../repositories/chat-conversations.js');
    const folder = (await findProject(actor.userId, body!.projectId))?.folder;
    if (!folder) return reply.code(404).send({ error: 'That project has no folder on this computer.', code: 'no_project_folder' });
    const { runCommandTool, runCommandOwnerTool } = await import('../../tools/core/run-command.js');
    const params = { command: body!.command, ...(body!.timeout !== undefined ? { timeout: body!.timeout } : {}) };
    // The command is asked on behalf of the main agent (the switch gave it the command tools), so its Run in Approvals has an agent with the grant.
    const { q } = await import('../../repositories/sql-steps.js');
    const main = await q.one<{ id: string }>('SELECT id FROM agents_config ORDER BY is_primary DESC, created_at ASC LIMIT 1');
    const context = { userId: actor.userId, accessOwnerId: actor.userId, workspaceDir: folder, fileReadRoot: folder, ...(main ? { agentId: main.id } : {}) } as any;
    const ran = await runCommandTool.execute(params, context);
    if (ran.error !== 'owner_run_required') return { ran: ran.error === undefined || ran.error === 'nonzero_exit', code: ran.error ?? null, output: (ran.content ?? []).map(c => c.text ?? '').join('\n').slice(0, 64 * 1024) };
    const { requestApproval } = await import('../../tools/approvals.js');
    const waiting = await requestApproval(runCommandOwnerTool, params, context, 'other');
    return { ran: false, code: 'waiting_for_run', approvalId: (waiting.details as { approvalId?: string } | undefined)?.approvalId ?? null, output: 'This command waits for the owner: it shows in Approvals with a Run button.' };
  });
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
