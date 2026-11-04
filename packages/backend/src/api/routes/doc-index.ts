/**
 * Document memory (KNOW-INDEX-01; GIRRU_DOC_INDEX). 404 while the switch is
 * off; owner only. No screen uses these yet (the board comes first).
 *
 *   GET   /api/memory/documents                       every source: state, files, chunks, unreadable files (path + reason), limited
 *   PUT   /api/memory/documents/sources               { kind: 'project' | 'agent', refId, enabled } turn a project's folders (or an
 *                                                     agent's knowledge folder) on or off; off forgets that index (files untouched)
 *   POST  /api/memory/documents/sources/:id/reindex   look at that source's files again now (background; answers at once)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authorizeActiveRole } from '../../auth/route-guards.js';
import { docIndexEnabled } from '../../services/doc-index-switch.js';
import { DocIndexError, docIndexStatus, getSource, queueDocIndex, setDocSource } from '../../memory/docs/indexer.js';

const OWNER_ONLY = ['owner'] as const;
type Req = FastifyRequest<{ Params: Record<string, string>; Body: unknown }>;
const bodyOf = (r: { body?: unknown }): Record<string, unknown> => (r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body as Record<string, unknown> : {});

export async function docIndexRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };
  const asOwner = (fn: (ownerId: string, request: Req, reply: FastifyReply) => Promise<unknown>) => async (request: Req, reply: FastifyReply) => {
    if (!docIndexEnabled()) return reply.code(404).send({ code: 'not_found' });
    const ownerId = authorizeActiveRole(request, reply, OWNER_ONLY);
    if (ownerId === null) return reply;
    try { return await fn(ownerId, request, reply); } catch (err) {
      if (err instanceof DocIndexError) return reply.code(err.status).send({ error: err.code, code: err.code });
      throw err;
    }
  };

  fastify.get('/api/memory/documents', { config }, asOwner(async (o) => ({ sources: await docIndexStatus(o) })));
  fastify.put('/api/memory/documents/sources', { config }, asOwner(async (o, r) => {
    const b = bodyOf(r);
    const s = await setDocSource(o, b.kind, b.refId, b.enabled);
    return { source: { id: s.id, kind: s.kind, refId: s.ref_id, enabled: !!s.enabled, state: s.state } };
  }));
  fastify.post('/api/memory/documents/sources/:id/reindex', { config }, asOwner(async (o, r, reply) => {
    const s = /^[0-9a-f]{32}$/.test(r.params.id) ? await getSource(r.params.id) : null;
    if (!s || s.owner_id !== o) return reply.code(404).send({ code: 'not_found' });
    if (!s.enabled) return reply.code(409).send({ code: 'disabled' });
    queueDocIndex(s.id);
    return reply.code(202).send({ queued: true });
  }));
}
