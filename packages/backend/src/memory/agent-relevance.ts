/**
 * Relevance by agent (STORE-MAP-01 P9, M3). Permissions decide what an agent
 * MAY see; this decides what comes first among what it may see, so a backend
 * agent and a marketing agent get different memories from the same project.
 *
 * An agent's profile: the words of its specialty (agents_config.specialty and
 * the linked specialty templates' names), its department's name, and the
 * agents of the same department (its team). A recalled memory is relevant to
 * the agent when it was written by the agent or its team, or when it uses the
 * profile's words. The recall score is multiplied by
 *
 *   1 + AGENT_RELEVANCE_WEIGHT · (0.5 · team + 0.5 · min(1, shared words / 2))
 *
 * so relevance reorders the candidates search already found (at most +25 %);
 * it never adds a memory, never lets a weak match pass the recall floor and
 * never changes how many memories go into the prompt. No profile (no agent,
 * or no specialty, department or team): the order stays as it is.
 * GIRRU_STORE_P9 only; the caller checks the switch.
 */

import { all, one, sql } from '../repositories/sql-steps.js';
import { lexicalTokens } from './text-normalize.js';

export const AGENT_RELEVANCE_WEIGHT = 0.25;
/** Profile words kept (names only, never long descriptions). */
const MAX_TERMS = 40;
const MAX_TEAM = 200;

export interface AgentProfile {
  agentId: string;
  /** Lexical tokens of the specialty and department names. */
  terms: ReadonlySet<string>;
  /** The agent and the agents of its department. */
  team: ReadonlySet<string>;
}

/** The agent's profile, or null when there is nothing to rank by. */
export async function agentProfile(agentId: string | null | undefined): Promise<AgentProfile | null> {
  if (!agentId) return null;
  const a = await sql().read(one<{ specialty: string | null; department: string | null; department_id: string | null }>(
    'SELECT specialty, department, department_id FROM agents_config WHERE id = ?', agentId));
  if (!a) return null;
  const templates = await sql().read(all<{ name: string; department: string | null }>(`
    SELECT t.name, t.department FROM agent_specialties s JOIN specialty_templates t ON t.id = s.template_id
     WHERE s.agent_id = ? ORDER BY t.name LIMIT 20`, agentId));
  const dept = a.department_id
    ? await sql().read(one<{ name: string }>('SELECT name FROM departments WHERE id = ?', a.department_id))
    : null;
  const words = [a.specialty, a.department, dept?.name, ...templates.flatMap((t) => [t.name, t.department])]
    .filter((s): s is string => typeof s === 'string' && !!s.trim())
    .join(' ');
  const terms = new Set(lexicalTokens(words).slice(0, MAX_TERMS));
  const team = new Set<string>([agentId]);
  const deptName = (a.department ?? '').trim().toLowerCase();
  if (a.department_id || deptName) {
    const rows = await sql().read(all<{ id: string }>(`
      SELECT id FROM agents_config
       WHERE id <> ? AND ((? <> '' AND department_id = ?) OR (? <> '' AND LOWER(TRIM(department)) = ?))
       ORDER BY id LIMIT ?`, agentId, a.department_id ?? '', a.department_id ?? '', deptName, deptName, MAX_TEAM));
    for (const r of rows) team.add(r.id);
  }
  // Its own memories alone are no profile: every memory it reads is the owner's or its own.
  if (!terms.size && team.size === 1) return null;
  return { agentId, terms, team };
}

/** 0–1: how relevant a memory is to the agent (see the module comment). */
export function agentRelevance(profile: AgentProfile, m: { content: string; sourceAgentId?: string | null }): number {
  const fromTeam = m.sourceAgentId && profile.team.has(m.sourceAgentId) ? 1 : 0;
  let shared = 0;
  if (profile.terms.size) {
    for (const t of new Set(lexicalTokens(m.content))) if (profile.terms.has(t)) shared++;
  }
  return 0.5 * fromTeam + 0.5 * Math.min(1, shared / 2);
}

/** The recall score with the agent's relevance applied. */
export function rankedScore(score: number, profile: AgentProfile | null, m: { content: string; sourceAgentId?: string | null }): number {
  return profile ? score * (1 + AGENT_RELEVANCE_WEIGHT * agentRelevance(profile, m)) : score;
}
