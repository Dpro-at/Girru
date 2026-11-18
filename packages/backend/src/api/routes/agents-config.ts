import { canonicalModelSelection, loadModelCatalogue, ModelSelectionError } from '../../services/model-catalogue.js';
import {LibraryError} from '../../services/personality-library.js';
/**
 * Agent Configurations API
 * CRUD for named agent profiles (name, system prompt, model, capabilities)
 *
 * Names (CORE-02): a new agent without a name gets a random name in the
 * onboarding language; every name used at creation or rename is reserved
 * company-wide for good (used_agent_names), so it never repeats, even after
 * the agent is deleted. POST /api/agents/name-suggestion (owner/admin)
 * returns a suggestion without reserving it.
 *
 * B1.6: data access and scope go through the agents repository
 * (repositories/agents-config.ts): members read, owner/admin write, the
 * reserved small local agent is owner-only. The owner/admin pre-check here
 * stays as defence in depth and keeps 401/403 before 400.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { actorOf } from '../../auth/auth-gate.js';
import { repositories } from '../../repositories/index.js';
import { ScopeError, actorOrReply, requireAdmin, requireMember } from '../../repositories/scope.js';
import type { Actor } from '../../repositories/actor.js';
import {
  AgentConfigConflictError,
  AgentConfigError,
  AgentConfigInputError,
  type AgentConfigInput,
  type AgentConfigRow,
} from '../../repositories/agents-config.js';
import { SECRET_PLACEHOLDER } from '../../credentials/secret-mask.js';
import { agentRenamed } from '../../services/task-file.js';
import { AgentNameInputError, AgentNameTakenError } from '../../services/agent-names.js';
import { etag, expectedVersionFrom, VersionInputError } from '../concurrency.js';
import { isoUtc } from '../timestamps.js';
import { OrgError, orgFields, orgRows, setReportsTo, subAgentWork, quickHelperRequester } from '../../services/agent-org.js';
import { createSubAgent } from '../../services/sub-agents.js';
import { cancelRun } from '../../services/task-runs.js';
import { one, sql } from '../../repositories/sql-steps.js';
import { isOwner } from '../../repositories/scope.js';

const agents = () => repositories.agents;

/** Map scope, naming and agent errors to the usual replies; anything else is rethrown. */
function errorReply(err: unknown, reply: FastifyReply): FastifyReply | null {
  if (err instanceof OrgError) return reply.status(err.code === 'version_conflict' ? 409 : err.status).send({ error: err.message, code: err.code });
  if(err instanceof LibraryError)return reply.status(err.status).send({code:err.status===409?'version_conflict':'invalid_personality',error:'Personality selection changed or is unavailable'});
  if (err instanceof ScopeError) {
    return reply.status(err.status).send(err.code === 'reserved_agent' ? { error: err.message, code: err.code } : { error: err.message });
  }
  if (err instanceof AgentNameTakenError) return reply.status(409).send({ error: err.message, code: 'name_taken' });
  if (err instanceof AgentNameInputError) return reply.status(400).send({ error: err.message });
  if (err instanceof AgentConfigInputError) return reply.status(400).send(err.code ? { error: err.message, code: err.code } : { error: err.message });
  if (err instanceof AgentConfigError) return reply.status(err.status).send({ error: err.message });
  if (err instanceof AgentConfigConflictError) {
    return reply.status(409).header('ETag', etag(err.current.version)).send({
      error: err.message,
      code: 'version_conflict',
      currentVersion: err.current.version,
      agent: parseAgent(err.current),
    });
  }
  return null;
}

/** Request actor through a scope rule (defence in depth), else 401/403 sent and null. */
const member = (req: FastifyRequest, reply: FastifyReply): Actor | null => actorOrReply(reply, actorOf(req), requireMember);
const admin = (req: FastifyRequest, reply: FastifyReply): Actor | null => actorOrReply(reply, actorOf(req), requireAdmin);

function parseAgent(row: AgentConfigRow) {
  // SECURITY (S1.1): the key lives in the encrypted credentials store; the
  // response only says whether one is set. The legacy column is never returned.
  const { api_key: _legacy, api_key_credential_id: _ref, ...rest } = row;
  const apiKeySet = !!row.api_key_credential_id || !!(row.api_key && row.api_key.trim());
  return {
    ...rest,
    // BE-UI-01: ISO-8601 UTC with Z; `version` is the optimistic-concurrency token.
    created_at: isoUtc(row.created_at),
    updated_at: isoUtc(row.updated_at),
    version: row.version ?? 1,
    isPrimary: row.is_primary === 1,
    capabilities: (() => { try { return JSON.parse(row.capabilities); } catch { return {}; } })(),
    apiKeySet,
    api_key: apiKeySet ? SECRET_PLACEHOLDER : '',
  };
}

export async function agentsConfigRoutes(fastify: FastifyInstance) {
  // POST /api/agents/name-suggestion — random unused name in the onboarding language (not reserved)
  fastify.post<{ Body: { language?: unknown; exclude?: unknown } }>(
    '/api/agents/name-suggestion', { config: { access: 'admin' } }, async (req, reply) => {
      const actor = admin(req, reply);
      if (!actor) return reply;
      try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        return reply.send(await agents().suggestName(actor, body));
      } catch (err) {
        const handled = errorReply(err, reply);
        if (handled) return handled;
        fastify.log.error({ err }, '[AgentsConfig] Name suggestion error');
        return reply.status(500).send({ error: 'Failed to suggest a name' });
      }
    });

  // GET /api/agents — list all agents
  fastify.get('/api/agents', async (req, reply) => {
    const actor = member(req, reply);
    if (!actor) return reply;
    try {
      const rows = await agents().listConfigs(actor);
      // AGENTS-ORG-01: who each agent reports to (the owner's choice, else Girru's place) and whose sub-agent it is.
      const org = orgFields(await orgRows());
      return reply.send({ agents: rows.map(r => ({ ...parseAgent(r), ...(org.get(r.id) ?? {}) })) });
    } catch (err: any) {
      const handled = errorReply(err, reply);
      if (handled) return handled;
      fastify.log.error('[AgentsConfig] List error:', err);
      return reply.status(500).send({ error: 'Failed to load agents' });
    }
  });

  // POST /api/agents/departments/rename { from, to } — owner only: every agent in `from` moves to `to`.
  //   400 invalid_input, 403 not the owner, 404 when no agent is in `from`.
  fastify.post<{ Body: unknown }>('/api/agents/departments/rename', { config: { access: 'owner' } }, async (req, reply) => {
    const actor = admin(req, reply);
    if (!actor) return reply;
    try {
      return reply.send(await agents().renameDepartment(actor, req.body));
    } catch (err) {
      const handled = errorReply(err, reply);
      if (handled) return handled;
      return reply.status(500).send({ error: 'Failed to rename the department' });
    }
  });

  // GET /api/agents/:id — get single agent
  fastify.get<{ Params: { id: string } }>('/api/agents/:id', async (req, reply) => {
    const actor = member(req, reply);
    if (!actor) return reply;
    try {
      const row = await agents().getConfig(actor, req.params.id);
      if (!row) return reply.status(404).send({ error: 'Agent not found' });
      return reply.header('ETag', etag(row.version ?? 1)).send({ agent: parseAgent(row) });
    } catch (err: any) {
      const handled = errorReply(err, reply);
      if (handled) return handled;
      return reply.status(500).send({ error: 'Failed to load agent' });
    }
  });

  // POST /api/agents — create agent (CORE-02: no name -> random name, reserved with the insert)
  fastify.post<{ Body: AgentConfigInput }>('/api/agents', async (req, reply) => {
    const actor = admin(req, reply);
    if (!actor) return reply;
    try {
      const row = await agents().createConfig(actor, req.body || {});
      return reply.status(201).send({ agent: parseAgent(row) });
    } catch (err: any) {
      const handled = errorReply(err, reply);
      if (handled) return handled;
      fastify.log.error('[AgentsConfig] Create error:', err);
      return reply.status(500).send({ error: 'Failed to create agent' });
    }
  });

  // PUT /api/agents/:id — update agent (partial body; optimistic concurrency, BE-UI-01)
  //   body: any subset of { name, description, emoji, system_prompt, model, provider,
  //         temperature, max_tokens, capabilities, api_key, role, department }
  //   + optional expectedVersion or header If-Match: "<version>". Only the fields
  //   sent are written. role: main | manager | specialist | evaluator | null;
  //   department: <= 64 chars, stored lowercase, or null (400 code invalid_role).
  //   modelSelection: current catalogue ID, requires a version and excludes raw
  //   model/provider fields; resolved by the backend after actor/version checks.
  //   A role change never changes the personality (CORE-01d).
  //   409 { code: 'version_conflict', currentVersion, agent } when the version moved on.
  fastify.put<{ Params: { id: string }; Body: unknown }>('/api/agents/:id', async (req, reply) => {
    const actor = admin(req, reply);
    if (!actor) return reply;
    try {
      const before = (req.body as { name?: unknown } | null)?.name !== undefined ? (await agents().getConfig(actor, req.params.id).catch(() => null))?.name : undefined;
      let input = req.body;
      if (input && typeof input === 'object' && !Array.isArray(input) && 'modelSelection' in input) {
        const choice = input as Record<string, unknown>;
        if (choice.model !== undefined || choice.provider !== undefined) throw new AgentConfigInputError('Selection cannot be combined with model/provider', 'invalid_model');
        const current = await agents().getConfig(actor, req.params.id);
        if (!current) throw new AgentConfigError(404, 'Agent not found');
        let expected: number | null;
        try { expected = expectedVersionFrom(choice, req.headers['if-match']); }
        catch (error) { if (error instanceof VersionInputError) throw new AgentConfigInputError(error.message, 'invalid_version'); throw error; }
        if (expected === null) throw new AgentConfigInputError('Selection requires expectedVersion', 'invalid_version');
        if (expected !== current.version) throw new AgentConfigConflictError(current);
        try {
          const selected = canonicalModelSelection(choice.modelSelection, (await loadModelCatalogue()).models);
          const { modelSelection: _intent, ...rest } = choice;
          input = { ...rest, ...selected };
        } catch (error) { if (error instanceof ModelSelectionError) throw new AgentConfigInputError('Model is no longer available in the backend catalogue', 'invalid_model'); throw error; }
      }
      const updated = await agents().updateConfig(actor, req.params.id, input, req.headers['if-match']);
      // STORE-MAP-01 P10: a new name reaches the task files that name the agent.
      if (before !== undefined && before !== updated.name) await agentRenamed(req.params.id).catch(() => undefined);
      return reply.header('ETag', etag(updated.version)).send({ agent: parseAgent(updated) });
    } catch (err: any) {
      const handled = errorReply(err, reply);
      if (handled) return handled;
      fastify.log.error('[AgentsConfig] Update error:', err);
      return reply.status(500).send({ error: 'Failed to update agent' });
    }
  });

  // POST /api/agents/:id/set-primary — make this agent the primary one
  fastify.post<{ Params: { id: string } }>('/api/agents/:id/set-primary', async (req, reply) => {
    const actor = admin(req, reply);
    if (!actor) return reply;
    try {
      await agents().setPrimary(actor, req.params.id);
      return reply.send({ success: true });
    } catch (err: any) {
      const handled = errorReply(err, reply);
      if (handled) return handled;
      return reply.status(500).send({ error: 'Failed to set primary agent' });
    }
  });

  // POST /api/agents/:id/duplicate — clone an agent (the copy gets its own new name)
  fastify.post<{ Params: { id: string } }>('/api/agents/:id/duplicate', async (req, reply) => {
    const actor = admin(req, reply);
    if (!actor) return reply;
    try {
      const row = await agents().duplicateConfig(actor, req.params.id);
      return reply.status(201).send({ agent: parseAgent(row) });
    } catch (err: any) {
      const handled = errorReply(err, reply);
      if (handled) return handled;
      return reply.status(500).send({ error: 'Failed to duplicate agent' });
    }
  });

  // PUT /api/agents/:id/reports-to { reportsTo: id | null, expectedVersion? } — owner only (AGENTS-ORG-01).
  //   null hands the place back to Girru. 400 main_fixed / sub_agent / not_movable / invalid_target / circle,
  //   404 not_found, 409 version_conflict.
  fastify.put<{ Params: { id: string }; Body: unknown }>('/api/agents/:id/reports-to', { config: { access: 'owner' } }, async (req, reply) => {
    const actor = admin(req, reply);
    if (!actor) return reply;
    if (!isOwner(actor)) return reply.status(403).send({ error: 'Only the owner changes who an agent reports to' });
    try {
      const res = await setReportsTo(req.params.id, req.body);
      return reply.header('ETag', etag(res.version)).send(res);
    } catch (err) {
      const handled = errorReply(err, reply);
      if (handled) return handled;
      return reply.status(500).send({ error: 'Failed to change who the agent reports to' });
    }
  });

  // POST /api/agents/:id/sub-agents { name?, startsAs: copy|specialty|empty, specialtyId?, description?, tools: [], model?, provider? }
  //   owner only: a new agent that belongs to :id; its tools must be :id's (400 invalid_tools), one level only.
  fastify.post<{ Params: { id: string }; Body: unknown }>('/api/agents/:id/sub-agents', { config: { access: 'owner' } }, async (req, reply) => {
    const actor = admin(req, reply);
    if (!actor) return reply;
    try {
      const { id } = await createSubAgent(actor, req.params.id, req.body);
      const row = await agents().getConfig(actor, id);
      const org = orgFields(await orgRows());
      return reply.status(201).send({ agent: { ...parseAgent(row!), ...(org.get(id) ?? {}) } });
    } catch (err) {
      const handled = errorReply(err, reply);
      if (handled) return handled;
      fastify.log.error({ err }, '[AgentsConfig] Sub-agent error');
      return reply.status(500).send({ error: 'Failed to add the sub-agent' });
    }
  });

  // GET /api/agents/:id/sub-agent-work — owner only: work it gave its sub-agents and quick helpers (newest first, 30 days).
  fastify.get<{ Params: { id: string } }>('/api/agents/:id/sub-agent-work', { config: { access: 'owner' } }, async (req, reply) => {
    const actor = admin(req, reply);
    if (!actor) return reply;
    if (!isOwner(actor)) return reply.status(403).send({ error: 'Only the owner sees this' });
    if (!(await agents().getConfig(actor, req.params.id))) return reply.status(404).send({ error: 'Agent not found' });
    return reply.send({ work: await subAgentWork(actor.userId!, req.params.id) });
  });

  // POST /api/agents/:id/sub-agent-work/:runId/stop — owner only: stop a running quick helper this agent started.
  fastify.post<{ Params: { id: string; runId: string } }>('/api/agents/:id/sub-agent-work/:runId/stop', { config: { access: 'owner' } }, async (req, reply) => {
    const actor = admin(req, reply);
    if (!actor) return reply;
    if (!isOwner(actor)) return reply.status(403).send({ error: 'Only the owner stops work' });
    const mine = await sql().read(one<{ run_id: string }>('SELECT run_id FROM small_agent_runs WHERE run_id = ? AND requested_by = ?', req.params.runId, quickHelperRequester(req.params.id)));
    if (!mine) return reply.status(404).send({ error: 'Work not found' });
    try {
      const run = await cancelRun(req.params.runId, actor.userId!);
      return reply.send({ id: run.id, status: run.status });
    } catch {
      return reply.status(409).send({ error: 'This work has already finished', code: 'finished' });
    }
  });

  // DELETE /api/agents/:id — delete agent (cannot delete primary if others exist)
  fastify.delete<{ Params: { id: string } }>('/api/agents/:id', async (req, reply) => {
    const actor = admin(req, reply);
    if (!actor) return reply;
    try {
      await agents().deleteConfig(actor, req.params.id);
      return reply.send({ success: true });
    } catch (err: any) {
      const handled = errorReply(err, reply);
      if (handled) return handled;
      return reply.status(500).send({ error: 'Failed to delete agent' });
    }
  });
}
