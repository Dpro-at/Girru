/**
 * Add a sub-agent (AGENTS-ORG-01, board SA1): a new agent that belongs to one
 * agent. Owner only.
 *
 *   startsAs  copy       its agent's job (description, instructions, role,
 *                        department, specialties) and personality
 *             specialty  one specialty from the library (linked)
 *             empty      a description the owner writes
 *   tools     only tools its agent has (tools/grants.ts refuses the rest)
 *
 * Steps: create the agent (repositories/agents-config.ts), link it to its
 * agent with the chosen tools (grants), link the specialty. If a later step
 * fails, the new agent is removed again, so nothing half-made stays.
 */

import type { Actor } from '../repositories/actor.js';
import { repositories } from '../repositories/index.js';
import { isOwner } from '../repositories/scope.js';
import { one, run, sql } from '../repositories/sql-steps.js';
import { OrgError, orgRows, placeAgents } from './agent-org.js';
import { currentPersonalityStep } from './personality-store.js';
import { createAgentToolsRegistry } from '../tools/index.js';
import { GrantValidationError, loadAgentGrants } from '../tools/grants.js';
import { copyPersonalityStep, writePersonalityView } from './personality-record.js';

const KEYS = new Set(['name', 'startsAs', 'specialtyId', 'description', 'tools', 'model', 'provider']);
const PROVIDERS = new Set(['claude', 'openai', 'gemini', 'ollama', 'lmstudio', 'local']);

export async function createSubAgent(actor: Actor | null | undefined, parentId: string, input: unknown): Promise<{ id: string }> {
  if (!isOwner(actor)) throw new OrgError(403, 'owner_only', 'Only the owner adds sub-agents');
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
  if (!body || Object.keys(body).some(k => !KEYS.has(k))) throw new OrgError(400, 'invalid_input', 'Unknown field');
  const startsAs = body.startsAs ?? 'copy';
  if (startsAs !== 'copy' && startsAs !== 'specialty' && startsAs !== 'empty') throw new OrgError(400, 'invalid_input', 'startsAs must be copy, specialty or empty');
  if (!Array.isArray(body.tools) || body.tools.length > 200 || body.tools.some(t => typeof t !== 'string')) throw new OrgError(400, 'invalid_input', 'tools must be a list of tool names');
  if (body.model !== undefined && (typeof body.model !== 'string' || !body.model || body.model.length > 150)) throw new OrgError(400, 'invalid_input', 'model must be text');
  if (body.provider !== undefined && (typeof body.provider !== 'string' || !PROVIDERS.has(body.provider))) throw new OrgError(400, 'invalid_input', 'unknown provider');
  if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 1000)) throw new OrgError(400, 'invalid_input', 'description is at most 1000 characters');

  const rows = await orgRows();
  const placed = placeAgents(rows).get(parentId);
  if (!placed) throw new OrgError(404, 'not_found', 'Agent not found');
  if (placed.placed === 'none') throw new OrgError(400, 'not_allowed', 'The small local agent cannot have sub-agents');
  if (placed.placed === 'sub') throw new OrgError(400, 'one_level', 'A sub-agent cannot have sub-agents of its own');
  const parent = (await repositories.agents.getConfig(actor, parentId))!;

  let specialty: { id: string; name: string; description: string; department: string } | undefined;
  if (startsAs === 'specialty') {
    if (typeof body.specialtyId !== 'string' || body.specialtyId.length > 64) throw new OrgError(400, 'invalid_input', 'specialtyId is required');
    specialty = await sql().read(one<{ id: string; name: string; description: string; department: string }>('SELECT id, name, description, department FROM specialty_templates WHERE id = ?', body.specialtyId));
    if (!specialty) throw new OrgError(404, 'not_found', 'Specialty not found');
  } else if (body.specialtyId !== undefined) throw new OrgError(400, 'invalid_input', 'specialtyId only with startsAs specialty');

  const copy = startsAs === 'copy';
  let personality: Record<string, unknown> | undefined;
  if (copy) {
    const current = await sql().read(currentPersonalityStep(parentId));
    if (current && current.version > 0) personality = { traits: current.traits, dialect: current.dialect, note: `Copy of ${parent.name}` };
  }
  // Check the tools before anything is made: a name, once used, stays reserved for good.
  const available = (await createAgentToolsRegistry({ workspaceDir: process.cwd() })).listRegistered().filter(t => !t.selfOnly);
  const parentTools = (await loadAgentGrants(parentId, available)).tools;
  const missing = (body.tools as string[]).find(t => !parentTools.has(t));
  if (missing) throw new OrgError(400, 'invalid_tools', `"${missing}" is not something ${parent.name} may use; a sub-agent only gets a part of its agent's tools`);
  const created = await repositories.agents.createConfig(actor, {
    ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name } : {}),
    description: typeof body.description === 'string' ? body.description : copy ? parent.description : specialty?.description ?? '',
    system_prompt: copy ? parent.system_prompt : '',
    model: typeof body.model === 'string' ? body.model : parent.model,
    provider: typeof body.provider === 'string' ? body.provider : parent.provider,
    role: 'specialist',
    department: parent.department ?? null,
    ...(personality ? { personality } : {}),
  });
  try {
    await repositories.agents.setGrants(actor, created.id, { grants: body.tools, parentAgentId: parentId }, available);
    await sql().tx(function* () {
      if (specialty) yield* run('INSERT INTO agent_specialties(agent_id, template_id, linked_by) VALUES(?, ?, ?)', created.id, specialty.id, actor!.userId!);
      if (copy) yield* run('INSERT INTO agent_specialties(agent_id, template_id, linked_by) SELECT ?, template_id, ? FROM agent_specialties WHERE agent_id = ?', created.id, actor!.userId!, parentId);
      // STORE-MAP-01 P4 (G3): a copy also takes its agent's personality text.
      if (copy) yield* copyPersonalityStep(parentId, created.id, actor!.userId!);
    });
    if (copy) await writePersonalityView(created.id).catch(() => {});
  } catch (err) {
    await repositories.agents.deleteConfig(actor, created.id).catch(() => {});
    if (err instanceof GrantValidationError) throw new OrgError(400, 'invalid_tools', err.message);
    throw err;
  }
  return { id: created.id };
}
