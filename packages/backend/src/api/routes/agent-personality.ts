/**
 * Agent personality API (CORE-01). Owner only (auth gate owner tier for
 * /api/agents/:id/personality/*, route access 'owner', handler role check).
 * Every change is a new version and is written to the audit log.
 *
 *   GET  /api/agents/:id/personality/current    current version + behaviour + presets
 *   GET  /api/agents/:id/personality/versions   all versions, newest first
 *   POST /api/agents/:id/personality/versions   { traits?, preset?, dialect?, lockedTraits?, note? }
 *   POST /api/agents/:id/personality/lock       lock (no saves or rollbacks until unlocked)
 *   POST /api/agents/:id/personality/unlock
 *   POST /api/agents/:id/personality/rollback   { version }
 *
 * Drift proposals (CORE-01c, MEM-03): proposal-only, the owner decides.
 *   POST /api/agents/:id/personality/proposals              owner or admin
 *        { traits | delta, reason, evidence? } -> 201 proposal (pending)
 *   GET  /api/agents/:id/personality/proposals[?status=]    owner
 *   GET  /api/agents/:id/personality/proposals/:pid         owner
 *   POST /api/agents/:id/personality/proposals/:pid/approve owner
 *        { expectedReviewHash } -> { proposal, version }
 *   POST /api/agents/:id/personality/proposals/:pid/reject  owner
 *        { expectedReviewHash, note? } -> proposal
 *   POST /api/agents/:id/personality/proposals/:pid/cancel  owner, or the owner/admin
 *        { expectedReviewHash } -> proposal (status 'cancelled')  who created it (CORE-01d)
 * Every proposal carries `reviewHash`. Error codes: 400 `review_hash_required`
 * | `no_change`, 409 `personality_locked` | `already_decided` | `stale` |
 * `review_changed`, 403 (cancel by someone else), 429 `too_many_pending`. created_by / decided_by come
 * from the request actor, never from the body. Agents and Evolution file
 * proposals through repositories.agents.proposePersonalityDrift (no route).
 *
 * Personality shapes prompting and confirmation behaviour only; it never
 * grants tools or permissions (those are /api/agents/:id/tool-grants).
 */

import { actorOf } from '../../auth/auth-gate.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { repositories } from '../../repositories/index.js';
import { ScopeError, actorOrReply, requireAdmin, requireOwner } from '../../repositories/scope.js';
import { logAudit } from '../../services/audit-logger.js';
import { safeErrorFields } from '../../services/safe-error-log.js';
import { sendInternalError } from '../error-handler.js';
import { DIALECTS, PRESETS, PersonalityInputError, TRAIT_NAMES, traitsToBehavior } from '../../services/personality.js';
import {
  PROPOSAL_STATUSES,
  PersonalityLockedError,
  PersonalityNotFoundError,
  PersonalityProposalError,
  exportPersonalityFile,
  type PersonalityProposal,
  type PersonalityVersion,
  type ProposalStatus,
} from '../../services/personality-store.js';
import { storeP4Enabled } from '../../services/store-p4.js';
import { PersonalityVersionConflict, recordText, savePersonalityText, writePersonalityView } from '../../services/personality-record.js';

const AGENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Owner account id (central rule, repositories/scope.ts), else 401/403 sent and null. */
function ownerOf(request: FastifyRequest, reply: FastifyReply): string | null {
  const actor = actorOrReply(reply, actorOf(request), requireOwner);
  return actor ? actor.userId ?? null : null;
}

/** Owner or admin account id, else 401/403 sent and null. */
function adminOf(request: FastifyRequest, reply: FastifyReply): string | null {
  const actor = actorOrReply(reply, actorOf(request), requireAdmin);
  return actor ? actor.userId ?? null : null;
}

const PROPOSAL_ID = /^[0-9a-f-]{36}$/;

function view(p: PersonalityVersion) {
  return { ...p, behavior: traitsToBehavior(p.traits, p.dialect) };
}

/**
 * Unexpected errors -> generic 500, safe-field log (FU-03). ScopeError keeps
 * its own status through the framework handler, as before.
 */
function internalError(reply: FastifyReply, route: string, err: unknown): FastifyReply {
  if (err instanceof ScopeError) throw err;
  return sendInternalError(reply, `[Personality] ${route}`, err);
}

type Params = { Params: { id: string } };
type ProposalParams = { Params: { id: string; pid: string } };

export async function agentPersonalityRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };

  async function change(
    request: FastifyRequest<Params>, reply: FastifyReply, action: string,
    run: (agentId: string) => Promise<PersonalityVersion>,
  ) {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    const agentId = request.params.id;
    if (!AGENT_ID.test(agentId)) return reply.code(400).send({ error: 'Invalid agent id' });
    const audit = (success: boolean, extra: { error_message?: string; metadata?: Record<string, unknown> }) => logAudit({
      event_type: 'data.update', event_category: 'data_modification', severity: 'info',
      user_id: ownerId, ip_address: request.ip, user_agent: request.headers['user-agent'],
      request_method: request.method, request_path: request.routeOptions?.url ?? undefined,
      resource_type: 'agent', resource_id: agentId, action, success, ...extra,
    });
    let result: PersonalityVersion;
    try {
      result = await run(agentId);
    } catch (err) {
      if (err instanceof PersonalityInputError) { audit(false, { error_message: err.message }); return reply.code(400).send({ error: err.message }); }
      if (err instanceof PersonalityLockedError) { audit(false, { error_message: err.message }); return reply.code(409).send({ error: err.message }); }
      if (err instanceof PersonalityNotFoundError) return reply.code(404).send({ error: err.message });
      if (err instanceof PersonalityVersionConflict) { audit(false, { error_message: 'changed' }); return reply.code(409).send({ error: 'The personality changed since you opened it', code: 'changed' }); }
      return internalError(reply, action, err);
    }
    audit(true, { metadata: { version: result.version, source: result.source, traits: result.traits, dialect: result.dialect, locked: result.locked } });
    try {
      await exportPersonalityFile(result);
    } catch (err) {
      // The database is canonical; a failed readable export does not undo the version.
      request.log.warn(safeErrorFields(err), '[Personality] PERSONALITY.md export failed');
    }
    return view(result);
  }

  fastify.get<Params>('/api/agents/:id/personality/current', { config }, async (request, reply) => {
    if (ownerOf(request, reply) === null) return reply;
    if (!AGENT_ID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid agent id' });
    try {
      const current = await repositories.agents.currentPersonality(actorOf(request), request.params.id);
      if (!current) return reply.code(404).send({ error: 'Agent not found' });
      // STORE-MAP-01 P4 (T7): the text is part of the one personality record.
      const record = storeP4Enabled() ? await recordText(request.params.id) : null;
      return {
        ...view(current),
        ...(record ? { text: record.text } : {}),
        traitNames: TRAIT_NAMES,
        dialects: DIALECTS,
        presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, traits: p.traits })),
      };
    } catch (err) {
      return internalError(reply, 'GET /api/agents/:id/personality/current', err);
    }
  });

  fastify.get<Params>('/api/agents/:id/personality/versions', { config }, async (request, reply) => {
    if (ownerOf(request, reply) === null) return reply;
    if (!AGENT_ID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid agent id' });
    try {
      const versions = await repositories.agents.personalityVersions(actorOf(request), request.params.id);
      if (!versions) return reply.code(404).send({ error: 'Agent not found' });
      return { agentId: request.params.id, versions };
    } catch (err) {
      return internalError(reply, 'GET /api/agents/:id/personality/versions', err);
    }
  });

  fastify.post<Params & { Body: Record<string, unknown> }>('/api/agents/:id/personality/versions', { config }, async (request, reply) => {
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : null;
    if (!body) {
      if (ownerOf(request, reply) === null) return reply;
      return reply.code(400).send({ error: 'Body must be an object' });
    }
    return change(request, reply, 'agent_personality.save', (agentId) => repositories.agents.savePersonality(actorOf(request), agentId, body));
  });

  fastify.post<Params>('/api/agents/:id/personality/lock', { config }, async (request, reply) =>
    change(request, reply, 'agent_personality.lock', (agentId) => repositories.agents.setPersonalityLocked(actorOf(request), agentId, true)));

  fastify.post<Params>('/api/agents/:id/personality/unlock', { config }, async (request, reply) =>
    change(request, reply, 'agent_personality.unlock', (agentId) => repositories.agents.setPersonalityLocked(actorOf(request), agentId, false)));

  fastify.post<Params & { Body: { version?: unknown } }>('/api/agents/:id/personality/rollback', { config }, async (request, reply) =>
    change(request, reply, 'agent_personality.rollback', (agentId) => repositories.agents.rollbackPersonality(actorOf(request), agentId, request.body?.version)));

  // STORE-MAP-01 P4 (T7, D15): the owner edits the personality text; saved at once as a new version
  // (Undo = rollback to the version before). Body { text, expectedVersion } — the version the editor showed.
  fastify.put<Params & { Body: { text?: unknown; expectedVersion?: unknown } }>('/api/agents/:id/personality/text', { config }, async (request, reply) => {
    if (!storeP4Enabled()) return reply.code(404).send({ error: 'Not found' });
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : null;
    if (!body || Object.keys(body).some((k) => k !== 'text' && k !== 'expectedVersion')) {
      if (ownerOf(request, reply) === null) return reply;
      return reply.code(400).send({ error: 'Body must be { text, expectedVersion }' });
    }
    if (body.expectedVersion === undefined) {
      if (ownerOf(request, reply) === null) return reply;
      return reply.code(400).send({ error: 'expectedVersion is required (the version you read)', code: 'expected_version_required' });
    }
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    return change(request, reply, 'agent_personality.text', (agentId) => savePersonalityText(agentId, body.text, body.expectedVersion, ownerId));
  });
  // --- drift proposals (CORE-01c) -------------------------------------------

  const ownerConfig = { access: 'owner' as const };
  const adminConfig = { access: 'admin' as const };

  function proposalError(err: unknown, reply: FastifyReply): FastifyReply | null {
    if (err instanceof PersonalityProposalError) return reply.code(err.status).send({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    if (err instanceof PersonalityInputError) return reply.code(400).send({ error: err.message });
    if (err instanceof PersonalityNotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof ScopeError) return reply.code(err.status).send({ error: err.message, code: err.code });
    return null;
  }

  function proposalAudit(
    request: FastifyRequest, userId: string, action: string, success: boolean, agentId: string,
    metadata: Record<string, unknown>, error_message?: string,
  ) {
    logAudit({
      event_type: 'data.update', event_category: 'data_modification', severity: 'info',
      user_id: userId, ip_address: request.ip, user_agent: request.headers['user-agent'],
      request_method: request.method, request_path: request.routeOptions?.url ?? undefined,
      resource_type: 'agent', resource_id: agentId, action, success, metadata,
      ...(error_message ? { error_message } : {}),
    });
  }

  const summary = (p: PersonalityProposal) => ({ proposalId: p.id, baseVersion: p.baseVersion, delta: p.delta, source: p.source, status: p.status });

  fastify.post<Params & { Body: unknown }>('/api/agents/:id/personality/proposals', { config: adminConfig }, async (request, reply) => {
    const userId = adminOf(request, reply);
    if (userId === null) return reply;
    const agentId = request.params.id;
    if (!AGENT_ID.test(agentId)) return reply.code(400).send({ error: 'Invalid agent id' });
    try {
      const proposal = await repositories.agents.createPersonalityProposal(actorOf(request), agentId, request.body);
      proposalAudit(request, userId, 'agent_personality.proposal.create', true, agentId, summary(proposal));
      return reply.code(201).send(proposal);
    } catch (err) {
      const handled = proposalError(err, reply);
      if (handled) {
        if (err instanceof PersonalityProposalError) proposalAudit(request, userId, 'agent_personality.proposal.create', false, agentId, { code: err.code }, err.message);
        return handled;
      }
      return internalError(reply, 'agent_personality.proposal.create', err);
    }
  });

  fastify.get<Params & { Querystring: { status?: string } }>('/api/agents/:id/personality/proposals', { config: ownerConfig }, async (request, reply) => {
    if (ownerOf(request, reply) === null) return reply;
    if (!AGENT_ID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid agent id' });
    const status = request.query?.status;
    if (status !== undefined && !(PROPOSAL_STATUSES as readonly string[]).includes(status)) return reply.code(400).send({ error: 'Invalid status' });
    try {
      const proposals = await repositories.agents.personalityProposals(actorOf(request), request.params.id, status as ProposalStatus | undefined);
      if (!proposals) return reply.code(404).send({ error: 'Agent not found' });
      return { agentId: request.params.id, proposals };
    } catch (err) {
      return internalError(reply, 'GET /api/agents/:id/personality/proposals', err);
    }
  });

  fastify.get<ProposalParams>('/api/agents/:id/personality/proposals/:pid', { config: ownerConfig }, async (request, reply) => {
    if (ownerOf(request, reply) === null) return reply;
    if (!AGENT_ID.test(request.params.id) || !PROPOSAL_ID.test(request.params.pid)) return reply.code(404).send({ error: 'Proposal not found' });
    try {
      const proposal = await repositories.agents.personalityProposal(actorOf(request), request.params.id, request.params.pid);
      if (!proposal) return reply.code(404).send({ error: 'Proposal not found' });
      return proposal;
    } catch (err) {
      return internalError(reply, 'GET /api/agents/:id/personality/proposals/:pid', err);
    }
  });

  const bodyOf = (request: FastifyRequest): Record<string, unknown> =>
    request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};

  fastify.post<ProposalParams>('/api/agents/:id/personality/proposals/:pid/approve', { config: ownerConfig }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    const { id: agentId, pid } = request.params;
    if (!AGENT_ID.test(agentId) || !PROPOSAL_ID.test(pid)) return reply.code(404).send({ error: 'Proposal not found' });
    try {
      const result = await repositories.agents.approvePersonalityProposal(actorOf(request), agentId, pid, bodyOf(request).expectedReviewHash);
      proposalAudit(request, ownerId, 'agent_personality.proposal.approve', true, agentId, {
        ...summary(result.proposal), version: result.version.version, traits: result.version.traits,
      });
      try {
        await exportPersonalityFile(result.version);
      } catch (err) {
        // The database is canonical; a failed readable export does not undo the approval.
        request.log.warn(safeErrorFields(err), '[Personality] PERSONALITY.md export failed');
      }
      return { proposal: result.proposal, version: view(result.version) };
    } catch (err) {
      const handled = proposalError(err, reply);
      if (handled) {
        if (err instanceof PersonalityProposalError) proposalAudit(request, ownerId, 'agent_personality.proposal.approve', false, agentId, { proposalId: pid, code: err.code }, err.message);
        return handled;
      }
      return internalError(reply, 'agent_personality.proposal.approve', err);
    }
  });

  fastify.post<ProposalParams>('/api/agents/:id/personality/proposals/:pid/reject', { config: ownerConfig }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    const { id: agentId, pid } = request.params;
    if (!AGENT_ID.test(agentId) || !PROPOSAL_ID.test(pid)) return reply.code(404).send({ error: 'Proposal not found' });
    try {
      const b = bodyOf(request);
      const proposal = await repositories.agents.rejectPersonalityProposal(actorOf(request), agentId, pid, b.expectedReviewHash, b.note);
      proposalAudit(request, ownerId, 'agent_personality.proposal.reject', true, agentId, summary(proposal));
      // T7b: "No" to a change made outside Girru writes the record back into PERSONALITY.md.
      if (proposal.origin === 'file') await writePersonalityView(agentId).catch((err) => request.log.warn(safeErrorFields(err), '[Personality] PERSONALITY.md write-back failed'));
      return proposal;
    } catch (err) {
      const handled = proposalError(err, reply);
      if (handled) {
        if (err instanceof PersonalityProposalError) proposalAudit(request, ownerId, 'agent_personality.proposal.reject', false, agentId, { proposalId: pid, code: err.code }, err.message);
        return handled;
      }
      return internalError(reply, 'agent_personality.proposal.reject', err);
    }
  });

  fastify.post<ProposalParams>('/api/agents/:id/personality/proposals/:pid/cancel', { config: adminConfig }, async (request, reply) => {
    const userId = adminOf(request, reply);
    if (userId === null) return reply;
    const { id: agentId, pid } = request.params;
    if (!AGENT_ID.test(agentId) || !PROPOSAL_ID.test(pid)) return reply.code(404).send({ error: 'Proposal not found' });
    try {
      const proposal = await repositories.agents.cancelPersonalityProposal(actorOf(request), agentId, pid, bodyOf(request).expectedReviewHash);
      proposalAudit(request, userId, 'agent_personality.proposal.cancel', true, agentId, summary(proposal));
      return proposal;
    } catch (err) {
      const handled = proposalError(err, reply);
      if (handled) {
        if (err instanceof PersonalityProposalError || err instanceof ScopeError) {
          proposalAudit(request, userId, 'agent_personality.proposal.cancel', false, agentId, { proposalId: pid, code: err.code }, err.message);
        }
        return handled;
      }
      return internalError(reply, 'agent_personality.proposal.cancel', err);
    }
  });
}
