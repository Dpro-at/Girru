/**
 * STORE-MAP-01 pilot: server-issued session capabilities for coding tools.
 *
 * A capability binds one owner or member, one project, a set of scopes, an
 * optional client and an expiry. It is issued by Girru (the owner's own
 * session or the trusted launcher) and handed to the coding tool's process;
 * only its SHA-256 is stored. A folder path (`cwd`) sent with a call never
 * grants anything: with a capability the project comes from the capability,
 * and a `cwd` inside another project is refused.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { q } from '../../repositories/sql-steps.js';
import { nowText } from '../../db/pg/dialect.js';

export const CAPABILITY_HEADER = 'x-girru-capability';
export const CAPABILITY_ENV = 'GIRRU_SESSION_CAPABILITY';
export const CAPABILITY_SCOPES = ['brief:read', 'memory:read', 'memory:propose', 'handoff:write'] as const;
export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];

/** The scope each dpro-memory tool needs. */
export const TOOL_SCOPE: Record<string, CapabilityScope> = {
  project_brief: 'brief:read',
  pinned_facts: 'brief:read',
  latest_handoff: 'brief:read',
  project_design: 'brief:read',
  memory_search: 'memory:read',
  memory_propose: 'memory:propose',
  handoff_write: 'handoff:write',
};

export const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN = /^gcap_[0-9a-f]{64}$/;

export class CapabilityError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

export interface Capability {
  id: string;
  ownerId: string;
  actorId: string;
  actorRole: 'owner' | 'member';
  projectId: string;
  scopes: CapabilityScope[];
  client: string | null;
  expiresAt: string;
}

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface IssueInput {
  ownerId: string;
  actorId: string;
  actorRole: 'owner' | 'member';
  projectId: string;
  scopes: readonly string[];
  client?: string | null;
  ttlMs?: number;
}

/** Issue a capability. The raw token is returned once and never stored. */
export async function issueCapability(input: IssueInput): Promise<{ token: string; capability: Capability }> {
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0 || scopes.some((s) => !(CAPABILITY_SCOPES as readonly string[]).includes(s))) {
    throw new CapabilityError('Unknown or empty scopes', 400, 'invalid_scopes');
  }
  if (input.actorRole !== 'owner' && input.actorRole !== 'member') throw new CapabilityError('Invalid role', 400, 'invalid_role');
  const project = await q.one<{ id: string }>('SELECT id FROM chat_projects WHERE id = ? AND user_id = ?', input.projectId, input.ownerId);
  if (!project) throw new CapabilityError('Unknown project', 404, 'unknown_project');
  const ttl = Math.min(Math.max(60_000, Number(input.ttlMs) || DEFAULT_TTL_MS), MAX_TTL_MS);
  const token = `gcap_${randomBytes(32).toString('hex')}`;
  const capability: Capability = {
    id: randomUUID(), ownerId: input.ownerId, actorId: input.actorId, actorRole: input.actorRole,
    projectId: input.projectId, scopes: scopes as CapabilityScope[], client: input.client ?? null,
    expiresAt: new Date(Date.now() + ttl).toISOString(),
  };
  await q.run(`INSERT INTO session_capabilities (id, token_hash, owner_id, actor_id, actor_role, project_id, scopes, client, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, capability.id, hashOf(token), capability.ownerId, capability.actorId, capability.actorRole,
    capability.projectId, JSON.stringify(capability.scopes), capability.client, capability.expiresAt);
  return { token, capability };
}

/** The live capability of a token, or a CapabilityError (401) when unknown, expired or revoked. */
export async function verifyCapability(token: unknown): Promise<Capability> {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw new CapabilityError('Not allowed', 401, 'unauthenticated');
  const h = hashOf(token);
  const r = await q.one<any>('SELECT * FROM session_capabilities WHERE token_hash = ?', h);
  if (!r || !timingSafeEqual(Buffer.from(r.token_hash, 'hex'), Buffer.from(h, 'hex'))) throw new CapabilityError('Not allowed', 401, 'unauthenticated');
  if (r.revoked_at) throw new CapabilityError('This session was ended in Girru', 401, 'revoked');
  if (Date.parse(r.expires_at) <= Date.now()) throw new CapabilityError('This session expired', 401, 'expired');
  let scopes: CapabilityScope[] = [];
  try { scopes = JSON.parse(r.scopes); } catch { /* none */ }
  return { id: r.id, ownerId: r.owner_id, actorId: r.actor_id, actorRole: r.actor_role, projectId: r.project_id, scopes, client: r.client ?? null, expiresAt: r.expires_at };
}

/** Throws 403 unless the capability allows the tool. */
export function requireScope(cap: Capability, tool: string): void {
  const need = TOOL_SCOPE[tool];
  if (!need || !cap.scopes.includes(need)) throw new CapabilityError(`This session may not use ${tool}`, 403, 'scope_denied');
}

export async function revokeCapability(ownerId: string, id: string): Promise<boolean> {
  const r = await q.run(`UPDATE session_capabilities SET revoked_at = ${nowText(q.dialect)} WHERE id = ? AND owner_id = ? AND revoked_at IS NULL`, id, ownerId);
  return r.changes === 1;
}

export async function listCapabilities(ownerId: string, projectId?: string): Promise<Array<Omit<Capability, 'scopes'> & { scopes: string[]; revokedAt: string | null; createdAt: string }>> {
  const rows = await q.all<any>(`SELECT * FROM session_capabilities WHERE owner_id = ?${projectId ? ' AND project_id = ?' : ''} ORDER BY created_at DESC, id DESC LIMIT 200`,
    ...(projectId ? [ownerId, projectId] : [ownerId]));
  return rows.map((r) => {
    let scopes: string[] = [];
    try { scopes = JSON.parse(r.scopes); } catch { /* none */ }
    return { id: r.id, ownerId: r.owner_id, actorId: r.actor_id, actorRole: r.actor_role, projectId: r.project_id, scopes,
      client: r.client ?? null, expiresAt: r.expires_at, revokedAt: r.revoked_at ?? null, createdAt: String(r.created_at) };
  });
}
