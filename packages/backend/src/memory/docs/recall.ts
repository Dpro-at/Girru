/**
 * Document recall (KNOW-INDEX-01; GIRRU_DOC_INDEX): the chunks of the turn's
 * documents that answer the message, with the file and page to cite.
 *
 * Same scopes as memory: a project's chunks only when that project's drawer
 * is open for this turn (the caller's drawers are already narrowed by the
 * agent's permissions, archived projects and "stays on this computer"), the
 * agent's knowledge chunks only for that agent, and nothing for a turn with
 * no drawers (an outsider is answered). Same scoring as memory (hybrid.ts:
 * BM25 + cosine of the same model only), same reliability floor
 * (RELIABLE_SCORE) and item share; at most MAX_PER_FILE chunks of one file.
 *
 * Reading only: a source that was never indexed, or not for a while, is
 * queued for the background indexer (never awaited here).
 */

import { all, sql } from '../../repositories/sql-steps.js';
import { getEmbeddingService, cosine } from '../embedding.js';
import { unpackVector } from '../vectors.js';
import { lexicalTokens } from '../text-normalize.js';
import { bm25FromCounts, hybridScore, termCounts, vectorScore, MIN_RECALL_SCORE } from '../hybrid.js';
import { RELIABLE_SCORE, ITEM_SHARE } from '../quality/recall.js';
import type { DrawerRef } from '../drawers.js';
import { docIndexEnabled } from '../../services/doc-index-switch.js';
import { isOutsideProject } from '../project-trust.js';
import { ensureAgentSource, ensureProjectSources, queueDocIndex } from './indexer.js';

export const DOC_RECALL_LIMIT = 4;
/** REPO-TRUST-01: a chunk of an outside project's file counts this share of its score (it ranks below the owner's own). */
export const OUTSIDE_WEIGHT = 0.8;
const MAX_PER_FILE = 2;
/** A source is looked at again by the indexer when recall finds it older than this. */
const STALE_MS = 2 * 60_000;
const CACHE_SOURCES = 24;

export interface DocHit {
  chunkId: string;
  /** Path to cite: relative to the project's folder (an added folder: its name first), or knowledge/… */
  file: string;
  page: number | null;
  heading: string | null;
  text: string;
  score: number;
  scope: { kind: 'project' | 'agent'; key: string };
  /** REPO-TRUST-01: from a project on the Outside projects list (someone else's repository). */
  outside?: boolean;
}

export interface DocScopes {
  sources: Array<{ id: string; kind: 'project' | 'agent'; refId: string; revision: number; state: string; scannedAt: string | null }>;
  /** Changes when any chunk of these sources changes (recall cache key). */
  token: string;
}

interface Loaded {
  revision: number;
  docs: Array<{ id: string; file: string; page: number | null; heading: string | null; content: string; counts: Map<string, number>; length: number; model: string | null; vec: number[] | null; scope: DocHit['scope'] }>;
}
const cache = new Map<string, Loaded>();
/** Agent sources known to exist (one insert per agent and process, not one per turn). */
const ensured = new Set<string>();
/** Projects whose default source was already created this process (one insert per project, not per turn). */
const ensuredProjects = new Set<string>();

/** The sources this turn may read, with their revisions (two small queries; no chunk text). */
export async function docScopes(input: { userId: string; drawers: readonly DrawerRef[]; agentId?: string | null }): Promise<DocScopes> {
  const empty: DocScopes = { sources: [], token: '' };
  if (!docIndexEnabled() || input.drawers.length === 0) return empty;
  const keys = input.drawers.filter((d) => d.kind === 'project' && d.key).map((d) => d.key!);
  let projectIds: string[] = [];
  if (keys.length) {
    const marks = keys.map(() => '?').join(', ');
    // A project drawer's key is its id (P3) or its slug (before P3): both name one project of this owner.
    projectIds = (await sql().read(all<{ id: string }>(`SELECT id FROM chat_projects WHERE user_id = ? AND (id IN (${marks}) OR slug IN (${marks}))`, input.userId, ...keys, ...keys))).map((r) => r.id);
  }
  const agentId = input.agentId && input.agentId !== 'small-local-agent' ? input.agentId : null;
  if (agentId && !ensured.has(`${input.userId}\n${agentId}`)) {
    if (await ensureAgentSource(input.userId, agentId).catch(() => null)) ensured.add(`${input.userId}\n${agentId}`);
  }
  if (!projectIds.length && !agentId) return empty;
  const parts: string[] = [];
  const params: string[] = [input.userId];
  if (projectIds.length) { parts.push(`(kind = 'project' AND ref_id IN (${projectIds.map(() => '?').join(', ')}))`); params.push(...projectIds); }
  if (agentId) { parts.push(`(kind = 'agent' AND ref_id = ?)`); params.push(agentId); }
  const rows = await sql().read(all<{ id: string; kind: 'project' | 'agent'; ref_id: string; revision: number; state: string; scanned_at: string | null }>(
    `SELECT id, kind, ref_id, revision, state, scanned_at FROM doc_index_sources WHERE owner_id = ? AND enabled = 1 AND (${parts.join(' OR ')}) ORDER BY id`, ...params));
  // A project with a folder is read by default: one the index has not met yet gets its source now (read in the background).
  const known = new Set(rows.filter((r) => r.kind === 'project').map((r) => r.ref_id));
  const missing = projectIds.filter((id) => !known.has(id) && !ensuredProjects.has(`${input.userId}\n${id}`));
  if (missing.length) {
    for (const id of missing) ensuredProjects.add(`${input.userId}\n${id}`);
    for (const id of await ensureProjectSources(input.userId).catch(() => [])) queueDocIndex(id);
  }
  const sources = rows.map((r) => ({ id: r.id, kind: r.kind, refId: r.ref_id, revision: Number(r.revision), state: r.state, scannedAt: r.scanned_at }));
  return { sources, token: sources.map((s) => `${s.id}:${s.revision}`).join(',') };
}

async function load(source: DocScopes['sources'][number]): Promise<Loaded> {
  const hit = cache.get(source.id);
  if (hit && hit.revision === source.revision) { cache.delete(source.id); cache.set(source.id, hit); return hit; }
  const rows = await sql().read(all<{ id: string; page: number | null; heading: string | null; content: string; lex: string; embedding_model: string | null; embedding_vec: unknown; display_path: string; scope_kind: 'project' | 'agent'; scope_key: string }>(
    `SELECT c.id, c.page, c.heading, c.content, c.lex, c.embedding_model, c.embedding_vec, f.display_path, c.scope_kind, c.scope_key
       FROM doc_index_chunks c JOIN doc_index_files f ON f.id = c.file_id
      WHERE c.source_id = ? ORDER BY f.display_path, c.ordinal`, source.id));
  const loaded: Loaded = {
    revision: source.revision,
    docs: rows.map((r) => {
      const toks = r.lex ? r.lex.split(' ') : [];
      return {
        id: r.id, file: r.display_path, page: r.page === null || r.page === undefined ? null : Number(r.page), heading: r.heading, content: r.content,
        counts: termCounts(toks), length: toks.length, model: r.embedding_model, vec: unpackVector(r.embedding_vec), scope: { kind: r.scope_kind, key: r.scope_key },
      };
    }),
  };
  cache.set(source.id, loaded);
  while (cache.size > CACHE_SOURCES) cache.delete(cache.keys().next().value!);
  return loaded;
}

/** Drop the in-process chunk cache (tests; a forgotten source). */
export function clearDocRecallCache(): void { cache.clear(); ensured.clear(); ensuredProjects.clear(); }

export async function docRecall(input: { userId: string; query: string; limit?: number; scopes: DocScopes }): Promise<{ items: DocHit[]; reliable: boolean; best: number }> {
  const none = { items: [], reliable: false, best: 0 };
  const query = input.query.trim().slice(0, 2000);
  if (!docIndexEnabled() || !query || !input.scopes.sources.length) return none;
  const nowMs = Date.now();
  for (const s of input.scopes.sources) {
    const age = s.scannedAt ? nowMs - new Date(s.scannedAt).getTime() : Infinity;
    // A run already queued in this process is not queued twice; one left 'running' by a stop is resumed.
    if (s.state === 'pending' || s.state === 'running' || !(age < STALE_MS)) queueDocIndex(s.id, { minIntervalMs: STALE_MS / 2 });
  }
  const docs = (await Promise.all(input.scopes.sources.map(load))).flatMap((l) => l.docs);
  if (!docs.length) return none;
  const outside = new Set<string>();
  for (const s of input.scopes.sources) if (s.kind === 'project' && await isOutsideProject(input.userId, s.refId)) outside.add(s.refId);
  const tokens = lexicalTokens(query);
  const lexical = bm25FromCounts(tokens, docs);
  const q = await getEmbeddingService().embedQuery(query);
  const scored = docs.map((d, i) => {
    const comparable = !!d.vec && d.model === q.model && d.vec.length === q.vector.length;
    // Hash vectors count only with a shared word (as in memory recall): otherwise a bucket collision.
    const vector = comparable && (q.semantic || lexical[i] > 0) ? vectorScore(cosine(q.vector, d.vec!), q.semantic) : null;
    const score = hybridScore(vector, lexical[i], q.semantic);
    return { d, score: d.scope.kind === 'project' && outside.has(d.scope.key) ? score * OUTSIDE_WEIGHT : score };
  }).filter((x) => x.score >= MIN_RECALL_SCORE).sort((a, b) => b.score - a.score);
  const best = scored[0]?.score ?? 0;
  if (best < (q.semantic ? RELIABLE_SCORE.semantic : RELIABLE_SCORE.hash)) return { items: [], reliable: false, best };
  const perFile = new Map<string, number>();
  const items: DocHit[] = [];
  for (const x of scored) {
    if (items.length >= (input.limit ?? DOC_RECALL_LIMIT) || x.score < best * ITEM_SHARE) break;
    const n = perFile.get(x.d.file) ?? 0;
    if (n >= MAX_PER_FILE) continue;
    perFile.set(x.d.file, n + 1);
    items.push({ chunkId: x.d.id, file: x.d.file, page: x.d.page, heading: x.d.heading, text: x.d.content, score: Math.round(x.score * 1000) / 1000, scope: x.d.scope,
      ...(x.d.scope.kind === 'project' && outside.has(x.d.scope.key) ? { outside: true } : {}) });
  }
  return { items, reliable: items.length > 0, best };
}

/** Where a hit is cited: "docs/spec.pdf, page 3" or "README.md › Setup". */
export function citeOf(h: Pick<DocHit, 'file' | 'page' | 'heading'>): string {
  if (h.page !== null) return `${h.file}, page ${h.page}`;
  return h.heading ? `${h.file} › ${h.heading}` : h.file;
}
