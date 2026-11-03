/**
 * STORE-MAP-01 P6 screens (P6a, D20-D22): the files Girru keeps in each
 * project folder, one state per file, for Memory › Coding apps › Project files.
 *
 *   .girru/brief.md        the brief projection (P6 change log), version = its projection number
 *   .girru/tasks.md        the task file (only where it is on or present)
 *   AGENTS.md              Girru's part only (between its markers)
 *   CLAUDE.md, GEMINI.md   the one-line pointers to AGENTS.md
 *   .cursor/rules/girru.mdc  Cursor's pointer, when present
 *
 * States: up_to_date, waiting (Girru has something newer to write),
 * changed_in_both (Girru's part was changed in the folder; Girru never writes
 * over it until the owner chooses), folder_not_found, could_not_write.
 *
 * Writes go through the existing writers only (the managed-files section
 * writer, the brief projection, the task file and the one safe file writer).
 * "Use Girru's version" keeps the folder's text of Girru's part as a memory
 * proposal labelled repository-file (never memory by itself); Undo puts the
 * folder text back and withdraws that proposal while the file is unchanged.
 * Undo tokens live in this process only; after a restart Undo has expired.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { findProject, listProjects, type Project } from '../../repositories/chat-conversations.js';
import { learn } from '../learning.js';
import { getProposal, rejectProposal } from '../memory-files.js';
import { redactImportText } from '../import/redact.js';
import { briefMarkdown, projectBrief, projectDrawer } from './brief.js';
import { MANAGED_FILES, MAX_MANAGED_FILE_BYTES, ManagedFileError, managedPart, previewFiles, writeSection, type ManagedName } from './managed-files.js';
import { readRegularFile } from './regular-file.js';
import { BridgeError, extrasOf, filesApply, filesPreview, sectionHash, setFolder } from './service.js';
import { CURSOR_RULE, CURSOR_RULE_TEXT } from './layout.js';
import { audit, folderSettings } from './store.js';
import { BRIEF_CONSUMER, getState, runBriefProjection } from '../outbox/projection.js';
import { disableScope, enableScope, latestSeq, projectScope, scopeInfo } from '../outbox/events.js';
import { pilotProjectId } from '../outbox/pilot.js';
import { safeWriteFile, SafeFileError } from '../../services/safe-file.js';
import { ensureTaskFile, TASKS_FILE, taskFileOn } from '../../services/task-file.js';

export type FileState = 'up_to_date' | 'waiting' | 'changed_in_both' | 'folder_not_found' | 'could_not_write';
export interface ProjectFile { path: string; what: string; version: number | null; state: FileState; reason?: string }
export interface ProjectFiles {
  projectId: string; name: string; folder: string | null; writeFiles: boolean; companyFacts: boolean;
  state: FileState; needsYou: boolean; writtenAt: string | null; version: number | null; files: ProjectFile[];
}

const BRIEF = '.girru/brief.md';
/** Worst first: the project's state is its worst file's. */
const ORDER: readonly FileState[] = ['folder_not_found', 'could_not_write', 'changed_in_both', 'waiting', 'up_to_date'];
const NEEDS_YOU: ReadonlySet<FileState> = new Set(['changed_in_both', 'folder_not_found', 'could_not_write']);
const WHAT: Record<string, string> = {
  [BRIEF]: 'The project brief coding apps read first',
  [TASKS_FILE]: 'Tasks with their ids',
  'AGENTS.md': "Girru's part only",
  'CLAUDE.md': 'One line that points to AGENTS.md',
  'GEMINI.md': 'One line that points to AGENTS.md',
  [CURSOR_RULE]: 'One rule that points Cursor to AGENTS.md',
};
export const PROJECT_FILE_PATHS: readonly string[] = Object.keys(WHAT);
const BRIEF_HEAD = /^<!-- girru:brief [^\n]*-->\n\n?/;

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

/** The file's bytes; null when it is not there, 'bad' when it is a link, not a plain file or too large. */
function readBytes(root: string, relative: string): Buffer | null | 'bad' {
  try { return readRegularFile(root, path.join(...relative.split('/')), MAX_MANAGED_FILE_BYTES).bytes; } catch (e: any) {
    return e?.code === 'ENOENT' ? null : 'bad';
  }
}
const textOf = (b: Buffer | null | 'bad'): string | null => (b === null || b === 'bad' ? null : b.toString('utf8'));

/** One file's state with what Girru would write and what the folder holds (Girru's part only). */
interface Detail { file: ProjectFile; girru: string | null; folderText: string | null; before: Buffer | null; marks?: ReturnType<typeof managedPart>['marks'] }
interface Inspected { view: ProjectFiles; project: Project; root: string | null; details: Map<string, Detail> }

const file = (p: string, state: FileState, reason?: string, version: number | null = null): ProjectFile => ({ path: p, what: WHAT[p], version, state, ...(reason ? { reason } : {}) });

function realFolder(folder: string | null): string | null {
  if (!folder) return null;
  try { const r = fs.realpathSync.native(folder); return fs.statSync(r).isDirectory() ? r : null; } catch { return null; }
}

async function inspect(ownerId: string, p: Project): Promise<Inspected> {
  const f = await folderSettings(ownerId, p.id);
  const root = realFolder(p.folder);
  const details = new Map<string, Detail>();
  const add = (d: Detail) => { details.set(d.file.path, d); };
  let version: number | null = null;
  if (!root) {
    for (const x of [BRIEF, TASKS_FILE, ...MANAGED_FILES]) add({ file: file(x, 'folder_not_found', 'The project folder is not on this computer'), girru: null, folderText: null, before: null });
  } else {
    // .girru/brief.md: the projection's own record against the file as it is now.
    const scope = projectScope(p);
    const [info, st] = [await scopeInfo(scope), await getState(BRIEF_CONSUMER, scope)];
    const bytes = readBytes(root, BRIEF);
    if (st || info?.enabled || bytes !== null) {
      version = st?.projectionVersion ? st.projectionVersion : null;
      const brief = await projectBrief(ownerId, p);
      let state: FileState, reason: string | undefined;
      if (bytes === 'bad') { state = 'could_not_write'; reason = `${BRIEF} is a link or not a plain file`; }
      else if (st?.status === 'dead') { state = 'could_not_write'; reason = st.lastError ?? undefined; }
      else if (bytes !== null && sha(bytes) !== st?.contentHash) state = 'changed_in_both';
      else if (st?.status === 'conflict') { state = /changed/i.test(st.lastError ?? '') ? 'changed_in_both' : 'could_not_write'; reason = st.lastError ?? undefined; }
      else if (!st || bytes === null || st.status !== 'up_to_date' || (await latestSeq(scope)) > st.watermark) state = 'waiting';
      else state = 'up_to_date';
      add({ file: file(BRIEF, state, reason, version), girru: briefMarkdown(brief).trim(), folderText: textOf(bytes)?.replace(BRIEF_HEAD, '').trim() ?? null, before: bytes === 'bad' ? null : bytes });
    }
    // .girru/tasks.md: the owner's file; Girru only starts it.
    const tasks = readBytes(root, TASKS_FILE);
    if (tasks !== null || await taskFileOn(p.id)) {
      add({ file: tasks === 'bad' ? file(TASKS_FILE, 'could_not_write', `${TASKS_FILE} is a link or not a plain file`) : file(TASKS_FILE, tasks === null ? 'waiting' : 'up_to_date'), girru: null, folderText: textOf(tasks), before: null });
    }
    // AGENTS.md, CLAUDE.md, GEMINI.md: the same plan the sync writes from.
    const brief = await projectBrief(ownerId, p);
    const extras = await extrasOf(p.id);
    let plan: ReturnType<typeof previewFiles> | null = null, problem: string | null = null;
    try { plan = previewFiles(p.id, brief, root, f.gitExclude, extras); } catch (err) {
      if (!(err instanceof ManagedFileError)) throw err;
      problem = err.message;
    }
    // Girru's inputs are what it last wrote: a Girru part that differs now was changed in the folder.
    const sameInputs = f.filesEnabled && f.briefHash === sectionHash(brief, extras);
    for (const name of MANAGED_FILES) {
      const part = managedPart(brief, root, name, extras);
      const pl = plan?.files.find((x) => x.relative === name);
      let state: FileState, reason: string | undefined;
      if (!pl) { state = 'could_not_write'; reason = problem ?? undefined; }
      else if (pl.action === 'conflict') { state = 'could_not_write'; reason = pl.reason; }
      else if (pl.action === 'unchanged') state = 'up_to_date';
      else state = pl.action === 'update' && sameInputs && part.current !== null && part.current !== part.girru ? 'changed_in_both' : 'waiting';
      const whole = part.whole === null ? null : Buffer.from(part.whole, 'utf8');
      add({ file: file(name, state, reason), girru: part.girru, folderText: part.current, before: whole, marks: part.marks });
    }
    // Cursor's pointer, when it is there.
    const cursor = readBytes(root, CURSOR_RULE);
    if (cursor !== null) {
      const state: FileState = cursor === 'bad' ? 'could_not_write' : cursor.toString('utf8') === CURSOR_RULE_TEXT ? 'up_to_date' : 'changed_in_both';
      add({ file: file(CURSOR_RULE, state, cursor === 'bad' ? `${CURSOR_RULE} is a link or not a plain file` : undefined), girru: CURSOR_RULE_TEXT.trim(), folderText: textOf(cursor)?.trim() ?? null, before: cursor === 'bad' ? null : cursor });
    }
  }
  const files = PROJECT_FILE_PATHS.map((x) => details.get(x)?.file).filter((x): x is ProjectFile => !!x);
  const state = ORDER.find((s) => files.some((x) => x.state === s)) ?? 'up_to_date';
  return {
    project: p, root, details,
    view: {
      projectId: p.id, name: p.name, folder: p.folder, writeFiles: f.filesEnabled, companyFacts: !!f.companyFacts,
      state, needsYou: NEEDS_YOU.has(state), writtenAt: f.writtenAt, version, files,
    },
  };
}

async function filesProject(ownerId: string, projectId: unknown): Promise<Project> {
  const p = typeof projectId === 'string' && projectId ? await findProject(ownerId, projectId) : undefined;
  if (!p || !p.folder) throw new BridgeError('Not found', 404, 'not_found');
  return p;
}

function tracked(relative: unknown): string {
  if (typeof relative !== 'string' || !PROJECT_FILE_PATHS.includes(relative)) throw new BridgeError(`path must be one of ${PROJECT_FILE_PATHS.join(', ')}`, 400, 'bad_path');
  return relative;
}

/** One listed file of the project, ready to compare or write; refuses a missing folder and a file without a Girru version. */
function writable(i: Inspected, relative: string): Detail & { root: string } {
  if (!i.root) throw new BridgeError('The project folder is not on this computer', 409, 'folder_not_found');
  const d = i.details.get(relative);
  if (!d || d.girru === null) throw new BridgeError(`${relative} has no Girru version to compare or write`, 400, 'bad_path');
  return { ...d, root: i.root };
}

// --- reads ------------------------------------------------------------------

/** Every project with a folder, needs-you first, then by name. */
export async function listProjectFiles(ownerId: string): Promise<{ projects: ProjectFiles[] }> {
  const out: ProjectFiles[] = [];
  for (const p of (await listProjects(ownerId)).filter((x) => x.folder)) out.push((await inspect(ownerId, p)).view);
  out.sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || a.name.localeCompare(b.name));
  return { projects: out };
}

export async function projectFiles(ownerId: string, projectId: unknown): Promise<ProjectFiles> {
  return (await inspect(ownerId, await filesProject(ownerId, projectId))).view;
}

/** Girru's version beside the folder's (Girru's part only for AGENTS.md / CLAUDE.md / GEMINI.md). */
export async function compareFile(ownerId: string, projectId: unknown, relative: unknown) {
  const rel = tracked(relative);
  const i = await inspect(ownerId, await filesProject(ownerId, projectId));
  const d = writable(i, rel);
  return { path: rel, version: d.file.version, girruText: d.girru!, folderText: d.folderText };
}

// --- writes -----------------------------------------------------------------

/** ⌘R: write the files again where Girru may; a file changed in the folder (or one Girru cannot write) is left as it is. */
export async function rewriteFiles(ownerId: string, projectId: unknown): Promise<{ project: ProjectFiles }> {
  const p = await filesProject(ownerId, projectId);
  const i = await inspect(ownerId, p);
  if (!i.root) throw new BridgeError('The project folder is not on this computer', 409, 'folder_not_found');
  const st = (x: string) => i.details.get(x)?.file.state;
  // The three memory files are written together (all or nothing), only while the owner's switch is on.
  const trio = MANAGED_FILES.map(st);
  if (i.view.writeFiles && trio.some((s) => s === 'waiting') && trio.every((s) => s === 'waiting' || s === 'up_to_date')) {
    const preview = await filesPreview(ownerId, p.id);
    await filesApply(ownerId, p.id, { previewHash: preview.previewHash, confirm: true }, 'owner: write again');
  }
  // The brief projection refuses by itself to replace a file changed outside Girru.
  const scope = projectScope(p);
  if (st(BRIEF) === 'waiting' && (await scopeInfo(scope))?.enabled) await runBriefProjection(scope, { force: true });
  if (st(TASKS_FILE) === 'waiting') await ensureTaskFile(p.id).catch(() => undefined);
  return { project: await projectFiles(ownerId, p.id) };
}

interface UndoEntry { ownerId: string; projectId: string; path: string; before: Buffer; afterSha: string; proposalId: string | null; at: number }
const UNDO_MS = 24 * 60 * 60_000;
const undos = new Map<string, UndoEntry>();
/** Test seam: forget every Undo. */
export function resetProjectFileUndo(): void { undos.clear(); }

/** The lines someone added in the folder (what Girru's text lacks), without list marks: only these become the suggestion. */
function addedLines(folder: string, girru: string): string {
  const norm = (l: string) => l.trim().replace(/^(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/, '').trim();
  const known = new Set(girru.split(/\r?\n/).map(norm).filter(Boolean));
  return folder.split(/\r?\n/).map(norm).filter((l) => l && !known.has(l) && !/^<!--[\s\S]*-->$/.test(l)).join('\n');
}

/**
 * "Use Girru's version" of one file: the folder's text of Girru's part becomes
 * a memory proposal (reason repository-file), then Girru's version is written.
 */
export async function useGirruVersion(ownerId: string, projectId: unknown, relative: unknown): Promise<{ project: ProjectFiles; undo: string }> {
  const rel = tracked(relative);
  const p = await filesProject(ownerId, projectId);
  const i = await inspect(ownerId, p);
  const d = writable(i, rel);
  if (d.file.state === 'could_not_write') throw new BridgeError(d.file.reason ?? `Girru cannot write ${rel}`, 409, 'could_not_write');
  if (d.before === null) throw new BridgeError(`${rel} is not in the folder yet; write the files again instead`, 409, 'could_not_write');
  const scope = projectScope(p);
  if (rel === BRIEF && !(await scopeInfo(scope))) throw new BridgeError('Turn on Write project files first', 409, 'could_not_write');

  // The folder's text is kept first, as a suggestion the owner reviews (never memory by itself).
  let proposalId: string | null = null;
  const kept = addedLines(d.folderText ?? '', d.girru!);
  if (kept) {
    const r = await learn({ userId: ownerId, actor: 'bridge:project-files', review: true, reviewReason: 'repository-file',
      candidates: [{ content: redactImportText(kept).text, type: 'fact', importance: 5, drawer: projectDrawer(p), origin: 'extraction' }] });
    proposalId = r.proposed[0]?.id ?? null;
    if (!proposalId && !r.skipped.some((s) => s.reason === 'already known')) {
      throw new BridgeError(`The folder's text could not be kept as a suggestion (${r.skipped[0]?.reason ?? 'unknown'}); nothing was written`, 409, 'could_not_write');
    }
  }
  try {
    if (rel === BRIEF) {
      const r = await runBriefProjection(scope, { force: true, overwrite: true, keepOutsideFile: false });
      if (!r.wrote) throw new BridgeError(r.reason ?? `Girru could not write ${rel}`, 409, 'could_not_write');
    } else if (rel === CURSOR_RULE) {
      safeWriteFile(d.root, CURSOR_RULE, CURSOR_RULE_TEXT, { expectSha256: sha(d.before) });
    } else {
      writeSection(d.root, rel, d.girru!, d.marks!);
    }
  } catch (err) {
    if (proposalId) await withdraw(ownerId, proposalId);
    if (err instanceof ManagedFileError) throw new BridgeError(err.message, 409, 'could_not_write');
    if (err instanceof SafeFileError) throw new BridgeError(err.message, 409, 'could_not_write');
    throw err;
  }
  const after = readBytes(d.root, rel);
  const token = `pfu_${randomBytes(24).toString('hex')}`;
  const now = Date.now();
  for (const [k, v] of undos) if (now - v.at > UNDO_MS) undos.delete(k);
  undos.set(token, { ownerId, projectId: p.id, path: rel, before: d.before, afterSha: after instanceof Buffer ? sha(after) : '', proposalId, at: now });
  await audit(ownerId, 'files-written', { projectId: p.id, note: `${rel}: Girru's version by owner${proposalId ? `, folder text kept as proposal ${proposalId}` : ''}` });
  return { project: await projectFiles(ownerId, p.id), undo: token };
}

async function withdraw(ownerId: string, proposalId: string): Promise<void> {
  const pr = await getProposal(ownerId, proposalId);
  if (pr?.status === 'pending') await rejectProposal(ownerId, proposalId, `owner:${ownerId}`, pr.reviewHash, "withdrawn: Use Girru's version was undone").catch(() => undefined);
}

/** Undo "Use Girru's version": the folder text back and the proposal withdrawn, only while the file is as Girru left it. */
export async function undoUseGirru(ownerId: string, projectId: unknown, token: unknown): Promise<{ project: ProjectFiles }> {
  const p = await filesProject(ownerId, projectId);
  const e = typeof token === 'string' ? undos.get(token) : undefined;
  const expired = () => new BridgeError('Undo is no longer possible: the file changed since', 409, 'undo_expired');
  if (!e || e.ownerId !== ownerId || e.projectId !== p.id || Date.now() - e.at > UNDO_MS) throw expired();
  const root = realFolder(p.folder);
  if (!root) throw new BridgeError('The project folder is not on this computer', 409, 'folder_not_found');
  const now = readBytes(root, e.path);
  if (!(now instanceof Buffer) || sha(now) !== e.afterSha) { undos.delete(token as string); throw expired(); }
  try { safeWriteFile(root, e.path, e.before, { expectSha256: e.afterSha }); } catch (err) {
    if (err instanceof SafeFileError) { if (err.code === 'changed') { undos.delete(token as string); throw expired(); } throw new BridgeError(err.message, 409, 'could_not_write'); }
    throw err;
  }
  undos.delete(token as string);
  if (e.proposalId) await withdraw(ownerId, e.proposalId);
  await audit(ownerId, 'files-written', { projectId: p.id, note: `${e.path}: folder text put back by owner (undo)` });
  return { project: await projectFiles(ownerId, p.id) };
}

/** The project's two switches: write project files (preview + apply in one step) and company facts (D22). */
export async function patchProjectFiles(ownerId: string, projectId: unknown, body: { writeFiles?: unknown; companyFacts?: unknown }): Promise<{ project: ProjectFiles }> {
  const p = await filesProject(ownerId, projectId);
  if (body.writeFiles !== undefined && typeof body.writeFiles !== 'boolean') throw new BridgeError('writeFiles must be true or false');
  if (body.companyFacts !== undefined && typeof body.companyFacts !== 'boolean') throw new BridgeError('companyFacts must be true or false');
  if (body.companyFacts !== undefined) await setFolder(ownerId, p.id, { companyFacts: body.companyFacts });
  if (body.writeFiles !== undefined && body.writeFiles !== (await folderSettings(ownerId, p.id)).filesEnabled) {
    if (body.writeFiles) {
      if (!realFolder(p.folder)) throw new BridgeError('The project folder is not on this computer', 409, 'folder_not_found');
      // The switch is the owner's confirmation: the same preview, then the write it describes.
      const preview = await filesPreview(ownerId, p.id);
      await filesApply(ownerId, p.id, { previewHash: preview.previewHash, confirm: true }, 'owner: write project files on');
      await enableScope(ownerId, p);
    } else {
      await setFolder(ownerId, p.id, { filesEnabled: false });
      if (p.id !== pilotProjectId()) await disableScope(projectScope(p));
    }
  }
  return { project: await projectFiles(ownerId, p.id) };
}
