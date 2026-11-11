import {createUnprotectedReadStream,assertMemoryFilesystemAccess} from '../../memory/encryption/protected-filesystem.js';
/**
 * GET /api/uploads/* — serve runtime uploads from `.data/uploads` (CL-05).
 *
 * Signed-in users only (auth gate default); the per-path rule is
 * `canReadUpload` (own avatars/backgrounds/animations, shared profiles and
 * logos; everything else owner/admin). Not allowed and not found both answer
 * 404 so the route does not reveal which files exist.
 */

import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { canReadUpload, resolveUploadFile, uploadMimeType } from '../../services/uploads.js';

export async function uploadsRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { '*': string } }>('/api/uploads/*', async (request, reply) => {
    const user = request.authUser;
    // Fastify has already decoded the wildcard once; never decode again.
    const rel = request.params['*'] ?? '';
    if (!user || !canReadUpload(user, rel)) return reply.code(404).send({ error: 'Not found' });
    const file = resolveUploadFile(rel);
    if (!file) return reply.code(404).send({ error: 'Not found' });
    return reply
      .type(uploadMimeType(file))
      .header('Cache-Control', 'private, max-age=300')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
      .header('Content-Disposition', 'inline')
      .send((assertMemoryFilesystemAccess(file),createUnprotectedReadStream(file)));
  });
}
