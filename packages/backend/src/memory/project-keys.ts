/**
 * STORE-MAP-01 P3 (D3, FD1): memory keeps projects by id.
 *
 * A project drawer's key was the chat project's slug. While GIRRU_STORE_P3 is
 * on it is the chat project's id: `projectKeyOf` is the one place that turns
 * a chat project into its memory key, and `moveProjectKeys` rewrites stored
 * keys at start-up (both directions, so the switch can go off again). Inside
 * memory the key stays opaque (ProjectScope.slug is "the key").
 *
 * Old links and routes that name a project by its slug keep working for one
 * release: `currentProjectKey` answers a slug with the id.
 */

import { randomUUID } from 'node:crypto';
import { all, one, run, sql, tableExists, lockName, type Step } from '../repositories/sql-steps.js';
import { storeP3Enabled } from '../services/store-p3.js';

export type KeyedBy = 'slug' | 'id';

/** The memory key of a chat project. */
export function projectKeyOf(p: { id: string; slug: string }): string {
  return storeP3Enabled() ? p.id : p.slug;
}

/** The chat_projects column that holds the memory key. */
export function chatProjectKeyColumn(): 'id' | 'slug' {
  return storeP3Enabled() ? 'id' : 'slug';
}

/** Every place that stores a project key: table, owner column, key column, and which rows. */
interface Keyed { table: string; owner: string | null; col: string; where?: string; prefix?: string }
const KEYED: readonly Keyed[] = [
  { table: 'memories', owner: 'user_id', col: 'drawer_key', where: "drawer_kind = 'project'" },
  { table: 'memory_versions', owner: 'user_id', col: 'drawer_key', where: "drawer_kind = 'project'" },
  { table: 'chat_memory_links', owner: 'user_id', col: 'drawer_key', where: "drawer_kind = 'project'" },
  { table: 'memory_file_proposals', owner: 'user_id', col: 'drawer_key', where: "drawer_kind = 'project'" },
  { table: 'memory_project_scopes', owner: 'owner_id', col: 'slug' },
  { table: 'memory_project_scopes', owner: 'owner_id', col: 'merged_into' },
  { table: 'memory_pinned_facts', owner: 'owner_id', col: 'scope_id', where: "scope_kind = 'project'" },
  { table: 'memory_access_rules', owner: 'owner_id', col: 'scope_id', where: "scope_kind = 'project'" },
  { table: 'memory_access_scope_rules', owner: 'owner_id', col: 'scope_id', where: "scope_kind = 'project'" },
  { table: 'memory_scope_rules', owner: 'owner_id', col: 'scope_id', where: "scope_kind = 'project'" },
  { table: 'memory_project_group_members', owner: 'owner_id', col: 'slug' },
  { table: 'memory_project_design', owner: 'owner_id', col: 'slug' },
  { table: 'memory_project_databases', owner: 'owner_id', col: 'slug' },
  { table: 'memory_project_db_access', owner: 'owner_id', col: 'slug' },
  { table: 'change_scopes', owner: 'owner_id', col: 'scope', prefix: 'project:' },
  { table: 'change_events', owner: 'user_id', col: 'scope', prefix: 'project:' },
  { table: 'projection_state', owner: null, col: 'scope', prefix: 'project:' },
];

export function* keyStateStep(ownerId: string): Step<KeyedBy> {
  const r = yield* one<{ keyed_by: string }>('SELECT keyed_by FROM memory_key_state WHERE owner_id = ?', ownerId);
  return r?.keyed_by === 'id' ? 'id' : 'slug';
}

function* assertProjectionKeysMovableStep(ownerId:string):Step<void>{
  yield* lockName('encrypted-projection-owner:'+ownerId);
  if (yield* tableExists('memory_encryption_projection_holds')) {
    const held = yield* one("SELECT 1 AS held FROM memory_encryption_projection_holds WHERE owner_id=? AND state='held' LIMIT 1", ownerId);
    if (held) throw new Error('Project key migration refused while encrypted projections are held');
  }
}

export function* rewriteStep(ownerId: string, from: string, to: string): Step<number> {
  yield* assertProjectionKeysMovableStep(ownerId);
  let n = 0;
  for (const k of KEYED) {
    const a = k.prefix ? k.prefix + from : from;
    const b = k.prefix ? k.prefix + to : to;
    const owned = k.owner ? ` AND ${k.owner} = ?` : '';
    const args = k.owner ? [ownerId] : [];
    n += (yield* run(`UPDATE ${k.table} SET ${k.col} = ? WHERE ${k.col} = ?${owned}${k.where ? ` AND ${k.where}` : ''}`, b, a, ...args)).changes;
  }
  if(yield* tableExists('memory_encryption_projection_holds')) {
    n += (yield* run("UPDATE memory_encryption_projection_holds SET scope=? WHERE owner_id=? AND scope=? AND state='released'",`project:${to}`,ownerId,`project:${from}`)).changes;
  }
  // Cache revisions are counters: a fresh process has no cache, so the new scope may start over.
  yield* run('DELETE FROM memory_cache_revisions WHERE user_id = ? AND scope = ?', ownerId, `project:${to}`);
  yield* run('UPDATE memory_cache_revisions SET scope = ? WHERE user_id = ? AND scope = ?', `project:${to}`, ownerId, `project:${from}`);
  return n;
}

/** Project keys in memory that are not a chat project's slug (memory-only names). */
function* memoryOnlyKeysStep(ownerId: string): Step<Array<{ key: string; name: string | null }>> {
  const keys = new Set<string>();
  for (const r of yield* all<{ k: string }>("SELECT DISTINCT drawer_key AS k FROM memories WHERE user_id = ? AND drawer_kind = 'project' AND drawer_key <> ''", ownerId)) keys.add(r.k);
  for (const r of yield* all<{ k: string }>('SELECT slug AS k FROM memory_project_scopes WHERE owner_id = ?', ownerId)) keys.add(r.k);
  const chats = new Set((yield* all<{ slug: string; id: string }>('SELECT slug, id FROM chat_projects WHERE user_id = ?', ownerId)).flatMap((c) => [c.slug, c.id]));
  const out: Array<{ key: string; name: string | null }> = [];
  for (const k of [...keys].sort()) {
    if (chats.has(k)) continue;
    const s = yield* one<{ name: string | null }>('SELECT name FROM memory_project_scopes WHERE owner_id = ? AND slug = ?', ownerId, k);
    out.push({ key: k, name: s?.name ?? null });
  }
  return out;
}

export interface MoveReport { direction: 'to_id' | 'to_slug' | 'none'; projects: number; rows: number; created: number }

/** Rewrites one owner's project keys to ids (to: 'id') or back to slugs (to: 'slug'). Idempotent. */
export function* moveProjectKeysStep(ownerId: string, to: KeyedBy): Step<MoveReport> {
  yield* assertProjectionKeysMovableStep(ownerId);
  const now = yield* keyStateStep(ownerId);
  const report: MoveReport = { direction: 'none', projects: 0, rows: 0, created: 0 };
  if (to === 'id') {
    // A memory-only key becomes a real project first (FD1b), so every key has an id.
    for (const m of yield* memoryOnlyKeysStep(ownerId)) {
      if (now === 'id' && /^[0-9a-f-]{36}$/.test(m.key)) continue; // already an id (a deleted project's memory)
      const id = randomUUID();
      yield* run('INSERT INTO chat_projects (id, user_id, name, slug) VALUES (?, ?, ?, ?)', id, ownerId, (m.name ?? m.key).slice(0, 80), m.key);
      yield* run('INSERT INTO memory_project_keys (owner_id, slug, project_id, origin) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', ownerId, m.key, id, 'memory_only');
      report.created++;
    }
    for (const c of yield* all<{ id: string; slug: string }>('SELECT id, slug FROM chat_projects WHERE user_id = ? ORDER BY id', ownerId)) {
      yield* run(`INSERT INTO memory_project_keys (owner_id, slug, project_id, origin) VALUES (?, ?, ?, 'chat_project') ON CONFLICT DO NOTHING`, ownerId, c.slug, c.id);
      const n = yield* rewriteStep(ownerId, c.slug, c.id);
      if (n) report.projects++;
      report.rows += n;
    }
  } else {
    if (now === 'slug') return report;
    for (const c of yield* all<{ id: string; slug: string }>('SELECT id, slug FROM chat_projects WHERE user_id = ? ORDER BY id', ownerId)) {
      const n = yield* rewriteStep(ownerId, c.id, c.slug);
      if (n) report.projects++;
      report.rows += n;
    }
  }
  if (to !== now || report.rows || report.created) report.direction = to === 'id' ? 'to_id' : 'to_slug';
  yield* run('INSERT INTO memory_key_state (owner_id, keyed_by, moved_at) VALUES (?, ?, ?) ON CONFLICT (owner_id) DO UPDATE SET keyed_by = excluded.keyed_by, moved_at = excluded.moved_at',
    ownerId, to, new Date().toISOString());
  return report;
}

/** Start-up: every owner's keys follow the switch (ids while on, slugs while off). */
export async function moveProjectKeys(to: KeyedBy = storeP3Enabled() ? 'id' : 'slug'): Promise<MoveReport[]> {
  const owners = await sql().read(all<{ id: string }>("SELECT id FROM users WHERE role = 'owner' ORDER BY id"));
  const out: MoveReport[] = [];
  for (const o of owners) out.push(await sql().tx(() => moveProjectKeysStep(o.id, to), { immediate: true }));
  return out;
}

/**
 * The key to use for a project named in a request: while P3 is on, a chat
 * project's slug (an old link) is answered with its id; anything else as given.
 */
export async function currentProjectKey(ownerId: string, key: string): Promise<string> {
  if (!storeP3Enabled()) return key;
  const r = await sql().read(one<{ id: string }>('SELECT id FROM chat_projects WHERE user_id = ? AND slug = ? AND id <> ?', ownerId, key, key));
  if (r) return r.id;
  const m = await sql().read(one<{ project_id: string }>('SELECT project_id FROM memory_project_keys WHERE owner_id = ? AND slug = ?', ownerId, key));
  return m?.project_id ?? key;
}

const norm = (x: string): string => x.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * FD1a: memory a deleted project with this name left behind (P3 keeps it under
 * the deleted project's id). Null when there is none, or while P3 is off.
 */
export async function deletedProjectMemory(ownerId: string, project: { id: string; name: string; slug: string }): Promise<{ key: string; name: string; memories: number } | null> {
  if (!storeP3Enabled()) return null;
  return sql().read((function* () {
    const live = new Set((yield* all<{ id: string }>('SELECT id FROM chat_projects WHERE user_id = ?', ownerId)).map((c) => c.id));
    const candidates = new Map<string, string>();
    for (const r of yield* all<{ slug: string; name: string | null }>('SELECT slug, name FROM memory_project_scopes WHERE owner_id = ?', ownerId)) if (r.name) candidates.set(r.slug, r.name);
    for (const r of yield* all<{ slug: string; project_id: string }>('SELECT slug, project_id FROM memory_project_keys WHERE owner_id = ?', ownerId)) if (!candidates.has(r.project_id)) candidates.set(r.project_id, r.slug);
    for (const [key, name] of candidates) {
      if (live.has(key) || key === project.id) continue;
      if (norm(name) !== norm(project.name) && norm(name) !== norm(project.slug)) continue;
      const n = Number((yield* one<{ n: number }>("SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND drawer_kind = 'project' AND drawer_key = ?", ownerId, key))?.n ?? 0);
      if (n > 0) return { key, name, memories: n };
    }
    return null;
  })());
}

/** FD1a "Use its memory": the deleted project's memory moves to the new project (one transaction). */
export async function adoptProjectMemory(ownerId: string, fromKey: string, projectId: string): Promise<number> {
  return sql().tx(function* () {
    const p = yield* one<{ id: string }>('SELECT id FROM chat_projects WHERE user_id = ? AND id = ?', ownerId, projectId);
    if (!p) throw Object.assign(new Error('Project not found'), { status: 404 });
    if (yield* one('SELECT 1 AS x FROM chat_projects WHERE user_id = ? AND id = ?', ownerId, fromKey)) throw Object.assign(new Error('That memory belongs to a project'), { status: 409 });
    // The new project's own scope row (if any) gives way to the old one, which keeps department and pins.
    yield* run('DELETE FROM memory_project_scopes WHERE owner_id = ? AND slug = ?', ownerId, projectId);
    return yield* rewriteStep(ownerId, fromKey, projectId);
  }, { immediate: true });
}
