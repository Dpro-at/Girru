/**
 * STORE-MAP-01 P8 (D24-D29): task links, handoff blockers and run notes. Owner
 * only (auth gate owner tier + handler check). Registered only while
 * GIRRU_STORE_P8 is on at start; with it off none of these routes exist.
 *
 *   GET   /api/boards/:id/cards/:cardId/links   -> { taskNo, notesPlace, handoffs (newest first), chats, taskFile, blocked }
 *   PATCH /api/handoffs/:id { blockers }        -> { handoff } (the owner edits blockers only; files touched stay read only)
 *   GET   /api/runs/:runId/notes?kind=chat|task|delegation
 *                                               -> { notes: [{ seq, text, at }], clearsAt } (read only; runId may also be
 *                                                  the Runs id: chat:…, task:…, handoff:… = a delegation)
 *
 * 400 { code: 'invalid_request' }, 404 { code: 'not_found' } (also for another owner's card, handoff or run).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authorizeActiveRole } from '../../auth/route-guards.js';
import { storeP8Enabled } from '../../services/store-p8.js';
import { cardLinks, setBlockers } from '../../memory/handoff/links.js';
import { HandoffInputError } from '../../memory/handoff/store.js';
import { listRunNotes, RUN_KINDS, type RunKind } from '../../memory/handoff/run-notes.js';

const OWNER_ONLY = ['owner'] as const;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HANDOFF_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
/** Runs page id prefixes and the run kind they keep notes under. */
const RUNS_PREFIX: Record<string, RunKind> = { chat: 'chat', task: 'task', handoff: 'delegation' };

type Req = FastifyRequest<{ Params: Record<string, string | undefined>; Querystring: Record<string, string | undefined>; Body: unknown }>;

export async function storeP8Routes(fastify: FastifyInstance) {
  if (!storeP8Enabled()) return;
  const config = { access: 'owner' as const };
  const owner = (request: FastifyRequest, reply: FastifyReply) => authorizeActiveRole(request, reply, OWNER_ONLY);
  const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error, code: 'invalid_request' });
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'Not found', code: 'not_found' });

  // D24: everything linked to task T-n (its card).
  fastify.get('/api/boards/:id/cards/:cardId/links', { config }, async (request: Req, reply) => {
    const ownerId = owner(request, reply);
    if (ownerId === null) return reply;
    const { id, cardId } = request.params;
    if (!ID.test(id ?? '') || !ID.test(cardId ?? '')) return notFound(reply);
    const links = await cardLinks(ownerId, id!, cardId!);
    return links ?? notFound(reply);
  });

  // D29: the owner edits a handoff's blockers (nothing else).
  fastify.patch('/api/handoffs/:id', { config }, async (request: Req, reply) => {
    const ownerId = owner(request, reply);
    if (ownerId === null) return reply;
    if (!HANDOFF_ID.test(request.params.id ?? '')) return notFound(reply);
    const b = request.body;
    if (b === null || typeof b !== 'object' || Array.isArray(b)) return bad(reply, 'Body must be a JSON object');
    const keys = Object.keys(b);
    if (keys.length !== 1 || keys[0] !== 'blockers') return bad(reply, 'Only blockers can be changed');
    try {
      const handoff = await setBlockers(ownerId, request.params.id!, (b as { blockers: unknown }).blockers);
      return handoff ? { handoff } : notFound(reply);
    } catch (err) {
      if (err instanceof HandoffInputError) return bad(reply, err.message);
      throw err;
    }
  });

  // D27: a run's working notes, read only.
  fastify.get('/api/runs/:runId/notes', { config }, async (request: Req, reply) => {
    const ownerId = owner(request, reply);
    if (ownerId === null) return reply;
    let runId = request.params.runId ?? '';
    let kind = request.query?.kind as RunKind | undefined;
    if (kind !== undefined && !(RUN_KINDS as readonly string[]).includes(kind)) return bad(reply, 'kind must be chat, task or delegation');
    const colon = runId.indexOf(':');
    if (colon > 0 && RUNS_PREFIX[runId.slice(0, colon)]) {
      const fromId = RUNS_PREFIX[runId.slice(0, colon)];
      if (kind && kind !== fromId) return bad(reply, 'kind does not match the run id');
      kind = fromId;
      runId = runId.slice(colon + 1);
    }
    if (!kind) return bad(reply, 'kind must be chat, task or delegation');
    if (!RUN_ID.test(runId)) return notFound(reply);
    return listRunNotes({ ownerId, runKind: kind, runId });
  });
}
