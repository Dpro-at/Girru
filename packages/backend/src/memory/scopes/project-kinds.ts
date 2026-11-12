/**
 * "Not projects" (MEM-READ-01 MR3).
 *
 * A project whose key or folder comes from downloaded code (the Go module
 * folder, node_modules, vendor, …) is marked 'library' on its own, once.
 * The owner's "It's a project" marks it 'project'; automatic detection never
 * changes a row that exists. A chat project is always the owner's own.
 */

import { all, one, run, sql } from '../../repositories/sql-steps.js';
import { isValidDrawerKey } from '../drawers.js';
import { isLibraryPath, libraryKindOf, libraryProjectKey } from '../import/library-folders.js';
import { ScopeInputError, listProjectsStep } from './store.js';

export type ProjectKind = 'library' | 'project';

const folderKey = (root: string) => (root.split(/[\\/]+/).filter(Boolean).at(-1) ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

async function discoveryRoots(ownerId: string): Promise<string[]> {
  const out: string[] = [];
  // Discovery creates these tables on first use; a fresh install may not have them yet.
  for (const query of ['SELECT root FROM discovery_computer_roots WHERE user_id = ?', 'SELECT DISTINCT root FROM discovery_items WHERE user_id = ? AND root IS NOT NULL', 'SELECT DISTINCT root FROM discovery_computer_notes WHERE user_id = ? AND root IS NOT NULL']) {
    try { for (const r of await sql().read(all<{ root: string }>(query, ownerId))) if (r.root) out.push(r.root); } catch { /* table not created yet */ }
  }
  return out;
}

const classified = new Map<string, number>();
const RECHECK_MS = 10 * 60_000;

/**
 * Mark the owner's library projects (no row yet, no chat project) as 'library'.
 * Returns how many were marked now. Cheap: runs at most every RECHECK_MS per owner unless forced.
 */
export async function classifyLibraryProjects(ownerId: string, opts: { force?: boolean; now?: number } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  if (!opts.force && now - (classified.get(ownerId) ?? 0) < RECHECK_MS) return 0;
  classified.set(ownerId, now);
  const projects = await sql().read(listProjectsStep(ownerId));
  const decided = new Set((await sql().read(all<{ slug: string }>('SELECT slug FROM memory_project_kinds WHERE owner_id = ?', ownerId))).map(r => r.slug));
  const libraryRoots = new Map<string, string>();
  for (const root of await discoveryRoots(ownerId)) if (isLibraryPath(root)) { const key = folderKey(root); if (key && !libraryRoots.has(key)) libraryRoots.set(key, root); }
  let marked = 0;
  for (const p of projects) {
    if (decided.has(p.slug) || p.chatProjectId) continue;
    const root = libraryRoots.get(p.slug);
    if (!root && !libraryProjectKey(p.slug)) continue;
    await sql().tx(() => run(`INSERT INTO memory_project_kinds (owner_id, slug, kind, reason, updated_by, updated_at) VALUES (?, ?, 'library', ?, 'discovery', ?) ON CONFLICT (owner_id, slug) DO NOTHING`,
      ownerId, p.slug, libraryKindOf(root ?? null, p.slug), new Date(now).toISOString()), { immediate: true });
    marked++;
  }
  return marked;
}

/** The owner's choice: 'project' ("It's a project") or 'library' ("Not a project"). */
export async function setProjectKind(ownerId: string, slug: unknown, kind: unknown, by: string): Promise<{ slug: string; kind: ProjectKind; before: ProjectKind | null }> {
  if (typeof slug !== 'string' || !isValidDrawerKey('project', slug)) throw new ScopeInputError('Unknown project', 404, 'not_found');
  if (kind !== 'library' && kind !== 'project') throw new ScopeInputError('kind must be library or project');
  const known = (await sql().read(listProjectsStep(ownerId))).find(p => p.slug === slug);
  if (!known) throw new ScopeInputError('Unknown project', 404, 'not_found');
  if (kind === 'library' && known.chatProjectId) throw new ScopeInputError('A chat project is always a project', 409, 'chat_project');
  const before = (await sql().read(one<{ kind: ProjectKind }>('SELECT kind FROM memory_project_kinds WHERE owner_id = ? AND slug = ?', ownerId, slug)))?.kind ?? null;
  const reason = kind === 'library' ? (known.notProjectReason ?? libraryKindOf(null, slug)) : '';
  await sql().tx(() => run(`INSERT INTO memory_project_kinds (owner_id, slug, kind, reason, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (owner_id, slug) DO UPDATE SET kind = excluded.kind, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ownerId, slug, kind, reason, by, new Date().toISOString()), { immediate: true });
  return { slug, kind, before };
}

/** For tests: forget the per-owner recheck time. */
export function resetProjectKindCache() { classified.clear(); }
