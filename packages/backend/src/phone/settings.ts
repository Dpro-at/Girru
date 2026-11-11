/**
 * Phone Settings (phone boards P33–P39): the few settings the owner changes while
 * away. The phone's screens are native; they ask with two signed commands:
 *
 *   settings.read {section}                        a small, reviewed view of one section
 *   settings.change {section, change, confirmed?}  one change, through the computer's own route
 *
 * Sections: general, account, replies, permissions, approval-rules, computers, phones.
 * Every request goes to a fixed route of the computer's own API as the owner, so the
 * same validation, permission rules and audit apply as on the computer. The phone never
 * picks a path. Changes marked sensitive (permissions, signing a device out, forgetting a
 * phone) need `confirmed: true`, which the app sends only right after a fresh Face ID
 * check; they are audited as warnings with the phone that made them.
 */
import { CommandError, type CommandContext } from './commands.js';
import { ownerInject } from './ui-bridge.js';
import { logAudit } from '../services/audit-logger.js';

type Body = Record<string, unknown>;

export const SETTINGS_SECTIONS = ['general', 'account', 'replies', 'permissions', 'approval-rules', 'computers', 'phones'] as const;
type Section = (typeof SETTINGS_SECTIONS)[number];
/** The seven actions of the desktop permissions grid (hire-contract.js › permissionCategories). */
export const PERMISSION_ACTIONS = ['browser', 'network', 'message', 'delete', 'install', 'money', 'settings'] as const;
const MODES = ['off', 'ask', 'allow'] as const;
/** Allowing these without asking needs the computer's own extra confirmation (confirmRisky), as on the desktop grid. */
const RISKY = new Set(['money', 'install', 'delete']);
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MODEL = /^[A-Za-z0-9_.:/@+-]{1,160}$/;

const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown, max = 200) => (typeof x === 'string' ? x.slice(0, max) : null);
const list = (x: unknown) => (Array.isArray(x) ? x.filter(record) : []);

function only(body: Body, keys: string[]): void {
  for (const k of Object.keys(body)) if (k !== 'type' && k !== 'ref' && !keys.includes(k)) throw new CommandError('bad_format');
}

function section(x: unknown): Section {
  if (typeof x !== 'string' || !(SETTINGS_SECTIONS as readonly string[]).includes(x)) throw new CommandError('bad_format');
  return x as Section;
}

async function get(ctx: CommandContext, url: string): Promise<unknown> {
  const r = await ownerInject(ctx.ownerId, 'GET', url);
  if (r.status !== 200) throw new CommandError(r.status === 404 ? 'not_found' : 'unavailable');
  return r.body;
}

function audit(ctx: CommandContext, action: string, success: boolean, sensitive: boolean, metadata: Record<string, unknown>) {
  logAudit({
    event_type: 'data.update', event_category: 'data_modification', severity: sensitive ? 'warning' : 'info',
    user_id: ctx.ownerId, resource_type: 'phone_command', resource_id: ctx.deviceId, action, success,
    metadata: { via: 'phone', device: ctx.deviceId, ...metadata },
  });
}

// ---------- read ----------

export async function settingsRead(ctx: CommandContext, body: Body) {
  only(body, ['section']);
  const s = section(body.section);
  if (s === 'general') {
    const raw = await get(ctx, '/api/chat/settings'); const chat = record(raw) ? raw : {};
    const look = await ownerInject(ctx.ownerId, 'GET', '/api/computers/look').catch(() => null);
    const settings = record(chat.settings) ? chat.settings : {};
    return { section: s, notifyDone: settings.notifyDone !== false, otherComputers: look && look.status === 200 && record(look.body) ? look.body.notices !== false : null };
  }
  if (s === 'account') {
    const sessions = await get(ctx, '/api/auth/sessions');
    const v = await ownerInject(ctx.ownerId, 'GET', '/api/auth/verification');
    // Every session here signs in to this computer; one without a device name is Girru on this computer itself.
    const comp = await ownerInject(ctx.ownerId, 'GET', '/api/computers').catch(() => null);
    const computerName = comp && comp.status === 200 && record(comp.body) && record(comp.body.self) ? str(comp.body.self.name, 100) : null;
    const nameOf = (label: string | null) => (!label || /^unknown device$/i.test(label.trim())) && computerName ? `Girru on ${computerName}` : label;
    return {
      section: s,
      twoStep: v.status === 200 && record(v.body) ? v.body.enabled === true : null,
      sessions: list(record(sessions) ? sessions.sessions : []).slice(0, 50).map(d => ({ id: str(d.id, 128), label: nameOf(str(d.label, 120)), current: d.current === true, lastSeenAt: typeof d.lastSeenAt === 'number' ? d.lastSeenAt : null })),
    };
  }
  if (s === 'replies') {
    const raw = await get(ctx, '/api/agents'); const agents = list(record(raw) ? raw.agents : []);
    const models = await ownerInject(ctx.ownerId, 'GET', '/api/models');
    const main = agents.find(a => a.primary === true || a.isPrimary === true || Number(a.is_primary) === 1) ?? agents[0];
    return {
      section: s,
      main: main ? { id: str(main.id, 128), name: str(main.name, 120), model: str(main.modelSelection ?? main.model, 160), version: typeof main.version === 'number' ? main.version : null } : null,
      models: list(models.status === 200 && record(models.body) ? models.body.models : []).slice(0, 60).map(m => ({ id: str(m.id, 160), label: str(m.label ?? m.name ?? m.id, 120), local: m.local === true || m.provider === 'ollama' })),
    };
  }
  if (s === 'permissions') {
    const raw = await get(ctx, '/api/agents'); const agents = list(record(raw) ? raw.agents : []).slice(0, 100);
    const rows = [];
    for (const a of agents) {
      const id = str(a.id, 128); if (!id || !ID.test(id)) continue;
      const p = await ownerInject(ctx.ownerId, 'GET', `/api/agents/${encodeURIComponent(id)}/permissions`);
      const modes = p.status === 200 && record(p.body) && record(p.body.modes) ? p.body.modes : {};
      rows.push({ id, name: str(a.name, 120), modes: Object.fromEntries(PERMISSION_ACTIONS.map(k => [k, (MODES as readonly string[]).includes(String(modes[k])) ? modes[k] : 'ask'])), version: p.status === 200 && record(p.body) && typeof p.body.version === 'number' ? p.body.version : null });
    }
    return { section: s, actions: PERMISSION_ACTIONS, agents: rows };
  }
  if (s === 'approval-rules') {
    // The computer shows approval rules only to an owner with account verification on; otherwise the phone says so.
    const r = await ownerInject(ctx.ownerId, 'GET', '/api/reviewer-policies');
    if (r.status !== 200) return { section: s, rules: [], needsVerification: r.status === 401 || r.status === 403 };
    const b = r.body;
    const items = list(record(b) ? (b.policies ?? b.items) : []).slice(0, 50);
    return { section: s, rules: items.map(x => ({ id: str(x.id, 128), name: str(x.name ?? x.title, 160), state: str(x.state ?? x.status, 40) })) };
  }
  if (s === 'computers') {
    const b = await get(ctx, '/api/computers');
    const devices = record(b) && Array.isArray(b.devices) ? b.devices : record(b) && record(b.configuration) && record(b.configuration.membership) ? b.configuration.membership.devices : [];
    // The computer this phone is paired with is `self` in the answer; it comes first, marked.
    const me = record(b) && record(b.self) ? b.self : null;
    const others = list(devices).filter(d => !me || d.id !== me.id);
    const rows = [...(me ? [{ id: str(me.id, 128), name: str(me.name, 120), thisPhonesComputer: true }] : []), ...others.slice(0, 50).map(d => ({ id: str(d.id, 128), name: str(d.name, 120), thisPhonesComputer: false }))];
    return { section: s, computers: rows };
  }
  const b = await get(ctx, '/api/phone');
  return {
    section: s,
    phones: list(record(b) ? b.devices : []).slice(0, 50).map(d => ({ id: str(d.id, 128), name: str(d.name, 120), model: str(d.model, 40), status: str(d.status, 20), lastUsedAt: str(d.lastUsedAt, 40), thisPhone: d.id === ctx.deviceId })),
  };
}

// ---------- change ----------

export async function settingsChange(ctx: CommandContext, body: Body) {
  only(body, ['section', 'change', 'confirmed']);
  const s = section(body.section);
  const c = record(body.change) ? body.change : null;
  if (!c) throw new CommandError('bad_format');
  const confirmed = body.confirmed === true;
  const done = async (action: string, sensitive: boolean, method: 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown, meta: Record<string, unknown> = {}) => {
    if (sensitive && !confirmed) throw new CommandError('confirmation_required');
    const r = await ownerInject(ctx.ownerId, method, url, payload);
    audit(ctx, action, r.status < 400, sensitive, { status: r.status, ...meta });
    if (r.status === 409) throw new CommandError('changed');
    if (r.status >= 400) throw new CommandError('refused');
    return { section: s, ok: true };
  };
  if (s === 'general') {
    if (typeof c.notifyDone === 'boolean' && Object.keys(c).length === 1) return done('phone.settings.general', false, 'PUT', '/api/chat/settings', { notifyDone: c.notifyDone });
    if (typeof c.otherComputers === 'boolean' && Object.keys(c).length === 1) return done('phone.settings.general', false, 'POST', '/api/computers/look', { notices: c.otherComputers });
    throw new CommandError('bad_format');
  }
  if (s === 'replies') {
    if (typeof c.agentId !== 'string' || !ID.test(c.agentId) || typeof c.model !== 'string' || !MODEL.test(c.model) || typeof c.version !== 'number') throw new CommandError('bad_format');
    return done('phone.settings.replies', false, 'PUT', `/api/agents/${encodeURIComponent(c.agentId)}`, { expectedVersion: c.version, modelSelection: c.model }, { agentId: c.agentId });
  }
  if (s === 'permissions') {
    if (typeof c.agentId !== 'string' || !ID.test(c.agentId) || !(PERMISSION_ACTIONS as readonly string[]).includes(String(c.action)) || !(MODES as readonly string[]).includes(String(c.mode))) throw new CommandError('bad_format');
    if (!confirmed) throw new CommandError('confirmation_required');
    const url = `/api/agents/${encodeURIComponent(c.agentId)}/permissions`;
    const now = await ownerInject(ctx.ownerId, 'GET', url);
    if (now.status !== 200 || !record(now.body)) throw new CommandError('not_found');
    const p = now.body;
    if (typeof c.version === 'number' && p.version !== c.version) throw new CommandError('changed');
    const modes = { ...(record(p.modes) ? p.modes : {}), [String(c.action)]: c.mode };
    const risky = c.mode === 'allow' && RISKY.has(String(c.action));
    if (risky && c.risky !== true) throw new CommandError('risky_confirmation_required');
    return done('phone.settings.permissions', true, 'PUT', url, { memoryRead: p.memoryRead, memoryWrite: p.memoryWrite, sharedMemory: p.sharedMemory, modes, expectedVersion: p.version, ...(risky ? { confirmRisky: true } : {}) }, { agentId: c.agentId, permission: c.action, mode: c.mode });
  }
  if (s === 'account') {
    if (typeof c.signOut !== 'string' || !ID.test(c.signOut) || Object.keys(c).length !== 1) throw new CommandError('bad_format');
    return done('phone.settings.sign_out', true, 'POST', `/api/auth/sessions/${encodeURIComponent(c.signOut)}/sign-out`);
  }
  if (s === 'phones') {
    if (typeof c.forget !== 'string' || !ID.test(c.forget) || Object.keys(c).length !== 1) throw new CommandError('bad_format');
    return done('phone.settings.forget_phone', true, 'DELETE', `/api/phone/devices/${encodeURIComponent(c.forget)}`, undefined, { forgotten: c.forget, self: c.forget === ctx.deviceId });
  }
  // approval-rules and computers are read-only on the phone (board P39): changes stay on the computer.
  throw new CommandError('on_the_computer');
}
