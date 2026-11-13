/**
 * The names a chat's recall query can use (MEM-ACC-02): the owner's projects and the people
 * and projects of the memory graph, each with every name it is known by. Read for one owner,
 * kept for ENTITY_TTL_MS in this process only (names, never memory text), dropped by forget
 * through forgetContextEntities.
 */

import { all, sql } from '../../repositories/sql-steps.js';
import { buildContextQuery, type KnownEntity } from './query.js';
import type { DrawerRef } from '../drawers.js';

/**
 * MEM-CTX-02: how often the owner's memory of these drawers uses a word, for picking topic words.
 * Null when the recall store is not loaded (then the query keeps the entity's names only), and never
 * an error: a failed lookup must not cost the turn its memory.
 */
async function drawerWords(ownerId: string, drawers: readonly DrawerRef[]): Promise<{ df: (token: string) => number; live: number } | null> {
  try {
    const store = await import('../recall-store.js');
    const open = await store.openStore(ownerId, [...drawers]);
    return open ? store.drawerTermCounts(ownerId, open) : null;
  } catch { return null; }
}

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
export async function contextEntities(ownerId: string, openProjectSlug: string | null): Promise<{ entities: KnownEntity[]; openProject: KnownEntity | null; projects: Array<{ slug: string; names: string[] }> }> {
  let e = cache.get(ownerId);
  if (!e || Date.now() - e.at > ENTITY_TTL_MS) { e = await load(ownerId); cache.set(ownerId, e); }
  const open = openProjectSlug ? (e.projects.get(openProjectSlug) ?? { names: namesOf([openProjectSlug.replace(/-/g, ' ')]) }) : null;
  return { entities: e.all, openProject: open && open.names.length ? open : null, projects: [...e.projects].map(([slug, p]) => ({ slug, names: [...p.names] })) };
}

/**
 * The recall query of a chat turn (MEM-ACC-02 mode B0): the last message plus the names of the
 * entity the conversation is about. GIRRU_RECALL_CONTEXT=0 keeps the last message alone. Any
 * failure falls back to the last message.
 */
export async function chatRecallQuery(input: { ownerId: string; message: string; history: readonly string[]; openProjectSlug: string | null; drawers?: readonly DrawerRef[] }): Promise<{ query: string; parts: string[]; focus: { names: string[]; others: string[] } | null }> {
  if (process.env.GIRRU_RECALL_CONTEXT === '0' || !input.message.trim()) return { query: input.message, parts: [], focus: null };
  try {
    const { entities, openProject } = await contextEntities(input.ownerId, input.openProjectSlug);
    // MEM-CTX-02: topic words of the message that brought the project up, kept only when the owner's
    // memory of these drawers uses them (GIRRU_RECALL_TOPIC=0: the entity's names only). Measured on the
    // held-out accuracy questions: indirect recall@5 0.79 -> 0.86, and with a strong model reading the
    // result 8 of 14 correct answers -> 14 of 14, at the same search speed.
    const memoryWords = process.env.GIRRU_RECALL_TOPIC === '0' || !input.drawers?.length ? null : await drawerWords(input.ownerId, input.drawers);
    const q = buildContextQuery({ message: input.message, history: input.history, entities, openProject, topic: !!memoryWords, memoryWords });
    // MEM-ACC-03: the head of a question with a relative clause is searched too (multi-hop).
    // MEM-ACC-04: memories that name only another project or person rank lower (GIRRU_RECALL_FOCUS=0: off).
    return { query: q.query, parts: process.env.GIRRU_RECALL_PARTS === '0' ? [] : q.parts, focus: process.env.GIRRU_RECALL_FOCUS === '0' ? null : q.focus };
  } catch {
    return { query: input.message, parts: [], focus: null };
  }
}
