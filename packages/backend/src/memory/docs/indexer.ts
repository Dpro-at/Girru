import {assertNoLegacyMemoryFileAccess} from '../encryption/consumer-host.js';
import {assertNoDefaultMemoryAccess} from '../encryption/execution-context.js';
/**
 * Document index (KNOW-INDEX-01; GIRRU_DOC_INDEX). Background only.
 *
 * Sources: a project's folders (its main folder and added folders) once the
 * owner turns them on, and an agent's knowledge folder (on by itself the
 * first time that agent's recall runs). The files stay where they are; the
 * database keeps, per file, its sha-256 and revision, and per chunk the
 * redacted text, its page (PDF) or heading (Markdown), the vector and model.
 *
 * One run of a source (indexSource):
 *   1. find the files (scan.ts: confined, no links, no secrets, caps)
 *   2. a file whose size and mtime did not change is left as it is; else its
 *      bytes are hashed: the same hash only updates size and mtime; a new
 *      hash reads it (PDF: pdf-text.ts; text: strict UTF-8), redacts secrets
 *      (import/redact.ts), cuts it into chunks (chunk.ts), embeds them with
 *      the memory's embedding model (the memory helper's, else the hash
 *      fallback) and replaces that file's chunks in ONE transaction with the
 *      next revision
 *   3. a file that is gone drops its chunks
 *   4. chunks embedded with another model than the one now in use are
 *      embedded again (a few hundred per run), so installing the memory
 *      helper later upgrades the index
 * A file that cannot be read is recorded as unreadable with a reason code
 * (encrypted, no_text = a scan, fonts, encoding, …), never guessed at.
 *
 * Resumable: every file is its own transaction, so a run that stops (quit,
 * crash) keeps what it finished and the next run goes on from there (a file
 * half done is still at its old revision). Runs are queued one at a time in
 * this process; a reply never waits for one.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { all, one, run, sql, num, type Step } from '../../repositories/sql-steps.js';
import { EmbeddingService } from '../embedding.js';
import { packVector } from '../vectors.js';
import { lexicalTokens } from '../text-normalize.js';
import { redactImportText } from '../import/redact.js';
import { extractPdfText } from './pdf-text.js';
import { chunkMarkdown, chunkPages, chunkText, type DocChunk } from './chunk.js';
import { readFound, scanRoot, MAX_FILES, type FoundFile } from './scan.js';
import { getAgentDir, validAgentFileId } from '../../services/agent-files.js';
import { docIndexEnabled } from '../../services/doc-index-switch.js';

export type SourceKind = 'project' | 'agent';
export const MAX_CHUNKS_PER_SOURCE = 8000;
const REEMBED_PER_RUN = 400;

export class DocIndexError extends Error {
  constructor(readonly status: 400 | 404, readonly code: string) { super(code); }
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
export const sourceIdOf = (ownerId: string, kind: SourceKind, refId: string) => sha(`${ownerId}\n${kind}\n${refId}`).slice(0, 32);
const fileIdOf = (sourceId: string, root: string, rel: string) => sha(`${sourceId}\n${root}\n${rel}`).slice(0, 32);

export interface SourceRow {
  id: string; owner_id: string; kind: SourceKind; ref_id: string; enabled: number; state: string; revision: number;
  files: number; chunks: number; unreadable: number; limited: number; note: string | null; scanned_at: string | null;
}

const toSource = (r: SourceRow): SourceRow => ({ ...r, enabled: num<number>(r.enabled), revision: num<number>(r.revision), files: num<number>(r.files), chunks: num<number>(r.chunks), unreadable: num<number>(r.unreadable), limited: num<number>(r.limited) });

export async function getSource(sourceId: string): Promise<SourceRow | null> {
  assertNoLegacyMemoryFileAccess();
  assertNoDefaultMemoryAccess();
  const r = await sql().read(one<SourceRow>('SELECT * FROM doc_index_sources WHERE id = ?', sourceId));
  return r ? toSource(r) : null;
}

function* deleteSourceIndexStep(sourceId: string): Step<void> {
  yield* run('DELETE FROM doc_index_chunks WHERE source_id = ?', sourceId);
  yield* run('DELETE FROM doc_index_files WHERE source_id = ?', sourceId);
}

/**
 * Turn indexing of a project's folders (or an agent's knowledge folder) on or
 * off. Off forgets that source's index at once (files are never touched).
 */
export async function setDocSource(ownerId: string, kind: unknown, refId: unknown, enabled: unknown): Promise<SourceRow> {
  assertNoLegacyMemoryFileAccess();
  assertNoDefaultMemoryAccess();
  if (kind !== 'project' && kind !== 'agent') throw new DocIndexError(400, 'invalid_kind');
  if (typeof enabled !== 'boolean') throw new DocIndexError(400, 'invalid_enabled');
  if (typeof refId !== 'string' || !refId) throw new DocIndexError(400, 'invalid_ref');
  if (kind === 'project') {
    const p = await sql().read(one<{ id: string }>('SELECT id FROM chat_projects WHERE id = ? AND user_id = ?', refId, ownerId));
    if (!p) throw new DocIndexError(404, 'project_not_found');
  } else if (!validAgentFileId(refId)) throw new DocIndexError(400, 'invalid_agent');
  const id = sourceIdOf(ownerId, kind, refId);
  await sql().tx(function* () {
    const prev = yield* one<{ enabled: number }>('SELECT enabled FROM doc_index_sources WHERE id = ?', id);
    if (!prev) {
      yield* run(`INSERT INTO doc_index_sources (id, owner_id, kind, ref_id, enabled, state, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        id, ownerId, kind, refId, enabled ? 1 : 0, now());
    } else {
      yield* run(`UPDATE doc_index_sources SET enabled = ?, state = ?, updated_at = ? WHERE id = ?`, enabled ? 1 : 0, enabled ? 'pending' : 'ready', now(), id);
    }
    if (!enabled) {
      yield* deleteSourceIndexStep(id);
      yield* run(`UPDATE doc_index_sources SET files = 0, chunks = 0, unreadable = 0, limited = 0, revision = revision + 1 WHERE id = ?`, id);
    }
  });
  if (enabled) queueDocIndex(id);
  return (await getSource(id))!;
}

/** The agent's knowledge source, created (on) the first time its recall needs it. */
export async function ensureAgentSource(ownerId: string, agentId: string): Promise<string | null> {
  assertNoLegacyMemoryFileAccess();
  assertNoDefaultMemoryAccess();
  if (!validAgentFileId(agentId)) return null;
  const id = sourceIdOf(ownerId, 'agent', agentId);
  const d = sql().dialect;
  const conflict = d === 'postgres' ? ' ON CONFLICT (id) DO NOTHING' : '';
  await sql().read(run(`INSERT ${d === 'postgres' ? '' : 'OR IGNORE '}INTO doc_index_sources (id, owner_id, kind, ref_id, enabled, state, updated_at) VALUES (?, ?, 'agent', ?, 1, 'pending', ?)${conflict}`,
    id, ownerId, agentId, now()));
  return id;
}

/**
 * Every project with a folder is read by default (owner's decision,
 * 2026-11-04): a source is created ON for each project that has none yet.
 * A project the owner turned off keeps its row (enabled 0) and stays off.
 * Folders may hold repositories cloned from others: their text stays
 * untrusted data in recall, and secrets are skipped as everywhere.
 */
export async function ensureProjectSources(ownerId: string): Promise<string[]> {
  assertNoLegacyMemoryFileAccess();
  assertNoDefaultMemoryAccess();
  const rows = await sql().read(all<{ id: string }>(`
    SELECT p.id FROM chat_projects p
     WHERE p.user_id = ? AND p.folder IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM doc_index_sources s WHERE s.owner_id = p.user_id AND s.kind = 'project' AND s.ref_id = p.id)`, ownerId)).catch(() => []);
  const made: string[] = [];
  for (const r of rows) {
    const id = sourceIdOf(ownerId, 'project', r.id);
    const d = sql().dialect;
    await sql().read(run(`INSERT ${d === 'postgres' ? '' : 'OR IGNORE '}INTO doc_index_sources (id, owner_id, kind, ref_id, enabled, state, updated_at) VALUES (?, ?, 'project', ?, 1, 'pending', ?)${d === 'postgres' ? ' ON CONFLICT (id) DO NOTHING' : ''}`, id, ownerId, r.id, now()));
    made.push(id);
  }
  return made;
}

/** A Knowledge file of this agent changed (Agent › Files): its sources look again soon. */
export async function agentKnowledgeChanged(agentId: string): Promise<void> {
  assertNoLegacyMemoryFileAccess();
  assertNoDefaultMemoryAccess();
  if (!docIndexEnabled() || !validAgentFileId(agentId)) return;
  const rows = await sql().read(all<{ id: string }>(`SELECT id FROM doc_index_sources WHERE kind = 'agent' AND ref_id = ? AND enabled = 1`, agentId));
  for (const r of rows) {
    await sql().read(run(`UPDATE doc_index_sources SET state = 'pending' WHERE id = ?`, r.id));
    queueDocIndex(r.id);
  }
}

/** The folders of a source, main folder first. */
async function sourceRoots(s: SourceRow): Promise<Array<{ root: string; label: string | null }>> {
  if (s.kind === 'agent') {
    if (!validAgentFileId(s.ref_id)) return [];
    return [{ root: path.join(getAgentDir(s.ref_id), 'knowledge'), label: 'knowledge' }];
  }
  const p = await sql().read(one<{ folder: string | null; extra_folders: string | null }>('SELECT folder, extra_folders FROM chat_projects WHERE id = ? AND user_id = ?', s.ref_id, s.owner_id));
  if (!p) return [];
  const out: Array<{ root: string; label: string | null }> = [];
  if (p.folder) out.push({ root: p.folder, label: null });
  try {
    const extra = JSON.parse(p.extra_folders ?? '[]');
    if (Array.isArray(extra)) for (const f of extra.slice(0, 8)) if (f && typeof f.path === 'string' && path.isAbsolute(f.path)) out.push({ root: f.path, label: path.basename(f.path) });
  } catch { /* no added folders */ }
  return out;
}

interface FileRow { id: string; root: string; rel_path: string; file_hash: string; revision: number; bytes: number; mtime_ms: number; status: string; chunks: number }

type Extracted = { ok: true; chunks: DocChunk[]; pages: number | null } | { ok: false; reason: string };

/** Text and chunks of one file's bytes (never a guess: an unreadable file says why). */
export function extractChunks(kind: FoundFile['kind'], data: Buffer): Extracted {
  if (kind === 'pdf') {
    const r = extractPdfText(data);
    if (!r.ok) return { ok: false, reason: r.reason };
    const pages = r.pages.map((p) => ({ page: p.page, text: redactImportText(p.text).text }));
    return { ok: true, chunks: chunkPages(pages), pages: r.pageCount };
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return { ok: false, reason: 'encoding' }; }
  if (text.includes('\u0000')) return { ok: false, reason: 'binary' };
  text = redactImportText(text.replace(/^﻿/, '')).text;
  const chunks = kind === 'md' ? chunkMarkdown(text) : chunkText(text);
  return { ok: true, chunks, pages: null };
}

const embedInput = (c: { heading: string | null; text: string }) => (c.heading ? `${c.heading}\n${c.text}` : c.text);

function* replaceFileStep(input: {
  source: SourceRow; fileId: string; found: FoundFile; display: string; hash: string; revision: number;
  status: 'ok' | 'unreadable'; reason: string | null; pages: number | null;
  chunks: Array<DocChunk & { model: string | null; vec: Buffer | null }>;
}): Step<void> {
  const { source, fileId, found } = input;
  const scope = source.kind === 'project' ? { kind: 'project', key: source.ref_id } : { kind: 'agent', key: source.ref_id };
  yield* run('DELETE FROM doc_index_chunks WHERE file_id = ?', fileId);
  const at = now();
  const exists = yield* one<{ id: string }>('SELECT id FROM doc_index_files WHERE id = ?', fileId);
  if (exists) {
    yield* run(`UPDATE doc_index_files SET display_path = ?, file_hash = ?, revision = ?, bytes = ?, mtime_ms = ?, status = ?, reason = ?, pages = ?, chunks = ?, indexed_at = ? WHERE id = ?`,
      input.display, input.hash, input.revision, found.bytes, found.mtimeMs, input.status, input.reason, input.pages, input.chunks.length, at, fileId);
  } else {
    yield* run(`INSERT INTO doc_index_files (id, source_id, owner_id, root, rel_path, display_path, file_hash, revision, bytes, mtime_ms, status, reason, pages, chunks, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fileId, source.id, source.owner_id, found.root, found.rel, input.display, input.hash, input.revision, found.bytes, found.mtimeMs, input.status, input.reason, input.pages, input.chunks.length, at);
  }
  let ordinal = 0;
  for (const c of input.chunks) {
    const id = sha(`${fileId}\n${input.revision}\n${ordinal}`).slice(0, 32);
    yield* run(`INSERT INTO doc_index_chunks (id, file_id, source_id, owner_id, scope_kind, scope_key, ordinal, page, heading, content, lex, file_hash, revision, embedding_model, embedding_vec, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, fileId, source.id, source.owner_id, scope.kind, scope.key, ordinal, c.page, c.heading, c.text,
      lexicalTokens(embedInput(c)).join(' '), input.hash, input.revision, c.model, c.vec, at);
    ordinal++;
  }
  yield* run('UPDATE doc_index_sources SET revision = revision + 1 WHERE id = ?', source.id);
}

function* dropFileStep(sourceId: string, fileId: string): Step<void> {
  yield* run('DELETE FROM doc_index_chunks WHERE file_id = ?', fileId);
  yield* run('DELETE FROM doc_index_files WHERE id = ?', fileId);
  yield* run('UPDATE doc_index_sources SET revision = revision + 1 WHERE id = ?', sourceId);
}

const yieldTurn = () => new Promise<void>((r) => setImmediate(r));

export interface IndexReport { sourceId: string; state: string; files: number; changed: number; removed: number; unreadable: number; chunks: number; reembedded: number; limited: boolean; skipped?: string }

/** One run of one source (see the header). */
export async function indexSource(sourceId: string, opts: { embedder?: EmbeddingService } = {}): Promise<IndexReport> {
  assertNoLegacyMemoryFileAccess();
  assertNoDefaultMemoryAccess();
  const base: IndexReport = { sourceId, state: 'ready', files: 0, changed: 0, removed: 0, unreadable: 0, chunks: 0, reembedded: 0, limited: false };
  if (!docIndexEnabled()) return { ...base, skipped: 'off' };
  const source = await getSource(sourceId);
  if (!source) return { ...base, skipped: 'missing' };
  if (!source.enabled) return { ...base, skipped: 'disabled' };
  await sql().read(run(`UPDATE doc_index_sources SET state = 'running', updated_at = ? WHERE id = ?`, now(), sourceId));
  const embedder = opts.embedder ?? new EmbeddingService();
  try {
    const roots = await sourceRoots(source);
    // A Knowledge file that goes whole into the agent's instructions is not indexed too (never in both places).
    const whole = source.kind === 'agent'
      ? (await (await import('../../services/agent-file-library.js')).knowledgePlan(source.ref_id).catch(() => null))?.included ?? new Set<string>()
      : new Set<string>();
    const existing = new Map((await sql().read(all<FileRow>('SELECT id, root, rel_path, file_hash, revision, bytes, mtime_ms, status, chunks FROM doc_index_files WHERE source_id = ?', sourceId)))
      .map((r) => [r.id, { ...r, revision: num<number>(r.revision), bytes: num<number>(r.bytes), mtime_ms: num<number>(r.mtime_ms), chunks: num<number>(r.chunks) }]));
    const seen = new Set<string>();
    const completeRoots = new Set<string>();
    const scannedRoots = new Set<string>();
    let limited = false;
    let chunkBudget = MAX_CHUNKS_PER_SOURCE;
    for (const r of existing.values()) chunkBudget -= r.chunks;
    let filesLeft = MAX_FILES;
    for (const { root, label } of roots) {
      if (filesLeft <= 0) { limited = true; break; }
      const scan = await scanRoot(root);
      if (scan.limited) limited = true;
      if (scan.root) scannedRoots.add(scan.root);
      if (scan.root && !scan.limited) completeRoots.add(scan.root);
      for (const found of scan.files.slice(0, filesLeft)) {
        if (whole.has(found.rel)) continue;
        filesLeft--;
        const fileId = fileIdOf(sourceId, found.root, found.rel);
        seen.add(fileId);
        const prev = existing.get(fileId);
        if (prev && prev.bytes === found.bytes && prev.mtime_ms === found.mtimeMs) continue;
        const data = await readFound(found);
        if (!data) continue;
        const hash = sha(data);
        if (prev && prev.file_hash === hash) {
          await sql().read(run('UPDATE doc_index_files SET bytes = ?, mtime_ms = ? WHERE id = ?', found.bytes, found.mtimeMs, fileId));
          continue;
        }
        const display = (label ? `${label}/${found.rel}` : found.rel).split(path.sep).join('/');
        const ex = extractChunks(found.kind, data);
        let chunks: Array<DocChunk & { model: string | null; vec: Buffer | null }> = [];
        if (ex.ok) {
          const room = Math.max(0, chunkBudget + (prev?.chunks ?? 0));
          let list = ex.chunks;
          if (list.length > room) { list = list.slice(0, room); limited = true; }
          const vecs = list.length ? await embedder.embedManyDetailed(list.map(embedInput)) : [];
          chunks = list.map((c, i) => ({ ...c, model: vecs[i]?.model ?? null, vec: vecs[i] ? packVector(vecs[i].vector) : null }));
          chunkBudget -= chunks.length - (prev?.chunks ?? 0);
        }
        await sql().tx(() => replaceFileStep({
          source, fileId, found, display, hash, revision: (prev?.revision ?? 0) + 1,
          status: ex.ok ? 'ok' : 'unreadable', reason: ex.ok ? null : ex.reason, pages: ex.ok ? ex.pages : null, chunks,
        }));
        base.changed++;
        await yieldTurn();
      }
    }
    // Gone: not found in a folder walked completely, a folder no longer in the source (or gone), or a missing file.
    for (const r of existing.values()) {
      if (seen.has(r.id)) continue;
      if (completeRoots.has(r.root) || !scannedRoots.has(r.root) || !(await stillThere(r.root, r.rel_path))) {
        await sql().tx(() => dropFileStep(sourceId, r.id));
        base.removed++;
      }
    }
    base.reembedded = await reembedSource(sourceId, embedder);
    const totals = await sql().read(one<{ files: number; chunks: number; unreadable: number }>(`
      SELECT COUNT(*) AS files, COALESCE(SUM(chunks), 0) AS chunks, COALESCE(SUM(CASE WHEN status = 'unreadable' THEN 1 ELSE 0 END), 0) AS unreadable
        FROM doc_index_files WHERE source_id = ?`, sourceId));
    base.files = num<number>(totals?.files) ?? 0;
    base.chunks = num<number>(totals?.chunks) ?? 0;
    base.unreadable = num<number>(totals?.unreadable) ?? 0;
    base.limited = limited;
    await sql().read(run(`UPDATE doc_index_sources SET state = 'ready', files = ?, chunks = ?, unreadable = ?, limited = ?, note = ?, scanned_at = ?, updated_at = ? WHERE id = ?`,
      base.files, base.chunks, base.unreadable, limited ? 1 : 0, roots.length ? null : 'no_folder', now(), now(), sourceId));
    return base;
  } catch (e) {
    await sql().read(run(`UPDATE doc_index_sources SET state = 'error', note = 'index_failed', updated_at = ? WHERE id = ?`, now(), sourceId)).catch(() => undefined);
    return { ...base, state: 'error' };
  }
}

async function stillThere(root: string, rel: string): Promise<boolean> {
  try { await (await import('node:fs/promises')).lstat(path.join(root, rel)); return true; } catch { return false; }
}

/** Chunks embedded with another model than the one the embedder now gives (semantic upgrade). */
async function reembedSource(sourceId: string, embedder: EmbeddingService): Promise<number> {
  const target = embedder.targetModel();
  const rows = await sql().read(all<{ id: string; heading: string | null; content: string }>(
    `SELECT id, heading, content FROM doc_index_chunks WHERE source_id = ? AND (embedding_model IS NULL OR embedding_model <> ?) ORDER BY id LIMIT ?`,
    sourceId, target, REEMBED_PER_RUN));
  if (!rows.length) return 0;
  const vecs = await embedder.embedManyDetailed(rows.map((r) => embedInput({ heading: r.heading, text: r.content })));
  // The target model was not available: nothing to upgrade yet (the hash vectors stay).
  if (!vecs.length || vecs[0].model !== target) return 0;
  await sql().tx(function* () {
    for (const [i, r] of rows.entries()) yield* run('UPDATE doc_index_chunks SET embedding_model = ?, embedding_vec = ? WHERE id = ?', vecs[i].model, packVector(vecs[i].vector), r.id);
    yield* run('UPDATE doc_index_sources SET revision = revision + 1 WHERE id = ?', sourceId);
  });
  return rows.length;
}

/* ---------------------------------------------------------------- queue */

let chain: Promise<unknown> = Promise.resolve();
const queued = new Set<string>();
const lastQueued = new Map<string, number>();

/** Index one source in the background (one run at a time in this process; never awaited by a reply). */
export function queueDocIndex(sourceId: string, opts: { minIntervalMs?: number } = {}): void {
  assertNoLegacyMemoryFileAccess();
  assertNoDefaultMemoryAccess();
  if (!docIndexEnabled() || queued.has(sourceId)) return;
  const last = lastQueued.get(sourceId) ?? 0;
  if (opts.minIntervalMs && Date.now() - last < opts.minIntervalMs) return;
  queued.add(sourceId);
  lastQueued.set(sourceId, Date.now());
  chain = chain.then(() => indexSource(sourceId)).catch(() => undefined).finally(() => queued.delete(sourceId));
}

/** Wait until every queued run is done (tests, shutdown). */
export async function docIndexIdle(): Promise<void> {
  assertNoDefaultMemoryAccess();
  for (let i = 0; i < 50 && queued.size; i++) await chain.catch(() => undefined);
}

/** Every enabled source of an owner, one after another (the scheduled job; resumes an interrupted run). */
export async function indexOwner(ownerId: string): Promise<IndexReport[]> {
  assertNoLegacyMemoryFileAccess();
  assertNoDefaultMemoryAccess();
  if (!docIndexEnabled()) return [];
  await ensureProjectSources(ownerId);
  const rows = await sql().read(all<{ id: string }>('SELECT id FROM doc_index_sources WHERE owner_id = ? AND enabled = 1 ORDER BY id', ownerId));
  const out: IndexReport[] = [];
  for (const r of rows) out.push(await indexSource(r.id));
  return out;
}

/* --------------------------------------------------------------- status */

export interface SourceStatus {
  id: string; kind: SourceKind; refId: string; enabled: boolean; state: string; files: number; chunks: number;
  unreadable: Array<{ file: string; reason: string }>; limited: boolean; note: string | null; scannedAt: string | null;
}

/** The index status of an owner's sources (paths shown relative to their folder; no file text). */
export async function docIndexStatus(ownerId: string): Promise<SourceStatus[]> {
  assertNoLegacyMemoryFileAccess();
  assertNoDefaultMemoryAccess();
  const sources = (await sql().read(all<SourceRow>('SELECT * FROM doc_index_sources WHERE owner_id = ? ORDER BY kind, ref_id', ownerId))).map(toSource);
  const bad = await sql().read(all<{ source_id: string; display_path: string; reason: string | null }>(
    `SELECT source_id, display_path, reason FROM doc_index_files WHERE owner_id = ? AND status = 'unreadable' ORDER BY display_path LIMIT 500`, ownerId));
  return sources.map((s) => ({
    id: s.id, kind: s.kind, refId: s.ref_id, enabled: !!s.enabled, state: s.state, files: s.files, chunks: s.chunks,
    unreadable: bad.filter((b) => b.source_id === s.id).map((b) => ({ file: b.display_path, reason: b.reason ?? 'unreadable' })),
    limited: !!s.limited, note: s.note, scannedAt: s.scanned_at,
  }));
}

export interface ProjectDocs {
  id: string; name: string; colour: string | null; mine: boolean; hasFolder: boolean;
  /** null: never turned on (read by default only when mine). */
  source: SourceStatus | null;
  /** The folders read, main first, with how many files each holds in the index. */
  folders: Array<{ path: string; name: string; main: boolean; files: number }>;
}

/**
 * Settings › Memory › Documents (board K1): every project of the owner with
 * its switch and status, and the agents' knowledge folders together. Paths
 * are the owner's own folders; no file text.
 */
export async function documentsView(ownerId: string): Promise<{ projects: ProjectDocs[]; agents: { sources: number; files: number; unreadable: Array<{ file: string; reason: string }>; state: string | null } }> {
  assertNoLegacyMemoryFileAccess();
  assertNoDefaultMemoryAccess();
  for (const id of await ensureProjectSources(ownerId)) queueDocIndex(id);
  const status = await docIndexStatus(ownerId);
  const projects = await sql().read(all<{ id: string; name: string; folder: string | null; extra_folders: string | null; mine: number | null }>(`
    SELECT p.id, p.name, p.folder, p.extra_folders, b.files_enabled AS mine FROM chat_projects p
      LEFT JOIN memory_bridge_folders b ON b.owner_id = p.user_id AND b.project_id = p.id
     WHERE p.user_id = ? ORDER BY LOWER(p.name), p.id`, ownerId));
  const perRoot = await sql().read(all<{ source_id: string; root: string; n: number }>(
    `SELECT source_id, root, COUNT(*) AS n FROM doc_index_files WHERE owner_id = ? GROUP BY source_id, root`, ownerId));
  const real = (p: string) => { try { return realpathSync.native(p); } catch { return p; } };
  const out: ProjectDocs[] = projects.map((p) => {
    const source = status.find((s) => s.kind === 'project' && s.refId === p.id) ?? null;
    const folders: ProjectDocs['folders'] = [];
    if (p.folder) folders.push({ path: p.folder, name: path.basename(p.folder), main: true, files: 0 });
    try {
      const extra = JSON.parse(p.extra_folders ?? '[]');
      if (Array.isArray(extra)) for (const f of extra.slice(0, 8)) if (f && typeof f.path === 'string') folders.push({ path: f.path, name: path.basename(f.path), main: false, files: 0 });
    } catch { /* none */ }
    if (source) for (const f of folders) f.files = perRoot.filter((r) => r.source_id === source.id && (r.root === f.path || r.root === real(f.path))).reduce((n, r) => n + Number(r.n), 0);
    return { id: p.id, name: p.name, colour: null, mine: Number(p.mine) === 1, hasFolder: !!p.folder, source, folders };
  });
  const agentSources = status.filter((s) => s.kind === 'agent' && s.enabled);
  return {
    projects: out,
    agents: {
      sources: agentSources.length,
      files: agentSources.reduce((n, s) => n + s.files, 0),
      unreadable: agentSources.flatMap((s) => s.unreadable.map((u) => ({ file: `${s.refId} › ${u.file}`, reason: u.reason }))).slice(0, 50),
      state: agentSources.some((s) => s.state === 'running' || s.state === 'pending') ? 'running' : agentSources.length ? 'ready' : null,
    },
  };
}
