/**
 * Managed memory files in a project folder (MEM-BRIDGE-01, the fallback for
 * agents that do not use the MCP server):
 *
 *   AGENTS.md   the canonical brief (Codex and Antigravity read it; Claude Code
 *               and Gemini CLI through the adapters)
 *   CLAUDE.md   thin adapter: `@AGENTS.md` (Claude Code import syntax)
 *   GEMINI.md   thin adapter: `@./AGENTS.md` (Gemini CLI import syntax)
 *
 * Girru writes ONLY between its two markers. Text outside them is the owner's
 * (or another agent's) and is kept byte for byte; a file without markers gets
 * the section appended. Broken markers (one missing, or more than one pair),
 * a symlink or an oversized file is a conflict: nothing is written to that
 * folder. Every write goes through a dry-run preview first; the apply call
 * carries the preview hash, so a file that changed in between is refused.
 * The brief is redacted (brief.ts) and checked again here: a block that
 * still holds anything the secret scan finds is never written.
 * Files Girru creates are listed in `.git/info/exclude` (inside its own
 * markers) unless the owner turns that off.
 */
import fs from 'node:fs';
import { readRegularFile } from './regular-file.js';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { redactImportText } from '../import/redact.js';
import { assertProjectFilesOnly, briefMarkdown, ProjectFilesScopeError, type ProjectBrief } from './brief.js';
import { SERVER_NAME } from './clients.js';
import { safeWriteFile, SafeFileError } from '../../services/safe-file.js';
import { storeP7Enabled } from '../../services/store-p7.js';

export const MARK_START = '<!-- dpro-memory:start — managed by Dpro: the text between these two markers is replaced on every sync; write your own notes outside them -->';
export const MARK_END = '<!-- dpro-memory:end -->';
const START_RE = /<!-- dpro-memory:start\b[^\n]*?-->/g;
const END_RE = /<!-- dpro-memory:end -->/g;
const GIT_START = '# dpro-memory:start (managed by Dpro)';
const GIT_END = '# dpro-memory:end';
/**
 * STORE-MAP-01 P2: ONE Girru section per file (memory brief, rules and the task
 * pointer together), with Girru markers. The two older sections (this file's
 * `dpro-memory` block and the rules writer's `girru:rules` block) are removed
 * in place when it is written; with P2 off, the older writers remove it again.
 */
export const GIRRU_START = '<!-- girru:start — written by Girru: the text between these two markers is replaced on every sync; write your own notes outside them -->';
export const GIRRU_END = '<!-- girru:end -->';
export const RULES_START_RE = /<!-- girru:rules\b[^\n]*?-->/g;
export const RULES_END_RE = /<!-- \/girru:rules -->/g;
export const MAX_MANAGED_FILE_BYTES = 1024 * 1024;
export const MANAGED_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] as const;
export type ManagedName = (typeof MANAGED_FILES)[number];

export class ManagedFileError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'invalid_request') { super(message); }
}

type Split = { before: string; inside: string; after: string };
/** A pair of Girru markers: the memory section here, the design section in DESIGN.md (DESIGN-FIND-01). */
export interface Marks { start: string; end: string; startRe: RegExp; endRe: RegExp }
const MEMORY_MARKS: Marks = { start: MARK_START, end: MARK_END, startRe: START_RE, endRe: END_RE };
export const GIRRU_MARKS: Marks = { start: GIRRU_START, end: GIRRU_END, startRe: /<!-- girru:start\b[^\n]*?-->/g, endRe: /<!-- girru:end -->/g };
const RULES_MARKS: Marks = { start: '', end: '', startRe: RULES_START_RE, endRe: RULES_END_RE };
/** What a P2 write replaces, and what an older writer removes after P2 was turned off. */
export const P2_LEGACY: readonly Marks[] = [MEMORY_MARKS, RULES_MARKS];
export const PRE_P2_LEGACY: readonly Marks[] = [GIRRU_MARKS];
const ALL_GIRRU_MARKS: readonly Marks[] = [MEMORY_MARKS, GIRRU_MARKS, RULES_MARKS];

/** What else goes into the one Girru section (P2): the project's rules for coding apps and the task file pointer. */
export interface SectionExtras { rules: string; tasks: boolean }

/** The one Girru section of AGENTS.md (P2): memory brief (when the owner turned memory files on), rules, task pointer. */
export function unifiedBlock(brief: ProjectBrief | null, extras: SectionExtras): string {
  const parts: string[] = [];
  if (brief) parts.push(briefMarkdown(brief));
  else parts.push('## Girru project instructions');
  if (extras.rules.trim()) parts.push(`### Rules from the owner (Agents › Rules)\n\n${extras.rules.trim()}`);
  if (extras.tasks) parts.push('### Tasks\n\nThe project\'s tasks are in `.girru/tasks.md`: one `## T-n · title` block per task. Keep that format when you update a task; finished tasks move to `.girru/tasks-done.md`.');
  return parts.join('\n\n');
}

/**
 * `text` with the given older Girru sections removed; `at` = where the first
 * one was (the new section goes there). 'broken' when one has broken markers.
 */
export function withoutSections(text: string, legacy: readonly Marks[]): { text: string; at: number | null; removed: string[] } | 'broken' {
  let out = text;
  let at: number | null = null;
  const removed: string[] = [];
  for (const m of legacy) {
    const split = splitManaged(out, m);
    if (split === 'broken') return 'broken';
    if (!split) continue;
    removed.push(split.inside);
    const pos = split.before.length;
    const after = split.after.replace(/^\n/, '');
    out = split.before + after;
    at = at === null ? pos : Math.min(at, pos);
  }
  return { text: out, at, removed };
}

/** The text around Girru's section; null when there is none, 'broken' when the markers are not exactly one ordered pair. */
export function splitManaged(text: string, marks: Marks = MEMORY_MARKS): Split | null | 'broken' {
  const starts = [...text.matchAll(marks.startRe)];
  const ends = [...text.matchAll(marks.endRe)];
  if (!starts.length && !ends.length) return null;
  if (starts.length !== 1 || ends.length !== 1) return 'broken';
  const s = starts[0], e = ends[0];
  if (e.index! < s.index!) return 'broken';
  return { before: text.slice(0, s.index!), inside: text.slice(s.index! + s[0].length, e.index!), after: text.slice(e.index! + e[0].length) };
}

/** `text` with Girru's section set to `block`; outside text unchanged. */
export function replaceManaged(text: string, block: string, marks: Marks = MEMORY_MARKS): string {
  const section = `${marks.start}\n${block.trim()}\n${marks.end}`;
  const split = splitManaged(text, marks);
  if (split === 'broken') throw new ManagedFileError('The Girru markers in this file are broken', 409, 'markers_broken');
  if (split) return split.before + section + split.after;
  if (!text) return `${section}\n`;
  return `${text}${text.endsWith('\n') ? '' : '\n'}\n${section}\n`;
}

/**
 * The owner's own text: everything outside Girru's sections (the memory
 * section, the one P2 section and the rules section), so back-flow never
 * reads Girru's own text back as a proposal.
 */
export function outsideManaged(text: string): string {
  const out = withoutSections(text, ALL_GIRRU_MARKS);
  return out === 'broken' ? text : out.text;
}

export function adapterBlock(name: ManagedName): string {
  if (name === 'CLAUDE.md') return `@AGENTS.md\n\nThe Girru project memory for this folder is in AGENTS.md (imported above). Live tools: the \`${SERVER_NAME}\` MCP server.`;
  return `@./AGENTS.md\n\nThe Girru project memory for this folder is in AGENTS.md (imported above). Live tools: the \`${SERVER_NAME}\` MCP server.`;
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export interface FilePlan {
  name: string;
  /** Path relative to the project folder. */
  relative: string;
  action: 'create' | 'update' | 'unchanged' | 'conflict';
  reason?: string;
  beforeSha256: string | null;
  afterSha256: string | null;
  /** Girru's section before (-) and after (+); outside text is never part of a change. */
  diff: string;
}
export interface FilesPreview { projectId: string; folder: string; files: FilePlan[]; previewHash: string; conflicts: number; changes: number }
type Planned = FilePlan & { abs: string; after: string | null; mode: number | null };

function readExisting(abs: string): { text: string | null; mode: number | null; problem?: string } {
  try {
    const { bytes, mode } = readRegularFile(abs, MAX_MANAGED_FILE_BYTES);
    const text = bytes.toString('utf8');
    if (text.includes('\0')) return { text: null, mode: null, problem: 'is not a text file' };
    return { text, mode };
  } catch (e: any) {
    return e.code === 'ENOENT' ? { text: null, mode: null } : { text: null, mode: null, problem: 'is unreadable, changed, oversized or not a regular file' };
  }
}

function blockDiff(oldBlock: string | null, newBlock: string): string {
  const out: string[] = [];
  if (oldBlock !== null) for (const l of oldBlock.trim().split('\n')) out.push(`-${l}`);
  for (const l of newBlock.trim().split('\n')) out.push(`+${l}`);
  return out.join('\n');
}

function planFile(folder: string, relative: string, block: string, marks: Marks = MEMORY_MARKS, legacy: readonly Marks[] = PRE_P2_LEGACY): Planned {
  const abs = path.join(folder, relative);
  const cur = readExisting(abs);
  const base = { name: path.basename(relative), relative, abs, mode: cur.mode };
  if (cur.problem) return { ...base, action: 'conflict', reason: `${relative} ${cur.problem}`, beforeSha256: null, afterSha256: null, diff: '', after: null };
  const broken = { ...base, action: 'conflict' as const, reason: `${relative} has broken Girru markers; fix or remove them by hand`, beforeSha256: cur.text === null ? null : sha(cur.text), afterSha256: null, diff: '', after: null };
  const split = cur.text === null ? null : splitManaged(cur.text, marks);
  if (split === 'broken') return broken;
  // Older Girru sections of the other layout are removed; the new section takes the place of the first one.
  const old = cur.text === null ? null : withoutSections(cur.text, legacy);
  if (old === 'broken') return broken;
  let after: string;
  if (old && old.at !== null && !split) {
    const section = `${marks.start}\n${block.trim()}\n${marks.end}\n`;
    after = old.text.slice(0, old.at) + section + old.text.slice(old.at);
  } else {
    after = replaceManaged(old ? old.text : (cur.text ?? ''), block, marks);
  }
  const before = cur.text;
  const action = before === null ? 'create' : before === after ? 'unchanged' : 'update';
  const previous = [split ? split.inside : null, ...(old ? old.removed : [])].filter((x): x is string => x !== null).join('\n');
  return { ...base, action, beforeSha256: before === null ? null : sha(before), afterSha256: sha(after), diff: action === 'unchanged' ? '' : blockDiff(previous || null, block), after };
}

/** `.git/info/exclude` with Girru's list of files it created (only when the folder is a git work tree). */
function planGitExclude(folder: string, created: string[]): Planned | null {
  const gitDir = path.join(folder, '.git');
  try { if (!fs.lstatSync(gitDir).isDirectory()) return null; } catch { return null; }
  const relative = path.join('.git', 'info', 'exclude');
  const abs = path.join(folder, relative);
  const cur = readExisting(abs);
  const base = { name: 'exclude', relative, abs, mode: cur.mode };
  if (cur.problem) return { ...base, action: 'conflict', reason: `${relative} ${cur.problem}`, beforeSha256: null, afterSha256: null, diff: '', after: null };
  const text = cur.text ?? '';
  const s = text.indexOf(GIT_START), e = text.indexOf(GIT_END);
  const listed = s >= 0 && e > s ? text.slice(s + GIT_START.length, e).split('\n').map((l) => l.trim()).filter(Boolean) : [];
  const names = [...new Set([...listed, ...created.map((c) => `/${c}`)])].sort();
  if (!created.length || created.every((c) => listed.includes(`/${c}`))) return null;
  const section = `${GIT_START}\n${names.join('\n')}\n${GIT_END}`;
  const after = s >= 0 && e > s ? text.slice(0, s) + section + text.slice(e + GIT_END.length) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${section}\n`;
  return { ...base, action: cur.text === null ? 'create' : 'update', beforeSha256: cur.text === null ? null : sha(cur.text), afterSha256: sha(after), diff: names.map((n) => `${listed.includes(n) ? ' ' : '+'}${n}`).join('\n'), after };
}

function checkFolder(folder: string | null): string {
  if (!folder) throw new ManagedFileError('This project has no folder', 400, 'no_folder');
  let real: string;
  try { real = fs.realpathSync.native(folder); } catch { throw new ManagedFileError('The project folder does not exist', 404, 'folder_missing'); }
  if (!fs.statSync(real).isDirectory()) throw new ManagedFileError('The project folder is not a folder', 400, 'no_folder');
  return real;
}

/** A managed block must hold nothing the secret scan finds (brief.ts already redacted it). */
function assertNoSecret(block: string): void {
  const r = redactImportText(block);
  if (Object.values(r.counts).some((n) => Number(n) > 0)) throw new ManagedFileError('The brief still contains something that looks like a secret; nothing was written', 422, 'secret_found');
}

function plan(brief: ProjectBrief | null, folderRaw: string | null, gitExclude: boolean, extras?: SectionExtras): { folder: string; files: Planned[] } {
  const folder = checkFolder(folderRaw);
  if (!extras && !brief) throw new ManagedFileError('Nothing to write', 400, 'invalid_request');
  // P2 (extras given): one Girru section; otherwise the memory section of the earlier layout.
  const canonical = extras ? unifiedBlock(brief, extras) : briefMarkdown(brief!);
  // The memory part is secret-checked (brief.ts redacted it already); the owner's rules are the owner's own words.
  if (brief) assertNoSecret(briefMarkdown(brief));
  // S4 (P7): owner, people and personal drawers never reach a project file.
  if (brief && storeP7Enabled()) {
    try { assertProjectFilesOnly(brief); } catch (err) {
      if (err instanceof ProjectFilesScopeError) throw new ManagedFileError(`${err.message}; nothing was written`, 422, err.code);
      throw err;
    }
  }
  const files: Planned[] = MANAGED_FILES.map((name) => planFile(folder, name, name === 'AGENTS.md' ? canonical : adapterBlock(name),
    extras ? GIRRU_MARKS : MEMORY_MARKS, extras ? P2_LEGACY : PRE_P2_LEGACY));
  if (gitExclude) {
    const g = planGitExclude(folder, files.filter((f) => f.action === 'create').map((f) => f.relative));
    if (g) files.push(g);
  }
  return { folder, files };
}

const hashOf = (folder: string, files: FilePlan[]) => sha(JSON.stringify([folder, files.map((f) => [f.relative, f.action, f.beforeSha256, f.afterSha256])]));
const visible = ({ abs: _a, after: _b, mode: _m, ...f }: Planned): FilePlan => f;

/** Dry run: what the folder's files would look like (nothing is written). */
export function previewFiles(projectId: string, brief: ProjectBrief | null, folder: string | null, gitExclude = true, extras?: SectionExtras): FilesPreview {
  const p = plan(brief, folder, gitExclude, extras);
  const files = p.files.map(visible);
  return { projectId, folder: p.folder, files, previewHash: hashOf(p.folder, files), conflicts: files.filter((f) => f.action === 'conflict').length, changes: files.filter((f) => f.action === 'create' || f.action === 'update').length };
}

function writeAtomic(folder: string, relative: string, abs: string, text: string, mode: number | null): void {
  // STORE-MAP-01 P7 (SEC2-6): the one safe file writer.
  if (storeP7Enabled()) {
    try { safeWriteFile(folder, relative.split(path.sep).join('/'), text, { mode: mode ?? 0o644, maxBytes: MAX_MANAGED_FILE_BYTES }); }
    catch (e) { if (e instanceof SafeFileError) throw new ManagedFileError(`Nothing written to ${relative}: ${e.message}`, 409, e.code === 'locked' ? 'locked' : 'unsafe_path'); throw e; }
    return;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, text, { flag: 'wx', mode: mode ?? 0o644 });
  try { if (mode !== null) fs.chmodSync(tmp, mode); fs.renameSync(tmp, abs); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

/**
 * Writes the planned files. `expectedHash` = the preview the owner saw, or
 * null for a regeneration of an already confirmed folder (still all-or-nothing:
 * any conflict writes nothing).
 */
export function applyFiles(projectId: string, brief: ProjectBrief | null, folder: string | null, gitExclude: boolean, expectedHash: string | null, extras?: SectionExtras): FilesPreview {
  const p = plan(brief, folder, gitExclude, extras);
  const files = p.files.map(visible);
  const hash = hashOf(p.folder, files);
  if (expectedHash !== null && hash !== expectedHash) throw new ManagedFileError('The files or the memory changed since the preview; preview again', 409, 'preview_stale');
  const conflicts = p.files.filter((f) => f.action === 'conflict');
  if (conflicts.length) throw new ManagedFileError(`Nothing written: ${conflicts.map((c) => c.reason).join('; ')}`, 409, 'conflict');
  for (const f of p.files) if ((f.action === 'create' || f.action === 'update') && f.after !== null) writeAtomic(p.folder, f.relative, f.abs, f.after, f.mode);
  return { projectId, folder: p.folder, files, previewHash: hash, conflicts: 0, changes: files.filter((f) => f.action === 'create' || f.action === 'update').length };
}

/**
 * Write one Girru section into one file (DESIGN-FIND-01: DESIGN.md), between
 * `marks`: the same rules as the managed memory files (outside text kept byte
 * for byte, a symlink / non-text / oversized file or broken markers = conflict,
 * nothing written) and the same secret check. Atomic.
 */
export function writeSection(folderRaw: string | null, relative: string, block: string, marks: Marks): { action: 'create' | 'update' | 'unchanged'; file: string } {
  const folder = checkFolder(folderRaw);
  assertNoSecret(block);
  const abs = path.join(folder, relative);
  const cur = readExisting(abs);
  if (cur.problem) throw new ManagedFileError(`${relative} ${cur.problem}`, 409, 'conflict');
  if (cur.text !== null && splitManaged(cur.text, marks) === 'broken') throw new ManagedFileError(`${relative} has broken Girru markers; fix or remove them by hand`, 409, 'markers_broken');
  const after = replaceManaged(cur.text ?? '', block, marks);
  if (cur.text === after) return { action: 'unchanged', file: abs };
  writeAtomic(folder, relative, abs, after, cur.mode);
  return { action: cur.text === null ? 'create' : 'update', file: abs };
}
