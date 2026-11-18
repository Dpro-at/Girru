/**
 * Document memory (KNOW-INDEX-01; GIRRU_DOC_INDEX). 404 while the switch is
 * off; owner only. Settings › Memory › Documents (board K1) and the chat use them.
 *
 *   GET   /api/memory/documents                       every project (switch, folders, status, files that can't be read) + the agents' knowledge folders
 *   PUT   /api/memory/documents/sources               { kind: 'project' | 'agent', refId, enabled } turn a project's folders (or an
 *                                                     agent's knowledge folder) on or off; off forgets that index (files untouched)
 *   POST  /api/memory/documents/sources/:id/reindex   look at that source's files again now (background; answers at once)
 *   POST  /api/memory/documents/read-pdf              { data: base64 } → { text } (pages marked) or { reason }: a PDF a chat attaches,
 *                                                     read with the same reader; nothing is kept
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authorizeActiveRole } from '../../auth/route-guards.js';
import { docIndexEnabled } from '../../services/doc-index-switch.js';
import { DocIndexError, documentsView, getSource, queueDocIndex, setDocSource } from '../../memory/docs/indexer.js';
import { pdfAsText } from '../../services/agent-file-library.js';

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

  fastify.get('/api/memory/documents', { config }, asOwner(async (o) => documentsView(o)));
  fastify.put('/api/memory/documents/sources', { config }, asOwner(async (o, r) => {
    const b = bodyOf(r);
    const s = await setDocSource(o, b.kind, b.refId, b.enabled);
    return { source: { id: s.id, kind: s.kind, refId: s.ref_id, enabled: !!s.enabled, state: s.state } };
  }));
  // A chat attachment: 10 MB of PDF at most (base64 is a third larger).
  fastify.post('/api/memory/documents/read-pdf', { config, bodyLimit: 15 * 1024 * 1024 }, asOwner(async (_o, r, reply) => {
    const data = bodyOf(r).data;
    if (typeof data !== 'string' || !data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) return reply.code(400).send({ code: 'invalid_input' });
    const buf = Buffer.from(data, 'base64');
    if (buf.length > 10 * 1024 * 1024) return reply.code(413).send({ code: 'too_large' });
    return pdfAsText(buf);
  }));
  fastify.post('/api/memory/documents/sources/:id/reindex', { config }, asOwner(async (o, r, reply) => {
    const s = /^[0-9a-f]{32}$/.test(r.params.id) ? await getSource(r.params.id) : null;
    if (!s || s.owner_id !== o) return reply.code(404).send({ code: 'not_found' });
    if (!s.enabled) return reply.code(409).send({ code: 'disabled' });
    queueDocIndex(s.id);
    return reply.code(202).send({ queued: true });
  }));
}
