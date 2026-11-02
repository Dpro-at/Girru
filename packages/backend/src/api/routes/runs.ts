/**
 * Runs (RUNS-01): everything that runs, in one place — read model in services/runs.ts.
 *
 *   GET  /api/runs?place=running|waiting|finished|failed&kind&agent&project&q&before&limit
 *                                         one page, newest first, plus the sidebar counts
 *   GET  /api/runs/item/:id               one run: steps, log, result, why, Copy details
 *   POST /api/runs/item/:id/stop          a chat reply, an agent task or a coding app that is working
 *   POST /api/runs/item/:id/retry         a chat reply again: the same message, in the same chat, as a new run
 *   GET  /api/runs/schedules              every schedule the person may see
 *   POST /api/runs/schedules              owner: "Schedule a task" (board RN6) — a board card with the instructions
 *                                         and its repeat; each run continues that task as the chosen agent
 *   GET  /api/runs/schedules/:id/runs     the last runs a schedule made
 *
 * Gate: 'user' tier (guests refused). The owner sees everything; anyone else only their own
 * runs, never system jobs or agent check-ins. Stop and Retry keep the gates of the routes they
 * stand for: a chat reply only by the person whose chat it is, an agent task through the task
 * runs repository (owner or the run's own user), a coding app only from its own chat.
 * Schedule changes stay on their own routes (scheduler, chat schedule, card schedule).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { actorOf } from '../../auth/auth-gate.js';
import { requireOwnUser, ownerWideUserFilter, ScopeError, sendScopeError } from '../../repositories/scope.js';
import { repositories } from '../../repositories/index.js';
import { q } from '../../repositories/sql-steps.js';
import { findConversation } from '../../repositories/chat-conversations.js';
import { chatRuns } from '../../services/chat-runs.js';
import { stopCodingRun } from '../../services/coding-runs.js';
import { KINDS, PLACES, RunNotFound, listRuns, listSchedules, parseRunId, runCounts, runDetail, scheduleRuns, type Place, type RunKind } from '../../services/runs.js';
import { logAudit } from '../../services/audit-logger.js';
import { startTurn } from './chat-conversations.js';
import { createCard, listBoards, BoardError } from '../../services/task-board.js';
import { setCardSchedule } from '../../services/card-schedules.js';

const AGENT_OR_PROJECT = /^[A-Za-z0-9_.:-]{1,120}$/;

function who(request: FastifyRequest): { userId: string | null; self: string; role: string } {
  const actor = requireOwnUser(actorOf(request));
  if (actor.kind !== 'user' || !actor.userId) throw new ScopeError(403, 'Runs are for signed-in people');
  const wide = ownerWideUserFilter(actor);
  return { userId: wide === undefined ? null : wide, self: actor.userId, role: (actor as { role?: string }).role ?? 'user' };
}
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'Run not found' });
function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof RunNotFound) return notFound(reply);
  return sendScopeError(reply, err);
}
function audit(request: FastifyRequest, userId: string, action: string, runId: string, success: boolean) {
  logAudit({ event_type: 'data.update', event_category: 'data_modification', severity: 'info', user_id: userId, ip_address: request.ip, user_agent: request.headers['user-agent'],
    request_method: request.method, request_path: request.routeOptions?.url ?? undefined, resource_type: 'run', resource_id: runId, action: `run.${action}`, success, metadata: {} });
}

export async function runsRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: Record<string, string | undefined> }>('/api/runs', async (request, reply) => {
    try {
      const { userId } = who(request);
      const qs = request.query ?? {};
      const place = (qs.place ?? 'running') as Place;
      if (!PLACES.includes(place)) return reply.code(400).send({ error: 'Invalid place' });
      if (qs.kind !== undefined && !KINDS.includes(qs.kind as RunKind)) return reply.code(400).send({ error: 'Invalid kind' });
      for (const k of ['agent', 'project'] as const) if (qs[k] !== undefined && !AGENT_OR_PROJECT.test(qs[k]!)) return reply.code(400).send({ error: `Invalid ${k}` });
      if (qs.q !== undefined && qs.q.length > 200) return reply.code(400).send({ error: 'Invalid q' });
      const before = qs.before === undefined ? undefined : Number(qs.before);
      if (before !== undefined && !(Number.isInteger(before) && before > 0)) return reply.code(400).send({ error: 'Invalid before' });
      const [page, counts] = await Promise.all([
        listRuns({ userId, place, kind: qs.kind as RunKind | undefined, agentId: qs.agent, projectId: qs.project, q: qs.q, before, limit: Number(qs.limit) || undefined }),
        runCounts(userId),
      ]);
      return { runs: page.runs, next: page.next, counts };
    } catch (err) { return fail(reply, err); }
  });

  fastify.get<{ Params: { id: string } }>('/api/runs/item/:id', async (request, reply) => {
    try {
      const { userId } = who(request);
      if (!parseRunId(request.params.id)) return reply.code(400).send({ error: 'Invalid id' });
      return await runDetail(userId, request.params.id);
    } catch (err) { return fail(reply, err); }
  });

  fastify.post<{ Params: { id: string } }>('/api/runs/item/:id/stop', async (request, reply) => {
    try {
      const me = who(request);
      const p = parseRunId(request.params.id);
      if (!p) return reply.code(400).send({ error: 'Invalid id' });
      if (p.source === 'chat') {
        const run = chatRuns.get(p.key);
        if (!run || run.userId !== me.self) return notFound(reply);
        run.requestStop();
        audit(request, me.self, 'stop', request.params.id, true);
        return { ok: true, status: run.status === 'running' ? 'stopping' : run.status };
      }
      if (p.source === 'task') {
        const { after } = await repositories.taskRuns.cancel(actorOf(request), p.key);
        audit(request, me.self, 'stop', request.params.id, true);
        return { ok: true, status: after.status };
      }
      if (p.source === 'code') {
        const row = await q.one<{ session_id: string; user_id: string | null }>('SELECT session_id, user_id FROM coding_app_runs WHERE id = ?', p.key);
        if (!row || row.user_id !== me.self || !stopCodingRun(row.session_id, p.key)) return notFound(reply);
        audit(request, me.self, 'stop', request.params.id, true);
        return { ok: true, status: 'stopping' };
      }
      return reply.code(409).send({ error: 'This run cannot be stopped here' });
    } catch (err) { return fail(reply, err); }
  });

  fastify.post<{ Params: { id: string } }>('/api/runs/item/:id/retry', async (request, reply) => {
    try {
      const me = who(request);
      const p = parseRunId(request.params.id);
      if (!p || p.source !== 'chat') return reply.code(409).send({ error: 'Only a chat reply can be retried here' });
      const j = await q.one<{ session_id: string; user_id: string; state: string }>('SELECT session_id, user_id, state FROM chat_run_journal WHERE run_id = ?', p.key);
      if (!j || j.user_id !== me.self) return notFound(reply);
      if (j.state === 'running' || j.state === 'complete') return reply.code(409).send({ error: 'Only a reply that failed or was stopped can be retried' });
      const message = await q.one<{ content: string }>("SELECT content FROM chat_messages WHERE run_id = ? AND role = 'user' ORDER BY created_at LIMIT 1", p.key);
      const c = await findConversation(me.self, j.session_id);
      if (!c || !message?.content) return notFound(reply);
      const runId = `retry-${randomUUID()}`;
      const out = await startTurn({ userId: me.self, role: me.role, c, runId, message: message.content, ...(c.model ? { model: c.model } : {}) });
      audit(request, me.self, 'retry', request.params.id, out.code === 202);
      return reply.code(out.code === 202 ? 202 : out.code).send(out.code === 202 ? { ok: true, run: `chat:${runId}`, sessionId: c.id } : out.body);
    } catch (err) { return fail(reply, err); }
  });

  fastify.get('/api/runs/schedules', async (request, reply) => {
    try {
      const me = who(request);
      return { schedules: await listSchedules(me.userId, me.userId === null ? me.self : null) };
    } catch (err) { return fail(reply, err); }
  });

  fastify.post('/api/runs/schedules', { config: { access: 'owner' } }, async (request, reply) => {
    try {
      const me = who(request);
      const b = request.body as Record<string, unknown> | null;
      const KEYS = ['instructions', 'agentId', 'every', 'at', 'weekday', 'notify', 'newChat', 'model', 'thinking', 'projectId'];
      if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !KEYS.includes(k))) return reply.code(400).send({ error: `A task schedule is { ${KEYS.join(', ')} }` });
      const instructions = typeof b.instructions === 'string' ? b.instructions.trim() : '';
      if (!instructions || instructions.length > 5000) return reply.code(400).send({ error: 'instructions are 1-5000 characters' });
      const agentId = typeof b.agentId === 'string' ? b.agentId : (await q.one<{ id: string }>('SELECT id FROM agents_config WHERE is_primary = 1 ORDER BY id LIMIT 1'))?.id ?? null;
      if (agentId && !AGENT_OR_PROJECT.test(agentId)) return reply.code(400).send({ error: 'Invalid agentId' });
      // The company board (made on first use, like the Board does).
      const board = (await listBoards(me.self))[0];
      const column = board ? await q.one<{ id: string }>('SELECT id FROM board_columns WHERE board_id = ? ORDER BY position LIMIT 1', board.id) : null;
      if (!board || !column) return reply.code(409).send({ error: 'The board has no column to put the task in' });
      const firstLine = instructions.split('\n').map((l) => l.trim()).find(Boolean) ?? instructions;
      const title = firstLine.length > 80 ? `${firstLine.slice(0, 79).trimEnd()}…` : firstLine;
      const schedule = { every: b.every, at: b.at, ...(b.weekday !== undefined ? { weekday: b.weekday } : {}), agentId, ...(b.model !== undefined ? { model: b.model } : {}), notify: b.notify ?? 'important', newChat: b.newChat ?? true, ...(b.thinking !== undefined ? { thinking: b.thinking } : {}), ...(b.projectId !== undefined ? { projectId: b.projectId } : {}) };
      // Check the schedule before a card is made (a wrong time must not leave a card behind).
      if (!['hourly', 'daily', 'weekly'].includes(String(b.every)) || typeof b.at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.at)) return reply.code(400).send({ error: 'every (hourly, daily, weekly) and at (like 09:00) are needed' });
      const card = await createCard(me.self, board.id, { columnId: column.id, title, description: instructions, ...(agentId ? { agents: [agentId] } : {}) });
      try { await setCardSchedule(me.self, board.id, card.id, schedule); }
      catch (err) { await q.run('DELETE FROM board_cards WHERE id = ?', card.id).catch(() => undefined); throw err; }
      audit(request, me.self, 'schedule', `cardsch:${card.id}`, true);
      return reply.code(201).send({ id: `cardsch:${card.id}`, boardId: board.id, cardId: card.id });
    } catch (err) {
      if (err instanceof BoardError) return reply.code(err.status).send({ error: err.message });
      return fail(reply, err);
    }
  });

  fastify.get<{ Params: { id: string } }>('/api/runs/schedules/:id/runs', async (request, reply) => {
    try {
      const me = who(request);
      return { runs: await scheduleRuns(me.userId, me.userId === null ? me.self : null, request.params.id) };
    } catch (err) { return fail(reply, err); }
  });
}
