/**
 * STORE-MAP-01 P7: the project folder layout, planned and then written in one
 * step with a preview (GIRRU_STORE_P7, needs the one Girru section of P2).
 *
 *   AGENTS.md            the one Girru section: memory brief, rules, task pointer
 *   CLAUDE.md, GEMINI.md pointers to AGENTS.md
 *   .girru/rules.md      the project's rules for coding apps
 *   .girru/tasks.md      the task file (on with the layout; no separate Rules step)
 *   .girru/brief.md      written by the debounced brief sync (P6), when that is on
 *   .git/info/exclude    Girru's files kept out of Git (when the owner keeps that on)
 *   .cursor/rules/girru.mdc  a pointer to AGENTS.md, while the Cursor client is on
 *
 * `layoutPreview` writes nothing. `layoutApply` takes the preview's hash and
 * refuses when anything changed since, or when any file is a conflict: then
 * nothing is written. Every write goes through the one safe file writer.
 */
import { isOutsideProject } from '../project-trust.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { findProject, type Project } from '../../repositories/chat-conversations.js';
import { storeP2Enabled } from '../../services/agent-context/switch.js';
import { storeP6Enabled } from '../../services/store-p6.js';
import { storeP7Enabled } from '../../services/store-p7.js';
import { projectBrief } from './brief.js';
import { ManagedFileError, previewFiles, type FilePlan } from './managed-files.js';
import { audit, clientEnabled, folderSettings, patchFolder } from './store.js';
import { SafeFileError, safeWriteFile } from '../../services/safe-file.js';

/** Cursor reads its own rule files, not AGENTS.md: one always-on rule points it there. */
export const CURSOR_RULE = '.cursor/rules/girru.mdc';
export const CURSOR_RULE_TEXT = [
  '---', 'description: Girru project memory, rules and tasks', 'alwaysApply: true', '---',
  '<!-- Written by Girru. Turning Cursor off in Girru removes nothing else. -->',
  'Read the Girru section of AGENTS.md before you start: it holds the project brief, the owner\'s rules and where the task file is.',
  'Use the dpro-memory tools to recall and save memory, and write a handoff when you stop.', '',
].join('\n');
import { BridgeError } from './service.js';

export type LayoutAction = 'create' | 'update' | 'unchanged' | 'conflict';
export interface LayoutFile {
  relative: string;
  action: LayoutAction;
  /** Which part of Girru keeps the file up to date afterwards. */
  by: 'project-files' | 'rules' | 'task-file' | 'brief-sync' | 'cursor';
  reason?: string;
  /** Girru's part before (-) and after (+), where there is one. */
  diff?: string;
}
export interface LayoutPreview { projectId: string; folder: string; files: LayoutFile[]; previewHash: string; conflicts: number; changes: number }

async function ownProject(ownerId: string, projectId: unknown): Promise<Project> {
  if (typeof projectId !== 'string' || !projectId) throw new BridgeError('projectId is required');
  const p = await findProject(ownerId, projectId);
  if (!p) throw new BridgeError('Not found', 404, 'not_found');
  if (!p.folder) throw new BridgeError('This project has no folder on this computer', 400, 'no_folder');
  return p;
}

function requireSwitches(): void {
  if (!storeP7Enabled()) throw new BridgeError('The project layout needs GIRRU_STORE_P7', 409, 'p7_off');
  if (!storeP2Enabled()) throw new BridgeError('The project layout needs the one Girru section (GIRRU_STORE_P2)', 409, 'p2_off');
}

const fromMemoryPlan = (f: FilePlan): LayoutFile => ({ relative: f.relative.split(path.sep).join('/'), action: f.action, by: 'project-files', ...(f.reason ? { reason: f.reason } : {}), ...(f.diff ? { diff: f.diff } : {}) });

async function plan(ownerId: string, projectId: unknown): Promise<{ project: Project; folder: string; files: LayoutFile[] }> {
  requireSwitches();
  const project = await ownProject(ownerId, projectId);
  const rf = await import('../../services/agent-rule-files.js');
  const { projectFileRules, TASK_RULE_TEXT } = await import('../../services/agent-rules.js');
  const settings = await folderSettings(ownerId, project.id);
  const rules = await projectFileRules(project.id);
  // The task file's own rule is added by the write (locked, first): the preview shows it already.
  if (!rules.some((r) => r.locked && r.projectId === project.id && r.text === TASK_RULE_TEXT)) {
    rules.unshift({ id: 'task-file', text: TASK_RULE_TEXT, when: null, projectId: project.id, who: 'all', targets: [], paused: false, status: 'active', source: 'girru',
      suggestedBy: null, reason: null, shipped: true, locked: true, version: 1, createdAt: '0001-01-01T00:00:01.000Z', updatedAt: '0001-01-01T00:00:01.000Z' });
  }
  // The section as it will be once the layout is on: memory brief, rules, task pointer.
  const extras = { rules: rules.length ? rf.rulesByPrecedenceText(rules) : '', tasks: true };
  let memory;
  try { memory = previewFiles(project.id, await projectBrief(ownerId, project), project.folder, settings.gitExclude, extras); } catch (err) {
    if (err instanceof ManagedFileError) throw new BridgeError(err.message, err.status, err.code);
    throw err;
  }
  const folder = memory.folder;
  const files = memory.files.map(fromMemoryPlan);

  const own = async (relative: string, next: string | null, by: LayoutFile['by']): Promise<LayoutFile> => {
    const cur = await rf.readPlain(path.join(folder, ...relative.split('/')));
    if (cur === 'link') return { relative, action: 'conflict', by, reason: `${relative} is a link or not a plain file` };
    if (next === null) return { relative, action: cur === null ? 'create' : 'unchanged', by };
    return { relative, action: cur === null ? 'create' : cur === next ? 'unchanged' : 'update', by };
  };
  files.push(await own(rf.SOURCE, rf.rulesText(rules), 'rules'));
  // An existing task file is the owner's and is kept as it is; a missing one starts with the header.
  const tasks = await own('.girru/tasks.md', null, 'task-file');
  files.push(tasks.action === 'create' ? tasks : { ...tasks, action: tasks.action === 'conflict' ? 'conflict' : 'unchanged' });
  if (storeP6Enabled()) {
    // Written and kept current by the brief sync from the database; the layout only starts it.
    files.push(await own('.girru/brief.md', null, 'brief-sync'));
  }
  if (await clientEnabled(ownerId, 'cursor')) files.push(await own(CURSOR_RULE, CURSOR_RULE_TEXT, 'cursor'));
  return { project, folder, files };
}

const hashOf = (folder: string, files: LayoutFile[]) =>
  createHash('sha256').update(JSON.stringify([folder, files.map((f) => [f.relative, f.action, f.diff ?? ''])])).digest('hex');

function summary(projectId: string, folder: string, files: LayoutFile[]): LayoutPreview {
  return {
    projectId, folder, files, previewHash: hashOf(folder, files),
    conflicts: files.filter((f) => f.action === 'conflict').length,
    changes: files.filter((f) => f.action === 'create' || f.action === 'update').length,
  };
}

/** Dry run: every file the layout would create or change, and why a file cannot be written. */
export async function layoutPreview(ownerId: string, projectId: unknown): Promise<LayoutPreview> {
  const p = await plan(ownerId, projectId);
  return summary(p.project.id, p.folder, p.files);
}

/** Write the layout the owner saw (all-or-nothing on conflicts) and keep it in sync from now on. */
export async function layoutApply(ownerId: string, projectId: unknown, input: { previewHash?: unknown; confirm?: unknown }, actor = 'owner'): Promise<LayoutPreview> {
  if (input?.confirm !== true) throw new BridgeError('Send confirm: true after reviewing the preview', 400, 'confirm_required');
  if (typeof input.previewHash !== 'string') throw new BridgeError('previewHash is required');
  const p = await plan(ownerId, projectId);
  // REPO-TRUST-01: Girru's layout is not written into someone else's repository until the owner trusts the project.
  if (await isOutsideProject(ownerId, p.project.id)) throw new BridgeError('This project is on the Outside projects list. Trust it first to add Girru\'s files to its folder.', 409, 'outside_project');
  const before = summary(p.project.id, p.folder, p.files);
  if (before.previewHash !== input.previewHash) throw new BridgeError('The files or the memory changed since the preview; preview again', 409, 'preview_stale');
  if (before.conflicts) throw new BridgeError(`Nothing written: ${p.files.filter((f) => f.action === 'conflict').map((f) => f.reason).join('; ')}`, 409, 'conflict');

  const { q } = await import('../../repositories/sql-steps.js');
  const rf = await import('../../services/agent-rule-files.js');
  const { ensureTaskFile } = await import('../../services/task-file.js');
  const was = await folderSettings(ownerId, p.project.id);
  const ruleRow = await q.one<{ mode: string; tasks: number | null; written_at: string | null }>('SELECT mode, tasks, written_at FROM agent_rule_files WHERE project_id = ?', p.project.id);
  try {
    // The project's files switch: memory files on, the task file on with them (no separate Rules step).
    await patchFolder(ownerId, p.project.id, { filesEnabled: true, confirmed: true });
    await q.run("INSERT INTO agent_rule_files(project_id,mode,tasks,written_at,updated_at) VALUES(?,?,1,?,CURRENT_TIMESTAMP) ON CONFLICT(project_id) DO UPDATE SET tasks=1, written_at=excluded.written_at, updated_at=CURRENT_TIMESTAMP",
      p.project.id, ruleRow?.mode === 'project' ? 'project' : 'private', new Date().toISOString());
    // Cursor's pointer first, so the rules writer below keeps it out of Git with Girru's other files.
    if (p.files.some((f) => f.by === 'cursor' && f.action !== 'unchanged')) safeWriteFile(p.folder, CURSOR_RULE, CURSOR_RULE_TEXT);
    // Rules file, the one Girru section, the task rule and the Git exclude list, as the rules writer keeps them.
    await rf.writeFiles(p.project.id);
    await ensureTaskFile(p.project.id);
  } catch (err) {
    // Put the switches back as they were; files already written stay valid and are rewritten on the next sync.
    await patchFolder(ownerId, p.project.id, { filesEnabled: was.filesEnabled });
    if (ruleRow) await q.run('UPDATE agent_rule_files SET tasks = ?, written_at = ? WHERE project_id = ?', ruleRow.tasks, ruleRow.written_at, p.project.id);
    else await q.run('DELETE FROM agent_rule_files WHERE project_id = ?', p.project.id);
    if (err instanceof rf.RuleFilesError) throw new BridgeError(err.message, 409, err.code === 'unsafe' ? 'unsafe_path' : err.code);
    if (err instanceof ManagedFileError) throw new BridgeError(err.message, err.status, err.code);
    if (err instanceof SafeFileError) throw new BridgeError(err.message, 409, 'unsafe_path');
    throw err;
  }
  if (storeP6Enabled()) {
    const { enableScope } = await import('../outbox/events.js');
    const { runBriefProjection } = await import('../outbox/projection.js');
    await runBriefProjection(await enableScope(ownerId, p.project), { force: true }).catch(() => undefined);
  }
  await audit(ownerId, 'files-written', { projectId: p.project.id, note: `project layout, ${before.changes} file(s) by ${actor}` });
  const after = await plan(ownerId, p.project.id);
  return summary(p.project.id, after.folder, after.files);
}
