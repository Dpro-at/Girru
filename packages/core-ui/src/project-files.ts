// STORE-MAP-01 P6 (boards P6a–P6c): Memory › Coding apps › Project files. One
// row per project folder Girru writes into; the inspector shows each file with
// its version and state. Girru never overwrites a file changed in the folder by
// itself: "Use Girru's version" writes its text and keeps the folder's text as
// a labelled suggestion in Needs you (⌘Z puts it back). Also the task-number
// questions from .girru/tasks.md and the "stays on this computer" switch of
// each memory place (stored only; not shown until a reply path honours it).
// Routes answer 404 while the backend's P6 switch is off;
// the window then says "not available yet".
import { Store, codeOf, ago } from './memory-store';
import type { Requester } from './memory-store';
import type { Place } from './memory-desktop';
import {
  PLACE_SETTINGS_PATH, PROJECT_FILES_NEEDS_PATH, PROJECT_FILES_PATH,
  placeSettingPath, projectFilesActionPath, projectFilesComparePath, projectFilesPath, taskProblemPath,
} from './project-files-contract.js';
import type { FileCompare, FileState, PlaceSettings, ProblemAction, ProjectFiles, TaskProblem } from './project-files-contract.js';

export type Missing = 'missing';
export type CompareOpen = Readonly<{ projectId: string; path: string; data: FileCompare | null; busy: boolean }>;
export type ProjectFilesState = Readonly<{
  phase: 'idle' | 'loading' | 'ready' | 'error' | Missing;
  projects: readonly ProjectFiles[]; selected: string | null; query: string; busy: boolean;
  compare: CompareOpen | null;
  problems: readonly TaskProblem[] | null | Missing;
  places: PlaceSettings | null | Missing;
}>;

/** The words and tone of a state chip (board P6a "The states"). */
export const STATE_WORD: Record<FileState, string> = { up_to_date: 'Up to date', waiting: 'Waiting', changed_in_both: 'Changed in both', folder_not_found: 'Folder not found', could_not_write: 'Could not write' };
export const STATE_TONE: Record<FileState, 'ok' | 'mute' | 'warn' | 'bad'> = { up_to_date: 'ok', waiting: 'mute', changed_in_both: 'warn', folder_not_found: 'bad', could_not_write: 'bad' };
const NOTICES: Record<string, string> = {
  not_found: 'This project no longer writes files.',
  folder_not_found: 'The project folder was not found. Nothing was written.',
  bad_path: 'Girru does not write that file.',
  undo_expired: 'The file changed since (or Girru restarted); it was not put back.',
  could_not_write: 'Girru could not write that file. Nothing was written.',
  conflict: 'A file changed in the folder; nothing was written. Compare it first.',
  bad_place: 'This place has no such switch.',
  invalid_request: 'Nothing changed.',
  invalid_board: 'Nothing changed.',
};
/** The task file is the owner's: it has no "Girru version" to compare or write back. */
export const comparable = (path: string) => path !== '.girru/tasks.md';

/** The second line of a project row in plain words. */
export function projectLine(p: ProjectFiles, now = Date.now()): string {
  const changed = p.files.filter(f => f.state === 'changed_in_both').length;
  switch (p.state) {
    case 'folder_not_found': return p.folder ? `Folder not found · ${p.folder}` : 'Folder not found';
    case 'could_not_write': return 'Girru tried several times and stopped';
    case 'changed_in_both': return `${changed || 1} ${changed > 1 ? 'files' : 'file'} changed in the folder and in Girru`;
    case 'waiting': return 'Writing… (a change from a moment ago)';
    default: { const a = p.writtenAt ? ago(p.writtenAt, now) : ''; return !p.writeFiles ? 'Files are not written' : a ? (a === 'now' ? 'Written just now' : `Written ${a} ago`) : 'Up to date'; }
  }
}

/** Projects split into "Needs you" and "Up to date", filtered by a search. */
export function groupProjects(projects: readonly ProjectFiles[], query = ''): { needs: ProjectFiles[]; rest: ProjectFiles[] } {
  const q = query.trim().toLowerCase();
  const shown = q ? projects.filter(p => p.name.toLowerCase().includes(q) || (p.folder ?? '').toLowerCase().includes(q)) : [...projects];
  return { needs: shown.filter(p => p.needsYou), rest: shown.filter(p => !p.needsYou) };
}

/** The bridge project of a memory project: the same id (projects by id, P3), else the one project with the same name. */
export function bridgeProjectFor(slug: string, name: string, projects: readonly ProjectFiles[]): ProjectFiles | null {
  const same = projects.find(p => p.projectId === slug);
  if (same) return same;
  const named = projects.filter(p => p.name.trim().toLowerCase() === name.trim().toLowerCase());
  return named.length === 1 ? named[0] : null;
}

/** The place-settings key of a Memory window place (null: the place has no switch). */
export function placeKeyOf(place: Place): string | null {
  if (place === 'all') return 'company';
  if (place === 'owner' || place === 'people' || place === 'experience' || place === 'tasks') return place;
  return place.startsWith('project:') ? place : null;
}
/** People stays on this computer unless the owner turned it off; other places go online unless turned on. */
export const staysLocalDefault = (key: string) => key === 'people';

export class ProjectFilesController extends Store<ProjectFilesState> {
  #ticket = 0;
  /** Where short results go (the window's notice). */
  say: (text: string) => void = () => {};
  /** Called when a suggestion was added or withdrawn (Use Girru’s version, its undo), so Needs you reads again. */
  onSuggestions: () => void = () => {};
  constructor(client: Requester) {
    super({ phase: 'idle', projects: [], selected: null, query: '', busy: false, compare: null, problems: null, places: null }, client);
  }

  async load() {
    const t = ++this.#ticket;
    if (this.getSnapshot().phase !== 'ready') this.publish({ phase: 'loading' });
    try {
      const r = await this.req('GET', PROJECT_FILES_PATH);
      if (t !== this.#ticket) return;
      if (r.status === 404) { this.publish({ phase: 'missing', projects: [] }); return; }
      if (r.status !== 200) { this.publish({ phase: 'error' }); return; }
      const projects = (r.body as { projects: ProjectFiles[] }).projects;
      const sel = this.getSnapshot().selected;
      this.publish({ phase: 'ready', projects, selected: sel && projects.some(p => p.projectId === sel) ? sel : projects[0]?.projectId ?? null });
    } catch { if (t === this.#ticket) this.publish({ phase: 'error' }); }
  }
  /** How many projects need the owner (the sidebar badge). */
  needsCount(): number { return this.getSnapshot().projects.filter(p => p.needsYou).length; }
  project(id: string | null): ProjectFiles | null { return id ? this.getSnapshot().projects.find(p => p.projectId === id) ?? null : null; }
  select(selected: string | null) { this.publish({ selected }); }
  setQuery(query: string) { this.publish({ query }); }
  /** Arrow keys: the next or previous project in the shown order. */
  step(by: 1 | -1) {
    const s = this.getSnapshot(); const g = groupProjects(s.projects, s.query); const flat = [...g.needs, ...g.rest];
    if (!flat.length) return;
    const at = flat.findIndex(p => p.projectId === s.selected);
    this.select(flat[Math.max(0, Math.min(flat.length - 1, at < 0 ? 0 : at + by))].projectId);
  }
  private put(p: ProjectFiles) {
    const s = this.getSnapshot();
    const projects = s.projects.some(x => x.projectId === p.projectId) ? s.projects.map(x => x.projectId === p.projectId ? p : x) : [...s.projects, p];
    this.publish({ projects: [...projects].sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || a.name.localeCompare(b.name)) });
  }
  private fail(r: { status: number; body: unknown }, fallback: string) { this.say(r.status === 404 && !codeOf(r as never) ? 'Project files are not available yet.' : NOTICES[codeOf(r as never) ?? ''] ?? fallback); }

  /** ⌘R: write the files again (a file changed in both stays as it is). */
  async rewrite(id: string): Promise<boolean> {
    this.publish({ busy: true });
    try {
      const r = await this.req('POST', projectFilesActionPath(id, 'rewrite'));
      this.publish({ busy: false });
      if (r.status !== 200) { this.fail(r, 'The files were not written.'); return false; }
      const p = (r.body as { project: ProjectFiles }).project; this.put(p);
      this.say(p.state === 'changed_in_both' ? 'Written again; a file changed in both waits for you.' : p.needsYou ? 'Girru still could not write every file.' : `Wrote the files of ${p.name} again.`);
      return true;
    } catch { this.publish({ busy: false }); this.say('The files were not written (no connection).'); return false; }
  }

  async openCompare(projectId: string, path: string) {
    this.publish({ compare: { projectId, path, data: null, busy: true } });
    try {
      const r = await this.req('GET', projectFilesComparePath(projectId, path));
      if (this.getSnapshot().compare?.path !== path) return;
      if (r.status !== 200) { this.publish({ compare: null }); this.fail(r, 'The two versions could not be read.'); return; }
      this.publish({ compare: { projectId, path, data: r.body as FileCompare, busy: false } });
    } catch { this.publish({ compare: null }); this.say('The two versions could not be read (no connection).'); }
  }
  closeCompare() { this.publish({ compare: null }); }

  /** Writes Girru's version; the folder's text becomes a suggestion. Returns the undo token. */
  async useGirru(projectId: string, path: string): Promise<string | null> {
    this.publish({ busy: true });
    try {
      const r = await this.req('POST', projectFilesActionPath(projectId, 'use-girru'), { path });
      this.publish({ busy: false });
      if (r.status !== 200) { this.fail(r, 'Girru’s version was not written.'); return null; }
      const out = r.body as { project: ProjectFiles; undo: string };
      this.put(out.project); this.publish({ compare: null }); this.onSuggestions();
      return out.undo;
    } catch { this.publish({ busy: false }); this.say('Girru’s version was not written (no connection).'); return null; }
  }
  /** Puts the folder's text back and withdraws the suggestion (409 when the file changed since). */
  async undo(projectId: string, undo: string): Promise<boolean> {
    try {
      const r = await this.req('POST', projectFilesActionPath(projectId, 'undo'), { undo });
      if (r.status !== 200) { this.fail(r, 'The file was not put back.'); return false; }
      this.put((r.body as { project: ProjectFiles }).project); this.onSuggestions();
      return true;
    } catch { return false; }
  }

  /** "Write project files" and "Company facts reach coding apps" (both reversible with ⌘Z). */
  async setProject(projectId: string, patch: { writeFiles?: boolean; companyFacts?: boolean }): Promise<boolean> {
    this.publish({ busy: true });
    try {
      const r = await this.req('PATCH', projectFilesPath(projectId), patch);
      this.publish({ busy: false });
      if (r.status !== 200) { this.fail(r, 'The switch did not change.'); return false; }
      this.put((r.body as { project: ProjectFiles }).project);
      return true;
    } catch { this.publish({ busy: false }); this.say('The switch did not change (no connection).'); return false; }
  }

  // ---- Needs you: task numbers in .girru/tasks.md ----
  async loadProblems() {
    try {
      const r = await this.req('GET', PROJECT_FILES_NEEDS_PATH);
      this.publish({ problems: r.status === 200 ? (r.body as { items: TaskProblem[] }).items : r.status === 404 ? 'missing' : null });
    } catch { this.publish({ problems: null }); }
  }
  problemCount(): number { const p = this.getSnapshot().problems; return Array.isArray(p) ? p.length : 0; }
  async solve(problem: TaskProblem, action: ProblemAction): Promise<boolean> {
    this.publish({ busy: true });
    try {
      const r = await this.req('POST', taskProblemPath(problem.id), { action });
      this.publish({ busy: false });
      if (r.status !== 200) { this.fail(r, 'Nothing changed.'); return false; }
      const p = this.getSnapshot().problems;
      if (Array.isArray(p)) this.publish({ problems: p.filter(x => x.id !== problem.id) });
      this.say(action === 'leave' ? `Left ${problem.number} as it is.` : action === 'new_task' ? `The second ${problem.number} is a new task now.` : `Added ${problem.number} as a new task.`);
      return true;
    } catch { this.publish({ busy: false }); this.say('Nothing changed (no connection).'); return false; }
  }

  // ---- "Stays on this computer" per memory place ----
  async loadPlaces() {
    try {
      const r = await this.req('GET', PLACE_SETTINGS_PATH);
      this.publish({ places: r.status === 200 ? (r.body as { places: PlaceSettings }).places : r.status === 404 ? 'missing' : null });
    } catch { this.publish({ places: null }); }
  }
  staysLocal(key: string): boolean {
    const p = this.getSnapshot().places;
    return p && p !== 'missing' && p[key] ? p[key].staysLocal : staysLocalDefault(key);
  }
  async setStaysLocal(key: string, staysLocal: boolean): Promise<boolean> {
    try {
      const r = await this.req('PUT', placeSettingPath(key), { staysLocal });
      if (r.status !== 200) { this.fail(r, 'The switch did not change.'); return false; }
      const p = this.getSnapshot().places;
      this.publish({ places: { ...(p && p !== 'missing' ? p : {}), [key]: { staysLocal: (r.body as { staysLocal: boolean }).staysLocal } } });
      return true;
    } catch { this.say('The switch did not change (no connection).'); return false; }
  }
}
