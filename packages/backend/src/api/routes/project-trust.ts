/**
 * Outside projects (REPO-TRUST-01; GIRRU_REPO_TRUST). Owner only; 404 while
 * the switch is off. No screen uses these yet (the board comes first).
 *
 *   GET     /api/memory/project-trust                 every project: outside or not, why (auto / owner), the remote
 *                                                     owner it was judged by; the owners counted as the owner's own
 *   PUT     /api/memory/project-trust/projects/:id    { outside: boolean } put a project on the list or take it off (kept)
 *   DELETE  /api/memory/project-trust/projects/:id    forget the owner's choice: the folder decides again
 *   POST    /api/memory/project-trust/owners          { name, host? } count a remote owner as the owner's own
 *   DELETE  /api/memory/project-trust/owners          { name, host? } stop counting it
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authorizeActiveRole } from '../../auth/route-guards.js';
import { repoTrustEnabled } from '../../services/repo-trust-switch.js';
import { ProjectTrustError, addOwnOwner, projectTrustView, removeOwnOwner, resetProjectTrust, setProjectOutside } from '../../memory/project-trust.js';

const OWNER_ONLY = ['owner'] as const;
type Req = FastifyRequest<{ Params: Record<string, string>; Body: unknown }>;
const bodyOf = (r: { body?: unknown }): Record<string, unknown> => (r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body as Record<string, unknown> : {});

export async function projectTrustRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };
  const asOwner = (fn: (ownerId: string, request: Req, reply: FastifyReply) => Promise<unknown>) => async (request: Req, reply: FastifyReply) => {
    if (!repoTrustEnabled()) return reply.code(404).send({ code: 'not_found' });
    const ownerId = authorizeActiveRole(request, reply, OWNER_ONLY);
    if (ownerId === null) return reply;
    try { return await fn(ownerId, request, reply); } catch (err) {
      if (err instanceof ProjectTrustError) return reply.code(err.status).send({ error: err.code, code: err.code });
      throw err;
    }
  };
  fastify.get('/api/memory/project-trust', { config }, asOwner((o) => projectTrustView(o)));
  fastify.put('/api/memory/project-trust/projects/:id', { config }, asOwner(async (o, r) => ({ project: await setProjectOutside(o, r.params.id, bodyOf(r).outside) })));
  fastify.delete('/api/memory/project-trust/projects/:id', { config }, asOwner(async (o, r) => ({ project: await resetProjectTrust(o, r.params.id) })));
  fastify.post('/api/memory/project-trust/owners', { config }, asOwner(async (o, r) => { const b = bodyOf(r); await addOwnOwner(o, b.name, b.host ?? ''); return { ok: true }; }));
  fastify.delete('/api/memory/project-trust/owners', { config }, asOwner(async (o, r) => { const b = bodyOf(r); await removeOwnOwner(o, b.name, b.host ?? ''); return { ok: true }; }));
}
