/**
 * MODELS-01-INSTALL routes (GIRRU_MEMORY_HELPER). Each answers 404 while the
 * switch is off; owner only. The job itself runs in the background
 * (memory/helper.ts); these only read its state or start a try now.
 *
 *   GET   /api/memory/helper          the helper's state (phase, progress, fallback reason; no text, no paths)
 *   POST  /api/memory/helper/retry    try again now (after a failed download); returns at once
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authorizeActiveRole } from '../../auth/route-guards.js';
import { memoryHelperEnabled } from '../../services/memory-helper-switch.js';
import { memoryHelperRow, memoryHelperStatus, retryMemoryHelper } from '../../memory/helper.js';

const OWNER_ONLY = ['owner'] as const;

export async function memoryHelperRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };
  const asOwner = (fn: () => unknown) => async (request: FastifyRequest, reply: FastifyReply) => {
    if (!memoryHelperEnabled()) return reply.code(404).send({ code: 'not_found' });
    if (authorizeActiveRole(request, reply, OWNER_ONLY) === null) return reply;
    return fn();
  };
  fastify.get('/api/memory/helper', { config }, asOwner(() => ({ status: memoryHelperStatus(), row: memoryHelperRow() })));
  fastify.post('/api/memory/helper/retry', { config }, asOwner(() => {
    void retryMemoryHelper().catch(() => undefined);
    return { started: true };
  }));
}
