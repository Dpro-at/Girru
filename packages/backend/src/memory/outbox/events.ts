/**
 * STORE-MAP-01 pilot: the change log (outbox).
 *
 * Events are written by database triggers (migration 163) in the same
 * transaction as the memory write, so no code path can change a memory of an
 * opted-in drawer without an event. This module opts drawers in and out,
 * reads events after a watermark, and removes only events that every
 * consumer of the scope has passed (never by age).
 */

import { q, sql, all, one, run, num } from '../../repositories/sql-steps.js';
import type { Project } from '../../repositories/chat-conversations.js';
import { projectKeyOf } from '../project-keys.js';

export interface ChangeEvent {
  seq: number;
  scope: string;
  userId: string;
  entity: string;
  entityId: string;
  op: 'insert' | 'update' | 'delete' | 'version';
  recordVersion: number | null;
  createdAt: string;
}

/** The change-log scope of a project's memory drawer. */
export const projectScope = (p: Pick<Project, 'id' | 'slug'>): string => `project:${projectKeyOf(p)}`;

/** Start (or resume) the change log for a project's drawer. Idempotent. */
export async function enableScope(ownerId: string, project: Pick<Project, 'id' | 'slug'>): Promise<string> {
  const scope = projectScope(project);
  await sql().tx(function* () {
    const row = yield* one<{ owner_id: string }>('SELECT owner_id FROM change_scopes WHERE scope = ?', scope);
    if (row && row.owner_id !== ownerId) throw new Error('The scope belongs to another owner');
    if (row) yield* run('UPDATE change_scopes SET enabled = 1, project_id = ? WHERE scope = ?', project.id, scope);
    else yield* run('INSERT INTO change_scopes (scope, owner_id, project_id, enabled) VALUES (?, ?, ?, 1)', scope, ownerId, project.id);
  });
  return scope;
}

/** Stop writing events for the scope (existing events and state are kept). */
export async function disableScope(scope: string): Promise<void> {
  await q.run('UPDATE change_scopes SET enabled = 0 WHERE scope = ?', scope);
}

export async function scopeInfo(scope: string): Promise<{ scope: string; ownerId: string; projectId: string; enabled: boolean } | null> {
  const r = await q.one<{ scope: string; owner_id: string; project_id: string; enabled: number }>(
    'SELECT scope, owner_id, project_id, enabled FROM change_scopes WHERE scope = ?', scope);
  return r ? { scope: r.scope, ownerId: r.owner_id, projectId: r.project_id, enabled: Number(r.enabled) === 1 } : null;
}

export async function enabledScopes(): Promise<string[]> {
  return (await q.all<{ scope: string }>('SELECT scope FROM change_scopes WHERE enabled = 1 ORDER BY scope')).map((r) => r.scope);
}

/** The newest event's sequence number of the scope (0 when none). */
export async function latestSeq(scope: string): Promise<number> {
  const r = await q.one<{ m: unknown }>('SELECT MAX(seq) AS m FROM change_events WHERE scope = ?', scope);
  return num<number | null>(r?.m) ?? 0;
}

/** Events of the scope after `after`, oldest first. */
export async function eventsAfter(scope: string, after: number, limit = 500): Promise<ChangeEvent[]> {
  const rows = await q.all<any>(
    'SELECT seq, scope, user_id, entity, entity_id, op, record_version, created_at FROM change_events WHERE scope = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
    scope, after, Math.max(1, Math.min(limit, 5000)));
  return rows.map((r) => ({
    seq: Number(r.seq), scope: r.scope, userId: r.user_id, entity: r.entity, entityId: r.entity_id, op: r.op,
    recordVersion: r.record_version === null || r.record_version === undefined ? null : Number(r.record_version), createdAt: String(r.created_at),
  }));
}

/**
 * Remove the scope's events that every consumer has passed. Without any
 * consumer state nothing is removed (an offline consumer still needs them).
 */
export async function pruneEvents(scope: string): Promise<number> {
  return sql().tx(function* () {
    const states = yield* all<{ watermark: unknown }>('SELECT watermark FROM projection_state WHERE scope = ?', scope);
    if (states.length === 0) return 0;
    const min = Math.min(...states.map((s) => Number(s.watermark) || 0));
    if (min <= 0) return 0;
    return (yield* run('DELETE FROM change_events WHERE scope = ? AND seq <= ?', scope, min)).changes;
  });
}
