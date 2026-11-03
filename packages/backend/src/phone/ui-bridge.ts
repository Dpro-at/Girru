/**
 * The computer's own pages on a paired phone (MOBILE-CTRL-01 Task 5, PROTOCOL.md
 * "The computer's pages on the phone"). Three signed commands:
 *
 *   ui.get {path, part?}            one file of the verified core-ui build, base64, in parts
 *   api.call {method, path, body?}  one page request, run here as the owner
 *   api.stream {path}               a run's live events as stream frames
 *
 * api.call passes two gates: PHONE_ROUTES below (the phone's short list) and the
 * desktop bridge's own allow list and answer projection (core-ui
 * scripts/application-server.cjs › allowed, project), so there is one allow list
 * per route, made narrower here. The request runs through Fastify inject with a
 * short-lived owner token that never leaves this process, so every route rule
 * (owner tier, token version, revoked sign-ins) still applies.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { CommandError, type CommandContext } from './commands.js';

const require = createRequire(import.meta.url);
const CORE_UI = fileURLToPath(new URL('../../../core-ui/', import.meta.url));

/** Raw bytes of one ui.get answer; base64 keeps it under the 1 MiB envelope. */
export const UI_PART_BYTES = 600 * 1024;
export const API_BODY_BYTES = 256 * 1024;
export const API_ANSWER_BYTES = 700 * 1024;
export const LIMITS = { call: 120, get: 600, streams: 4, windowMs: 60_000 };

type Body = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Gate {
  allowed(method: string, target: string, body: unknown): boolean;
  project(target: string, status: number, body: unknown): unknown;
}

let gate: Gate | null = null;
async function desktopGate(): Promise<Gate> {
  gate ??= require(`${CORE_UI}scripts/application-server.cjs`) as Gate;
  return gate;
}

let conversation: { conversationPath(p: string): { kind: string; run?: string; after?: number } | null; projectRunEvent(x: unknown): Record<string, unknown> | null } | null = null;
async function conversationContract() {
  conversation ??= await import(`${CORE_UI}src/conversation-contract.js`);
  return conversation!;
}

let api: FastifyInstance | null = null;
/** server.ts binds the running app; tests bind their own. */
export function bindPhoneApi(app: FastifyInstance | null): void { api = app; }

// ---------- the phone's short list ----------

/** Conversation request kinds (conversation-contract.js › conversationPath) and the methods the phone may use. */
const CHAT_KINDS: Record<string, Method[]> = {
  list: ['GET', 'POST'],
  one: ['GET', 'PATCH'],
  messages: ['GET'],
  runs: ['POST'],
  stop: ['POST'],
  'chat-usage': ['GET'],
  'chat-team': ['GET'],
  'chat-schedule': ['GET'],
  'chat-stop': ['POST'],
  sidebar: ['GET', 'PUT'],
  panel: ['GET', 'PUT'],
  last: ['GET'],
  'chat-settings': ['GET'],
};

const STEER = /^\/api\/chat\/runs\/[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}\/steer$/;
const AGENT = /^\/api\/agents\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * The phone's own list: only what the chat page needs (the owner's rule: the
 * chat is the desktop page itself; tasks, approvals and team are the phone's own
 * screens on their own commands). Anything not named here is refused before the
 * desktop gate is asked, whatever that gate allows.
 */
export async function phoneMayCall(method: string, target: string): Promise<boolean> {
  if (typeof target !== 'string' || !target.startsWith('/api/') || target.length > 2048) return false;
  if (method === 'GET' && (target === '/api/auth/me' || target === '/api/agents' || (AGENT.test(target) && !target.endsWith('/name-suggestion')))) return true;
  if (method === 'POST' && STEER.test(target)) return true;
  const { conversationPath } = await conversationContract();
  const kind = conversationPath(target)?.kind;
  return !!kind && (CHAT_KINDS[kind] ?? []).includes(method as Method);
}

// ---------- limits ----------

const used = new Map<string, { at: number; call: number; get: number }>();
const streams = new Map<string, number>();

function spend(deviceId: string, what: 'call' | 'get', now: number): void {
  let u = used.get(deviceId);
  if (!u || now - u.at >= LIMITS.windowMs) { u = { at: now, call: 0, get: 0 }; used.set(deviceId, u); }
  if (++u[what] > LIMITS[what]) throw new CommandError('rate_limited');
}

export function forgetUiLimits(deviceId?: string): void {
  if (deviceId === undefined) { used.clear(); streams.clear(); return; }
  used.delete(deviceId); streams.delete(deviceId);
}

function only(body: Body, keys: string[]): void {
  for (const k of Object.keys(body)) if (k !== 'type' && k !== 'ref' && !keys.includes(k)) throw new CommandError('bad_format');
}

// ---------- ui.get ----------

const PAGE_ROUTES = ['/', '/chat', '/agents', '/memory', '/tasks', '/settings', '/channels'];
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', gif: 'image/gif', txt: 'text/plain; charset=utf-8' };
const BUILD_RECHECK_MS = 30_000;

let build: { id: string; files: Map<string, Buffer>; checkedAt: number } | null = null;
let buildRoot = CORE_UI;
/** Tests point this at a throwaway package folder with its own dist/. */
export function setUiPackageRoot(root: string | null): void { buildRoot = root ?? CORE_UI; build = null; }

function currentBuild(now: number): { id: string; files: Map<string, Buffer> } {
  if (build && now - build.checkedAt < BUILD_RECHECK_MS) return build;
  const { readCurrent } = require(`${CORE_UI}scripts/build-artifacts.cjs`) as { readCurrent(root: string, channel: string): { manifest: { buildId: string }; files: Map<string, Buffer> } };
  // The desktop loads the candidate build; a plain checkout serves current.
  let read: { manifest: { buildId: string }; files: Map<string, Buffer> } | null = null;
  for (const channel of ['candidate', 'current']) {
    try { read = readCurrent(buildRoot, channel); break; } catch { /* next channel */ }
  }
  if (!read) throw new CommandError('ui_unavailable');
  build = build?.id === read.manifest.buildId ? { ...build, checkedAt: now } : { id: read.manifest.buildId, files: read.files, checkedAt: now };
  return build;
}

export async function uiGet(ctx: CommandContext, body: Body) {
  only(body, ['path', 'part']);
  if (typeof body.path !== 'string' || body.path.length > 256) throw new CommandError('bad_format');
  const part = body.part ?? 0;
  if (!Number.isSafeInteger(part) || (part as number) < 0) throw new CommandError('bad_format');
  spend(ctx.deviceId, 'get', ctx.now());
  const b = currentBuild(ctx.now());
  const name = PAGE_ROUTES.includes(body.path) ? 'index.html' : body.path.startsWith('/') ? body.path.slice(1) : '';
  // The build's own names only (index.html, the notices, assets/*.js|css|gif): a lookup, never a path on disk.
  const data = b.files.get(name);
  if (!data) return { status: 404, build: b.id };
  const parts = Math.max(1, Math.ceil(data.length / UI_PART_BYTES));
  if ((part as number) >= parts) throw new CommandError('bad_format');
  const slice = data.subarray((part as number) * UI_PART_BYTES, ((part as number) + 1) * UI_PART_BYTES);
  return { status: 200, type: TYPES[name.slice(name.lastIndexOf('.') + 1)] ?? 'application/octet-stream', size: data.length, parts, part, build: b.id, body: slice.toString('base64') };
}

// ---------- api.call ----------

const METHODS: Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

async function ownerHeaders(ownerId: string): Promise<Record<string, string>> {
  const { findTokenUser, generateToken } = await import('../auth/jwt.js');
  const { launchTokenFromEnv, LAUNCH_HEADER } = await import('../api/launch-token.js');
  const user = await findTokenUser(ownerId);
  if (!user || user.role !== 'owner' || user.status !== 'active') throw new CommandError('owner_changed');
  const launch = launchTokenFromEnv();
  // Lives for this one request inside this process; the phone never sees it.
  return { authorization: `Bearer ${generateToken(ownerId, user.token_version ?? 1, '60s')}`, ...(launch ? { [LAUNCH_HEADER]: launch } : {}) };
}

export async function apiCall(ctx: CommandContext, body: Body) {
  only(body, ['method', 'path', 'body']);
  const method = body.method, target = body.path;
  if (typeof method !== 'string' || !METHODS.includes(method as Method) || typeof target !== 'string') throw new CommandError('bad_format');
  if (body.body !== undefined && (method === 'GET' || Buffer.byteLength(JSON.stringify(body.body)) > API_BODY_BYTES)) throw new CommandError(method === 'GET' ? 'bad_format' : 'too_large');
  if (!(await phoneMayCall(method, target))) throw new CommandError('not_allowed');
  spend(ctx.deviceId, 'call', ctx.now());
  const g = await desktopGate();
  if (!g.allowed(method, target, body.body)) return { status: 400, body: null };
  if (!api) throw new CommandError('ui_unavailable');
  const res = await api.inject({
    method: method as Method, url: target,
    headers: { ...(await ownerHeaders(ctx.ownerId)), accept: 'application/json', ...(body.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body.body !== undefined ? { payload: JSON.stringify(body.body) } : {}),
  });
  if (!/^application\/json/i.test(String(res.headers['content-type'] ?? '')) && res.body !== '') return { status: 502, body: null };
  let parsed: unknown;
  try { parsed = res.body === '' ? undefined : JSON.parse(res.body); } catch { return { status: 502, body: null }; }
  // The desktop's projection: only reviewed fields, never error text. A reply outside it fails closed.
  let projected: unknown;
  try { projected = g.project(target, res.statusCode, parsed) ?? null; } catch { return { status: 502, body: null }; }
  if (Buffer.byteLength(JSON.stringify(projected)) > API_ANSWER_BYTES) throw new CommandError('too_large');
  return { status: res.statusCode, body: projected };
}

// ---------- api.stream ----------

export async function apiStream(ctx: CommandContext, body: Body) {
  only(body, ['path']);
  if (typeof body.path !== 'string') throw new CommandError('bad_format');
  const { conversationPath, projectRunEvent } = await conversationContract();
  const route = conversationPath(body.path);
  if (route?.kind !== 'events' || !route.run) throw new CommandError('not_allowed');
  const open = streams.get(ctx.deviceId) ?? 0;
  if (open >= LIMITS.streams) throw new CommandError('rate_limited');
  const { chatRuns } = await import('../services/chat-runs.js');
  const run = chatRuns.get(route.run);
  if (!run || run.userId !== ctx.ownerId) throw new CommandError('not_found');
  streams.set(ctx.deviceId, open + 1);
  const after = route.after ?? 0;
  return { follow: () => followEvents(ctx, run, after, projectRunEvent) };
}

type Run = { status: string; since(after: number): Array<{ seq: number; frame: Record<string, unknown> }>; emitter: import('node:events').EventEmitter };

/** Same events and order as GET /api/chat/runs/:runId/events, each projected as the desktop page reads it. */
function followEvents(ctx: CommandContext, run: Run, after: number, project: (x: unknown) => Record<string, unknown> | null): Promise<void> {
  return new Promise((resolve) => {
    let last = after, done = false;
    const finish = (status: 'complete' | 'dropped') => {
      if (done) return;
      done = true;
      run.emitter.off('event', onEvent); run.emitter.off('preview', onPreview); run.emitter.off('end', onEnd);
      streams.set(ctx.deviceId, Math.max(0, (streams.get(ctx.deviceId) ?? 1) - 1));
      ctx.push({ type: 'stream.end', status });
      resolve();
    };
    const send = (data: Record<string, unknown>) => { if (!done && !ctx.push({ type: 'stream', data })) finish('dropped'); };
    const onEvent = (e: { seq: number; frame: Record<string, unknown> }) => {
      if (e.seq <= last) return;
      const data = project({ seq: e.seq, ...e.frame });
      if (!data) return;
      last = e.seq;
      send(data);
      if (data.type === 'end') finish('complete');
    };
    const onPreview = (p: Record<string, unknown>) => {
      if (p && p.type === 'preview' && typeof p.content === 'string') send({ seq: 0, type: 'preview', content: p.content.slice(0, 128 * 1024), ...(typeof p.tool === 'string' ? { tool: p.tool.slice(0, 128) } : {}) });
    };
    const onEnd = () => finish('complete');
    for (const e of run.since(after)) onEvent(e);
    if (done) return;
    if (run.status !== 'running') { finish('complete'); return; }
    run.emitter.on('event', onEvent);
    run.emitter.on('preview', onPreview);
    run.emitter.once('end', onEnd);
  });
}
