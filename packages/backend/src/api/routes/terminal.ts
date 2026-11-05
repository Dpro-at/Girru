/**
 * Built-in terminal API (TERM-01). Owner only (auth gate owner tier for
 * /api/terminal, route access 'owner', handler checks a real owner account),
 * loopback clients only, and off unless AGENT_TERMINAL=true.
 *
 *   GET    /api/terminal                       { enabled, sessions: [...] }
 *   POST   /api/terminal/sessions              { cols?, rows? } -> { id, shell, cols, rows }
 *   GET    /api/terminal/sessions/:id/stream   SSE: `output` {seq, data} | `exit` {exitCode}; ?after=<seq> resumes
 *   POST   /api/terminal/sessions/:id/input    { data }
 *   POST   /api/terminal/sessions/:id/resize   { cols, rows }
 *   DELETE /api/terminal/sessions/:id
 *
 * Every open and close is written to the audit log; keystrokes are not.
 */

import { variablesEnv } from '../../services/project-variables.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { actorOf } from '../../auth/auth-gate.js';
import { actorOrReply, requireOwner } from '../../repositories/scope.js';
import { logAudit } from '../../services/audit-logger.js';
import { openSseStream } from '../../services/chat-sse.js';
import { TerminalError, TerminalManager, commandAllowed, terminalEnabled, terminalPrefs, DEFAULT_TERMINAL_PREFS } from '../../terminal/manager.js';
import { getPref, setPref } from '../../repositories/user-prefs.js';
import { checkFolder, findProject } from '../../repositories/chat-conversations.js';

const SESSION_ID = /^[0-9a-f-]{36}$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const STATUS: Record<TerminalError['code'], number> = {
  disabled: 403, limit: 429, not_found: 404, invalid: 400, closed: 409, unsupported: 501,
};

/** The socket peer, not a forwarded header: only this machine may open a shell. */
export function isLoopbackPeer(request: FastifyRequest): boolean {
  return LOOPBACK.has(String(request.socket?.remoteAddress ?? ''));
}

function ownerOf(request: FastifyRequest, reply: FastifyReply): string | null {
  const actor = actorOrReply(reply, actorOf(request), requireOwner);
  if (!actor) return null;
  if (actor.kind !== 'user' || !actor.userId) {
    reply.code(403).send({ error: 'The terminal requires a signed-in owner account', code: 'forbidden' });
    return null;
  }
  if (!isLoopbackPeer(request)) {
    reply.code(403).send({ error: 'The terminal is only available on this machine', code: 'not_loopback' });
    return null;
  }
  return actor.userId;
}

function audit(request: FastifyRequest, owner: string, event: 'terminal.session.open' | 'terminal.session.close', id: string) {
  logAudit({
    event_type: event, event_category: 'system', severity: 'warning',
    user_id: owner, ip_address: request.ip, user_agent: request.headers['user-agent'],
    request_method: request.method, request_path: request.routeOptions?.url ?? undefined,
    resource_type: 'terminal', resource_id: id, action: event, success: true,
  });
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof TerminalError) return reply.code(STATUS[err.code]).send({ error: err.message, code: err.code });
  throw err;
}

function sessionId(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): string | null {
  const id = request.params.id;
  if (!SESSION_ID.test(id)) {
    reply.code(404).send({ error: 'No such terminal', code: 'not_found' });
    return null;
  }
  return id;
}

export function terminalRoutesWith(manager: TerminalManager) {
  return async function terminalRoutes(fastify: FastifyInstance) {
    const config = { access: 'owner' as const };
    fastify.addHook('onClose', async () => manager.closeAll());

    fastify.get('/api/terminal', { config }, async (request, reply) => {
      const owner = ownerOf(request, reply);
      if (!owner) return reply;
      return { enabled: terminalEnabled(), sessions: manager.list(owner) };
    });

    // The screen's look (TERM-PRO-01): saved per owner, merged over the defaults.
    fastify.get('/api/terminal/prefs', { config }, async (request, reply) => {
      const owner = ownerOf(request, reply);
      if (!owner) return reply;
      return { prefs: terminalPrefs(await getPref(owner, 'terminal')), defaults: DEFAULT_TERMINAL_PREFS };
    });
    fastify.put<{ Body: unknown }>('/api/terminal/prefs', { config }, async (request, reply) => {
      const owner = ownerOf(request, reply);
      if (!owner) return reply;
      const merged = { ...(terminalPrefs(await getPref(owner, 'terminal')) ?? DEFAULT_TERMINAL_PREFS), ...(request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body as object : { bad: true }) };
      const prefs = terminalPrefs(merged, true);
      if (!prefs) return reply.code(400).send({ error: 'Unknown or out-of-range terminal setting', code: 'invalid' });
      await setPref(owner, 'terminal', prefs);
      return { prefs };
    });

    fastify.post<{ Body: { cols?: unknown; rows?: unknown; projectId?: unknown; command?: unknown } }>('/api/terminal/sessions', { config }, async (request, reply) => {
      const owner = ownerOf(request, reply);
      if (!owner) return reply;
      try {
        const body = request.body && typeof request.body === 'object' ? request.body : {};
        // A chat project's terminal opens in the project folder (re-checked: it must still exist).
        let cwd: string | undefined;
        let extraEnv: Record<string, string> | undefined;
        if (body.projectId !== undefined) {
          const project = typeof body.projectId === 'string' && SESSION_ID.test(body.projectId) ? await findProject(owner, body.projectId) : undefined;
          if (!project?.folder) return reply.code(404).send({ error: 'No such project folder', code: 'not_found' });
          try { cwd = checkFolder(project.folder); } catch { return reply.code(404).send({ error: 'The project folder is gone', code: 'not_found' }); }
          extraEnv = await variablesEnv(owner, project.id).catch(() => undefined);
        }
        if (body.command !== undefined && !commandAllowed(body.command)) return reply.code(400).send({ error: 'This command has hidden or control characters, or is too long', code: 'invalid' });
        const created = await manager.create(owner, { cols: body.cols, rows: body.rows, cwd, extraEnv, ...(typeof body.command === 'string' ? { command: body.command } : {}) });
        audit(request, owner, 'terminal.session.open', created.id);
        return reply.code(201).send(created);
      } catch (err) {
        return fail(reply, err);
      }
    });

    fastify.get<{ Params: { id: string }; Querystring: { after?: string } }>(
      '/api/terminal/sessions/:id/stream', { config }, async (request, reply) => {
        const owner = ownerOf(request, reply);
        if (!owner) return reply;
        const id = sessionId(request, reply);
        if (!id) return reply;
        const after = Number.parseInt(String(request.query.after ?? '0'), 10);
        const raw = reply.raw;
        let unsubscribe: (() => void) | null = null;
        const send = (event: string, data: unknown) => {
          if (!raw.writableEnded && !raw.destroyed) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        try {
          // Validate ownership before hijacking, so a wrong id still gets a JSON 404.
          manager.subscribe(owner, id, Number.MAX_SAFE_INTEGER, () => {})();
        } catch (err) {
          return fail(reply, err);
        }
        reply.hijack();
        openSseStream(raw);
        unsubscribe = manager.subscribe(owner, id, Number.isFinite(after) && after > 0 ? after : 0, event => {
          if (event.type === 'data') send('output', event.chunk);
          else { send('exit', { exitCode: event.exitCode, ...(event.signal ? { signal: event.signal } : {}) }); raw.end(); }
        });
        request.raw.on('close', () => unsubscribe?.());
      });

    fastify.post<{ Params: { id: string }; Body: { data?: unknown } }>(
      '/api/terminal/sessions/:id/input', { config, bodyLimit: 128 * 1024 }, async (request, reply) => {
        const owner = ownerOf(request, reply);
        if (!owner) return reply;
        const id = sessionId(request, reply);
        if (!id) return reply;
        try {
          manager.write(owner, id, request.body?.data);
          return reply.code(204).send();
        } catch (err) {
          return fail(reply, err);
        }
      });

    fastify.post<{ Params: { id: string }; Body: { cols?: unknown; rows?: unknown } }>(
      '/api/terminal/sessions/:id/resize', { config }, async (request, reply) => {
        const owner = ownerOf(request, reply);
        if (!owner) return reply;
        const id = sessionId(request, reply);
        if (!id) return reply;
        try {
          return manager.resize(owner, id, request.body?.cols, request.body?.rows);
        } catch (err) {
          return fail(reply, err);
        }
      });

    fastify.post<{ Params: { id: string } }>('/api/terminal/sessions/:id/stop', { config }, async (request, reply) => {
      const owner = ownerOf(request, reply); if (!owner) return reply;
      try { manager.stop(owner, request.params.id); return reply.code(204).send(); } catch (err) { return fail(reply, err); }
    });

    fastify.delete<{ Params: { id: string } }>('/api/terminal/sessions/:id', { config }, async (request, reply) => {
      const owner = ownerOf(request, reply);
      if (!owner) return reply;
      const id = sessionId(request, reply);
      if (!id) return reply;
      try {
        manager.close(owner, id);
        audit(request, owner, 'terminal.session.close', id);
        return reply.code(204).send();
      } catch (err) {
        return fail(reply, err);
      }
    });
  };
}

/** The server's single terminal manager. */
/** The one manager; the phone link streams a session through it too (phone/ui-bridge.ts). */
export const terminalManager = new TerminalManager();
export const terminalRoutes = terminalRoutesWith(terminalManager);
