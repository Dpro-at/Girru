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
import { rulesByPrecedence, rulesContext, sessionProject } from '../agent-rules.js';
import { guidesIndex } from './guides.js';
import { storeP2Enabled } from './switch.js';
import { pinnedFactsBlock, scopeFactAccess } from '../../memory/scopes/pinned.js';
import { loadRunPermissions } from '../../tools/agent-permissions.js';
import { narrowProjectMemory } from '../../tools/memory/project-access.js';
import { handoffText, projectHandoff } from '../../memory/bridge/brief.js';
import { selectDrawers, type DrawerRef } from '../../memory/drawers.js';
import { outsiderAgentMemoryEnabled } from '../outsider-memory.js';
import { evaluateContextPolicy, type ContextPolicy, type EntryPoint } from './policy.js';
import { projectKeyOf } from '../../memory/project-keys.js';

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
  /** The drawers recall may read in this context: the policy, then this agent's memory access (applied before any retrieval). */
  drawers: DrawerRef[];
  /** P2: skills and specialties are listed by name; the agent reads one with guide_read. */
  guidesByName: boolean;
}

export interface ResolveInput {
  agentId: string;
  entry: EntryPoint;
  ownerId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  /** Chat only: instructions sent with the request replace the hired instructions and personality text (as before). */
  instructionsOverride?: string | null;
}

/** Longest instructions or personality text kept (the middle is cut, like chat did). */
export const DEFINITION_CHARS = 32_000;
function capMiddle(text: string, max = DEFINITION_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 40) / 2);
  return `${text.slice(0, half)}\n[… shortened …]\n${text.slice(-half)}`;
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

  const override = input.instructionsOverride?.trim() || '';
  const file = override ? '' : await readPersonality(agent.id).catch(() => '');
  const personality = file && file.trim() !== getDefaultPersonality().trim() ? stripPersonalityExport(file).trim() : '';
  // P2 (AG1, AG6): guides by name with the full text on demand; owner rules in precedence order.
  const p2 = storeP2Enabled();
  const behavior = (await libraryBehavior(agent.id).catch(() => null))?.promptBlock ?? '';

  // What THIS agent may read here (CORE-PERMS-01, MEM-SCALE-01), applied before anything is loaded,
  // as chat does: pinned facts by its fact access, the handoff and the drawers by its memory access.
  const slug = project ? projectKeyOf(project) : null; // the project's memory key (P3: its id)
  const perms = ownerId && policy.memory
    ? await loadRunPermissions(agent.id, [], { userId: ownerId, project: slug }).catch(() => null)
    : null;
  const memoryRead: readonly string[] = perms?.memoryRead ?? [];
  const openDrawers = policy.memory ? selectDrawers({ audience: 'owner', project: slug }) : [];
  const drawers = perms && ownerId
    ? ((await narrowProjectMemory({ agentId: agent.id, userId: ownerId, memoryDrawers: openDrawers }).catch(() => [])) ?? []).filter((d) => memoryRead.includes(d.kind))
    : [];

  const data = { pinnedFacts: '', handoff: '' };
  if (ownerId && perms && policy.pinnedFacts) {
    const allow = scopeFactAccess(perms, openDrawers.some((d) => d.kind === 'owner'));
    if (allow.company || allow.project) data.pinnedFacts = await pinnedFactsBlock(ownerId, slug, allow).catch(() => '');
  }
  if (ownerId && perms && project && policy.handoff && drawers.some((d) => d.kind === 'project')) {
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
      hired: capMiddle(override || (agent.system_prompt ?? '').trim()),
      personality: capMiddle(personality),
      behavior: behavior.trim(),
      skills: (p2 ? await guidesIndex(agent.id) : await agentSkillsPrompt(agent.id)).trim(),
      team: (await teamContext(agent.id).catch(() => '')).trim(),
      knowledge: policy.memory ? (await knowledgeContext(agent.id).catch(() => '')).trim() : '',
    },
    ownerRules: await (p2 ? rulesByPrecedence(agent.id, projectId ?? null) : rulesContext(agent.id, { projectId: projectId ?? null })).catch(() => ''),
    data,
    drawers,
    guidesByName: p2,
  };
}
