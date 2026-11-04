// Settings › Memory › Documents (KNOW-INDEX-01, board K1): one row per
// project with a switch, one quiet status line and a ⋯ menu; a badge only when
// a file can't be read. A row opens a sheet with the folders read and the
// files that can't be read, in plain words, and one main button: Read again
// now. The agents' Knowledge folders are one row (always read, per agent).
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { SessionClient } from './session';
import { ContextMenu, IconButton, Notice, Sheet, Tile, useMenu } from './desktop-ui';
import { UiIcon } from './ui-icons';
import { canRevealFolder, revealFolder } from './chat-actions';
import { DOCUMENTS_PATH, DOCUMENT_SOURCES_PATH, reindexPath } from './doc-index-contract.js';
import type { DocProject, DocumentsView } from './doc-index-contract.js';
import { PDF_UNREADABLE, statusLine } from './doc-index';
import { OutsideTag, useOutsideProjects } from './outside-projects';

const finder = () => (typeof navigator !== 'undefined' && /Win/.test(navigator.platform ?? '') ? 'Show in Explorer' : 'Show in Finder');

export function DocumentsPane({ client }: { client: SessionClient }) {
  const [view, setView] = useState<DocumentsView | null | 'off' | 'error'>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [toast, setToast] = useState<{ id: number; text: string; undo: boolean } | null>(null);
  const undo = useRef<(() => void) | null>(null);
  const menu = useMenu();
  const trust = useOutsideProjects(client);
  const req = (method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown) => client.request({ method, path, ...(body === undefined ? {} : { body }) } as never);
  async function load() {
    try {
      const r = await req('GET', DOCUMENTS_PATH);
      setView(r.status === 200 ? r.body as DocumentsView : r.status === 404 ? 'off' : 'error');
    } catch { setView('error'); }
  }
  useEffect(() => { void load(); }, [client]);
  const busy = view && typeof view === 'object' && (view.projects.some(p => p.source?.enabled && (p.source.state === 'running' || p.source.state === 'pending')) || view.agents.state === 'running');
  // While something is being read, the lines follow it (quietly, every few seconds).
  useEffect(() => { if (!busy) return; const t = setInterval(() => void load(), 4000); return () => clearInterval(t); }, [busy]);

  async function setOn(p: DocProject, enabled: boolean, quiet = false) {
    const r = await req('PUT', DOCUMENT_SOURCES_PATH, { kind: 'project', refId: p.id, enabled }).catch(() => null);
    if (!r || r.status !== 200) { setToast({ id: Date.now(), text: 'Not changed. Try again.', undo: false }); return; }
    await load();
    if (quiet) return;
    undo.current = () => void setOn(p, !enabled, true);
    setToast({ id: Date.now(), text: enabled ? `${p.name}: documents are read` : `${p.name}: documents no longer read`, undo: true });
  }
  async function again(p: DocProject) {
    if (!p.source?.enabled) return;
    await req('POST', reindexPath(p.source.id)).catch(() => null);
    await load();
    setToast({ id: Date.now(), text: `Reading ${p.name} again`, undo: false });
  }
  const items = (p: DocProject) => [
    { label: 'Read again now', icon: 'refresh' as const, disabled: !p.source?.enabled, run: () => void again(p) },
    ...(canRevealFolder() && p.folders[0] ? [{ label: finder(), icon: 'folder' as const, run: () => revealFolder(p.folders[0].path) }] : []),
    { label: 'Files that can’t be read', icon: 'alert' as const, disabled: !p.source?.unreadable.length, run: () => setOpen(p.id) },
  ];

  if (view === null) return <div className="mem-settings-body"><p className="fine-print" role="status">Reading…</p></div>;
  if (view === 'off') return <div className="mem-settings-body"><p className="fine-print">Document memory is turned off on this computer.</p></div>;
  if (view === 'error') return <div className="mem-settings-body"><p className="fine-print" role="status">The documents could not be read. <button type="button" className="link-button" onClick={() => void load()}>Try again</button></p></div>;
  const selected = view.projects.find(p => p.id === open) ?? null;
  return <div className="mem-settings-body doc-pane">
    <p className="fine-print">Agents find answers in a project’s files (.md, .txt, .pdf) and say which file and page. The files stay where they are. Every project with a folder is read; turn one off here.</p>
    {view.projects.length === 0 ? <div className="dk-empty"><UiIcon name="folder" size={24}/><p>Give a project a folder in Chat; its documents can then be read here.</p></div>
      : <ul className="doc-list" aria-label="Projects">{view.projects.map(p => {
        const on = !!p.source?.enabled;
        const bad = p.source?.unreadable.length ?? 0;
        const running = on && (p.source?.state === 'running' || p.source?.state === 'pending');
        return <li key={p.id} className="doc-row" data-on={on || undefined} onContextMenu={(e: ReactMouseEvent) => { e.preventDefault(); menu.at(e, items(p)); }}>
          <button type="button" className="doc-row-main" disabled={!p.hasFolder} onClick={() => setOpen(p.id)} title={p.hasFolder ? 'Folders read and files that can’t be read' : 'This project has no folder on this computer'}>
            <Tile name={p.name}/>
            <span className="doc-row-text"><span className="doc-row-name">{p.name}<OutsideTag store={trust} projectId={p.id}/>{bad > 0 && <span className="doc-badge" data-tone="warn">{bad === 1 ? '1 can’t be read' : `${bad} can’t be read`}</span>}</span>
              <span className="fine-print">{running && <UiIcon name="refresh" size={11}/>}{statusLine(p)}</span></span>
          </button>
          <button type="button" role="switch" className="ag-switch" aria-checked={on} disabled={!p.hasFolder} aria-label={`Read the documents of ${p.name}`} title={on ? 'Agents read its documents' : 'Not read'} onClick={() => void setOn(p, !on)}><i/></button>
          <IconButton icon="more" label={`More for ${p.name}`} onClick={e => menu.at(e, items(p))}/>
        </li>;
      })}</ul>}
    <ul className="doc-list" aria-label="Agents">
      <li className="doc-row"><span className="doc-row-main doc-row-static"><span className="doc-person"><UiIcon name="person" size={14}/></span>
        <span className="doc-row-text"><span className="doc-row-name">Each agent’s Knowledge files{view.agents.unreadable.length > 0 && <span className="doc-badge" data-tone="warn">{view.agents.unreadable.length} can’t be read</span>}</span>
          <span className="fine-print">Read for that agent only · always on{view.agents.files ? ` · ${view.agents.files} ${view.agents.files === 1 ? 'file' : 'files'}` : ''}</span></span></span></li>
    </ul>
    {selected && <Sheet wide title={`${selected.name} · Documents`} onClose={() => setOpen(null)} actions={<button type="button" className="primary" disabled={!selected.source?.enabled} onClick={() => void again(selected)}><UiIcon name="refresh" size={14}/>Read again now</button>}>
      <div className="doc-sheet">
        <p className="fine-print">Read from these folders:</p>
        <ul className="doc-list">{selected.folders.map(f => <li key={f.path} className="doc-row"><span className="doc-row-main doc-row-static"><UiIcon name="folder" size={16}/>
          <span className="doc-row-text"><span className="doc-row-name">{f.name}</span><span className="fine-print dk-path" title={f.path}>{f.main ? 'Main folder' : 'Added folder'}{selected.source?.enabled ? ` · ${f.files} ${f.files === 1 ? 'file' : 'files'}` : ''}</span></span></span>
          {canRevealFolder() && <IconButton icon="folder" label={finder()} onClick={() => revealFolder(f.path)}/>}</li>)}</ul>
        {!selected.source?.enabled && <p className="fine-print">Not read now. Turn the switch on to read these folders.</p>}
        {(selected.source?.unreadable.length ?? 0) > 0 && <><p className="fine-print">Can’t be read (nothing is guessed):</p>
          <ul className="doc-list">{selected.source!.unreadable.map(u => <li key={u.file} className="doc-row"><span className="doc-row-main doc-row-static"><UiIcon name="file" size={16}/>
            <span className="doc-row-text"><span className="doc-row-name">{u.file}</span><span className="fine-print">{PDF_UNREADABLE[u.reason] ?? PDF_UNREADABLE.unreadable}</span></span></span></li>)}</ul></>}
        {selected.source?.limited && <p className="fine-print">Only part of these folders was read: there are more files than Girru reads in one project (500).</p>}
        <p className="fine-print">Never read: hidden files, .env, secrets and keys, dependency folders, files over 20 MB. Secrets inside a file are hidden before it is kept.</p>
      </div>
    </Sheet>}
    <ContextMenu menu={menu.menu} onClose={menu.close}/>
    <Notice toast={toast} onUndo={() => { undo.current?.(); undo.current = null; setToast(null); }} onDone={id => setToast(t => (t?.id === id ? null : t))}/>
  </div>;
}
