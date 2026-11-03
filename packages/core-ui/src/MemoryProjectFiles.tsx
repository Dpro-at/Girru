// STORE-MAP-01 P6 (boards P6a–P6c): Memory › Coding apps › Project files — a
// quiet list of projects ("Needs you" first) and an inspector with each file
// Girru writes, its version and state; the Compare sheet; the project and place
// switches; and the task-number questions shown in Needs you. Shown only while
// the backend's P6 switch is on.
import { useEffect, useSyncExternalStore } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { UiIcon } from './ui-icons';
import { IconButton, Sheet, Tile } from './desktop-ui';
import type { MenuItem } from './desktop-ui';
import { canRevealFolder, revealFolder } from './chat-actions';
import { STATE_TONE, STATE_WORD, comparable, groupProjects, projectLine } from './project-files';
import type { ProjectFilesController } from './project-files';
import type { MemoryDesktopController } from './memory-desktop';
import type { FileState, ProjectFiles, TaskProblem } from './project-files-contract.js';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent ?? '');
const mod = isMac ? '⌘' : 'Ctrl+';
const finder = typeof navigator !== 'undefined' && /Win/.test(navigator.platform ?? '') ? 'Show in Explorer' : 'Show in Finder';
const fileName = (path: string) => path.split('/').pop() ?? path;

function useStore<S>(c: { subscribe: (fn: () => void) => () => void; getSnapshot: () => S }): S {
  return useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
}

export function StateChip({ state }: { state: FileState }) {
  return <span className="dk-chip dk-state" data-tone={STATE_TONE[state]}>{STATE_WORD[state]}</span>;
}

/** The same actions on the toolbar's ⋯ and on a right-click of the project. */
export function projectFilesMenu(c: ProjectFilesController, d: MemoryDesktopController, p: ProjectFiles): MenuItem[] {
  return [
    { label: 'Write the files again', icon: 'refresh', shortcut: `${mod}R`, disabled: !p.writeFiles, run: () => void c.rewrite(p.projectId) },
    ...(p.folder && canRevealFolder() ? [{ label: finder, icon: 'open' as const, run: () => revealFolder(p.folder!) }] : []),
    'sep',
    p.writeFiles ? { label: 'Stop writing files', icon: 'close', run: () => void setWrite(c, d, p, false) }
      : { label: 'Write project files again', icon: 'file', run: () => void setWrite(c, d, p, true) },
  ];
}
async function setWrite(c: ProjectFilesController, d: MemoryDesktopController, p: ProjectFiles, on: boolean) {
  if (!(await c.setProject(p.projectId, { writeFiles: on }))) return;
  d.remember(on ? `${p.name} writes its project files again.` : `Stopped writing files for ${p.name}.`, () => c.setProject(p.projectId, { writeFiles: !on }));
}
async function setFacts(c: ProjectFilesController, d: MemoryDesktopController, p: ProjectFiles, on: boolean) {
  if (!(await c.setProject(p.projectId, { companyFacts: on }))) return;
  d.remember(on ? `Coding apps in ${p.name} may read company facts.` : `Company facts stay out of ${p.name}.`, () => c.setProject(p.projectId, { companyFacts: !on }));
}
/** "Use Girru's version": the folder's text becomes a suggestion; ⌘Z puts it back. */
export async function applyGirru(c: ProjectFilesController, d: MemoryDesktopController, p: ProjectFiles, path: string) {
  const undo = await c.useGirru(p.projectId, path);
  if (undo) d.remember(`Used Girru’s version of ${fileName(path)}. The folder’s text waits in Needs you.`, () => c.undo(p.projectId, undo), 'needs');
}

/** The middle list: projects that need you, then the ones up to date. */
export function ProjectFilesView({ c, onMenu, searchRef }: { c: ProjectFilesController; onMenu: (e: ReactMouseEvent, p: ProjectFiles) => void; searchRef?: RefObject<HTMLInputElement | null> }) {
  const s = useStore(c);
  useEffect(() => { if (s.phase === 'idle') void c.load(); }, [c, s.phase]);
  if (s.phase === 'missing') return <div className="dk-empty"><p>Project files are not available yet. They arrive with the next update of Girru.</p></div>;
  if (s.phase === 'error') return <div className="dk-empty"><p>The project files could not be read.</p><button type="button" onClick={() => void c.load()}>Try again</button></div>;
  if (s.phase !== 'ready') return <p className="dk-empty" role="status">Reading the project folders…</p>;
  if (!s.projects.length) return <div className="dk-empty"><UiIcon name="code" size={20}/><p>No project writes files yet. Turn it on in a project’s details.</p></div>;
  const g = groupProjects(s.projects, s.query);
  function keys(e: ReactKeyboardEvent) {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); c.step(e.key === 'ArrowDown' ? 1 : -1); }
  }
  const row = (p: ProjectFiles) => <div key={p.projectId} className="dk-row" role="option" aria-selected={s.selected === p.projectId} onClick={() => c.select(p.projectId)}
    onContextMenu={e => { c.select(p.projectId); onMenu(e, p); }}>
    <span className="dk-row-icon"><Tile name={p.name}/></span>
    <span className="dk-row-text"><span className="dk-row-main">{p.name}</span><span className="dk-row-sub" title={p.folder ?? undefined}>{projectLine(p)}</span></span>
    <StateChip state={p.state}/>
  </div>;
  return <div className="dk-list" tabIndex={0} role="listbox" aria-label="Projects" onKeyDown={keys}>
    <div className="dk-pad"><label className="dk-search"><UiIcon name="search" size={13}/><input ref={searchRef} type="search" placeholder="Search projects" aria-label={`Search projects (${mod}F)`} value={s.query} onChange={e => c.setQuery(e.target.value)}/></label></div>
    {g.needs.length > 0 && <section className="dk-list-group"><h3>Needs you</h3>{g.needs.map(row)}</section>}
    {g.rest.length > 0 && <section className="dk-list-group"><h3>Up to date</h3>{g.rest.map(row)}</section>}
    {!g.needs.length && !g.rest.length && <div className="dk-empty"><p>No project matches.</p></div>}
  </div>;
}

/** The inspector of the selected project: each file Girru writes, its version and state. */
export function ProjectFilesInspector({ c, d, project, onMenu }: { c: ProjectFilesController; d: MemoryDesktopController; project: ProjectFiles; onMenu: (e: ReactMouseEvent, p: ProjectFiles) => void }) {
  const s = useStore(c); const p = project;
  return <div className="dk-insp">
    <div className="dk-insp-head"><Tile name={p.name} size={28}/><div><h3>{p.name}</h3>
      <p className="fine-print" title={p.folder ?? undefined}>{p.folder ? <span className="dk-path">{p.folder}</span> : 'No folder'} · {p.files.length} {p.files.length === 1 ? 'file' : 'files'} Girru writes</p></div>
      <span className="dk-toolbar-gap"/>
      <IconButton icon="refresh" label="Write the files again" shortcut={`${mod}R`} disabled={s.busy || !p.writeFiles} onClick={() => void c.rewrite(p.projectId)}/>
      {p.folder && canRevealFolder() && <IconButton icon="open" label={finder} onClick={() => revealFolder(p.folder!)}/>}
      <IconButton icon="more" label="More for this project" onClick={e => onMenu(e, p)}/>
    </div>
    {p.state === 'folder_not_found' && <div className="dk-ask" role="alert"><p>The folder moved, or the disk is not connected.</p>
      <div className="actions"><button type="button" disabled={s.busy} onClick={() => void setWrite(c, d, p, false)}>Stop writing files for this project</button></div></div>}
    {p.state === 'could_not_write' && <div className="dk-ask" role="alert"><p>Girru tried several times and stopped (no space or no permission).</p>
      <div className="actions"><button type="button" className="primary" disabled={s.busy} onClick={() => void c.rewrite(p.projectId)}>Try again</button></div></div>}
    <ul className="dk-pf-files" aria-label="Files Girru writes">{p.files.map(f => <li key={f.path} data-state={f.state}>
      <span className="dk-row-icon"><UiIcon name="file" size={14}/></span>
      <span className="dk-row-text"><span className="dk-row-main dk-path">{f.path}</span>
        <span className="dk-row-sub">{f.what}{f.state === 'changed_in_both' ? ' · changed in the folder and in Girru' : f.version !== null ? ` · version ${f.version}` : ''}</span>
        {f.reason && f.state !== 'up_to_date' && <span className="dk-row-sub">{f.reason}</span>}</span>
      <StateChip state={f.state}/>
      {f.state === 'changed_in_both' && comparable(f.path) && <span className="actions dk-pf-actions">
        <button type="button" disabled={s.busy} onClick={() => void c.openCompare(p.projectId, f.path)}>Compare…</button>
        <button type="button" className="primary" disabled={s.busy} onClick={() => void applyGirru(c, d, p, f.path)}>Use Girru’s version</button></span>}
    </li>)}</ul>
    <p className="fine-print">Every file says which version it shows (a hidden stamp at its end). Coding apps read the files when they start; live answers come from Girru while they run.</p>
    <ProjectSwitches c={c} d={d} project={p}/>
    <p className="fine-print">Text outside Girru’s part is never touched. {mod}Z undoes “Use Girru’s version”.</p>
  </div>;
}

/** Board P6c1: the two switches of a project (also in Memory › Projects › a project). */
export function ProjectSwitches({ c, d, project }: { c: ProjectFilesController; d: MemoryDesktopController; project: ProjectFiles }) {
  const s = useStore(c); const p = project;
  return <section className="dk-pf-switches" aria-label="Coding apps">
    <label className="dk-switch"><input type="checkbox" role="switch" checked={p.writeFiles} disabled={s.busy} onChange={e => void setWrite(c, d, p, e.target.checked)}/>
      <span><span>Write project files</span><span className="fine-print">brief, tasks and the Girru part of AGENTS.md</span></span></label>
    <label className="dk-switch"><input type="checkbox" role="switch" checked={p.companyFacts} disabled={s.busy} onChange={e => void setFacts(c, d, p, e.target.checked)}/>
      <span><span>Company facts reach coding apps</span><span className="fine-print">Facts about your company (not about you or people) may be read by coding apps working here</span></span></label>
    <p className="fine-print">Off by default. About you and People never go into project files or to coding apps.</p>
  </section>;
}

/** Board P6c2: "Stays on this computer" in a memory place's details. Not rendered yet: the backend stores
 *  the setting but no reply path honours it, so the words would promise something untrue. */
export function PlaceSwitch({ c, d, placeKey, name }: { c: ProjectFilesController; d: MemoryDesktopController; placeKey: string; name: string }) {
  const s = useStore(c);
  useEffect(() => { if (s.places === null) void c.loadPlaces(); }, [c]);
  if (s.places === 'missing') return null;
  const on = c.staysLocal(placeKey);
  async function flip(next: boolean) {
    if (!(await c.setStaysLocal(placeKey, next))) return;
    d.remember(next ? `${name} stays on this computer.` : `${name} may be sent to an online model again.`, () => c.setStaysLocal(placeKey, !next));
  }
  return <label className="dk-switch"><input type="checkbox" role="switch" checked={on} disabled={s.places === null} onChange={e => void flip(e.target.checked)}/>
    <span><span>Stays on this computer</span><span className="fine-print">Never sent to an online model; answered by the local model only</span></span></label>;
}

/** The sheet "AGENTS.md changed in the folder": Girru's text next to the folder's. */
export function CompareSheet({ c, d }: { c: ProjectFilesController; d: MemoryDesktopController }) {
  const s = useStore(c); const cmp = s.compare;
  if (!cmp) return null;
  const p = c.project(cmp.projectId); const name = fileName(cmp.path); const v = cmp.data?.version;
  return <Sheet wide title={`${name} changed in the folder`} onClose={() => c.closeCompare()}
    actions={<><button type="button" onClick={() => c.closeCompare()}>Cancel</button>
      <button type="button" className="primary" disabled={s.busy || cmp.busy || !p} onClick={() => { if (p) void applyGirru(c, d, p, cmp.path); }}>Use Girru’s version</button></>}>
    {cmp.busy || !cmp.data ? <p className="dk-empty" role="status">Reading both versions…</p> : <>
      <p><b>{name}</b>{/^(AGENTS|CLAUDE|GEMINI)\.md$/.test(name) ? ' in Girru’s part' : ''} was changed in the folder after Girru wrote it.</p>
      <div className="dk-versus">
        <div><span className="fine-print">Girru{v !== null && v !== undefined ? ` (version ${v})` : ''}</span><pre className="dk-pf-text" dir="auto">{cmp.data.girruText}</pre></div>
        <div data-new><span className="fine-print">In the folder now</span><pre className="dk-pf-text" dir="auto">{cmp.data.folderText}</pre></div>
      </div>
      <p className="fine-print"><b>Use Girru’s version</b> writes Girru’s text into the file. The folder’s text is kept as a suggestion in Needs you, labelled “From a file in the project”.</p>
    </>}
  </Sheet>;
}

/** Board P6b1: task-number questions from .girru/tasks.md, one action each. */
export function TaskProblems({ c }: { c: ProjectFilesController }) {
  const s = useStore(c);
  useEffect(() => { void c.loadProblems(); }, [c]);
  if (!Array.isArray(s.problems) || !s.problems.length) return null;
  return <>{(s.problems as readonly TaskProblem[]).map(q => <article key={q.id} className="dk-question">
    {q.kind === 'duplicate_number' ? <>
      <h3><UiIcon name="check" size={15}/>Two tasks in tasks.md use the same number {q.number}</h3>
      <p className="fine-print">{q.projectName} · {q.file}{q.titles.length >= 2 ? <> · “{q.titles[0]}” and “{q.titles[1]}”</> : null}. Nothing in the file was changed and no card was moved until you pick.</p>
      <div className="actions"><button type="button" className="primary" disabled={s.busy} onClick={() => void c.solve(q, 'new_task')}>Make the second one a new task</button></div>
    </> : <>
      <h3><UiIcon name="check" size={15}/>A task in tasks.md names a number Girru does not know ({q.number})</h3>
      <p className="fine-print">{q.projectName} · {q.file} · it was probably copied from another project.</p>
      <div className="actions"><button type="button" disabled={s.busy} onClick={() => void c.solve(q, 'leave')}>Leave it</button><button type="button" className="primary" disabled={s.busy} onClick={() => void c.solve(q, 'add_task')}>Add it as a new task</button></div>
    </>}
  </article>)}</>;
}
