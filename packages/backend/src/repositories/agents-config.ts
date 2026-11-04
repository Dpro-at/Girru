import {seedLibraryPersonality} from '../services/personality-library.js';
/**
 * Agent configurations (B1.6, part of the agents repository): CRUD for the
 * named agent profiles in `agents_config` and their names (CORE-02).
 * Scope rules (scope.ts):
 *
 *   listConfigs / getConfig            member accounts (owner/admin/user)
 *   suggestName / createConfig /
 *   updateConfig / setPrimary /
 *   duplicateConfig / deleteConfig     owner or admin
 *   the reserved small local agent     owner only for update / set-primary /
 *   (MCP-01b, `small-local-agent`)     delete (403 code `reserved_agent`)
 *
 * Agent runs and channel turns have no access (agent configuration is a
 * permission/config change). Names: a new agent without a name gets a random
 * name in the onboarding language; every name used at creation, rename or
 * duplicate is reserved company-wide for good (same transaction as the row).
 * Updates use optimistic concurrency (BE-UI-01): `expectedVersion` in the
 * body or `If-Match`; a moved version -> AgentConfigConflictError.
 *
 * The API key never lands in the row: it goes to the encrypted credentials
 * store (S1.1).
 *
 * CORE-01c: creation takes an optional `role` (main | manager | specialist |
 * evaluator) and `department`; version 1 of the personality is seeded from
 * the role's default preset (services/personality.ts defaultPresetForRole).
 * An explicit `personality` at creation is the owner's choice and wins (owner
 * only: personality changes are owner actions). Without role and personality
 * nothing is seeded (the agent reads as defaults, as before). Personality
 * never grants tools or permissions.
 *
 * CORE-01d: updateConfig also takes `role` / `department` (same validation as
 * create, 400 `invalid_role`); a change never touches the personality (the
 * role only picks the default preset of new agents). duplicateConfig copies
 * role and department, not personality versions (the copy starts with none,
 * as a duplicate always did).
 */

import { randomBytes } from 'node:crypto';
import type { Actor } from './actor.js';
import { ScopeError, isOwner, isSystem, requireAdmin, requireMember } from './scope.js';
import { all, dialect, one, run, sql, type Step } from './sql-steps.js';
import { nowText } from '../db/pg/dialect.js';
import { setAgentApiKey, removeAgentApiKey } from '../credentials/authority.js';
import {
  normalizeAgentName,
  reserveAgentName,
  resolveNamingLanguage,
  suggestAgentName,
  validateAgentName,
  validateExclude,
  type NameSuggestion,
} from '../services/agent-names.js';
import { VersionInputError, expectedVersionFrom } from '../api/concurrency.js';
import { AGENT_ROLES, PersonalityInputError, isAgentRole, normalizeDepartment, type AgentRole } from '../services/personality.js';
import { checkOwnerPersonalityInput, seedPersonalityForNewAgent, type SaveInput } from '../services/personality-store.js';
import { seedNewAgentPermissionsStep } from '../tools/agent-permissions.js';
import { releaseReportsStep } from '../services/agent-org.js';
import { storeP3Enabled } from '../services/store-p3.js';
import { storeP4Enabled } from '../services/store-p4.js';
import { copyPersonalityStep, writePersonalityView } from '../services/personality-record.js';
import { companyOwnerStep, departmentKey, linkAgentDepartment, renameDepartmentEverywhere, syncDepartments } from '../services/departments.js';

export interface AgentConfigRow {
  id: string;
  name: string;
  description: string;
  emoji: string;
  system_prompt: string;
  model: string;
  provider: string;
  is_primary: number;
  temperature: number;
  max_tokens: number;
  capabilities: string;
  api_key: string;
  api_key_credential_id?: string | null;
  version: number;
  /** CORE-01c: 'main' | 'manager' | 'specialist' | 'evaluator', or null (migration 075). */
  role?: string | null;
  /** CORE-01c: normalized lowercase department, or null. */
  department?: string | null;
  /** AGENTS-ORG-01: the agent this one reports to, or null (Girru places it; migration 144). */
  reports_to?: string | null;
  created_at: string;
  updated_at: string;
}

export type AgentConfigInput = Partial<Omit<AgentConfigRow, 'capabilities' | 'role' | 'department'>> & {
  capabilities?: object | string;
  language?: unknown;
  expectedVersion?: unknown;
  /** Create (CORE-01c: picks the default personality preset) and update (CORE-01d: metadata only). */
  role?: unknown;
  department?: unknown;
  /** Creation only, owner only: explicit { preset?, traits?, dialect?, lockedTraits?, note? } (wins over the role default). */
  personality?: unknown;
  libraryPersonality?: unknown;
};

/** Invalid input (400), optionally with a machine code (e.g. `invalid_version`). */
export class AgentConfigInputError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

/** A rule of the agents (400 primary delete, 404 missing). */
export class AgentConfigError extends Error {
  constructor(readonly status: 400 | 404, message: string) { super(message); }
}

/** The version moved on (409); carries the current row. */
export class AgentConfigConflictError extends Error {
  constructor(readonly current: AgentConfigRow) { super('The agent was changed by someone else; reload it and try again'); }
}

/**
 * services/small-agent.ts SMALL_AGENT_ID. Not imported from there: that
 * module loads the tools registry, which loads the repositories (cycle).
 * The scope matrix checks both stay equal.
 */
export const RESERVED_AGENT_ID = 'small-local-agent';

export const RESERVED_AGENT_MSG = 'The small local agent is reserved; only the owner can change it';
const NOT_FOUND = 'Agent not found';

export interface AgentConfigsRepository {
  listConfigs(actor: Actor | null | undefined): Promise<AgentConfigRow[]>;
  getConfig(actor: Actor | null | undefined, id: string): Promise<AgentConfigRow | null>;
  suggestName(actor: Actor | null | undefined, input: { language?: unknown; exclude?: unknown }): Promise<NameSuggestion>;
  createConfig(actor: Actor | null | undefined, input: AgentConfigInput): Promise<AgentConfigRow>;
  updateConfig(actor: Actor | null | undefined, id: string, input: unknown, ifMatch?: unknown): Promise<AgentConfigRow>;
  setPrimary(actor: Actor | null | undefined, id: string): Promise<void>;
  duplicateConfig(actor: Actor | null | undefined, id: string): Promise<AgentConfigRow>;
  deleteConfig(actor: Actor | null | undefined, id: string): Promise<void>;
  renameDepartment(actor: Actor | null | undefined, input: unknown): Promise<{ from: string; to: string; moved: number }>;
}

function* rowStep(id: string): Step<AgentConfigRow | undefined> {
  return yield* one<AgentConfigRow>('SELECT * FROM agents_config WHERE id = ?', id);
}
const row = (id: string) => sql().read(rowStep(id));
/**
 * Reserve the name, insert the agents_config row, seed personality v1 and
 * the safe default permissions (CORE-PERMS-01).
 * A step: run it inside a transaction (createConfig, and the batch hire of
 * ONBOARD-TEAM-02 together with its own bookkeeping row).
 */
export function* insertAgentConfigStep(input: {
  id: string; name: string; language: string | null; body: AgentConfigInput;
  role: AgentRole | null; department: string | null; explicit: SaveInput | null; userId: string | null;
}): Step<void> {
  const { id, name, language, body, role, department, explicit, userId } = input;
  yield* reserveAgentName(name, id, { reason: 'create', language, reservedBy: userId });
  yield* run(`
    INSERT INTO agents_config (id, name, description, emoji, system_prompt, model, provider, temperature, max_tokens, capabilities, api_key, role, department)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)
  `,
    id,
    name,
    body.description || '',
    body.emoji || '🤖',
    body.system_prompt || '',
    body.model || 'claude-sonnet-4-5-20250929',
    body.provider || 'claude',
    body.temperature ?? 0.7,
    body.max_tokens ?? 4096,
    typeof body.capabilities === 'object' ? JSON.stringify(body.capabilities) : (body.capabilities || '{}'),
    role,
    department,
  );
  if(body.libraryPersonality!==undefined) yield* seedLibraryPersonality(id,userId??'system',body.libraryPersonality);
  else if (role || explicit) yield* seedPersonalityForNewAgent(id, { role, department, explicit }, userId ?? 'system');
  // D7: every new agent starts at Careful, including agents created in batches.
  yield* seedNewAgentPermissionsStep(id, userId);
}

export const newAgentId = () => `agent-${Date.now()}-${randomBytes(3).toString('hex')}`;

/** Owner/admin; the reserved small local agent: owner only (MCP-01b). */
function adminFor(actor: Actor | null | undefined, id: string): Actor {
  const a = requireAdmin(actor);
  if (id === RESERVED_AGENT_ID && !isSystem(a) && !isOwner(a)) throw new ScopeError(403, RESERVED_AGENT_MSG, 'reserved_agent');
  return a;
}

/**
 * role / department as sent (create and update share the rules): role is one
 * of AGENT_ROLES, or null / '' for none; department is normalized lowercase,
 * at most 64 characters, or null. 400 code `invalid_role` otherwise.
 */
function roleAndDepartment(body: { role?: unknown; department?: unknown }): { role: AgentRole | null; department: string | null } {
  try {
    let role: AgentRole | null = null;
    if (body.role !== undefined && body.role !== null && body.role !== '') {
      if (!isAgentRole(body.role)) throw new PersonalityInputError(`role must be one of: ${AGENT_ROLES.join(', ')}`);
      role = body.role;
    }
    return { role, department: normalizeDepartment(body.department) };
  } catch (err) {
    if (err instanceof PersonalityInputError) throw new AgentConfigInputError(err.message, 'invalid_role');
    throw err;
  }
}

export const agentConfigs: AgentConfigsRepository = {
  /**
   * Settings › Departments: rename a department, so every agent in it moves to
   * the new name (each agent's version moves on). Owner only. A department is
   * the agents' own `department` value; there is no separate list to keep.
   */
  async renameDepartment(actor, input) {
    if (!isOwner(actor)) throw new ScopeError(403, 'Only the owner can rename a department');
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
    if (!body || Object.keys(body).some(k => k !== 'from' && k !== 'to')) throw new AgentConfigInputError('from and to are required', 'invalid_input');
    let from: string | null, to: string | null;
    try { from = normalizeDepartment(body.from); to = normalizeDepartment(body.to); } catch { throw new AgentConfigInputError('A department is at most 64 characters', 'invalid_input'); }
    if (!from || !to || /[\u0000-\u001f\u007f]/.test(to)) throw new AgentConfigInputError('from and to are required', 'invalid_input');
    if (from === to) return { from, to, moved: 0 };
    if (storeP3Enabled()) {
      // P3: rename the department in the one list; rules, boards and projects follow too.
      await syncDepartments();
      const owner = await sql().read(companyOwnerStep());
      const dep = owner ? await sql().read(one<{ id: string }>('SELECT id FROM departments WHERE owner_id = ? AND norm_name = ?', owner, departmentKey(from))) : undefined;
      if (!owner || !dep) throw new AgentConfigError(404, 'No agent is in that department');
      const n = await sql().read(one<{ n: number }>('SELECT COUNT(*) AS n FROM agents_config WHERE department_id = ? AND id != ?', dep.id, RESERVED_AGENT_ID));
      await renameDepartmentEverywhere(owner, dep.id, String(body.to).trim());
      return { from, to, moved: Number(n?.n ?? 0) };
    }
    const moved = await sql().tx(function* () {
      const d = yield* dialect();
      const r = yield* run(`UPDATE agents_config SET department = ?, updated_at = ${nowText(d)} WHERE department = ? AND id != ?`, to, from, RESERVED_AGENT_ID);
      return r.changes;
    });
    if (!moved) throw new AgentConfigError(404, 'No agent is in that department');
    return { from, to, moved };
  },

  async listConfigs(actor) {
    requireMember(actor);
    return sql().read(all<AgentConfigRow>('SELECT * FROM agents_config ORDER BY is_primary DESC, created_at ASC'));
  },

  async getConfig(actor, id) {
    requireMember(actor);
    return (await row(id)) ?? null;
  },

  async suggestName(actor, input) {
    const a = requireAdmin(actor);
    const language = await resolveNamingLanguage(a.userId, input.language);
    return suggestAgentName(language, validateExclude(input.exclude));
  },

  async createConfig(actor, body) {
    const a = requireAdmin(actor);
    // CORE-01c: role/department pick the default personality; explicit personality is the owner's.
    const { role, department } = roleAndDepartment(body);
    let explicit: SaveInput | null = null;
    try {
      if (body.personality !== undefined && body.personality !== null) {
        if (typeof body.personality !== 'object' || Array.isArray(body.personality)) throw new PersonalityInputError('personality must be an object');
        explicit = body.personality as SaveInput;
        checkOwnerPersonalityInput(explicit);
      }
    } catch (err) {
      if (err instanceof PersonalityInputError) throw new AgentConfigInputError(err.message, 'invalid_personality');
      throw err;
    }
    if(body.libraryPersonality!==undefined && body.personality!==undefined) throw new AgentConfigInputError('Choose one personality source','invalid_personality');
    if ((explicit || body.libraryPersonality!==undefined) && !isSystem(a) && !isOwner(a)) {
      throw new ScopeError(403, 'Only the owner can set a personality; leave it out to use the role default');
    }
    const id = newAgentId();
    // CORE-02: no name -> random name in the onboarding language.
    let name: string;
    let language: string | null = null;
    if (body.name === undefined || body.name === null || body.name === '') {
      const suggestion = await suggestAgentName(await resolveNamingLanguage(a.userId, body.language));
      name = suggestion.name;
      language = suggestion.language;
    } else {
      name = validateAgentName(body.name);
      if (body.language !== undefined) language = await resolveNamingLanguage(a.userId, body.language);
    }

    await sql().tx(() => insertAgentConfigStep({ id, name, language, body, role, department, explicit, userId: a.userId ?? null }));
    if (department && storeP3Enabled()) await linkAgentDepartment(id);

    // SECURITY (S1.1): the key goes to the encrypted credentials store only.
    if (typeof body.api_key === 'string' && body.api_key.trim()) await setAgentApiKey(id, body.api_key);
    return (await row(id)) as AgentConfigRow;
  },

  async updateConfig(actor, id, raw, ifMatch) {
    const a = adminFor(actor, id);
    if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
      throw new AgentConfigInputError('Body must be a JSON object');
    }
    const body = (raw || {}) as AgentConfigInput;

    let expected: number | null;
    try {
      expected = expectedVersionFrom(body, ifMatch);
    } catch (err) {
      if (err instanceof VersionInputError) throw new AgentConfigInputError(err.message, 'invalid_version');
      throw err;
    }

    const existing = await row(id);
    if (!existing) throw new AgentConfigError(404, NOT_FOUND);
    if (expected !== null && expected !== existing.version) throw new AgentConfigConflictError(existing);

    // Only the fields that were sent (partial update; no stale rewrite of the others).
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    const text = (k: 'description' | 'emoji' | 'system_prompt' | 'model' | 'provider') => {
      if (body[k] === undefined) return null;
      if (typeof body[k] !== 'string') return `${k} must be a string`;
      sets.push(`${k} = ?`); args.push(body[k] as string);
      return null;
    };
    const num = (k: 'temperature' | 'max_tokens') => {
      if (body[k] === undefined) return null;
      if (typeof body[k] !== 'number' || !Number.isFinite(body[k] as number)) return `${k} must be a number`;
      sets.push(`${k} = ?`); args.push(body[k] as number);
      return null;
    };
    for (const problem of [text('description'), text('emoji'), text('system_prompt'), text('model'), text('provider'), num('temperature'), num('max_tokens')]) {
      if (problem) throw new AgentConfigInputError(problem);
    }
    // CORE-01d: role / department (same rules as create). Changing them never
    // touches the personality; the role only picks defaults for new agents.
    if (body.role !== undefined || body.department !== undefined) {
      const parsed = roleAndDepartment(body);
      if (body.role !== undefined) { sets.push('role = ?'); args.push(parsed.role); }
      if (body.department !== undefined) { sets.push('department = ?'); args.push(parsed.department); }
    }
    if (body.capabilities !== undefined) {
      sets.push('capabilities = ?');
      args.push(typeof body.capabilities === 'object' && body.capabilities !== null ? JSON.stringify(body.capabilities) : String(body.capabilities));
    }

    // CORE-02 / D-AGENT-RENAME: a new name must be free company-wide and is
    // reserved for good (same transaction as the update).
    const name = body.name !== undefined ? validateAgentName(body.name) : existing.name;
    const renamed = normalizeAgentName(name) !== normalizeAgentName(existing.name ?? '');
    if (body.name !== undefined && name !== existing.name) { sets.push('name = ?'); args.push(name); }

    const LOST = Symbol('version_conflict');
    try {
      await sql().tx(function* () {
        const d = yield* dialect();
        if (renamed) yield* reserveAgentName(name, id, { reason: 'rename', reservedBy: a.userId });
        if (sets.length) {
          // Compare-and-set: on PostgreSQL a concurrent update holds the row
          // lock; this one then re-checks `version` and changes nothing.
          const r = yield* run(`UPDATE agents_config SET ${sets.join(', ')}, updated_at = ${nowText(d)} WHERE id = ?${expected !== null ? ' AND version = ?' : ''}`,
            ...args, id, ...(expected !== null ? [expected] : []));
          if (r.changes === 0) throw LOST; // rolls back the name reservation too
        }
      });
    } catch (err) {
      if (err !== LOST) throw err;
      const current = await row(id);
      if (!current) throw new AgentConfigError(404, NOT_FOUND);
      throw new AgentConfigConflictError(current);
    }
    if (body.department !== undefined && storeP3Enabled()) await linkAgentDepartment(id);

    // SECURITY (S1.1): a new key goes to the encrypted credentials store; an
    // empty or masked value keeps the stored key.
    if (typeof body.api_key === 'string' && body.api_key.trim()) await setAgentApiKey(id, body.api_key);
    return (await row(id)) as AgentConfigRow;
  },

  async setPrimary(actor, id) {
    adminFor(actor, id);
    if (!(await row(id))) throw new AgentConfigError(404, NOT_FOUND);
    await sql().tx(function* () {
      const d = yield* dialect();
      yield* run(`UPDATE agents_config SET is_primary = 0, updated_at = ${nowText(d)}`);
      yield* run(`UPDATE agents_config SET is_primary = 1, updated_at = ${nowText(d)} WHERE id = ?`, id);
    });
  },

  async duplicateConfig(actor, id) {
    const a = requireAdmin(actor);
    const original = await row(id);
    if (!original) throw new AgentConfigError(404, NOT_FOUND);
    const newId = newAgentId();
    // CORE-02: a copy is a new agent, so it gets its own new unique name.
    const suggestion = await suggestAgentName(await resolveNamingLanguage(a.userId));
    await sql().tx(function* () {
      yield* reserveAgentName(suggestion.name, newId, { reason: 'duplicate', language: suggestion.language, reservedBy: a.userId });
      yield* run(`
        INSERT INTO agents_config (id, name, description, emoji, system_prompt, model, provider, temperature, max_tokens, capabilities, role, department)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        newId,
        suggestion.name,
        original.description,
        original.emoji,
        original.system_prompt,
        original.model,
        original.provider,
        original.temperature,
        original.max_tokens,
        original.capabilities,
        original.role ?? null,
        original.department ?? null,
      );
      // STORE-MAP-01 P4 (G3): the copy starts with the original's personality record (text + adjustments).
      yield* copyPersonalityStep(id, newId, a.userId ?? 'system');
    });
    if (storeP4Enabled()) await writePersonalityView(newId).catch(() => {});
    return (await row(newId)) as AgentConfigRow;
  },

  async deleteConfig(actor, id) {
    adminFor(actor, id);
    const existing = await row(id);
    if (!existing) throw new AgentConfigError(404, NOT_FOUND);
    const totalCount = (await sql().read(one<{ cnt: number }>('SELECT COUNT(*) as cnt FROM agents_config')))!.cnt;
    if (existing.is_primary === 1 && totalCount > 1) throw new AgentConfigError(400, 'Cannot delete the primary agent. Set another agent as primary first.');
    // AGENTS-ORG-01: the agents that report to it move up to its manager; its sub-agents go with it.
    // Keys first (they need the rows), as before.
    const subs = (await sql().read(all<{ agent_id: string }>('SELECT agent_id FROM agent_grant_profiles WHERE parent_agent_id = ? AND agent_id != ?', id, id))).map(r => r.agent_id);
    for (const gone of [id, ...subs]) await removeAgentApiKey(gone);
    await sql().tx(function* () {
      const { subAgents } = yield* releaseReportsStep(id);
      for (const sub of subAgents) yield* run('DELETE FROM agents_config WHERE id = ?', sub);
      yield* run('DELETE FROM agents_config WHERE id = ?', id);
    });
  },
};
