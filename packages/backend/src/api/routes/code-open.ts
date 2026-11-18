/**
 * CODE-OPEN-01: "Open in Code" (boards C1–C3). Owner only.
 *
 *   POST  /api/code-open   { path, line? } -> { folder, file, path, line, generated, where, project }
 *
 * Only a regular file inside one of the owner's projects or Girru's data folder
 * (real path checked, no links; services/code-open.ts). 403 { code: 'outside' }
 * for anything else: nothing opens. The page then opens the answer in the Code
 * page (the desktop checks the same again), or shows it in Finder / Explorer.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authorizeActiveRole } from '../../auth/route-guards.js';
import { CodeOpenError, codeTarget } from '../../services/code-open.js';

const OWNER_ONLY = ['owner'] as const;

export async function codeOpenRoutes(fastify: FastifyInstance) {
  fastify.post('/api/code-open', { config: { access: 'owner' as const } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ownerId = authorizeActiveRole(request, reply, OWNER_ONLY);
    if (ownerId === null) return reply;
    const b = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
    try { return await codeTarget(ownerId, { path: b.path, line: b.line }); } catch (err) {
      if (err instanceof CodeOpenError) return reply.code(err.status).send({ error: err.message, code: err.code });
      throw err;
    }
  });
}
