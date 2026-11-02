/**
 * STORE-MAP-01 pilot (CX6): one resolved agent context for every entry point.
 *
 * Chat, task runs and coding-app replies used to build three different
 * prompts, so the same agent had a different identity in each (the hired
 * instructions never reached chat, the owner rules never reached task runs,
 * coding apps got no pinned facts). This resolves the agent ONCE: identity,
 * definition (hired instructions, personality text, behaviour, skills and
 * specialties), owner rules and, per the policy, the data parts. Renderers
 * (render.ts) only format it.
 */

import { one, sql } from '../../repositories/sql-steps.js';
import { findProject } from '../../repositories/chat-conversations.js';
import { readPersonality, getDefaultPersonality } from '../agent-files.js';
import { stripPersonalityExport } from '../personality.js';
import { libraryBehavior } from '../personality-library.js';
import { agentSkillsPrompt } from '../../skills/central-store.js';
import { teamContext } from '../agent-org.js';
import { knowledgeContext } from '../agent-file-library.js';
import { rulesContext, sessionProject } from '../agent-rules.js';
import { pinnedFactsBlock } from '../../memory/scopes/pinned.js';
import { handoffText, projectHandoff } from '../../memory/bridge/brief.js';
import { selectDrawers, type DrawerRef } from '../../memory/drawers.js';
import { outsiderAgentMemoryEnabled } from '../outsider-memory.js';
import { evaluateContextPolicy, type ContextPolicy, type EntryPoint } from './policy.js';

export interface ResolvedAgentContext {
  entry: EntryPoint;
  policy: ContextPolicy;
  agent: { id: string; name: string };
  ownerId: string | null;
  project: { id: string; slug: string; name: string } | null;
  definition: {
    /** The instructions the agent was hired with (agents_config.system_prompt). */
    hired: string;
    /** PERSONALITY.md written for this agent ('' for the untouched template). */
    personality: string;
    /** The owner-set behaviour profile. */
    behavior: string;
    /** Linked specialties and assigned skills. */
    skills: string;
    /** Place in the team (names only; grants nothing). */
    team: string;
    /** Knowledge files the owner marked as read by this agent (reference data). */
    knowledge: string;
  };
  ownerRules: string;
  data: { pinnedFacts: string; handoff: string };
  /** The drawers recall may read in this context (policy applied before any retrieval). */
  drawers: DrawerRef[];
}

export interface ResolveInput {
  agentId: string;
  entry: EntryPoint;
  ownerId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
}

export class AgentContextError extends Error {}

export async function resolveAgentContext(input: ResolveInput): Promise<ResolvedAgentContext> {
  const policy = evaluateContextPolicy(input.entry, { outsiderMemory: outsiderAgentMemoryEnabled() });
  const agent = await sql().read(one<{ id: string; name: string; system_prompt: string | null }>(
    'SELECT id, name, system_prompt FROM agents_config WHERE id = ?', input.agentId));
  if (!agent) throw new AgentContextError('agent_context_unavailable');

  const projectId = input.projectId !== undefined ? input.projectId : await sessionProject(input.sessionId);
  const ownerId = input.ownerId ?? null;
  const project = projectId && ownerId ? await findProject(ownerId, projectId) : undefined;

  const file = await readPersonality(agent.id).catch(() => '');
  const personality = file && file.trim() !== getDefaultPersonality().trim() ? stripPersonalityExport(file).trim() : '';
  const behavior = (await libraryBehavior(agent.id).catch(() => null))?.promptBlock ?? '';

  const data = { pinnedFacts: '', handoff: '' };
  if (ownerId && policy.pinnedFacts) data.pinnedFacts = await pinnedFactsBlock(ownerId, project?.slug ?? null).catch(() => '');
  if (ownerId && project && policy.handoff) {
    const h = await projectHandoff(ownerId, project.id).catch(() => null);
    data.handoff = h ? handoffText(h) : '';
  }

  return {
    entry: input.entry,
    policy,
    agent: { id: agent.id, name: agent.name },
    ownerId,
    project: project ? { id: project.id, slug: project.slug, name: project.name } : null,
    definition: {
      hired: (agent.system_prompt ?? '').trim(),
      personality,
      behavior: behavior.trim(),
      skills: (await agentSkillsPrompt(agent.id)).trim(),
      team: (await teamContext(agent.id).catch(() => '')).trim(),
      knowledge: policy.memory ? (await knowledgeContext(agent.id).catch(() => '')).trim() : '',
    },
    ownerRules: await rulesContext(agent.id, { projectId: projectId ?? null }).catch(() => ''),
    data,
    drawers: policy.memory ? selectDrawers({ audience: 'owner', project: project?.slug ?? null }) : [],
  };
}
