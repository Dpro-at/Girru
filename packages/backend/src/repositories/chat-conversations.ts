/**
 * Saved chat conversations and their turns (CHAT-REBUILD-01).
 *
 * Built on chat_sessions / chat_messages (migration 084 adds the agent,
 * pinned flag and the assistant turn's work: reasoning, tool calls and text
 * in order, its status and duration). Every function takes the caller's user
 * id where it matters; the routes never pass one from the request body.
 */

import { deleteSessionSummaries } from '../memory/context/summaries.js';
import { deleteSessionTraces } from '../memory/context/trace.js';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { orderedId } from './ordered-id.js';
import { q, sql, one, run, type Step } from './sql-steps.js';
import { deleteChatImages } from '../services/chat-images.js';

export type TurnStatus = 'complete' | 'stopped' | 'error';

/** One piece of an assistant turn, in the order it happened. */
export type TurnPart =
  | { kind: 'reasoning'; text: string; ms?: number }
  | { kind: 'text'; text: string }
  | { kind: 'tools'; step: number; calls: ToolCallPart[] }
  /** CHAT-BUILD-01 stage 5: a message the owner sent while the agent worked, seen at a step. */
  | { kind: 'steer'; text: string; step: number }
  /** A notice kept with the reply (injected text that was ignored, the chat summed up). */
  | { kind: 'notice'; code: string; text?: string };

export interface ToolCallPart { id: string; name: string; input: string; output?: string; isError?: boolean; ms?: number; approvalId?: string }

export interface Conversation {
  id: string;
  title: string | null;
  agentId: string | null;
  projectId: string | null;
  pinned: boolean;
  model?: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  /** CHAT-BUILD-01 stage 2: archived chats leave the sidebar sections (still searchable and open). */
  archived?: boolean;
  /** The chat an agent opened this one from (shown under it in the sidebar). */
  parentId?: string | null;
  /** CHAT-BUILD-01 stage 3 (CH3): Mode and Thinking of this chat (absent = auto / normal). */
  mode?: ChatMode;
  thinking?: ChatThinking;
  /** Messages waiting to be sent after the running reply (kept across reloads). */
  queued?: { key: string; text: string }[];
}
export type ChatMode = 'auto' | 'ask' | 'accept_edits' | 'plan';
export type ChatThinking = 'quick' | 'normal' | 'deep';
export const CHAT_MODES: readonly ChatMode[] = ['auto', 'ask', 'accept_edits', 'plan'];
export const CHAT_THINKING: readonly ChatThinking[] = ['quick', 'normal', 'deep'];
const parseQueue = (raw: string | null | undefined) => { try { const v = JSON.parse(raw ?? '[]'); return Array.isArray(v) ? v.filter((x) => x && typeof x.key === 'string' && typeof x.text === 'string').slice(0, 20) : []; } catch { return []; } };

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  parts: TurnPart[] | null;
  status: TurnStatus;
  runId: string | null;
  durationMs: number | null;
  createdAt: string;
  code?: 'run_interrupted';
  /** CHAT-PRO-02 I: the agent that wrote an assistant reply (null = the conversation's agent). */
  agentId?: string | null;
  /** CHAT-BUILD-01 stage 5: files this reply changed in the project folder, and whether they were undone. */
  changes?: { files: number; undone: boolean; unavailable?: boolean; added?: number; removed?: number };
}

interface SessionRow { mode?: string | null; thinking?: string | null; queued?: string | null; archived_at?: string | null; parent_id?: string | null; model?: string; id: string; user_id: string; title: string | null; agent_id: string | null; project_id?: string | null; pinned: number; created_at: string; updated_at: string; preview?: string | null }
interface MessageRow { checkpoint_added?: number | null; checkpoint_removed?: number | null; checkpoint_files?: number | null; checkpoint_undone?: number | null; id: string; role: ConversationMessage['role']; content: string; parts: string | null; status: TurnStatus | null; run_id: string | null; duration_ms: number | null; created_at: string; agent_id?: string | null; error_code?: string | null }

const PREVIEW_CHARS = 140;

function toConversation(r: SessionRow): Conversation {
  return {
    ...(r.model&&r.model!=='default'?{model:r.model}:{}),
    id: r.id, title: r.title, agentId: r.agent_id, projectId: r.project_id ?? null, pinned: !!r.pinned,
    preview: (r.preview ?? '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS),
    createdAt: r.created_at, updatedAt: r.updated_at,
    ...(r.archived_at ? { archived: true } : {}), ...(r.parent_id ? { parentId: r.parent_id } : {}),
    ...(r.mode && r.mode !== 'auto' && (CHAT_MODES as readonly string[]).includes(r.mode) ? { mode: r.mode as ChatMode } : {}),
    ...(r.thinking && r.thinking !== 'normal' && (CHAT_THINKING as readonly string[]).includes(r.thinking) ? { thinking: r.thinking as ChatThinking } : {}),
    ...(r.queued && parseQueue(r.queued).length ? { queued: parseQueue(r.queued) } : {}),
  };
}

function parseParts(raw: string | null): TurnPart[] | null {
  if (!raw) return null;
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null; } catch { return null; }
}

function toMessage(r: MessageRow): ConversationMessage {
  return {
    id: r.id, role: r.role, content: r.content, parts: parseParts(r.parts), status: r.status ?? 'complete',
    runId: r.run_id, durationMs: r.duration_ms, createdAt: r.created_at, agentId: r.agent_id ?? null, ...(r.error_code === 'run_interrupted' ? { code: 'run_interrupted' as const } : {}),
    ...(Number(r.checkpoint_files) > 0 ? { changes: { files: Number(r.checkpoint_files), undone: !!r.checkpoint_undone, ...(r.checkpoint_added != null ? { added: Number(r.checkpoint_added), removed: Number(r.checkpoint_removed ?? 0) } : {}) } } : Number(r.checkpoint_files) === -1 ? { changes: { files: 0, undone: false, unavailable: true } } : {}),
  };
}

const PREVIEW_SQL = `(SELECT m.content FROM chat_messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.created_at DESC, m.id DESC LIMIT 1)`;

/** The caller's conversations: pinned first, then most recent. */
export async function listConversations(userId: string, limit = 200): Promise<Conversation[]> {
  const rows = await q.all<SessionRow>(
    `SELECT s.*, ${PREVIEW_SQL} AS preview FROM chat_sessions s WHERE s.user_id = ? ORDER BY s.pinned DESC, s.updated_at DESC, s.id DESC LIMIT ?`,
    userId, limit);
  // The waiting messages travel with one open chat only, never in the list.
  return rows.map(toConversation).map(({ queued: _queued, ...c }) => c);
}

/** The conversation if it belongs to the caller (else undefined: the route answers 404). */
export async function findConversation(userId: string, id: string): Promise<Conversation | undefined> {
  const r = await q.one<SessionRow>(`SELECT s.*, ${PREVIEW_SQL} AS preview FROM chat_sessions s WHERE s.id = ? AND s.user_id = ?`, id, userId);
  return r ? toConversation(r) : undefined;
}

export async function createConversation(userId: string, input: { title?: string | null; agentId?: string | null; projectId?: string | null; model?: string; mode?: ChatMode; thinking?: ChatThinking }): Promise<Conversation> {
  const id = randomUUID();
  await q.run('INSERT INTO chat_sessions (id, user_id, title, model, agent_id, project_id, mode, thinking) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, userId, input.title?.trim() || null, input.model || 'default', input.agentId || null, input.projectId || null, input.mode ?? null, input.thinking ?? null);
  return (await findConversation(userId, id))!;
}

/** Rename and/or pin. Renaming bumps nothing else; pinning does not reorder by time. */
export async function patchConversation(userId: string, id: string, patch: { title?: string | null; pinned?: boolean; projectId?: string | null; model?: string; archived?: boolean; mode?: ChatMode; thinking?: ChatThinking; queued?: { key: string; text: string }[] }): Promise<Conversation | undefined> {
  const fields: string[] = [];
  const params: Array<string | number | null> = [];
  if (patch.model !== undefined) { fields.push('model = ?'); params.push(patch.model || 'default'); }
  if (patch.title !== undefined) { fields.push('title = ?'); params.push(patch.title?.trim() || null); }
  if (patch.pinned !== undefined) { fields.push('pinned = ?'); params.push(patch.pinned ? 1 : 0); }
  if (patch.projectId !== undefined) { fields.push('project_id = ?'); params.push(patch.projectId); }
  if (patch.mode !== undefined) { fields.push('mode = ?'); params.push(patch.mode); }
  if (patch.thinking !== undefined) { fields.push('thinking = ?'); params.push(patch.thinking); }
  if (patch.queued !== undefined) { fields.push('queued = ?'); params.push(patch.queued.length ? JSON.stringify(patch.queued) : null); }
  if (patch.archived !== undefined) fields.push(patch.archived ? 'archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP)' : 'archived_at = NULL');
  if (fields.length) await q.run(`UPDATE chat_sessions SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, ...params, id, userId);
  return findConversation(userId, id);
}

/** Deletes the conversation and its messages (ON DELETE CASCADE). */
export async function deleteConversation(userId: string, id: string): Promise<boolean> {
  const gone = (await q.run('DELETE FROM chat_sessions WHERE id = ? AND user_id = ?', id, userId)).changes > 0;
  // MEM-CACHE-01: its turn summaries and reply traces go with it.
  if (gone) { await Promise.all([deleteSessionSummaries(id), deleteSessionTraces(id)]).catch(() => undefined); deleteChatImages(id); }
  return gone;
}

export async function listConversationMessages(sessionId: string): Promise<ConversationMessage[]> {
  const rows = await q.all<MessageRow>('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC', sessionId);
  return rows.map(toMessage);
}

/** CHAT-BUILD-01: one page of a long conversation, newest last. `before` is a message id of this
 * conversation; a page stops at `limit` messages or about `maxChars` of stored text (never empty). */
export async function pageConversationMessages(sessionId: string, opts: { before?: string; limit: number; maxChars: number }): Promise<{ messages: ConversationMessage[]; hasMore: boolean } | null> {
  let anchor: { created_at: string; id: string } | undefined;
  if (opts.before) {
    anchor = await q.one<{ created_at: string; id: string }>('SELECT created_at, id FROM chat_messages WHERE id = ? AND session_id = ?', opts.before, sessionId);
    if (!anchor) return null;
  }
  const rows = anchor
    ? await q.all<MessageRow>('SELECT * FROM chat_messages WHERE session_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?', sessionId, anchor.created_at, anchor.created_at, anchor.id, opts.limit + 1)
    : await q.all<MessageRow>('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', sessionId, opts.limit + 1);
  const page: MessageRow[] = [];
  let chars = 0;
  for (const row of rows.slice(0, opts.limit)) {
    chars += String(row.content ?? '').length + String(row.parts ?? '').length;
    if (page.length > 0 && chars > opts.maxChars) break;
    page.push(row);
  }
  return { messages: page.reverse().map(toMessage), hasMore: rows.length > page.length };
}

/** A title from the first message: its first line, at most 7 words / 60 characters. */
export function deriveTitle(text: string): string {
  const line = text.replace(/```[\s\S]*?(```|$)/g, ' ').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const words = line.replace(/\s+/g, ' ').split(' ').slice(0, 7).join(' ');
  const clipped = words.length > 60 ? `${words.slice(0, 59).trimEnd()}…` : words;
  return clipped || 'New chat';
}

/**
 * Stores the user's message of a run (once per run id) and bumps the
 * conversation; the first message also names an untitled conversation.
 * Returns the stored message (the existing one for a repeated run id).
 */
export async function addUserMessage(sessionId: string, content: string, runId: string): Promise<ConversationMessage> {
  const id = orderedId();
  return sql().tx(function* (): Step<ConversationMessage> {
    const existing = yield* one<MessageRow>("SELECT * FROM chat_messages WHERE run_id = ? AND role = 'user'", runId);
    if (existing) return toMessage(existing);
    yield* run("INSERT INTO chat_messages (id, session_id, role, content, run_id, status) VALUES (?, ?, 'user', ?, ?, 'complete')", id, sessionId, content, runId);
    yield* run('UPDATE chat_sessions SET title = COALESCE(title, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?', deriveTitle(content), sessionId);
    return toMessage((yield* one<MessageRow>('SELECT * FROM chat_messages WHERE id = ?', id))!);
  });
}

/** Stores the assistant's turn of a run (once per run id). */
export async function addAssistantMessage(sessionId: string, input: { runId: string; content: string; parts: TurnPart[]; status: TurnStatus; durationMs: number; agentId?: string | null }): Promise<ConversationMessage> {
  const id = orderedId();
  return sql().tx(function* (): Step<ConversationMessage> {
    const existing = yield* one<MessageRow>("SELECT * FROM chat_messages WHERE run_id = ? AND role = 'assistant'", input.runId);
    if (existing) return toMessage(existing);
    yield* run("INSERT INTO chat_messages (id, session_id, role, content, parts, status, run_id, duration_ms, agent_id) VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?)",
      id, sessionId, input.content, JSON.stringify(input.parts), input.status, input.runId, Math.max(0, Math.round(input.durationMs)), input.agentId ?? null);
    yield* run('UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', sessionId);
    return toMessage((yield* one<MessageRow>('SELECT * FROM chat_messages WHERE id = ?', id))!);
  });
}

// ---- projects (CHAT-PRO-02 A) ----------------------------------------------

/** CHAT-BUILD-01 stage 3 (CH5): a folder added to a project besides its main one; read only unless `write`. */
export interface ProjectFolder { path: string; write: boolean }
export interface Project { id: string; name: string; slug: string; folder: string | null; repoUrl: string | null; createdAt: string; updatedAt: string; folders: ProjectFolder[] }
interface ProjectRow { id: string; user_id: string; name: string; slug: string; folder: string | null; repo_url: string | null; created_at: string; updated_at: string; extra_folders?: string | null }
const MAX_FOLDERS = 8;
function parseFolders(raw: string | null | undefined): ProjectFolder[] {
  try { const v = JSON.parse(raw ?? '[]'); return Array.isArray(v) ? v.filter((f) => f && typeof f.path === 'string').slice(0, MAX_FOLDERS).map((f) => ({ path: f.path, write: f.write === true })) : []; } catch { return []; }
}
const toProject = (r: ProjectRow): Project => ({ id: r.id, name: r.name, slug: r.slug, folder: r.folder, repoUrl: r.repo_url, createdAt: r.created_at, updatedAt: r.updated_at, folders: parseFolders(r.extra_folders) });
/** Checked added folders: real directories, not the main folder, no repeats. */
export function checkFolders(list: unknown, main: string | null): ProjectFolder[] {
  if (!Array.isArray(list) || list.length > MAX_FOLDERS) throw new ProjectInputError(`A project can have at most ${MAX_FOLDERS} added folders`);
  const out: ProjectFolder[] = [];
  for (const f of list) {
    if (!f || typeof f !== 'object' || typeof (f as any).path !== 'string' || ((f as any).write !== undefined && typeof (f as any).write !== 'boolean')) throw new ProjectInputError('Each added folder needs a path');
    const real = checkFolder((f as any).path);
    if (real === main || out.some((o) => o.path === real)) continue;
    out.push({ path: real, write: (f as any).write === true });
  }
  return out;
}

export class ProjectInputError extends Error {}

/** A memory-drawer key from a project name: lowercase letters, digits, - and _. */
export function projectSlug(name: string): string {
  const s = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return s || `project-${randomUUID().slice(0, 8)}`;
}

/**
 * A project folder: an absolute path to an existing directory, never the
 * filesystem root or the home folder itself (the agent may read under it).
 */
export function checkFolder(raw: string, home = process.env.HOME ?? ''): string {
  const p = raw.trim().replace(/^~(?=$|\/)/, home);
  if (!path.isAbsolute(p)) throw new ProjectInputError('The folder must be a full path, like /Users/you/Projects/app');
  let real: string;
  try { real = fs.realpathSync.native(p); } catch { throw new ProjectInputError('That folder does not exist on this computer'); }
  if (!fs.statSync(real).isDirectory()) throw new ProjectInputError('That path is a file, not a folder');
  if (real === path.parse(real).root || (home && real === fs.realpathSync.native(home))) throw new ProjectInputError('Pick a project folder, not the whole disk or home folder');
  return real;
}

const repoOk = (u: string) => /^(https:\/\/|git@)[A-Za-z0-9.@:/_~%+-]{3,300}$/.test(u);

export async function listProjects(userId: string): Promise<Project[]> {
  return (await q.all<ProjectRow>('SELECT * FROM chat_projects WHERE user_id = ? ORDER BY LOWER(name), id', userId)).map(toProject);
}

export async function findProject(userId: string, id: string): Promise<Project | undefined> {
  const r = await q.one<ProjectRow>('SELECT * FROM chat_projects WHERE id = ? AND user_id = ?', id, userId);
  return r ? toProject(r) : undefined;
}

export async function createProject(userId: string, input: { name: string; folder?: string | null; repoUrl?: string | null; folders?: unknown }): Promise<Project> {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new ProjectInputError('Give the project a name');
  const folder = input.folder?.trim() ? checkFolder(input.folder) : null;
  const repo = input.repoUrl?.trim() || null;
  if (repo && !repoOk(repo)) throw new ProjectInputError('The repo must be an https:// or git@ address');
  let slug = projectSlug(name);
  for (let n = 2; await q.one('SELECT 1 AS x FROM chat_projects WHERE user_id = ? AND slug = ?', userId, slug); n++) slug = `${projectSlug(name)}-${n}`;
  const id = randomUUID();
  const folders = input.folders === undefined ? [] : checkFolders(input.folders, folder);
  await q.run('INSERT INTO chat_projects (id, user_id, name, slug, folder, repo_url, extra_folders) VALUES (?, ?, ?, ?, ?, ?, ?)', id, userId, name, slug, folder, repo, JSON.stringify(folders));
  return (await findProject(userId, id))!;
}

export async function patchProject(userId: string, id: string, patch: { name?: string; folder?: string | null; repoUrl?: string | null; folders?: unknown }): Promise<Project | undefined> {
  const fields: string[] = []; const params: Array<string | null> = [];
  if (patch.name !== undefined) { const n = patch.name.trim().slice(0, 80); if (!n) throw new ProjectInputError('Give the project a name'); fields.push('name = ?'); params.push(n); }
  if (patch.folder !== undefined) { fields.push('folder = ?'); params.push(patch.folder?.trim() ? checkFolder(patch.folder) : null); }
  if (patch.repoUrl !== undefined) { const r = patch.repoUrl?.trim() || null; if (r && !repoOk(r)) throw new ProjectInputError('The repo must be an https:// or git@ address'); fields.push('repo_url = ?'); params.push(r); }
  if (patch.folders !== undefined) {
    const main = patch.folder !== undefined ? (patch.folder?.trim() ? checkFolder(patch.folder) : null) : (await findProject(userId, id))?.folder ?? null;
    fields.push('extra_folders = ?'); params.push(JSON.stringify(checkFolders(patch.folders, main)));
  }
  if (fields.length) await q.run(`UPDATE chat_projects SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`, ...params, id, userId);
  return findProject(userId, id);
}

/** Deletes the project; its conversations stay, without a project. */
export async function deleteProject(userId: string, id: string): Promise<boolean> {
  return sql().tx(function* (): Step<boolean> {
    const r = yield* run('DELETE FROM chat_projects WHERE id = ? AND user_id = ?', id, userId);
    if (!r.changes) return false;
    yield* run('UPDATE chat_sessions SET project_id = NULL WHERE project_id = ? AND user_id = ?', id, userId);
    return true;
  });
}

/** A GitHub repository named by a remote URL (https or ssh form), or null. */
export function githubRepo(remote: string | null): { owner: string; repo: string } | null {
  const m = remote ? /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(remote) : null;
  return m ? { owner: m[1], repo: m[2] } : null;
}

export type GitInfo = {
  branch: string | null; remote: string | null; dirty: boolean | null; added: number | null; removed: number | null; files: number | null;
  upstream?: string | null; ahead?: number | null; behind?: number | null; defaultBranch?: string | null;
  lastCommit?: { hash: string; subject: string; author: string; date: string } | null;
  github?: { owner: string; repo: string; repoUrl: string; branchUrl: string | null; compareUrl: string | null } | null;
};

/**
 * The folder's git state: branch, origin URL, uncommitted changes, upstream
 * with ahead/behind counts and the last commit. Local commands only: no
 * fetch, so ahead/behind compare against the last known remote state.
 */
export function gitInfo(folder: string): Promise<GitInfo> {
  const git = (args: string[]) => new Promise<string | null>((resolve) => {
    execFile('git', ['-C', folder, ...args], { timeout: 3000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } },
      (err, out) => resolve(err ? null : String(out).trim()));
  });
  return Promise.all([git(['rev-parse', '--abbrev-ref', 'HEAD']), git(['remote', 'get-url', 'origin']), git(['status', '--porcelain']), git(['diff', '--shortstat', 'HEAD']),
    git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']), git(['rev-list', '--left-right', '--count', '@{u}...HEAD']),
    git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']), git(['log', '-1', '--format=%h%x1f%s%x1f%an%x1f%cI'])])
    .then(([branch, remote, status, stat, upstream, counts, originHead, last]) => {
      // "3 files changed, 10 insertions(+), 2 deletions(-)" (uncommitted changes against HEAD)
      const n = (re: RegExp) => { const m = stat === null ? null : re.exec(stat); return stat === null ? null : m ? Number(m[1]) : 0; };
      const cleanRemote = remote ? remote.replace(/\/\/[^/@]+@/, '//') : null;
      const ab = counts ? /^(\d+)\s+(\d+)$/.exec(counts) : null;
      const defaultBranch = originHead ? originHead.replace(/^origin\//, '') : null;
      const lc = last ? last.split('\x1f') : null;
      const gh = githubRepo(cleanRemote);
      const onBranch = branch && branch !== 'HEAD' ? branch : null;
      const enc = (b: string) => b.split('/').map(encodeURIComponent).join('/');
      const base = gh ? `https://github.com/${gh.owner}/${gh.repo}` : null;
      return { branch: branch || null, remote: cleanRemote, dirty: status === null ? null : status.length > 0,
        added: n(/(\d+) insertion/), removed: n(/(\d+) deletion/), files: n(/(\d+) files? changed/),
        upstream: upstream || null, behind: ab ? Number(ab[1]) : null, ahead: ab ? Number(ab[2]) : null, defaultBranch,
        lastCommit: lc && lc.length === 4 ? { hash: lc[0], subject: lc[1].slice(0, 200), author: lc[2].slice(0, 100), date: lc[3] } : null,
        github: gh && base ? { ...gh, repoUrl: base,
          branchUrl: onBranch && upstream ? `${base}/tree/${enc(onBranch)}` : null,
          compareUrl: onBranch && defaultBranch && onBranch !== defaultBranch ? `${base}/compare/${enc(defaultBranch)}...${enc(onBranch)}?expand=1` : null } : null };
    });
}
