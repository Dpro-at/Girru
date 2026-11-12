/**
 * The names a chat's recall query can use (MEM-ACC-02): the owner's projects and the people
 * and projects of the memory graph, each with every name it is known by. Read for one owner,
 * kept for ENTITY_TTL_MS in this process only (names, never memory text), dropped by forget
 * through forgetContextEntities.
 */

import { all, sql } from '../../repositories/sql-steps.js';
import { buildContextQuery, type KnownEntity } from './query.js';

export const ENTITY_TTL_MS = 60_000;
/** At most this many graph entities (the most recently updated). */
export const MAX_GRAPH_ENTITIES = 500;

interface OwnerEntities { at: number; projects: Map<string, KnownEntity>; all: KnownEntity[] }
const cache = new Map<string, OwnerEntities>();

export function forgetContextEntities(ownerId?: string): void {
  if (ownerId === undefined) cache.clear();
  else cache.delete(ownerId);
}

function namesOf(...lists: Array<ReadonlyArray<string | null | undefined>>): string[] {
  const out: string[] = [];
  for (const list of lists) for (const n of list) {
    const s = typeof n === 'string' ? n.trim() : '';
    if (s.length >= 3 && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

function parseAliases(raw: string | null): string[] {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}

async function load(ownerId: string): Promise<OwnerEntities> {
  const scopes = await sql().read(all<{ slug: string; name: string | null }>(
    'SELECT slug, name FROM memory_project_scopes WHERE owner_id = ? AND archived_at IS NULL', ownerId)).catch(() => []);
  const graph = await sql().read(all<{ kind: string; name: string; aliases: string | null }>(
    `SELECT kind, name, aliases FROM memory_graph_entities WHERE user_id = ? AND kind IN ('person', 'project')
     ORDER BY updated_at DESC LIMIT ${MAX_GRAPH_ENTITIES}`, ownerId)).catch(() => []);
  const projects = new Map<string, KnownEntity>();
  const lower = (s: string) => s.toLowerCase();
  for (const s of scopes) {
    // A graph project with the same name (or slug) adds its other names (e.g. its Arabic spelling).
    const g = graph.filter((e) => e.kind === 'project' && [e.name, ...parseAliases(e.aliases)].some((n) => [lower(s.slug), lower(s.name || '')].includes(lower(n))));
    projects.set(s.slug, { names: namesOf([s.name, s.slug.replace(/-/g, ' ')], ...g.map((e) => [e.name, ...parseAliases(e.aliases)])) });
  }
  const seen = new Set([...projects.values()].flatMap((e) => e.names.map(lower)));
  const others: KnownEntity[] = [];
  for (const e of graph) {
    const names = namesOf([e.name, ...parseAliases(e.aliases)]);
    if (names.length === 0 || names.some((n) => seen.has(lower(n)))) continue;
    names.forEach((n) => seen.add(lower(n)));
    others.push({ names });
  }
  return { at: Date.now(), projects, all: [...projects.values(), ...others].filter((e) => e.names.length > 0) };
}

/** The known entities of an owner and the names of the open project (when the chat has one). */
export async function contextEntities(ownerId: string, openProjectSlug: string | null): Promise<{ entities: KnownEntity[]; openProject: KnownEntity | null }> {
  let e = cache.get(ownerId);
  if (!e || Date.now() - e.at > ENTITY_TTL_MS) { e = await load(ownerId); cache.set(ownerId, e); }
  const open = openProjectSlug ? (e.projects.get(openProjectSlug) ?? { names: namesOf([openProjectSlug.replace(/-/g, ' ')]) }) : null;
  return { entities: e.all, openProject: open && open.names.length ? open : null };
}

/**
 * The recall query of a chat turn (MEM-ACC-02 mode B0): the last message plus the names of the
 * entity the conversation is about. GIRRU_RECALL_CONTEXT=0 keeps the last message alone. Any
 * failure falls back to the last message.
 */
export async function chatRecallQuery(input: { ownerId: string; message: string; history: readonly string[]; openProjectSlug: string | null }): Promise<string> {
  if (process.env.GIRRU_RECALL_CONTEXT === '0' || !input.message.trim()) return input.message;
  try {
    const { entities, openProject } = await contextEntities(input.ownerId, input.openProjectSlug);
    return buildContextQuery({ message: input.message, history: input.history, entities, openProject, topic: false }).query;
  } catch {
    return input.message;
  }
}
