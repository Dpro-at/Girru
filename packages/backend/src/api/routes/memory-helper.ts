/**
 * MODELS-01-INSTALL + MEM-PANEL-01 routes (GIRRU_MEMORY_HELPER). Each answers
 * 404 while the switch is off; owner only. The job itself runs in the
 * background (memory/helper.ts); these read its state, its RAM and settings.
 *
 *   GET   /api/memory/helper            { status, row, ram, settings, candidates }  (no text, no paths)
 *   POST  /api/memory/helper/retry      try again now (after a failed download); returns at once
 *   PUT   /api/memory/helper/settings   { ram?: { mode, customGb? }, worker?: model | null } -> { settings, ram, candidates }
 *                                       400 invalid_settings · 409 worker_not_installed / worker_too_big / worker_off_in_light
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authorizeActiveRole } from '../../auth/route-guards.js';
import { memoryHelperEnabled } from '../../services/memory-helper-switch.js';
import { helperEmbeddingModel, memoryHelperRow, memoryHelperStatus, retryMemoryHelper } from '../../memory/helper.js';
import { HelperSettingsError, helperSettings, ramView, setHelperSettings, workerCandidates } from '../../memory/helper-settings.js';
import { repositories } from '../../repositories/index.js';
import { requestMeta } from '../../repositories/audit.js';
import { actorOf } from '../../auth/auth-gate.js';

const OWNER_ONLY = ['owner'] as const;

/** Everything the Memory helper place and its Settings page show. */
export async function memoryHelperView() {
  const model = helperEmbeddingModel();
  return { status: memoryHelperStatus(), row: memoryHelperRow(), ram: await ramView(), settings: helperSettings(), candidates: await workerCandidates(model) };
}

export async function memoryHelperRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };
  const asOwner = (fn: (request: FastifyRequest, reply: FastifyReply) => unknown) => async (request: FastifyRequest, reply: FastifyReply) => {
    if (!memoryHelperEnabled()) return reply.code(404).send({ code: 'not_found' });
    if (authorizeActiveRole(request, reply, OWNER_ONLY) === null) return reply;
    reply.header('Cache-Control', 'no-store');
    return fn(request, reply);
  };
  fastify.get('/api/memory/helper', { config }, asOwner(() => memoryHelperView()));
  fastify.post('/api/memory/helper/retry', { config }, asOwner(() => {
    void retryMemoryHelper().catch(() => undefined);
    return { started: true };
  }));
  fastify.put('/api/memory/helper/settings', { config }, asOwner(async (request, reply) => {
    const before = helperSettings();
    try {
      const settings = await setHelperSettings(request.body, helperEmbeddingModel());
      const actor = actorOf(request);
      if (actor) void repositories.audit.record(actor, {
        event_type: 'data.update', event_category: 'data_modification', severity: 'info', resource_type: 'memory_helper', resource_id: 'settings',
        action: 'memory.helper_settings', success: true, metadata: { ram: settings.ram, worker: settings.worker },
      }, requestMeta(request));
      // A newly chosen night writer is checked (and its RAM state shown) by the helper job.
      if (settings.worker && settings.worker !== before.worker) void retryMemoryHelper().catch(() => undefined);
      const view = await memoryHelperView();
      return { settings, ram: view.ram, candidates: view.candidates };
    } catch (err) {
      if (err instanceof HelperSettingsError) return reply.code(err.code === 'invalid_settings' ? 400 : 409).send({ error: err.message, code: err.code });
      throw err;
    }
  }));
}
