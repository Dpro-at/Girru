/**
 * AGENT-BTW-01: HTTP surface for the side-question channel (`/btw`).
 *
 * Owner only. These routes never run the main agent: they read its immutable
 * context snapshot and drive the independent SideQuestion service. Streaming
 * uses the same SSE helper as chat; stop and clear are plain POSTs.
 *
 *   POST /api/chat/btw         { parentSessionId, question }  -> SSE cumulative answer
 *   GET  /api/chat/btw?parentSessionId=...                    -> history + summary
 *   POST /api/chat/btw/stop    { parentSessionId }            -> cancel the running request
 *   POST /api/chat/btw/clear   { parentSessionId }            -> clear history + snapshot
 */

import type { FastifyInstance } from 'fastify';
import { authenticateActiveUser } from '../../auth/route-guards.js';
import { openSseStream, chunkText } from '../../services/chat-sse.js';
import { askSideQuestion, stopSideQuestion, SideQuestionError } from '../../services/side-question/service.js';
import { clearSnapshot, getSnapshot } from '../../services/side-question/snapshot.js';
import { clearSession, ensureSession, listRequests } from '../../services/side-question/store.js';

interface AskBody { parentSessionId?: string; question?: string }
interface SessionBody { parentSessionId?: string }

const ANSWER_FRAME_BYTES = 16_000;

function requireOwner(request: any, reply: any): { id: string } | null {
  const user = authenticateActiveUser(request);
  if (!user) { reply.status(401).send({ error: 'Authentication required' }); return null; }
  if (user.role !== 'owner') { reply.status(403).send({ error: 'Owner only', code: 'forbidden' }); return null; }
  return user;
}

export async function sideQuestionRoutes(fastify: FastifyInstance) {
  // POST /api/chat/btw — ask a side question, stream the cumulative answer.
  fastify.post<{ Body: AskBody }>('/api/chat/btw', async (request, reply) => {
    const user = requireOwner(request, reply);
    if (!user) return reply;
    const parentSessionId = String(request.body?.parentSessionId ?? '').trim();
    const question = String(request.body?.question ?? '');
    if (!parentSessionId) return reply.status(400).send({ error: 'parentSessionId is required' });
    if (!getSnapshot(user.id, parentSessionId)) {
      return reply.status(409).send({ error: 'No agent context is available for this session yet', code: 'no_snapshot' });
    }

    openSseStream(reply.raw);
    const write = (obj: Record<string, unknown>) => { if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`); };
    // Client disconnect cancels the running request (its own cancellation context).
    reply.raw.once('close', () => { void stopSideQuestion(user.id, parentSessionId).catch(() => {}); });

    try {
      let last = '';
      const result = await askSideQuestion(
        { ownerId: user.id, parentSessionId, question },
        {
          onStatus: (status) => { if (status === 'running') write({ type: 'started' }); },
          onDelta: (cumulative) => {
            // Send only the new tail so frames stay small; the client concatenates.
            const delta = cumulative.startsWith(last) ? cumulative.slice(last.length) : cumulative;
            last = cumulative;
            for (const content of chunkText(delta, ANSWER_FRAME_BYTES)) write({ type: 'delta', content });
          },
        },
      );
      write({ type: result.status, requestId: result.requestId, provider: result.provider, model: result.model });
    } catch (err) {
      const e = err instanceof SideQuestionError ? err : null;
      write({ type: 'error', code: e?.code ?? 'internal', error: e ? e.message : 'Side question failed' });
    } finally {
      if (!reply.raw.writableEnded) reply.raw.end();
    }
    return reply;
  });

  // GET /api/chat/btw — history for a parent session.
  fastify.get<{ Querystring: { parentSessionId?: string } }>('/api/chat/btw', async (request, reply) => {
    const user = requireOwner(request, reply);
    if (!user) return reply;
    const parentSessionId = String(request.query?.parentSessionId ?? '').trim();
    if (!parentSessionId) return reply.status(400).send({ error: 'parentSessionId is required' });
    const session = await ensureSession(user.id, parentSessionId);
    const rows = await listRequests(session.id);
    return reply.send({
      parentSessionId,
      hasSnapshot: !!getSnapshot(user.id, parentSessionId),
      summary: session.summary,
      requests: rows.map((r) => ({
        id: r.id, question: r.question, answer: r.answer, status: r.status,
        provider: r.provider, model: r.model, error: r.error, createdAt: r.created_at,
      })),
    });
  });

  // POST /api/chat/btw/stop — cancel the running request for a parent session.
  fastify.post<{ Body: SessionBody }>('/api/chat/btw/stop', async (request, reply) => {
    const user = requireOwner(request, reply);
    if (!user) return reply;
    const parentSessionId = String(request.body?.parentSessionId ?? '').trim();
    if (!parentSessionId) return reply.status(400).send({ error: 'parentSessionId is required' });
    const stopped = await stopSideQuestion(user.id, parentSessionId);
    return reply.send({ stopped });
  });

  // POST /api/chat/btw/clear — clear history and forget the snapshot.
  fastify.post<{ Body: SessionBody }>('/api/chat/btw/clear', async (request, reply) => {
    const user = requireOwner(request, reply);
    if (!user) return reply;
    const parentSessionId = String(request.body?.parentSessionId ?? '').trim();
    if (!parentSessionId) return reply.status(400).send({ error: 'parentSessionId is required' });
    await stopSideQuestion(user.id, parentSessionId).catch(() => {});
    const cleared = await clearSession(user.id, parentSessionId);
    clearSnapshot(user.id, parentSessionId);
    return reply.send({ cleared });
  });
}
