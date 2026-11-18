/**
 * Owner configuration of the shared channel catalog; saving never starts a provider.
 * CHANNELS-01: every channel lives under channels.<id> of the one 'agent-connect' row. Telegram and
 * Discord keep their bot token as `bot_token` (their Node transport); the others keep provider
 * variables and settings for the Python worker.
 */
import type { FastifyInstance } from 'fastify';
import { CHANNEL_CATALOG } from '../../../extensions/shared/channel-catalog.js';
import {channelRuntimeStatus} from '../../services/channel-runtime.js';
import { actorOf } from '../../auth/auth-gate.js';
import { requireOwner, ScopeError } from '../../repositories/scope.js';
import { q, sql, one, run, type Step } from '../../repositories/sql-steps.js';
import { isValidEnvironment, isValidSettings } from '../../../extensions/shared/channel-policy.js';

import { channelRuntimeState, isNativeChannel as native, refreshChannel } from '../../../extensions/shared/channel-host.js';

const catalog = new Map(CHANNEL_CATALOG.map(c => [c.id as string, c]));
const EXTENSION = 'agent-connect';
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const accessList = (v: unknown) => Array.isArray(v) && v.length <= 100 && v.every(x => typeof x === 'string' && x.length > 0 && x.length <= 200 && !/[\r\n\0]/.test(x));
function visible(id: string, root: Record<string, any>, enabled: boolean) {
  const c = root.channels?.[id] ?? {};
  const active = enabled && c.enabled !== false;
  const runtime = channelRuntimeState(id);
  const state = !active ? 'disabled' : ['connected','connecting','reconnecting','error','disconnected','restart_required'].includes(runtime) ? runtime : 'disconnected';
  return { id, enabled: active, state, configured: native(id) ? !!c.bot_token : c.configured === true,
    allowedUsers: Array.isArray(c.allowed_users) ? c.allowed_users : typeof c.allowed_users === 'string' ? c.allowed_users.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
    allowedChannels: Array.isArray(c.allowed_channels) ? c.allowed_channels : typeof c.allowed_channels === 'string' ? c.allowed_channels.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
    hasSecrets: !!c.bot_token || !!Object.keys(c.environment ?? {}).length || !!Object.keys(c.settings ?? {}).length };
}
export async function agentConnectRoutes(app: FastifyInstance) {
  const config = { access: 'owner' as const };
  const deny = (reply: any, error: unknown) => reply.code(error instanceof ScopeError ? error.status : error instanceof TypeError ? 400 : 500).send({ code: error instanceof ScopeError ? error.code : error instanceof TypeError ? 'invalid_input' : 'unavailable' });
  app.get('/api/agent-connect/catalog', { config }, async (request, reply) => {
    try {
      requireOwner(actorOf(request));
      const row = await q.one<{ enabled: number; config_json: string }>('SELECT enabled, config_json FROM extension_configs WHERE extension_id = ?', EXTENSION);
      const root = row ? JSON.parse(row.config_json) : {};
      const runtime=await channelRuntimeStatus();
      return { channels: CHANNEL_CATALOG.map(c => ({
        label: c.label, runtime: native(c.id) ? 'node' : 'python', requiredEnv: [...c.requiredEnv], prerequisites: c.prerequisites,
        ...visible(c.id, root, row?.enabled === 1),
      })), configurable: q.dialect === 'sqlite' && runtime.ready, app:runtime };
    } catch (error) { return deny(reply, error); }
  });
  app.put<{ Params: { id: string } }>('/api/agent-connect/:id/activation', { config, bodyLimit: 1024 }, async (request, reply) => {
    try {
      const owner = requireOwner(actorOf(request)), item = catalog.get(request.params.id);
      if (!item) return reply.code(404).send({ code: 'not_found' });
      // Use the catalog's own id, never the request text, as the key from here on.
      const id = item.id as string;
      if (q.dialect !== 'sqlite') return reply.code(409).send({ code: 'unsupported_store' });
      const body = request.body;
      if (!record(body) || Object.keys(body).length !== 1 || typeof body.enabled !== 'boolean') throw new TypeError();
      if(body.enabled&&!(await channelRuntimeStatus()).ready)return reply.code(409).send({code:'unavailable'});
      const channel = await sql().tx(function* (): Step<ReturnType<typeof visible>> {
        const row = yield* one<{config_json:string;enabled:number}>('SELECT config_json, enabled FROM extension_configs WHERE extension_id=?', EXTENSION);
        if (!row) throw new TypeError();
        const root = JSON.parse(row.config_json), current = root.channels?.[id];
        if (!record(current) || (body.enabled && !visible(id, root, true).configured)) throw new TypeError();
        const updated = { ...current, enabled: body.enabled, owner_user_id: owner.userId };
        // When first enabling a shared extension, leave every other saved channel off.
        const siblings = Object.fromEntries(Object.entries(root.channels ?? {}).map(([key, value]) => [key,
          row.enabled !== 1 && record(value) && value.enabled === undefined ? { ...value, enabled: false } : value]));
        const next = { ...root, channels: { ...siblings, [id]: updated } };
        const hostEnabled = row.enabled === 1 || body.enabled;
        yield* run('UPDATE extension_configs SET config_json=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE extension_id=?', JSON.stringify(next), hostEnabled ? 1 : 0, EXTENSION);
        return visible(id, next, hostEnabled);
      });
      refreshChannel(id);
      return { saved: true, channel };
    } catch (error) { return deny(reply, error); }
  });
  app.put<{ Params: { id: string } }>('/api/agent-connect/:id/config', { config, bodyLimit: 65536 }, async (request, reply) => {
    try {
      const owner = requireOwner(actorOf(request)), item = catalog.get(request.params.id);
      if (!item) return reply.code(404).send({ code: 'not_found' });
      const id = item.id as string;
      if (q.dialect !== 'sqlite') return reply.code(409).send({ code: 'unsupported_store' });
      const b = request.body;
      if (!record(b) || Object.keys(b).some(k => !['allowedUsers', 'allowedChannels', 'environment', 'settings'].includes(k)) || !accessList(b.allowedUsers) || !accessList(b.allowedChannels) || !isValidEnvironment(id, b.environment) || !isValidSettings(id, b.settings)) throw new TypeError();
      const env = record(b.environment) ? Object.fromEntries(Object.entries(b.environment).filter(([,v]) => v !== '')) : undefined;
      if (native(id) && (b.settings !== undefined || (env && Object.keys(env).some(k => !item.requiredEnv.includes(k as never))))) throw new TypeError();
      const channel = await sql().tx(function* (): Step<ReturnType<typeof visible>> {
        const row = yield* one<{config_json:string;enabled:number}>('SELECT config_json, enabled FROM extension_configs WHERE extension_id=?', EXTENSION);
        const root = row ? JSON.parse(row.config_json) : {};
        const current = root.channels?.[id] ?? {};
        const configured = native(id) ? typeof current.bot_token === 'string' && current.bot_token.trim() !== '' : current.configured === true;
        // A channel saved for the first time stays off until the owner turns it on.
        const updated = { ...current, enabled: current.enabled ?? (configured ? undefined : false), owner_user_id: owner.userId, allowed_users: b.allowedUsers, allowed_channels: b.allowedChannels, auto_reply: current.auto_reply === true };
        if (native(id)) {
          const tokenKey = item.requiredEnv[0];
          const token = tokenKey ? env?.[tokenKey] : undefined;
          if (token) updated.bot_token = token;
          if (typeof updated.bot_token !== 'string' || !updated.bot_token.trim()) throw new TypeError();
        } else {
          updated.environment = { ...current.environment, ...env };
          if (b.settings !== undefined) updated.settings = { ...current.settings, ...b.settings, ...(b.settings.extra ? {extra:{...current.settings?.extra,...b.settings.extra}} : {}) };
          if (!isValidEnvironment(id, updated.environment) || !isValidSettings(id, updated.settings)) throw new TypeError();
          if (current.configured !== true && item.requiredEnv.some(key => !updated.environment[key])) throw new TypeError();
          updated.configured = true;
        }
        const next = { ...root, channels: { ...root.channels, [id]: updated } };
        yield* run('INSERT INTO extension_configs (extension_id, config_json, enabled) VALUES (?, ?, 0) ON CONFLICT(extension_id) DO UPDATE SET config_json=excluded.config_json, updated_at=CURRENT_TIMESTAMP', EXTENSION, JSON.stringify(next));
        return visible(id, next, row?.enabled === 1);
      });
      return { channel, saved: true };
    } catch (error) { return deny(reply, error); }
  });
}
